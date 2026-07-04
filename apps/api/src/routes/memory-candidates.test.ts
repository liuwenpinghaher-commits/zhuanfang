import { describe, it, expect, vi } from "vitest";
import Fastify from "fastify";
import { registerMemoryCandidateRoutes } from "./memory-candidates";
import { createInMemoryProductStateRepository } from "../product-state-repository";
import { createEmptyProductState } from "../../../../src/domain/engine";
import type { MemoryCandidate, MemoryRecord, ProductState } from "../../../../src/domain/types";

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
    const fixedVector = [0.11, 0.22, 0.33, 0.44];
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

  it("without embeddingClient: record is created with no embedding and does not crash", async () => {
    const repo = createInMemoryProductStateRepository(seedPendingCandidate());
    const server = Fastify({ logger: false });
    await registerMemoryCandidateRoutes(server, repo, {}); // no embeddingClient

    const res = await server.inject({
      method: "POST",
      url: "/api/memory-candidates/mc-approve-001/approve"
    });
    expect(res.statusCode).toBe(200);
    const record = res.json().record;
    expect(record).toBeDefined();
    expect(record.embedding).toBeUndefined();
    // importance backfill from reviewScore still applies (pure, client-independent).
    expect(typeof record.importance).toBe("number");

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

  it("embedding failure degrades to no embedding (record still created)", async () => {
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
    expect(res.statusCode).toBe(200);
    const record = res.json().record;
    expect(record).toBeDefined();
    expect(record.embedding).toBeUndefined();

    await server.close();
  });
});

// M5: lightweight consolidation — POST /api/memory/consolidate de-dups
// near-identical confirmed records (deprecate the weaker) and persists the
// result. With a chat client it may additionally emit a pending summary
// candidate for HITL; without one it just de-dups (offline-safe).
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
  it("deprecates the weaker of a near-duplicate pair and reports the count", async () => {
    const repo = createInMemoryProductStateRepository(seedNearDuplicateRecords());
    const server = Fastify({ logger: false });
    await registerMemoryCandidateRoutes(server, repo, {});

    const res = await server.inject({ method: "POST", url: "/api/memory/consolidate" });
    expect(res.statusCode).toBe(200);

    const body = res.json();
    expect(body.summary.deprecated).toBe(1);

    // The weaker record is deprecated in the persisted state; the stronger stays.
    const persisted = repo.getState();
    expect(persisted.memoryRecords.find((r) => r.id === "rec-weak")?.status).toBe("deprecated");
    expect(persisted.memoryRecords.find((r) => r.id === "rec-keep")?.status).toBe("confirmed");
    expect(body.state.memoryRecords.find((r: MemoryRecord) => r.id === "rec-weak")?.status).toBe("deprecated");

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

  it("without a chat client: de-dups but emits no summary candidate", async () => {
    const repo = createInMemoryProductStateRepository(seedNearDuplicateRecords());
    const server = Fastify({ logger: false });
    await registerMemoryCandidateRoutes(server, repo, {}); // no bailianChatClient

    const res = await server.inject({ method: "POST", url: "/api/memory/consolidate" });
    expect(res.statusCode).toBe(200);
    expect(res.json().summary.deprecated).toBe(1);
    // No LLM → no new pending candidate is created.
    expect(repo.getState().memoryCandidates.length).toBe(0);

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

  it("chat client failure degrades to dedup-only (no crash, no candidate)", async () => {
    const complete = vi.fn(async () => {
      throw new Error("chat service down");
    });
    const repo = createInMemoryProductStateRepository(seedNearDuplicateRecords());
    const server = Fastify({ logger: false });
    await registerMemoryCandidateRoutes(server, repo, { bailianChatClient: { complete } });

    const res = await server.inject({ method: "POST", url: "/api/memory/consolidate" });
    expect(res.statusCode).toBe(200);
    expect(res.json().summary.deprecated).toBe(1);
    expect(repo.getState().memoryRecords.find((r) => r.id === "rec-weak")?.status).toBe("deprecated");
    // Summary failed → no candidate, but consolidation still persisted.
    expect(repo.getState().memoryCandidates.length).toBe(0);

    await server.close();
  });
});
