/**
 * Route-level conflict approve discipline (realization Must-set skeptic fix).
 * Drives registerMemoryCandidateRoutes + shipped approveMemoryCandidate.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Fastify from "fastify";
import { createInitialProductState } from "../../../../src/domain/engine";
import { createInMemoryProductStateRepository } from "../product-state-repository";
import { registerMemoryCandidateRoutes } from "./memory-candidates";
import type { MemoryCandidate, ProductState } from "../../../../src/domain/types";

function pendingConflict(id: string): MemoryCandidate {
  return {
    id,
    text: "组织效率提升的结构性前提缺一不可，必须满足全部准入门槛",
    status: "pending",
    sourceType: "interview_session",
    sourceId: "s-conflict",
    evidenceQuote: "原文片段足够长可作证据",
    reason: "需确认",
    sensitivity: "normal",
    suggestedUpdate: "conflict",
    createdAt: "2026-08-01T00:00:00.000Z",
    reviewScore: 70,
    reviewSignals: ["与笔记/用户修正冲突", "不可静默确认"]
  };
}

describe("POST /api/memory-candidates/:id/approve conflict block", () => {
  const app = Fastify();
  const stateRepo = createInMemoryProductStateRepository(createInitialProductState());

  beforeAll(async () => {
    await registerMemoryCandidateRoutes(app, stateRepo);
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it("conflict is checked before embed (no 502 when embedding would fail)", async () => {
    // Production has embedding client; conflict must not be masked by embed 502.
    const failingEmbed = {
      providerId: "bailian-embed",
      async embed() {
        throw new Error("Bailian embeddings request failed: 400");
      }
    };
    const appWithEmbed = Fastify();
    const repo = createInMemoryProductStateRepository(createInitialProductState());
    await registerMemoryCandidateRoutes(appWithEmbed, repo, {
      embeddingClient: failingEmbed as never
    });
    await appWithEmbed.ready();
    try {
      repo.replaceState({
        ...createInitialProductState(),
        memoryCandidates: [pendingConflict("c_before_embed")],
        memoryCorrections: [
          {
            id: "corr_embed",
            text: "纠正：效率瓶颈不是结构性前提，也不是必须全部满足的准入门槛",
            createdAt: "2026-08-01T00:00:00.000Z"
          }
        ],
        memoryRecords: []
      });
      const res = await appWithEmbed.inject({
        method: "POST",
        url: "/api/memory-candidates/c_before_embed/approve",
        payload: { mode: "add" }
      });
      expect(res.statusCode).toBe(409);
      expect(res.json().blocked).toBe(true);
      expect(res.json().error ?? "").toMatch(/冲突|拦截/);
      expect(res.statusCode).not.toBe(502);
    } finally {
      await appWithEmbed.close();
    }
  });

  it("returns 409, does not confirm, and never claims 已确认记忆 when embedding is off", async () => {
    const seeded: ProductState = {
      ...createInitialProductState(),
      memoryCandidates: [pendingConflict("c_conflict_route")],
      memoryCorrections: [
        {
          id: "corr_route",
          text: "纠正：效率瓶颈不是结构性前提，也不是必须全部满足的准入门槛",
          createdAt: "2026-08-01T00:00:00.000Z"
        }
      ],
      memoryRecords: []
    };
    stateRepo.replaceState(seeded);

    const res = await app.inject({
      method: "POST",
      url: "/api/memory-candidates/c_conflict_route/approve",
      payload: { mode: "add" }
    });

    expect(res.statusCode).toBe(409);
    const body = res.json() as {
      error?: string;
      blocked?: boolean;
      candidate?: MemoryCandidate;
      state?: ProductState;
      warning?: string;
      embeddingReady?: boolean;
    };
    expect(body.blocked).toBe(true);
    expect(body.error ?? "").toMatch(/冲突|拦截/);
    expect(body.warning ?? "").not.toMatch(/已确认记忆/);
    expect(body.embeddingReady).toBe(false);
    expect(body.candidate?.status).toBe("pending");
    expect(body.state?.memoryRecords ?? []).toHaveLength(0);
    expect(body.state?.memoryCandidates.find((c) => c.id === "c_conflict_route")?.status).toBe("pending");
    // Durable: audit block should be present after replaceState
    expect(
      (body.state?.auditEvents ?? []).some((e) => e.type === "memory_candidate_approve_blocked")
    ).toBe(true);
  });

  it("force=true can confirm after explicit override", async () => {
    const seeded: ProductState = {
      ...createInitialProductState(),
      memoryCandidates: [pendingConflict("c_force_route")],
      memoryCorrections: [
        {
          id: "corr_force",
          text: "纠正：效率瓶颈不是结构性前提，也不是必须全部满足的准入门槛",
          createdAt: "2026-08-01T00:00:00.000Z"
        }
      ],
      memoryRecords: []
    };
    stateRepo.replaceState(seeded);

    const res = await app.inject({
      method: "POST",
      url: "/api/memory-candidates/c_force_route/approve",
      payload: { mode: "add", force: true }
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      candidate?: MemoryCandidate;
      record?: { text?: string };
      state?: ProductState;
      warning?: string;
    };
    expect(body.candidate?.status).toBe("approved");
    expect(body.record?.text).toContain("结构性前提");
    expect(body.state?.memoryRecords.some((r) => r.status === "confirmed")).toBe(true);
    // Without embed client, warning may mention 已确认记忆 — only valid after real confirm.
    if (body.warning) {
      expect(body.warning).toMatch(/已确认记忆/);
    }
  });

  it("PATCH edit re-annotates: conflict clears then approve succeeds without force", async () => {
    const seeded: ProductState = {
      ...createInitialProductState(),
      memoryCandidates: [pendingConflict("c_edit_route")],
      memoryCorrections: [
        {
          id: "corr_edit",
          text: "纠正：效率瓶颈不是结构性前提，也不是必须全部满足的准入门槛",
          createdAt: "2026-08-01T00:00:00.000Z"
        }
      ],
      memoryRecords: []
    };
    stateRepo.replaceState(seeded);

    const patch = await app.inject({
      method: "PATCH",
      url: "/api/memory-candidates/c_edit_route",
      payload: {
        text: "组织效率瓶颈在跨部门激励与决策权，而不是结构性前提缺一不可"
      }
    });
    expect(patch.statusCode).toBe(200);
    const patched = patch.json() as { candidate?: MemoryCandidate; state?: ProductState };
    expect(patched.candidate?.suggestedUpdate).not.toBe("conflict");
    expect(patched.candidate?.status).toBe("pending");

    const approve = await app.inject({
      method: "POST",
      url: "/api/memory-candidates/c_edit_route/approve",
      payload: { mode: "add" }
    });
    expect(approve.statusCode).toBe(200);
    const body = approve.json() as { candidate?: MemoryCandidate; record?: { id?: string } };
    expect(body.candidate?.status).toBe("approved");
    expect(body.record?.id).toBeTruthy();
  });
});
