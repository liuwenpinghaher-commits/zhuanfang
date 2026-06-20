import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Fastify from "fastify";
import { createInitialProductState } from "../../../../src/domain/engine";
import { createInMemoryProductStateRepository } from "../product-state-repository";
import { registerMemoryRecordRoutes } from "./memory-records";
import { registerMemoryCandidateRoutes } from "./memory-candidates";
import { registerAssetRoutes } from "./assets";

describe("new zhuanfang routes", () => {
  const app = Fastify();
  const stateRepo = createInMemoryProductStateRepository(createInitialProductState());

  beforeAll(async () => {
    await registerMemoryRecordRoutes(app, stateRepo);
    await registerMemoryCandidateRoutes(app, stateRepo);
    await registerAssetRoutes(app, stateRepo);
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  describe("memory-records", () => {
    it("PATCH /api/memory-records/:id returns 404 for missing record", async () => {
      const res = await app.inject({
        method: "PATCH",
        url: "/api/memory-records/nonexistent",
        payload: { text: "updated" },
      });
      expect(res.statusCode).toBe(404);
    });

    it("DELETE /api/memory-records/:id returns 404 for missing record", async () => {
      const res = await app.inject({
        method: "DELETE",
        url: "/api/memory-records/nonexistent",
      });
      expect(res.statusCode).toBe(404);
    });

    it("POST /api/memory-records/:id/deprecate returns 404 for missing record", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/memory-records/nonexistent/deprecate",
      });
      expect(res.statusCode).toBe(404);
    });
  });

  describe("memory-candidates", () => {
    it("PATCH /api/memory-candidates/:id returns 404 for missing candidate", async () => {
      const res = await app.inject({
        method: "PATCH",
        url: "/api/memory-candidates/nonexistent",
        payload: { text: "updated" },
      });
      expect(res.statusCode).toBe(404);
    });

    it("POST /api/memory-candidates/:id/approve returns 404 for missing candidate", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/memory-candidates/nonexistent/approve",
      });
      expect(res.statusCode).toBe(404);
    });

    it("POST /api/memory-candidates/:id/reject returns 404 for missing candidate", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/memory-candidates/nonexistent/reject",
      });
      expect(res.statusCode).toBe(404);
    });
  });

  describe("assets", () => {
    // Asset status mutations (points/questions/debts/decision-review) are local-first
    // reducers persisted via PUT /api/state — they have no dedicated routes. Only the
    // authoritative "confirm decision" write is server-side.
    it("POST /api/assets/decisions/:id/confirm confirms a decision", async () => {
      const state = stateRepo.getState();
      const decisionId = state.decisions[0].id;
      const res = await app.inject({
        method: "POST",
        url: `/api/assets/decisions/${decisionId}/confirm`,
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.asset.confirmationStatus).toBe("用户确认");
    });

    it("POST /api/assets/decisions/:id/confirm returns 404 for missing decision", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/assets/decisions/nonexistent/confirm",
      });
      expect(res.statusCode).toBe(404);
    });
  });
});
