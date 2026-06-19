import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Fastify from "fastify";
import { createInitialProductState } from "../../../../src/domain/engine";
import { createInMemoryProductStateRepository } from "../product-state-repository";
import { registerMemoryRecordRoutes } from "./memory-records";
import { registerMemoryCandidateRoutes } from "./memory-candidates";
import { registerMemoryCorrectionRoutes } from "./memory-corrections";
import { registerNoteRoutes } from "./notes";
import { registerAssetRoutes } from "./assets";
import { registerPlaybookPatchRoutes } from "./playbook-patches";
import { registerGeneratedArtifactRoutes } from "./generated-artifacts";

describe("new zhuanfang routes", () => {
  const app = Fastify();
  const stateRepo = createInMemoryProductStateRepository(createInitialProductState());

  beforeAll(async () => {
    await registerMemoryRecordRoutes(app, stateRepo);
    await registerMemoryCandidateRoutes(app, stateRepo);
    await registerMemoryCorrectionRoutes(app, stateRepo);
    await registerNoteRoutes(app, stateRepo);
    await registerAssetRoutes(app, stateRepo);
    await registerPlaybookPatchRoutes(app, stateRepo);
    await registerGeneratedArtifactRoutes(app, stateRepo);
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  describe("memory-corrections", () => {
    it("POST /api/memory-corrections creates a correction", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/memory-corrections",
        payload: { text: "corrected memory" },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.correction).toBeDefined();
      expect(body.correction.text).toBe("corrected memory");
    });

    it("POST /api/memory-corrections rejects empty text", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/memory-corrections",
        payload: { text: "" },
      });
      expect(res.statusCode).toBe(422);
    });
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

  describe("notes", () => {
    it("POST /api/notes/:id/questions returns 404 for missing note", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/notes/nonexistent/questions",
        payload: { nextQuestionIndex: 0 },
      });
      expect(res.statusCode).toBe(404);
    });

    it("POST /api/notes/:id/questions returns 422 for invalid index", async () => {
      const state = stateRepo.getState();
      const noteId = state.notes[0].id;
      const res = await app.inject({
        method: "POST",
        url: `/api/notes/${noteId}/questions`,
        payload: { nextQuestionIndex: 999 },
      });
      expect(res.statusCode).toBe(422);
    });

    it("POST /api/notes/:id/questions creates a question from a note", async () => {
      const state = stateRepo.getState();
      const noteId = state.notes[0].id;
      const res = await app.inject({
        method: "POST",
        url: `/api/notes/${noteId}/questions`,
        payload: { nextQuestionIndex: 0 },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.question).toBeDefined();
      expect(body.question.id).toContain("question-from-note");
    });

    it("POST /api/notes/:id/feedback submits feedback", async () => {
      const state = stateRepo.getState();
      const noteId = state.notes[0].id;
      const res = await app.inject({
        method: "POST",
        url: `/api/notes/${noteId}/feedback`,
        payload: {
          tags: ["went-deep", "summary-accurate"],
          mostValuableQuestion: "What is the real cost?",
        },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.note).toBeDefined();
      expect(body.note.feedback).toBeDefined();
    });
  });

  describe("assets", () => {
    it("PATCH /api/assets/points/:id/status updates point status", async () => {
      const state = stateRepo.getState();
      const pointId = state.points[0].id;
      const res = await app.inject({
        method: "PATCH",
        url: `/api/assets/points/${pointId}/status`,
        payload: { status: "稳定观点" },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.asset.status).toBe("稳定观点");
    });

    it("PATCH /api/assets/questions/:id/status updates question status", async () => {
      const state = stateRepo.getState();
      const questionId = state.questions[0].id;
      const res = await app.inject({
        method: "PATCH",
        url: `/api/assets/questions/${questionId}/status`,
        payload: { status: "阶段性回答" },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.asset.status).toBe("阶段性回答");
    });

    it("PATCH /api/assets/debts/:id/status updates knowledge debt status", async () => {
      const state = stateRepo.getState();
      const debtId = state.debts[0].id;
      const res = await app.inject({
        method: "PATCH",
        url: `/api/assets/debts/${debtId}/status`,
        payload: { status: "能复述" },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.asset.status).toBe("能复述");
    });

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

    it("PATCH /api/assets/decisions/:id/status updates decision review status", async () => {
      const state = stateRepo.getState();
      const decisionId = state.decisions[0].id;
      const res = await app.inject({
        method: "PATCH",
        url: `/api/assets/decisions/${decisionId}/status`,
        payload: { status: "已复盘" },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.asset.status).toBe("已复盘");
    });

    it("PATCH /api/assets/points/:id/status returns 404 for missing point", async () => {
      const res = await app.inject({
        method: "PATCH",
        url: "/api/assets/points/nonexistent/status",
        payload: { status: "稳定观点" },
      });
      expect(res.statusCode).toBe(404);
    });
  });

  describe("playbook-patches", () => {
    it("POST /api/playbook-patches/:id/apply returns 404 for missing patch", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/playbook-patches/nonexistent/apply",
      });
      expect(res.statusCode).toBe(404);
    });

    it("POST /api/playbook-patches/:id/revert returns 404 for missing patch", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/playbook-patches/nonexistent/revert",
      });
      expect(res.statusCode).toBe(404);
    });
  });

  describe("generated-artifacts", () => {
    it("POST /api/generated-artifacts/cleanup runs deduplication", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/generated-artifacts/cleanup",
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.removed).toBeDefined();
    });
  });
});
