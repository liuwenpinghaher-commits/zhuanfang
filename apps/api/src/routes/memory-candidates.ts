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
import type { ProductStateRepository } from "../product-state-repository"
import { replaceStateDurable } from "../product-state-repository";
import { createLlmBudget, type LlmBudget } from "../llm-budget";
import { MAX_EMBED_CHARS } from "./knowledge";
import { runStateCommand } from "../state-command";
import type { WriteGate } from "../server";
import type { BailianChatClient, BailianEmbeddingClient } from "../providers/bailian";

interface RejectMemoryCandidatePayload {
  reviewNote?: unknown;
}

interface UpdateMemoryCandidatePayload {
  text?: unknown;
}

// P1-05: cap a single candidate text field (same budget as a confirmed memory record).
const MEMORY_CANDIDATE_TEXT_MAX_CHARS = 16 * 1024;

// 审计修复(P1-6 + 回归审查 R3-B):consolidate 摘要循环此前绕过 LLM 预算且无上限——预算硬闸被
// 单点击穿,且 N×60s 串行 LLM 是超写锁上限致"强放-覆盖"的确定性入口。单轮封顶到写锁上限内:
// 4 簇 × 每簇最坏 60s(bailian 默认超时)= 240s < WRITE_SLOT_MAX_HOLD_MS(360s),确保 consolidate
// 本身不破线被强放。超出的簇本轮不摘要(dedup 本身已完成、loser 已 deprecate,摘要是可选 HITL)。
const MAX_SUMMARY_CLUSTERS = 4;

interface MemoryCandidateRouteOptions {
  embeddingClient?: BailianEmbeddingClient;
  /** M5: when present, a consolidation pass may summarize a merged cluster into a
   * pending HITL candidate. Absent → consolidation just de-dups (offline-safe). */
  bailianChatClient?: BailianChatClient;
  /** 审计修复(P1-6):consolidate 摘要须过共享预算(memory_consolidate 桶,滑窗恢复)。 */
  llmBudget?: LlmBudget;
  /** R3:PATCH /:id 与 POST /:id/reject 换轨 CAS 后,commit 经此写门与在途长持锁写互斥
   *  (D3 不变量,见 state-command.ts);approve/consolidate 不换轨(临界区有外部 IO),仍整段持锁。 */
  writeGate?: WriteGate;
}

export async function registerMemoryCandidateRoutes(
  server: FastifyInstance,
  repository: ProductStateRepository,
  options: MemoryCandidateRouteOptions = {}
) {
  // R3 试点:候选文本编辑是纯同步小 RMW,换轨 runStateCommand CAS(payload 校验在 CAS 外,
  // 实体查找/pending 校验在 mutate 内基于最新态重算)。
  server.patch("/api/memory-candidates/:id", async (request, reply) => {
    const text = normalizeOptionalString(normalizeObject<UpdateMemoryCandidatePayload>(request.body).text);
    if (!text) {
      return reply.code(422).send({ error: "Memory candidate text is required." });
    }
    if (text.length > MEMORY_CANDIDATE_TEXT_MAX_CHARS) {
      return reply.code(422).send({ error: `Memory candidate text exceeds the ${MEMORY_CANDIDATE_TEXT_MAX_CHARS}-character limit.` });
    }

    const candidateId = getCandidateId(request.params);
    let failure: { code: number; error: string } | null = null;
    let updatedCandidate: MemoryCandidate | undefined;
    const persisted = await runStateCommand(
      repository,
      (state) => {
        failure = null;
        updatedCandidate = undefined;
        const candidate = findCandidate(state, candidateId);
        if (!candidate) {
          failure = { code: 404, error: "Memory candidate not found." };
          return null;
        }
        if (candidate.status !== "pending") {
          failure = { code: 409, error: "Memory candidate is not pending." };
          return null;
        }
        const nextState = updateMemoryCandidateText(state, candidate.id, text);
        updatedCandidate = findCandidate(nextState, candidate.id);
        return nextState;
      },
      { writeGate: options.writeGate, label: `command:memory-candidate-patch:${candidateId ?? "unknown"}` }
    );
    if (!persisted) {
      const f = failure ?? { code: 404, error: "Memory candidate not found." };
      return reply.code(f.code).send({ error: f.error });
    }
    // state 必须是 replaceState 返回的权威态(revision 已 bump),否则客户端下一次乐观 PUT 必 409。
    return { candidate: updatedCandidate, state: persisted };
  });

  // R3 有意不换轨:approve 在读态与写态之间 await embedding(慢网络 IO 在临界区)且以读时基写回,
  // 豁免写锁前须先按 R6-6/PATCH 记忆记录的模式改造(embed 挪到锁外 + mutate 内基于最新态重算)。
  // 低频 HITL 操作,收益小、改造是新的行为面,留在全局写锁内(整段持锁 = 读写窗口独占,现状安全)。
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
    // store is cosine-searchable. Domain approve stays pure; route owns the client.
    // C-P1-06: when an embedding client is configured, embed failure is fail-closed (502)
    // so "confirmed" never silently means "not HNSW-searchable". When no client is
    // configured (keyword-only product config), approve succeeds with embeddingReady:false.
    const embedOutcome = await embedCandidateText(candidate.text, options.embeddingClient);
    if (options.embeddingClient && embedOutcome.status !== "ok") {
      const embedError =
        embedOutcome.status === "failed" ? embedOutcome.error : "嵌入服务不可用";
      return reply.code(502).send({
        error: `记忆确认失败（语义向量不可用）：${embedError}。本条未确认，请重试。`,
        embeddingReady: false,
        vectorRecallAvailable: false
      });
    }
    const embedding = embedOutcome.status === "ok" ? embedOutcome.embedding : undefined;
    // ME-P1-01: UI offers merge vs add; default merge preserves approved candidate text.
    const body =
      request.body && typeof request.body === "object"
        ? (request.body as Record<string, unknown>)
        : {};
    const mode =
      body.mode === "add" || body.mode === "merge" ? (body.mode as "add" | "merge") : "merge";
    const nextState = approveMemoryCandidate(state, candidate.id, {
      ...(embedding ? { embedding, embeddingProvider: options.embeddingClient?.providerId } : {}),
      // Consolidation summaries carry the keeper's importance; honor it over the reviewScore band.
      ...(candidate.importance != null ? { importance: candidate.importance } : {}),
      mode
    });
    const reviewedCandidate = findCandidate(nextState, candidate.id);
    // Merge path may update an existing record without sourceCandidateId=this candidate.
    const record =
      nextState.memoryRecords.find((item) => item.sourceCandidateId === candidate.id) ??
      (candidate.similarToRecordId
        ? nextState.memoryRecords.find((item) => item.id === candidate.similarToRecordId)
        : undefined) ??
      nextState.memoryRecords.find((item) => item.text === candidate.text);
    const persisted = /*durable*/await replaceStateDurable(repository, nextState);
    const embeddingReady = Boolean(embedding && embedding.length > 0);

    return {
      candidate: reviewedCandidate,
      record,
      state: persisted,
      embeddingReady,
      vectorRecallAvailable: embeddingReady,
      ...(embeddingReady
        ? {}
        : {
            warning:
              "已确认记忆，但当前未配置嵌入模型：跨会话向量召回不可用，仅关键词/子串路径可命中。"
          })
    };
  });

  // R3 试点:候选拒绝(pending→rejected)是纯同步小 RMW,换轨 CAS;并发双 reject/与 approve
  // 竞争同一候选 = 后到者在 mutate 重算时看到 status 已流转 → 确定性 409。
  server.post("/api/memory-candidates/:id/reject", async (request, reply) => {
    const candidateId = getCandidateId(request.params);
    const reviewNote = normalizeOptionalString(normalizeObject<RejectMemoryCandidatePayload>(request.body).reviewNote);
    let failure: { code: number; error: string } | null = null;
    let reviewedCandidate: MemoryCandidate | undefined;
    const persisted = await runStateCommand(
      repository,
      (state) => {
        failure = null;
        reviewedCandidate = undefined;
        const candidate = findCandidate(state, candidateId);
        if (!candidate) {
          failure = { code: 404, error: "Memory candidate not found." };
          return null;
        }
        if (candidate.status !== "pending") {
          failure = { code: 409, error: "Memory candidate is not pending." };
          return null;
        }
        const nextState = rejectMemoryCandidate(state, candidate.id, reviewNote);
        reviewedCandidate = findCandidate(nextState, candidate.id);
        return nextState;
      },
      { writeGate: options.writeGate, label: `command:memory-candidate-reject:${candidateId ?? "unknown"}` }
    );
    if (!persisted) {
      const f = failure ?? { code: 404, error: "Memory candidate not found." };
      return reply.code(f.code).send({ error: f.error });
    }
    return { candidate: reviewedCandidate, state: persisted };
  });

  // M5: lightweight consolidation. De-dup near-identical confirmed records — the
  // deterministic decision lives in the pure dedupeMemoryRecords; the weaker of
  // each near-dup pair is deprecated. Each merged cluster is then summarized by
  // the LLM into a single pending candidate so the human can optionally promote
  // one clean phrasing (HITL). 摘要是整合契约的一部分：LLM 不可用/失败时整个
  // consolidate 原子失败（503/429/502，未持久化任何变更），不再静默降级为"仅去重"。
  // R3 有意不换轨:读态与写态之间有最多 4×60s 的串行 LLM(慢 IO 在临界区)且全量记忆宽事务,
  // 本该串行——留在全局写锁内(路径 /api/memory/ 与候选前缀不同,天然不在豁免名单)。
  server.post("/api/memory/consolidate", async (_request, reply) => {
    const state = repository.getState();
    const before = state.memoryRecords;
    const after = dedupeMemoryRecords(before);
    const allClusters = collectMergedClusters(before, after);
    // ME-P1-02: only permanently deprecate losers in clusters that receive a summary path.
    // Unsummarized clusters (beyond MAX_SUMMARY_CLUSTERS) restore losers to confirmed.
    const boundedClusters = allClusters.slice(0, MAX_SUMMARY_CLUSTERS);
    const deferredLoserIds = new Set(
      allClusters.slice(MAX_SUMMARY_CLUSTERS).flatMap((cluster) => cluster.losers.map((l) => l.id))
    );
    const beforeById = new Map(before.map((r) => [r.id, r] as const));
    const afterRecovered =
      deferredLoserIds.size > 0
        ? after.map((record) => {
            if (!deferredLoserIds.has(record.id)) return record;
            const original = beforeById.get(record.id);
            return original ? { ...original } : record;
          })
        : after;

    const clusters = boundedClusters;
    const deprecated = clusters.reduce((sum, cluster) => sum + cluster.losers.length, 0);
    if (deprecated > 0 && !options.bailianChatClient) {
      return reply.code(503).send({ error: "记忆整合摘要 LLM 未配置（缺少 DASHSCOPE_API_KEY），无法整合。" });
    }

    // M1: theme attribution now lives inline on each record (record.relatedThemeIds),
    // replacing state.memoryEdges. dedupeMemoryRecords deprecates (not deletes) losers, so
    // strip the deprecated losers' theme links here — matching the old edge hygiene that
    // dropped memoryEdges from deprecated records (keeps them out of about_theme aggregation).
    const loserIds = new Set(clusters.flatMap((cluster) => cluster.losers.map((loser) => loser.id)));
    const prunedRecords = loserIds.size > 0
      ? afterRecovered.map((record) => (loserIds.has(record.id) ? { ...record, relatedThemeIds: [] } : record))
      : afterRecovered;

    let nextState: ProductState = { ...state, memoryRecords: prunedRecords };
    if (deprecated > 0) {
      const reviewedAt = nowIso();
      // LLM summaries — one pending candidate per merged cluster. 失败原子中止（尚未持久化）。
      const budget = options.llmBudget ?? createLlmBudget();
      let summaryCandidates: MemoryCandidate[];
      try {
        summaryCandidates = await buildClusterSummaryCandidates(clusters, options.bailianChatClient!, reviewedAt, budget);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(JSON.stringify({ event: "llm_failed", capability: "memory_consolidate", error: message }));
        const code = message.includes("预算已用尽") ? 429 : 502;
        return reply.code(code).send({ error: `记忆整合失败：${message}。未做任何变更，请稍后重试。` });
      }
      // ME-P1-03: summary candidates point at keeper so approve merge can replace keeper text.
      nextState = {
        ...nextState,
        memoryCandidates: [
          ...summaryCandidates.map((c, i) => ({
            ...c,
            similarToRecordId: clusters[i]?.keeper.id,
            suggestedUpdate: "update" as const
          })),
          ...nextState.memoryCandidates
        ]
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

    const persisted = /*durable*/await replaceStateDurable(repository, nextState);
    return { state: persisted, summary: { deprecated } };
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

// Ask the model for one concise consolidated phrasing per cluster, wrapped as a
// pending candidate (scored via withMemoryCandidateReview) so it goes through the
// same HITL approve/reject controls. 失败/预算耗尽向上抛——由 consolidate 路由
// 原子中止并如实 5xx/429，不再吞错降级为"仅去重"。
async function buildClusterSummaryCandidates(
  clusters: MergedCluster[],
  chatClient: BailianChatClient,
  createdAt: string,
  budget: LlmBudget
): Promise<MemoryCandidate[]> {
  const candidates: MemoryCandidate[] = [];
  // 审计修复(P1-6):单轮封顶 + 逐 cluster 过预算——此前无 tryConsume 无上限,预算硬闸被
  // 单点击穿,且 N×60s 串行 LLM 是超写锁持有上限的确定性入口。超出部分下轮 consolidate 再做。
  const bounded = clusters.slice(0, MAX_SUMMARY_CLUSTERS);
  if (clusters.length > bounded.length) {
    console.warn(JSON.stringify({ event: "memory_consolidate_clusters_capped", total: clusters.length, processed: bounded.length }));
  }
  for (const cluster of bounded) {
    if (!budget.tryConsume("memory_consolidate")) {
      console.warn(JSON.stringify({ event: "llm_budget_exceeded", capability: "memory_consolidate" }));
      throw new Error("本时段 LLM 预算已用尽（记忆整合摘要）");
    }
    const phrasings = [cluster.keeper.text, ...cluster.losers.map((loser) => loser.text)];
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
      throw new Error("记忆整合摘要 LLM 返回空结果");
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
  }
  return candidates;
}

type EmbedCandidateOutcome =
  | { status: "ok"; embedding: number[] }
  | { status: "unavailable" }
  | { status: "failed"; error: string };

// M3c: embed candidate text for semantic recall. Distinguishes "no client configured"
// from "client failed" so approve can fail-closed when vectors were expected.
async function embedCandidateText(
  text: string,
  embeddingClient: BailianEmbeddingClient | undefined
): Promise<EmbedCandidateOutcome> {
  if (!embeddingClient) {
    return { status: "unavailable" };
  }
  try {
    const vectors = await embeddingClient.embed([text.slice(0, MAX_EMBED_CHARS)]);
    const vector = vectors[0];
    if (Array.isArray(vector) && vector.length > 0) {
      return { status: "ok", embedding: vector };
    }
    return { status: "failed", error: "嵌入模型返回空向量" };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(JSON.stringify({ event: "memory_approve_embed_failed", error: message }));
    return { status: "failed", error: message };
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
