import { describe, it, expect, vi } from "vitest";
import Fastify from "fastify";
import { registerMemoryCandidateRoutes } from "./memory-candidates";
import { createInMemoryProductStateRepository } from "../product-state-repository";
import { createEmptyProductState } from "../../../../src/domain/engine";
import type { MemoryCandidate, MemoryRecord, ProductState } from "../../../../src/domain/types";
import { createLlmBudget } from "../llm-budget";
import { createFakeChatClient } from "../test-helpers/fake-llm-clients";

function confirmedRecord(partial: Partial<MemoryRecord> & { id: string; text: string }): MemoryRecord {
  return {
    status: "confirmed",
    sourceType: "interview_session",
    sourceId: "s1",
    evidenceQuote: "",
    createdAt: "2026-06-20T00:00:00.000Z",
    updatedAt: "2026-06-20T00:00:00.000Z",
    ...partial
  } as MemoryRecord;
}

// Task 5 (M3c): approving a candidate must enrich the new MemoryRecord with a
// semantic embedding (computed in the route via the embeddingClient) and an
// importance score, so the long-term store is cosine-searchable. Without a
// client it must degrade gracefully (no embedding, no crash).

function seedPendingCandidate(overrides: Partial<MemoryCandidate> = {}): ProductState {
  const candidate: MemoryCandidate = {
    id: "mc-approve-001",
    text: "用户目前带领一支 12 人的团队。",
    status: "pending",
    sourceType: "interview_session",
    sourceId: "session-x",
    evidenceQuote: "我现在带的是 12 个人",
    reason: "专访原话，待用户确认写入长期记忆",
    sensitivity: "normal",
    reviewScore: 72,
    reviewSignals: ["有明确证据"],
    createdAt: "2026-06-10T00:00:00.000Z",
    ...overrides
  };
  return { ...createEmptyProductState(), memoryCandidates: [candidate] };
}

describe("memory-candidates approve (M3c embedding enrichment)", () => {
  it("with embeddingClient: the new MemoryRecord carries the embedding vector and an importance", async () => {
    // N-01-embedding:mock 向量须是合法 1024 维——approve 经 replaceState → normalizeProductState →
    // clampPersistableEnums(optFloatArray)持久化,非 1024 维会被钳成 NONE(防坏维度 wedge HNSW)。
    const fixedVector = Array.from({ length: 1024 }, (_, i) => (i % 4 + 1) * 0.11);
    const embed = vi.fn(async (texts: string[]) => texts.map(() => fixedVector));
    const repo = createInMemoryProductStateRepository(seedPendingCandidate());
    const server = Fastify({ logger: false });
    await registerMemoryCandidateRoutes(server, repo, { embeddingClient: { embed } });

    const res = await server.inject({
      method: "POST",
      url: "/api/memory-candidates/mc-approve-001/approve"
    });
    expect(res.statusCode).toBe(200);

    const record = res.json().record;
    expect(record).toBeDefined();
    // The embedding must be the vector returned by the injected client (proves
    // the route actually embedded the candidate text, not a placeholder).
    expect(record.embedding).toEqual(fixedVector);
    // importance derived from reviewScore (72 → ~7), must be a 1..10 number.
    expect(typeof record.importance).toBe("number");
    expect(record.importance).toBeGreaterThanOrEqual(1);
    expect(record.importance).toBeLessThanOrEqual(10);

    // It must be embedded exactly with the candidate's text.
    expect(embed).toHaveBeenCalledTimes(1);
    expect(embed.mock.calls[0][0]).toEqual(["用户目前带领一支 12 人的团队。"]);

    // And it must be persisted into the repository state, not just returned.
    const persisted = repo.getState().memoryRecords.find((r) => r.sourceCandidateId === "mc-approve-001");
    expect(persisted?.embedding).toEqual(fixedVector);

    await server.close();
  });

  it("without embeddingClient: record is created with embeddingReady:false signal", async () => {
    const repo = createInMemoryProductStateRepository(seedPendingCandidate());
    const server = Fastify({ logger: false });
    await registerMemoryCandidateRoutes(server, repo, {}); // no embeddingClient

    const res = await server.inject({
      method: "POST",
      url: "/api/memory-candidates/mc-approve-001/approve"
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.record).toBeDefined();
    expect(body.record.embedding).toBeUndefined();
    expect(body.embeddingReady).toBe(false);
    expect(body.vectorRecallAvailable).toBe(false);
    expect(typeof body.warning).toBe("string");
    // importance backfill from reviewScore still applies (pure, client-independent).
    expect(typeof body.record.importance).toBe("number");

    await server.close();
  });

  it("R6-5:approve 的 embed 输入截断到 MAX_EMBED_CHARS(2000)——与 PATCH 重嵌同口径,向量空间一致", async () => {
    const embed = vi.fn(async (texts: string[]) => texts.map(() => [0.1]));
    const repo = createInMemoryProductStateRepository(seedPendingCandidate({ text: "记".repeat(5000) }));
    const server = Fastify({ logger: false });
    await registerMemoryCandidateRoutes(server, repo, { embeddingClient: { embed } });
    const res = await server.inject({ method: "POST", url: "/api/memory-candidates/mc-approve-001/approve" });
    expect(res.statusCode).toBe(200);
    expect(embed).toHaveBeenCalledTimes(1);
    // 此前 approve 全文 embed、PATCH 截断 2000 → 同一记忆两次向量漂移;R6-5 统一到 MAX_EMBED_CHARS。
    expect(embed.mock.calls[0][0][0].length).toBe(2000);
    await server.close();
  });

  it("C-P1-06: embedding client present but fails → 502 fail-closed, candidate stays pending", async () => {
    const embed = vi.fn(async () => {
      throw new Error("embedding service down");
    });
    const repo = createInMemoryProductStateRepository(seedPendingCandidate());
    const server = Fastify({ logger: false });
    await registerMemoryCandidateRoutes(server, repo, { embeddingClient: { embed } });

    const res = await server.inject({
      method: "POST",
      url: "/api/memory-candidates/mc-approve-001/approve"
    });
    expect(res.statusCode).toBe(502);
    const body = res.json();
    expect(body.embeddingReady).toBe(false);
    expect(body.vectorRecallAvailable).toBe(false);
    expect(String(body.error)).toMatch(/语义向量不可用|嵌入/);
    // Not confirmed into long-term store
    expect(repo.getState().memoryRecords.find((r) => r.sourceCandidateId === "mc-approve-001")).toBeUndefined();
    expect(repo.getState().memoryCandidates.find((c) => c.id === "mc-approve-001")?.status).toBe("pending");

    await server.close();
  });
});

// M5: lightweight consolidation — POST /api/memory/consolidate de-dups
// near-identical confirmed records (deprecate the weaker) and persists the
// result, and summarizes each merged cluster into a pending HITL candidate.
// 真实性重构:摘要是整合契约的一部分——有合并簇但 LLM 不可用/预算耗尽/失败时,
// 整个 consolidate 原子失败(503/429/502,未持久化任何去重变更),不再静默降级为"仅去重"。
function seedNearDuplicateRecords(): ProductState {
  return {
    ...createEmptyProductState(),
    memoryRecords: [
      confirmedRecord({ id: "rec-keep", text: "用户偏好先小范围验证再放权", importance: 8, embedding: [0.1, 0.2, 0.3] }),
      confirmedRecord({ id: "rec-weak", text: "用户喜欢先验证再授权", importance: 3, embedding: [0.1, 0.2, 0.31] })
    ]
  };
}

describe("memory consolidate (M5 lightweight consolidation)", () => {
  it("deprecates the weaker of a near-duplicate pair and reports the count (成功路径注入假 LLM)", async () => {
    const repo = createInMemoryProductStateRepository(seedNearDuplicateRecords());
    const server = Fastify({ logger: false });
    // 有合并簇时摘要 LLM 是必选能力——注入确定性假 client 走真实摘要路径。
    await registerMemoryCandidateRoutes(server, repo, { bailianChatClient: createFakeChatClient() });

    const res = await server.inject({ method: "POST", url: "/api/memory/consolidate" });
    expect(res.statusCode).toBe(200);

    const body = res.json();
    expect(body.summary.deprecated).toBe(1);

    // The weaker record is deprecated in the persisted state; the stronger stays.
    const persisted = repo.getState();
    expect(persisted.memoryRecords.find((r) => r.id === "rec-weak")?.status).toBe("deprecated");
    expect(persisted.memoryRecords.find((r) => r.id === "rec-keep")?.status).toBe("confirmed");
    expect(body.state.memoryRecords.find((r: MemoryRecord) => r.id === "rec-weak")?.status).toBe("deprecated");

    // 成功时每个合并簇必有一条摘要候选（吞错跳簇已删除）。
    const candidates = persisted.memoryCandidates;
    expect(candidates).toHaveLength(1);
    expect(candidates[0].status).toBe("pending");
    expect(candidates[0].text).toBe("当系统失败时会如实暴露而不是伪装成功（整合后的记忆表述）。");

    await server.close();
  });

  it("no near-duplicates → deprecates nothing", async () => {
    const repo = createInMemoryProductStateRepository({
      ...createEmptyProductState(),
      memoryRecords: [
        confirmedRecord({ id: "a", text: "喜欢喝咖啡" }),
        confirmedRecord({ id: "b", text: "讨厌开会" })
      ]
    });
    const server = Fastify({ logger: false });
    await registerMemoryCandidateRoutes(server, repo, {});

    const res = await server.inject({ method: "POST", url: "/api/memory/consolidate" });
    expect(res.statusCode).toBe(200);
    expect(res.json().summary.deprecated).toBe(0);
    expect(repo.getState().memoryRecords.every((r) => r.status === "confirmed")).toBe(true);

    await server.close();
  });

  // 真实性重构:有合并簇但无 chatClient → 503,原子失败(不再静默降级为"仅去重")。
  it("有合并簇但无 chatClient → 503,未持久化任何去重变更", async () => {
    const repo = createInMemoryProductStateRepository(seedNearDuplicateRecords());
    const server = Fastify({ logger: false });
    await registerMemoryCandidateRoutes(server, repo, {}); // no bailianChatClient

    const res = await server.inject({ method: "POST", url: "/api/memory/consolidate" });
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toContain("未配置");
    // 原子失败:去重未持久化,两条记录仍 confirmed,无摘要候选。
    const persisted = repo.getState();
    expect(persisted.memoryRecords.find((r) => r.id === "rec-weak")?.status).toBe("confirmed");
    expect(persisted.memoryRecords.find((r) => r.id === "rec-keep")?.status).toBe("confirmed");
    expect(persisted.memoryCandidates).toHaveLength(0);

    await server.close();
  });

  it("with a chat client: emits a pending summary candidate for the merged cluster (HITL)", async () => {
    const complete = vi.fn(async () => "用户偏好先小范围验证后再逐步授权放权。");
    const repo = createInMemoryProductStateRepository(seedNearDuplicateRecords());
    const server = Fastify({ logger: false });
    await registerMemoryCandidateRoutes(server, repo, { bailianChatClient: { complete } });

    const res = await server.inject({ method: "POST", url: "/api/memory/consolidate" });
    expect(res.statusCode).toBe(200);
    expect(res.json().summary.deprecated).toBe(1);

    expect(complete).toHaveBeenCalledTimes(1);
    const candidates = repo.getState().memoryCandidates;
    // A single pending summary candidate is queued for human review.
    expect(candidates.length).toBe(1);
    expect(candidates[0].status).toBe("pending");
    expect(candidates[0].text).toContain("授权");

    await server.close();
  });

  // 真实性重构:摘要 LLM 运行时失败 → 502,整个 consolidate 原子失败(去重也不落库)。
  it("摘要 LLM 失败 → 502,原子失败未持久化任何去重变更", async () => {
    const complete = vi.fn(async () => {
      throw new Error("chat service down");
    });
    const repo = createInMemoryProductStateRepository(seedNearDuplicateRecords());
    const server = Fastify({ logger: false });
    await registerMemoryCandidateRoutes(server, repo, { bailianChatClient: { complete } });

    const res = await server.inject({ method: "POST", url: "/api/memory/consolidate" });
    expect(res.statusCode).toBe(502);
    expect(res.json().error).toContain("记忆整合失败");
    // 原子失败:rec-weak 未被 deprecate,无摘要候选。
    expect(repo.getState().memoryRecords.find((r) => r.id === "rec-weak")?.status).toBe("confirmed");
    expect(repo.getState().memoryCandidates).toHaveLength(0);

    await server.close();
  });

  // ME-P1-02: clusters beyond MAX_SUMMARY_CLUSTERS=4 restore losers (not permanent deprecate).
  it("ME-P1-02: 超出摘要 cap 的簇 loser 恢复 confirmed，不永久 deprecate", async () => {
    // 5 near-dup pairs → 5 clusters; only 4 get summaries; 5th loser must stay confirmed.
    // Use legal 1024-d embeddings so clampPersistableEnums keeps vectors (short dims strip).
    const axis = (i: number, noise = 0) =>
      Array.from({ length: 1024 }, (_, d) => (d === i * 20 ? 1 + noise : 0.001 * ((d + i) % 7)));
    const records: MemoryRecord[] = [];
    for (let i = 0; i < 5; i++) {
      const base = `主题簇${i}用户偏好先小范围验证再放权后扩大试点路径独立内容`;
      records.push(
        confirmedRecord({
          id: `keep-${i}`,
          text: base,
          importance: 9,
          embedding: axis(i, 0)
        }),
        confirmedRecord({
          id: `weak-${i}`,
          text: `${base}略作改写`,
          importance: 2,
          embedding: axis(i, 0.02)
        })
      );
    }
    const repo = createInMemoryProductStateRepository({
      ...createEmptyProductState(),
      memoryRecords: records
    });
    const complete = vi.fn(async () => "整合后的表述");
    const server = Fastify({ logger: false });
    await registerMemoryCandidateRoutes(server, repo, {
      bailianChatClient: { complete },
      llmBudget: createLlmBudget({ maxCallsPerSession: 20 })
    });

    const res = await server.inject({ method: "POST", url: "/api/memory/consolidate" });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { summary: { deprecated: number } };
    // At most 4 clusters summarized (one loser each under our pairing).
    expect(body.summary.deprecated).toBeLessThanOrEqual(4);
    expect(complete.mock.calls.length).toBeLessThanOrEqual(4);

    const persisted = repo.getState().memoryRecords;
    const weakStatuses = [0, 1, 2, 3, 4].map((i) => persisted.find((r) => r.id === `weak-${i}`)?.status);
    const confirmedWeaks = weakStatuses.filter((s) => s === "confirmed").length;
    const deprecatedWeaks = weakStatuses.filter((s) => s === "deprecated").length;
    expect(deprecatedWeaks).toBeLessThanOrEqual(4);
    if (deprecatedWeaks === 4) {
      expect(confirmedWeaks).toBeGreaterThanOrEqual(1);
    }

    // Summary candidates point at keepers for merge-on-approve (ME-P1-03).
    const summaries = repo.getState().memoryCandidates.filter((c) => c.status === "pending");
    for (const c of summaries) {
      expect(c.suggestedUpdate).toBe("update");
      expect(c.similarToRecordId).toBeTruthy();
    }

    await server.close();
  });

  // 真实性重构:摘要预算耗尽 → 429,同样原子失败。
  it("摘要预算耗尽 → 429,原子失败未持久化任何去重变更", async () => {
    const repo = createInMemoryProductStateRepository(seedNearDuplicateRecords());
    const exhaustedBudget = createLlmBudget({ maxCallsPerSession: 1 });
    exhaustedBudget.tryConsume("memory_consolidate"); // 消耗唯一配额
    const server = Fastify({ logger: false });
    await registerMemoryCandidateRoutes(server, repo, {
      bailianChatClient: createFakeChatClient(),
      llmBudget: exhaustedBudget
    });

    const res = await server.inject({ method: "POST", url: "/api/memory/consolidate" });
    expect(res.statusCode).toBe(429);
    expect(res.json().error).toContain("预算已用尽");
    expect(repo.getState().memoryRecords.find((r) => r.id === "rec-weak")?.status).toBe("confirmed");
    expect(repo.getState().memoryCandidates).toHaveLength(0);

    await server.close();
  });
});
