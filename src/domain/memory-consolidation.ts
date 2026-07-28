/**
 * Stage-2 memory consolidation helpers (pure):
 * - confidence / importance decay by recency
 * - contradiction detection → pending HITL candidates
 */
import type { MemoryCandidate, MemoryRecord, ProductState } from "./types";
import { makeId, nowIso, withAuditEvent } from "./utils";
import { tokenizeMemoryGraphText } from "./context-pack";
import { withMemoryCandidateReview } from "./memoryReview";

const DAY_MS = 24 * 60 * 60 * 1000;

/** Half-life days for importance decay (default ~90d → ~half confidence). */
export const DEFAULT_IMPORTANCE_HALF_LIFE_DAYS = 90;

export function decayImportance(
  importance: number | undefined,
  lastTouchIso: string | undefined,
  nowIsoStr: string,
  halfLifeDays = DEFAULT_IMPORTANCE_HALF_LIFE_DAYS
): number {
  const base = importance ?? 5;
  if (!lastTouchIso || halfLifeDays <= 0) return base;
  const last = Date.parse(lastTouchIso);
  const now = Date.parse(nowIsoStr);
  if (!Number.isFinite(last) || !Number.isFinite(now) || now <= last) return base;
  const days = (now - last) / DAY_MS;
  const factor = Math.pow(0.5, days / halfLifeDays);
  // Floor at 1 so decay never erases the memory from ranking entirely.
  return Math.max(1, Math.round(base * factor * 10) / 10);
}

/** Apply decay to all confirmed records (pure). Does not deprecate. */
export function applyImportanceDecay(
  records: MemoryRecord[],
  now: string = nowIso(),
  halfLifeDays = DEFAULT_IMPORTANCE_HALF_LIFE_DAYS
): MemoryRecord[] {
  return records.map((r) => {
    if (r.status !== "confirmed") return { ...r };
    const touch = r.lastAccessedAt ?? r.updatedAt ?? r.createdAt;
    const next = decayImportance(r.importance, touch, now, halfLifeDays);
    if (next === (r.importance ?? 5)) return { ...r };
    return { ...r, importance: next, updatedAt: r.updatedAt };
  });
}

export interface ContradictionPair {
  a: MemoryRecord;
  b: MemoryRecord;
  reason: string;
}

const CONTRADICTION_MARKERS: Array<{ pos: RegExp; neg: RegExp; label: string }> = [
  { pos: /应该|必须|一定要/, neg: /不应该|不必|千万别|不要/, label: "应然对立" },
  { pos: /总是|永远|一直/, neg: /从不|绝不|从未/, label: "频率对立" },
  { pos: /喜欢|热爱|擅长/, neg: /讨厌|害怕|不擅长|排斥/, label: "态度对立" },
  { pos: /可以|能够|愿意/, neg: /不能|无法|不愿|拒绝/, label: "能力/意愿对立" }
];

function shareTopic(a: string, b: string): boolean {
  const ta = tokenizeMemoryGraphText(a);
  const tb = new Set(tokenizeMemoryGraphText(b));
  let hits = 0;
  for (const t of ta) {
    if (tb.has(t)) hits += 1;
  }
  return hits >= 2;
}

/**
 * Detect likely contradictions among confirmed memories.
 * Conservative: requires shared topic tokens + opposing polarity markers.
 */
export function detectMemoryContradictions(records: MemoryRecord[]): ContradictionPair[] {
  const confirmed = records.filter((r) => r.status === "confirmed");
  const pairs: ContradictionPair[] = [];
  for (let i = 0; i < confirmed.length; i += 1) {
    for (let j = i + 1; j < confirmed.length; j += 1) {
      const a = confirmed[i]!;
      const b = confirmed[j]!;
      if (!shareTopic(a.text, b.text)) continue;
      for (const m of CONTRADICTION_MARKERS) {
        const aPos = m.pos.test(a.text);
        const aNeg = m.neg.test(a.text);
        const bPos = m.pos.test(b.text);
        const bNeg = m.neg.test(b.text);
        if ((aPos && bNeg) || (aNeg && bPos)) {
          pairs.push({
            a,
            b,
            reason: `可能存在${m.label}：请确认哪一条仍成立，或合并为更精确的表述。`
          });
          break;
        }
      }
    }
  }
  return pairs.slice(0, 8);
}

/** Build pending HITL candidates for contradiction pairs (no auto-resolve). */
export function buildContradictionCandidates(
  pairs: ContradictionPair[],
  createdAt: string = nowIso()
): MemoryCandidate[] {
  return pairs.map((pair) =>
    withMemoryCandidateReview({
      id: makeId("memory-candidate"),
      text: `【待裁决矛盾】A：${pair.a.text} ｜ B：${pair.b.text}`,
      status: "pending",
      sourceType: pair.a.sourceType,
      sourceId: pair.a.sourceId,
      evidenceQuote: pair.b.evidenceQuote || pair.a.evidenceQuote,
      reason: pair.reason,
      sensitivity: pair.a.sensitivity === "sensitive" || pair.b.sensitivity === "sensitive" ? "sensitive" : "normal",
      similarToRecordId: pair.a.id,
      suggestedUpdate: "conflict",
      importance: Math.max(pair.a.importance ?? 5, pair.b.importance ?? 5),
      createdAt
    })
  );
}

/**
 * Stage-3 echo-chamber guard: drop candidate texts that merely restate already-confirmed
 * rules / user corrections so consolidate does not re-propose known facts as insights.
 */
export function filterEchoChamberTexts(
  proposedTexts: string[],
  knownTexts: string[],
  opts: { minOverlapRatio?: number } = {}
): string[] {
  const minOverlap = opts.minOverlapRatio ?? 0.72;
  const knownTokenSets = knownTexts.map((t) => new Set(tokenizeMemoryGraphText(t)));
  return proposedTexts.filter((text) => {
    const tokens = tokenizeMemoryGraphText(text);
    const tokenList = [...tokens];
    if (!tokenList.length) return false;
    for (const known of knownTokenSets) {
      let hits = 0;
      for (const t of tokenList) {
        if (known.has(t)) hits += 1;
      }
      if (hits / tokenList.length >= minOverlap) return false;
    }
    return true;
  });
}

export function collectEchoChamberKnownTexts(state: ProductState): string[] {
  const fromRecords = state.memoryRecords
    .filter((r) => r.status === "confirmed" || r.status === "deprecated")
    .map((r) => r.text);
  const fromCorrections = (state.memoryCorrections ?? []).map((c) => c.text).filter(Boolean);
  const fromBoundaries = state.profile?.explicitBoundaries ?? [];
  return [...fromRecords, ...fromCorrections, ...fromBoundaries].filter(Boolean);
}

/** Resolve a contradiction candidate: keep one side, demote the other with supersede links. */
export function resolveMemoryConflict(
  state: ProductState,
  opts: {
    keepRecordId: string;
    demoteRecordId: string;
    candidateId?: string;
    now?: string;
  }
): ProductState {
  const now = opts.now ?? nowIso();
  const keep = state.memoryRecords.find((r) => r.id === opts.keepRecordId);
  const demote = state.memoryRecords.find((r) => r.id === opts.demoteRecordId);
  if (!keep || !demote) return state;

  let next: ProductState = {
    ...state,
    memoryRecords: state.memoryRecords.map((r) => {
      if (r.id === opts.keepRecordId) {
        const supersedes = Array.from(new Set([...(r.supersedesRecordIds ?? []), opts.demoteRecordId]));
        const contradicts = Array.from(new Set([...(r.contradictsRecordIds ?? []), opts.demoteRecordId]));
        return {
          ...r,
          supersedesRecordIds: supersedes,
          contradictsRecordIds: contradicts,
          updatedAt: now,
          lastAccessedAt: now
        };
      }
      if (r.id === opts.demoteRecordId) {
        return {
          ...r,
          status: "deprecated" as const,
          deprecatedReason: `矛盾裁决：被 ${opts.keepRecordId} 取代`,
          supersededByRecordId: opts.keepRecordId,
          contradictsRecordIds: Array.from(new Set([...(r.contradictsRecordIds ?? []), opts.keepRecordId])),
          updatedAt: now
        };
      }
      return r;
    }),
    memoryCandidates: opts.candidateId
      ? state.memoryCandidates.map((c) =>
          c.id === opts.candidateId ? { ...c, status: "approved" as const, reviewedAt: now } : c
        )
      : state.memoryCandidates
  };

  return withAuditEvent(next, {
    type: "memory_record_deprecated",
    label: "矛盾裁决：demote-not-delete",
    detail: `保留 ${opts.keepRecordId}，降级 ${opts.demoteRecordId}`,
    severity: "warning",
    entityType: "memory_record",
    entityId: opts.demoteRecordId,
    createdAt: now
  });
}

/** Parse 【待裁决矛盾】A：…｜B：… candidate into paired record ids when similarTo + text match. */
export function findConflictPairRecords(
  state: ProductState,
  candidate: MemoryCandidate
): { aId?: string; bId?: string } {
  if (candidate.suggestedUpdate !== "conflict" && !candidate.text.startsWith("【待裁决矛盾】")) {
    return {};
  }
  const body = candidate.text.replace(/^【待裁决矛盾】/, "");
  const parts = body.split(/｜|\|/);
  const aText = (parts[0] ?? "").replace(/^A：/, "").trim();
  const bText = (parts[1] ?? "").replace(/^B：/, "").trim();
  const a = state.memoryRecords.find((r) => r.text === aText || r.id === candidate.similarToRecordId);
  const b = state.memoryRecords.find((r) => r.text === bText);
  return { aId: a?.id, bId: b?.id };
}

/** Full pure consolidation enrichment after dedupe: decay + contradiction candidates. */
export function enrichStateAfterDedupe(state: ProductState, now: string = nowIso()): ProductState {
  const decayed = applyImportanceDecay(state.memoryRecords, now);
  const pairs = detectMemoryContradictions(decayed);
  const existingTexts = new Set(state.memoryCandidates.map((c) => c.text));
  const known = collectEchoChamberKnownTexts({ ...state, memoryRecords: decayed });
  const freshRaw = buildContradictionCandidates(pairs, now).filter((c) => !existingTexts.has(c.text));
  // Echo-chamber: drop contradiction cards whose both sides are already explicit boundaries-only noise
  // (keep real conflicts). Also filter any non-conflict summary-like dups if present.
  const fresh = freshRaw.filter((c) => {
    if (c.suggestedUpdate === "conflict") return true;
    return filterEchoChamberTexts([c.text], known).length > 0;
  });
  let next: ProductState = {
    ...state,
    memoryRecords: decayed,
    memoryCandidates: fresh.length ? [...fresh, ...state.memoryCandidates] : state.memoryCandidates
  };
  if (fresh.length > 0) {
    next = withAuditEvent(next, {
      type: "memory_candidate_updated",
      label: "记忆整理：检出待裁决矛盾",
      detail: `新增 ${fresh.length} 条矛盾候选，需人工确认`,
      severity: "warning",
      entityType: "memory_candidate",
      entityId: fresh[0]!.id,
      createdAt: now
    });
  }
  return next;
}

/** Stage-3 sleep-time queue: propose without mutating durable records. */
export function buildConsolidationQueuePreview(state: ProductState, now: string = nowIso()): {
  decayPreview: MemoryRecord[];
  contradictionCandidates: MemoryCandidate[];
  echoFilteredCount: number;
} {
  const decayPreview = applyImportanceDecay(state.memoryRecords, now);
  const pairs = detectMemoryContradictions(decayPreview);
  const raw = buildContradictionCandidates(pairs, now);
  const known = collectEchoChamberKnownTexts({ ...state, memoryRecords: decayPreview });
  const keptTexts = filterEchoChamberTexts(
    raw.filter((c) => c.suggestedUpdate !== "conflict").map((c) => c.text),
    known
  );
  const keptSet = new Set(keptTexts);
  const contradictionCandidates = raw.filter(
    (c) => c.suggestedUpdate === "conflict" || keptSet.has(c.text)
  );
  return {
    decayPreview,
    contradictionCandidates,
    echoFilteredCount: Math.max(0, raw.length - contradictionCandidates.length)
  };
}
