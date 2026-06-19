import type {
  MemoryCandidate,
  MemoryEdge,
  MemoryRecord,
  ProductState,
} from "./types";

import { cloneState, makeId, nowIso, withAuditEvent, withAiRunEvent } from "./utils";
import { buildMemoryEdgesForRecord, formatMemoryGraphTargetLabel, tokenizeMemoryGraphText } from "./context-pack";
import { cosineSimilarity } from "./vector";

import { withMemoryCandidateReview } from "./memoryReview";

/** Cosine threshold above which a candidate is a near-duplicate of an existing record (both embedded). */
const DEDUP_COSINE_THRESHOLD = 0.88;
/** Token-Jaccard is far stricter than cosine, and finalize/import candidates carry no embedding,
 *  so the no-embedding path needs a lower bar or the M2 dedup hint would never fire offline. */
const DEDUP_TOKEN_THRESHOLD = 0.45;
/** M5 consolidation actually deprecates the weaker record, so it is more conservative than the M2 hint. */
const DEDUP_MERGE_COSINE_THRESHOLD = 0.9;
const DEDUP_MERGE_TOKEN_THRESHOLD = 0.5;

/** Strip the deterministic finalize candidate prefix ("用户在《title》中表达：") so similarity
 *  compares the real content, not the shared boilerplate that otherwise dilutes token overlap. */
function stripMemoryTemplatePrefix(text: string): string {
  const stripped = text.replace(/^用户在《[^》]*》中表达：/, "").trim();
  return stripped.length > 0 ? stripped : text;
}

/**
 * The dedup decision surfaced to the HITL reviewer (Task 6 / M2).
 *
 * `op` mirrors `MemoryCandidate.suggestedUpdate`; this task only emits `add`/`update`
 * deterministically. `conflict`/`noop` are reserved on the candidate type but NOT
 * auto-decided here: without an LLM we cannot reliably tell "contradicts existing"
 * from "refines existing", and silently classifying a near-duplicate as a conflict
 * would mislead the reviewer. So we stop at "looks like X — you decide" and leave
 * the merge/keep/discard call to the human via the existing approve/reject controls.
 */
export interface MemoryUpdatePlan {
  op: "add" | "update";
  /** When op === "update", the confirmed record this candidate most resembles. */
  similarToRecordId?: string;
}

/**
 * Borrowed from Mem0's extract-then-update idea, but HITL-first: instead of mutating
 * the store, we score a fresh candidate against already-confirmed memories and hand
 * the reviewer a "似已有记忆 X" hint. The store is never changed automatically — that
 * matches this system's human-in-the-loop philosophy and stays safe with no API key.
 *
 * Pure & synchronous. Similarity is embedding cosine when BOTH sides carry an
 * embedding; otherwise it falls back to normalized token overlap (Jaccard over the
 * shared `tokenizeMemoryGraphText` tokenizer), which is what candidates at finalize/
 * import time actually have (they're produced without embeddings). Only `confirmed`
 * records are considered as merge targets.
 *
 * @returns `{op:"update", similarToRecordId}` when the closest confirmed record scores
 *          strictly above `threshold` (default 0.88); otherwise `{op:"add"}`.
 */
export function planMemoryUpdate(
  candidate: { text: string; embedding?: number[] },
  existingRecords: MemoryRecord[],
  opts: { threshold?: number } = {}
): MemoryUpdatePlan {
  const candidateText = candidate.text?.trim() ?? "";
  if (!candidateText) {
    return { op: "add" };
  }

  const candidateTokens = tokenizeMemoryGraphText(stripMemoryTemplatePrefix(candidateText));
  const hasCandidateEmbedding = Array.isArray(candidate.embedding) && candidate.embedding.length > 0;

  let best: { id: string; score: number; usedEmbedding: boolean } | undefined;
  for (const record of existingRecords) {
    if (record.status !== "confirmed") {
      continue;
    }
    const { score, usedEmbedding } = scoreCandidateAgainstRecord(
      candidate,
      candidateTokens,
      hasCandidateEmbedding,
      record
    );
    if (!best || score > best.score) {
      best = { id: record.id, score, usedEmbedding };
    }
  }

  if (best) {
    // Token-Jaccard is far stricter than cosine, so the no-embedding path uses a lower bar.
    const threshold =
      opts.threshold ?? (best.usedEmbedding ? DEDUP_COSINE_THRESHOLD : DEDUP_TOKEN_THRESHOLD);
    if (best.score > threshold) {
      return { op: "update", similarToRecordId: best.id };
    }
  }
  return { op: "add" };
}

// Embedding cosine when both sides have a vector; otherwise normalized token overlap
// (template prefix stripped so it compares real content, not the shared boilerplate).
function scoreCandidateAgainstRecord(
  candidate: { text: string; embedding?: number[] },
  candidateTokens: Set<string>,
  hasCandidateEmbedding: boolean,
  record: MemoryRecord
): { score: number; usedEmbedding: boolean } {
  if (hasCandidateEmbedding && Array.isArray(record.embedding) && record.embedding.length > 0) {
    return { score: cosineSimilarity(candidate.embedding as number[], record.embedding), usedEmbedding: true };
  }
  return {
    score: tokenOverlapRatio(candidateTokens, tokenizeMemoryGraphText(stripMemoryTemplatePrefix(record.text))),
    usedEmbedding: false
  };
}

// Jaccard similarity over token sets: |A∩B| / |A∪B|, 0 when either side is empty.
function tokenOverlapRatio(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) {
    return 0;
  }
  let intersection = 0;
  for (const token of a) {
    if (b.has(token)) {
      intersection += 1;
    }
  }
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/**
 * M5: lightweight consolidation — borrows Generative Agents' "reflection/merge"
 * idea but at the smallest useful scope: a manual "整理记忆" pass that de-dups
 * near-identical CONFIRMED records, deprecating the weaker of each near-dup pair
 * so the long-term store stops carrying two phrasings of the same fact.
 *
 * Pure & synchronous — like {@link planMemoryUpdate} it never calls Date.now()/
 * embed; similarity reuses embedding cosine when BOTH sides carry a vector,
 * otherwise token-overlap (Jaccard) over the shared tokenizer. Only `confirmed`
 * records participate; already-deprecated/deleted records are returned untouched.
 *
 * Merge policy for a near-dup pair (score strictly > `threshold`, default 0.9):
 * keep the stronger by `importance` (`?? 5`, matching scoreMemoryForRetrieval),
 * breaking ties toward the more recent `createdAt`; the loser is flagged
 * `status:"deprecated"` with a `deprecatedReason` pointing at the kept record id.
 * A record already chosen as a loser cannot later be kept, so we never deprecate
 * the stronger member of a cluster via a chained comparison.
 *
 * @returns a NEW array (input is never mutated). Optional LLM summarization of a
 *          merged cluster is done in the route layer (it has the chat client);
 *          this function only makes the deterministic, offline-safe dedup decision.
 */
export function dedupeMemoryRecords(
  records: MemoryRecord[],
  opts: { threshold?: number } = {}
): MemoryRecord[] {
  // recordId -> kept record id that supersedes it (the merge target).
  const deprecatedBy = new Map<string, string>();

  const confirmed = records.filter((record) => record.status === "confirmed");
  for (let i = 0; i < confirmed.length; i += 1) {
    for (let j = i + 1; j < confirmed.length; j += 1) {
      const a = confirmed[i];
      const b = confirmed[j];
      // A record already marked a loser is out of the running on both sides:
      // it can neither be kept nor re-deprecated.
      if (deprecatedBy.has(a.id) || deprecatedBy.has(b.id)) {
        continue;
      }
      const { score, usedEmbedding } = recordSimilarity(a, b);
      // M5 merge deprecates a record, so it is more conservative than the M2 hint;
      // token-Jaccard path uses a lower bar than cosine since Jaccard is far stricter.
      const pairThreshold =
        opts.threshold ?? (usedEmbedding ? DEDUP_MERGE_COSINE_THRESHOLD : DEDUP_MERGE_TOKEN_THRESHOLD);
      if (score <= pairThreshold) {
        continue;
      }
      const keeper = strongerRecord(a, b);
      const loser = keeper.id === a.id ? b : a;
      deprecatedBy.set(loser.id, keeper.id);
    }
  }

  if (deprecatedBy.size === 0) {
    return records.map((record) => ({ ...record }));
  }
  return records.map((record) => {
    const keptId = deprecatedBy.get(record.id);
    if (!keptId) {
      return { ...record };
    }
    return {
      ...record,
      status: "deprecated",
      deprecatedReason: `记忆整理：与 ${keptId} 合并`
    };
  });
}

// Embedding cosine when both records carry a vector; otherwise token overlap.
// Mirrors scoreCandidateAgainstRecord but for two stored records.
function recordSimilarity(a: MemoryRecord, b: MemoryRecord): { score: number; usedEmbedding: boolean } {
  const hasA = Array.isArray(a.embedding) && a.embedding.length > 0;
  const hasB = Array.isArray(b.embedding) && b.embedding.length > 0;
  if (hasA && hasB) {
    return { score: cosineSimilarity(a.embedding as number[], b.embedding as number[]), usedEmbedding: true };
  }
  return {
    score: tokenOverlapRatio(
      tokenizeMemoryGraphText(stripMemoryTemplatePrefix(a.text)),
      tokenizeMemoryGraphText(stripMemoryTemplatePrefix(b.text))
    ),
    usedEmbedding: false
  };
}

// The record to KEEP from a near-dup pair: higher importance wins; on a tie the
// more recent createdAt wins (so consolidation prefers the freshest phrasing).
// importance defaults to 5, matching scoreMemoryForRetrieval's `importance ?? 5`.
function strongerRecord(a: MemoryRecord, b: MemoryRecord): MemoryRecord {
  const importanceA = a.importance ?? 5;
  const importanceB = b.importance ?? 5;
  if (importanceA !== importanceB) {
    return importanceA > importanceB ? a : b;
  }
  return a.createdAt >= b.createdAt ? a : b;
}

/**
 * M3c: approve a candidate into a confirmed MemoryRecord.
 *
 * Pure & synchronous — embeddings are computed asynchronously in the route layer
 * (which has the embeddingClient) and handed in pre-computed via `opts.embedding`,
 * keeping this function key-free and offline-safe. Omitting `opts` reproduces the
 * pre-M3c behaviour exactly (no embedding, importance backfilled from reviewScore).
 *
 * @param opts.embedding   semantic vector for `candidate.text` (route-computed).
 * @param opts.importance  explicit 1–10 salience; when absent, derived from the
 *                         candidate's reviewScore (0–100) mapped into 1–10.
 */
export function approveMemoryCandidate(
  state: ProductState,
  candidateId: string,
  opts: { embedding?: number[]; importance?: number } = {}
): ProductState {
  const candidate = state.memoryCandidates.find((item) => item.id === candidateId);
  if (!candidate || candidate.status !== "pending") {
    return state;
  }

  const reviewedAt = nowIso();
  const importance = opts.importance ?? reviewScoreToImportance(candidate.reviewScore);
  const record: MemoryRecord = {
    id: makeId("memory-record"),
    text: candidate.text,
    status: "confirmed",
    sourceType: candidate.sourceType,
    sourceId: candidate.sourceId,
    evidenceQuote: candidate.evidenceQuote,
    sourceCandidateId: candidate.id,
    sensitivity: candidate.sensitivity,
    importance,
    ...(opts.embedding && opts.embedding.length > 0 ? { embedding: opts.embedding } : {}),
    createdAt: reviewedAt,
    updatedAt: reviewedAt,
    // Seed lastAccessedAt at confirm time so retrieval recency has a real value to decay
    // from (route-side write-back on each recall is a later enhancement).
    lastAccessedAt: reviewedAt
  };
  const clonedState = cloneState(state);
  const projectedState: ProductState = {
    ...clonedState,
    memoryRecords: [record, ...(clonedState.memoryRecords ?? [])]
  };
  const memoryEdges = buildMemoryEdgesForRecord(projectedState, record, reviewedAt);
  const nextState: ProductState = {
    ...projectedState,
    memoryCandidates: state.memoryCandidates.map((item) =>
      item.id === candidate.id
        ? {
            ...item,
            status: "approved",
            reviewedAt
          }
        : item
    ),
    memoryEdges: [...memoryEdges, ...(state.memoryEdges ?? [])]
  };

  return withAuditEvent(nextState, {
    type: "memory_candidate_approved",
    label: "候选记忆已确认",
    detail: candidate.text,
    severity: "info",
    entityType: "memory_record",
    entityId: record.id,
    createdAt: reviewedAt
  });
}
// M3c: map a candidate review score (0–100) into the MemoryRecord importance band
// (1–10) consumed by scoreMemoryForRetrieval. Non-finite scores fall back to the
// neutral midpoint (50 → 5), matching scoreMemoryForRetrieval's `importance ?? 5`.
function reviewScoreToImportance(reviewScore: number | undefined): number {
  const score = Number.isFinite(reviewScore) ? (reviewScore as number) : 50;
  return Math.max(1, Math.min(10, Math.round(score / 10)));
}
export function deleteMemoryRecord(state: ProductState, recordId: string): ProductState {
  const record = state.memoryRecords.find((item) => item.id === recordId);
  if (!record) {
    return state;
  }

  const deletedAt = nowIso();
  const nextState: ProductState = {
    ...cloneState(state),
    memoryRecords: state.memoryRecords.filter((item) => item.id !== record.id),
    memoryEdges: (state.memoryEdges ?? []).filter((edge) => edge.fromMemoryRecordId !== record.id)
  };

  return withAuditEvent(nextState, {
    type: "memory_record_deleted",
    label: "确认记忆已删除",
    detail: record.text,
    severity: "warning",
    entityType: "memory_record",
    entityId: record.id,
    createdAt: deletedAt
  });
}
export function deprecateMemoryRecord(
  state: ProductState,
  recordId: string,
  deprecatedReason = "用户撤销这条长期记忆。"
): ProductState {
  const record = state.memoryRecords.find((item) => item.id === recordId);
  if (!record || record.status !== "confirmed") {
    return state;
  }

  const updatedAt = nowIso();
  const nextState: ProductState = {
    ...cloneState(state),
    memoryRecords: state.memoryRecords.map((item) =>
      item.id === record.id
        ? {
            ...item,
            status: "deprecated",
            updatedAt,
            deprecatedReason
          }
        : item
    )
  };

  return withAuditEvent(nextState, {
    type: "memory_record_deprecated",
    label: "确认记忆已废弃",
    detail: `${record.text}｜${deprecatedReason}`,
    severity: "warning",
    entityType: "memory_record",
    entityId: record.id,
    createdAt: updatedAt
  });
}
export function rejectMemoryCandidate(state: ProductState, candidateId: string, reviewNote = "用户拒绝写入长期记忆。"): ProductState {
  const candidate = state.memoryCandidates.find((item) => item.id === candidateId);
  if (!candidate || candidate.status !== "pending") {
    return state;
  }

  const reviewedAt = nowIso();
  const nextState: ProductState = {
    ...cloneState(state),
    memoryCandidates: state.memoryCandidates.map((item) =>
      item.id === candidate.id
        ? {
            ...item,
            status: "rejected",
            reviewedAt,
            reviewNote
          }
        : item
    )
  };

  return withAuditEvent(nextState, {
    type: "memory_candidate_rejected",
    label: "候选记忆已拒绝",
    detail: `${candidate.text}｜${reviewNote}`,
    severity: "warning",
    entityType: "memory_candidate",
    entityId: candidate.id,
    createdAt: reviewedAt
  });
}
export function updateMemoryCandidateText(state: ProductState, candidateId: string, text: string): ProductState {
  const candidate = state.memoryCandidates.find((item) => item.id === candidateId);
  const revisedText = text.trim();
  if (!candidate || candidate.status !== "pending" || !revisedText || revisedText === candidate.text) {
    return state;
  }

  const updatedAt = nowIso();
  const nextState: ProductState = {
    ...cloneState(state),
    memoryCandidates: state.memoryCandidates.map((item) =>
      item.id === candidate.id
        ? withMemoryCandidateReview({
            ...item,
            text: revisedText
          }, { preserveExisting: false })
        : item
    )
  };

  return withAuditEvent(nextState, {
    type: "memory_candidate_updated",
    label: "候选记忆已修改",
    detail: `从“${candidate.text}”修改为“${revisedText}”。`,
    severity: "warning",
    entityType: "memory_candidate",
    entityId: candidate.id,
    createdAt: updatedAt
  });
}
export function updateMemoryRecordText(state: ProductState, recordId: string, text: string): ProductState {
  const record = state.memoryRecords.find((item) => item.id === recordId);
  const revisedText = text.trim();
  if (!record || record.status !== "confirmed" || !revisedText || revisedText === record.text) {
    return state;
  }

  const updatedAt = nowIso();
  const updatedRecord: MemoryRecord = {
    ...record,
    text: revisedText,
    updatedAt
  };
  const baseState: ProductState = {
    ...cloneState(state),
    memoryRecords: state.memoryRecords.map((item) => (item.id === record.id ? updatedRecord : item)),
    memoryEdges: (state.memoryEdges ?? []).filter((edge) => edge.fromMemoryRecordId !== record.id)
  };
  const nextState: ProductState = {
    ...baseState,
    memoryEdges: [...buildMemoryEdgesForRecord(baseState, updatedRecord, updatedAt), ...baseState.memoryEdges]
  };

  return withAuditEvent(nextState, {
    type: "memory_record_updated",
    label: "确认记忆已修正",
    detail: `从“${record.text}”修正为“${revisedText}”。`,
    severity: "warning",
    entityType: "memory_record",
    entityId: record.id,
    createdAt: updatedAt
  });
}
