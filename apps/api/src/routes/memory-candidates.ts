import type { FastifyInstance } from "fastify";
import {
  approveMemoryCandidate,
  dedupeMemoryRecords,
  rejectMemoryCandidate,
  updateMemoryCandidateText
} from "../../../../src/domain/engine";
import { withMemoryCandidateReview } from "../../../../src/domain/memoryReview";
import { makeId, nowIso, withAuditEvent } from "../../../../src/domain/utils";
import type { MemoryCandidate, MemoryRecord, ProductState } from "../../../../src/domain/types";
import type { ProductStateRepository } from "../product-state-repository";
import type { BailianChatClient, BailianEmbeddingClient } from "../providers/bailian";

interface RejectMemoryCandidatePayload {
  reviewNote?: unknown;
}

interface UpdateMemoryCandidatePayload {
  text?: unknown;
}

// P1-05: cap a single candidate text field (same budget as a confirmed memory record).
const MEMORY_CANDIDATE_TEXT_MAX_CHARS = 16 * 1024;

interface MemoryCandidateRouteOptions {
  embeddingClient?: BailianEmbeddingClient;
  /** M5: when present, a consolidation pass may summarize a merged cluster into a
   * pending HITL candidate. Absent → consolidation just de-dups (offline-safe). */
  bailianChatClient?: BailianChatClient;
}

export async function registerMemoryCandidateRoutes(
  server: FastifyInstance,
  repository: ProductStateRepository,
  options: MemoryCandidateRouteOptions = {}
) {
  server.patch("/api/memory-candidates/:id", async (request, reply) => {
    const state = repository.getState();
    const candidate = findCandidate(state, getCandidateId(request.params));
    if (!candidate) {
      return reply.code(404).send({ error: "Memory candidate not found." });
    }
    if (candidate.status !== "pending") {
      return reply.code(409).send({ error: "Memory candidate is not pending." });
    }

    const text = normalizeOptionalString(normalizeObject<UpdateMemoryCandidatePayload>(request.body).text);
    if (!text) {
      return reply.code(422).send({ error: "Memory candidate text is required." });
    }
    if (text.length > MEMORY_CANDIDATE_TEXT_MAX_CHARS) {
      return reply.code(422).send({ error: `Memory candidate text exceeds the ${MEMORY_CANDIDATE_TEXT_MAX_CHARS}-character limit.` });
    }

    const nextState = updateMemoryCandidateText(state, candidate.id, text);
    const updatedCandidate = findCandidate(nextState, candidate.id);
    repository.replaceState(nextState);

    return { candidate: updatedCandidate, state: nextState };
  });

  server.post("/api/memory-candidates/:id/approve", async (request, reply) => {
    const state = repository.getState();
    const candidate = findCandidate(state, getCandidateId(request.params));
    if (!candidate) {
      return reply.code(404).send({ error: "Memory candidate not found." });
    }
    if (candidate.status !== "pending") {
      return reply.code(409).send({ error: "Memory candidate is not pending." });
    }

    // M3c: enrich the confirmed record with a semantic embedding so the long-term
    // store is cosine-searchable from the interview line. The embedding is computed
    // here (route layer has the client); the domain approve stays pure and offline-
    // safe. On any embed failure / no client we pass nothing and the record is
    // created without an embedding (keyword retrieval still works). importance is
    // backfilled inside approveMemoryCandidate from the candidate's reviewScore.
    const embedding = await embedCandidateText(candidate.text, options.embeddingClient);
    const nextState = approveMemoryCandidate(state, candidate.id, {
      ...(embedding ? { embedding } : {}),
      // Consolidation summaries carry the keeper's importance; honor it over the reviewScore band.
      ...(candidate.importance != null ? { importance: candidate.importance } : {})
    });
    const reviewedCandidate = findCandidate(nextState, candidate.id);
    const record = nextState.memoryRecords.find((item) => item.sourceCandidateId === candidate.id);
    repository.replaceState(nextState);

    return { candidate: reviewedCandidate, record, state: nextState };
  });

  server.post("/api/memory-candidates/:id/reject", async (request, reply) => {
    const state = repository.getState();
    const candidate = findCandidate(state, getCandidateId(request.params));
    if (!candidate) {
      return reply.code(404).send({ error: "Memory candidate not found." });
    }
    if (candidate.status !== "pending") {
      return reply.code(409).send({ error: "Memory candidate is not pending." });
    }

    const reviewNote = normalizeOptionalString(normalizeObject<RejectMemoryCandidatePayload>(request.body).reviewNote);
    const nextState = rejectMemoryCandidate(state, candidate.id, reviewNote);
    const reviewedCandidate = findCandidate(nextState, candidate.id);
    repository.replaceState(nextState);

    return { candidate: reviewedCandidate, state: nextState };
  });

  // M5: lightweight consolidation. De-dup near-identical confirmed records — the
  // deterministic, offline-safe decision lives in the pure dedupeMemoryRecords;
  // the weaker of each near-dup pair is deprecated. When a chat client is
  // available we ALSO summarize each merged cluster into a single pending
  // candidate so the human can optionally promote one clean phrasing (HITL).
  // Summarization is best-effort: any failure / no client degrades to dedup-only.
  server.post("/api/memory/consolidate", async () => {
    const state = repository.getState();
    const before = state.memoryRecords;
    const after = dedupeMemoryRecords(before);

    const clusters = collectMergedClusters(before, after);
    const deprecated = clusters.reduce((sum, cluster) => sum + cluster.losers.length, 0);

    // Drop graph edges originating from records we just deprecated, matching
    // deleteMemoryRecord's edge hygiene (otherwise the graph keeps dangling edges).
    const loserIds = new Set(clusters.flatMap((cluster) => cluster.losers.map((loser) => loser.id)));
    const prunedEdges = loserIds.size > 0
      ? state.memoryEdges.filter((edge) => !loserIds.has(edge.fromMemoryRecordId))
      : state.memoryEdges;

    let nextState: ProductState = { ...state, memoryRecords: after, memoryEdges: prunedEdges };
    if (deprecated > 0) {
      const reviewedAt = nowIso();
      // Optional LLM summaries — one pending candidate per merged cluster.
      const summaryCandidates = options.bailianChatClient
        ? await buildClusterSummaryCandidates(clusters, options.bailianChatClient, reviewedAt)
        : [];
      nextState = {
        ...nextState,
        memoryCandidates: [...summaryCandidates, ...nextState.memoryCandidates]
      };
      // Per-loser audit, matching deprecateMemoryRecord's granularity & reason text
      // (the existing closed AuditEvent union already covers memory_record_deprecated).
      for (const cluster of clusters) {
        for (const loser of cluster.losers) {
          nextState = withAuditEvent(nextState, {
            type: "memory_record_deprecated",
            label: "记忆整理：合并近重复记忆",
            detail: `${loser.text}｜与「${cluster.keeper.text}」合并`,
            severity: "warning",
            entityType: "memory_record",
            entityId: loser.id,
            createdAt: reviewedAt
          });
        }
      }
    }

    repository.replaceState(nextState);
    return { state: nextState, summary: { deprecated } };
  });
}

interface MergedCluster {
  keeper: MemoryRecord;
  losers: MemoryRecord[];
}

// Compares the pre/post dedup record lists and groups each kept record with the
// records that were deprecated in favour of it (parsed from deprecatedReason,
// which dedupeMemoryRecords writes as "记忆整理：与 <keptId> 合并").
function collectMergedClusters(before: MemoryRecord[], after: MemoryRecord[]): MergedCluster[] {
  const beforeById = new Map(before.map((record) => [record.id, record] as const));
  const afterById = new Map(after.map((record) => [record.id, record] as const));
  const losersByKeeper = new Map<string, MemoryRecord[]>();

  for (const record of after) {
    const was = beforeById.get(record.id);
    const newlyDeprecated = record.status === "deprecated" && was?.status === "confirmed";
    if (!newlyDeprecated) {
      continue;
    }
    const keptId = parseConsolidationKeeperId(record.deprecatedReason);
    if (!keptId || !afterById.has(keptId)) {
      continue;
    }
    const group = losersByKeeper.get(keptId) ?? [];
    group.push(record);
    losersByKeeper.set(keptId, group);
  }

  return Array.from(losersByKeeper.entries())
    .map(([keptId, losers]) => ({ keeper: afterById.get(keptId)!, losers }))
    .filter((cluster) => cluster.keeper);
}

function parseConsolidationKeeperId(reason: string | undefined): string | undefined {
  const match = reason?.match(/与\s+(\S+)\s+合并/);
  return match?.[1];
}

// Best-effort: ask the model for one concise consolidated phrasing per cluster,
// wrapped as a pending candidate (scored via withMemoryCandidateReview) so it
// goes through the same HITL approve/reject controls. Any failure is swallowed —
// consolidation must still succeed as dedup-only.
async function buildClusterSummaryCandidates(
  clusters: MergedCluster[],
  chatClient: BailianChatClient,
  createdAt: string
): Promise<MemoryCandidate[]> {
  const candidates: MemoryCandidate[] = [];
  for (const cluster of clusters) {
    const phrasings = [cluster.keeper.text, ...cluster.losers.map((loser) => loser.text)];
    try {
      const summary = (
        await chatClient.complete({
          messages: [
            {
              role: "system",
              content:
                "你在整理一个人的长期记忆。把下面几条意思相近的记忆，合并成一条最准确、最凝练的中文陈述。" +
                "铁律：必须保留其中最具体的可操作锚点——具体数字/阈值、可触发的条件或机制（形如「当X则Y」「因为A所以B」「不是A而是B」）、可证伪的判断；" +
                "宁可长一点也不要为了简洁把这些具体锚点概括成空泛的大道理或修辞。只输出这一条陈述本身，不要解释。"
            },
            {
              role: "user",
              content: phrasings.map((text, index) => `${index + 1}. ${text}`).join("\n")
            }
          ],
          temperature: 0.3
        })
      ).trim();
      if (!summary) {
        continue;
      }
      candidates.push(
        withMemoryCandidateReview({
          id: makeId("memory-candidate"),
          text: summary,
          status: "pending",
          sourceType: cluster.keeper.sourceType,
          sourceId: cluster.keeper.sourceId,
          evidenceQuote: cluster.keeper.evidenceQuote,
          reason: "记忆整理：由多条相近记忆概括而成，待用户确认是否替换。",
          sensitivity: cluster.keeper.sensitivity ?? "normal",
          // Inherit the keeper's importance so approving the summary keeps显著性 (the
          // keeper is the cluster's strongest, so this is the cluster max).
          ...(cluster.keeper.importance != null ? { importance: cluster.keeper.importance } : {}),
          createdAt
        })
      );
    } catch (error) {
      console.warn(
        JSON.stringify({
          event: "memory_consolidate_summary_failed",
          error: error instanceof Error ? error.message : String(error)
        })
      );
    }
  }
  return candidates;
}

// M3c: embed the candidate text for semantic recall. Fail-safe — returns undefined
// when there's no client, the call throws, or the model returns an empty vector, so
// approve always succeeds (it just degrades to keyword retrieval for that record).
async function embedCandidateText(
  text: string,
  embeddingClient: BailianEmbeddingClient | undefined
): Promise<number[] | undefined> {
  if (!embeddingClient) {
    return undefined;
  }
  try {
    const vectors = await embeddingClient.embed([text]);
    const vector = vectors[0];
    return Array.isArray(vector) && vector.length > 0 ? vector : undefined;
  } catch (error) {
    console.warn(
      JSON.stringify({ event: "memory_approve_embed_failed", error: error instanceof Error ? error.message : String(error) })
    );
    return undefined;
  }
}

function normalizeObject<T>(value: unknown): Partial<T> {
  return value && typeof value === "object" ? (value as Partial<T>) : {};
}

function normalizeOptionalString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function getCandidateId(params: unknown) {
  return normalizeObject<{ id: string }>(params).id;
}

function findCandidate(state: ProductState, candidateId: unknown): MemoryCandidate | undefined {
  return typeof candidateId === "string"
    ? state.memoryCandidates.find((candidate) => candidate.id === candidateId)
    : undefined;
}
