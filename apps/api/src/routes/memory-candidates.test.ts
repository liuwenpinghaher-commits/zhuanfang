import { describe, it, expect, vi } from "vitest";
import Fastify from "fastify";
import { registerMemoryCandidateRoutes } from "./memory-candidates";
import { createInMemoryProductStateRepository } from "../product-state-repository";
import { createEmptyProductState } from "../../../../src/domain/engine";
import type { MemoryCandidate, ProductState } from "../../../../src/domain/types";

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
