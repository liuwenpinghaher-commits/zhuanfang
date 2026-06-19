import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Fastify from "fastify";
import { createInitialProductState } from "../../../../src/domain/engine";
import { buildSearchBrief } from "../../../../src/domain/search-brief";
import { createInMemoryProductStateRepository } from "../product-state-repository";
import { registerSearchRoutes } from "./search";

// ---------------------------------------------------------------------------
// Fake search provider — injects deterministic SearchBriefInput without I/O
// ---------------------------------------------------------------------------
const fakeBailianSearchClient = {
  async createSearchBrief(input: { topic: string }) {
    return {
      topic: input.topic,
      provider: "local-demo" as const,
      status: "ready" as const,
      summary: `Fake summary for ${input.topic}`,
      facts: [`Fact about ${input.topic}`],
      controversies: ["Fake controversy"],
      opposingViews: ["Fake opposing view"],
      interviewAngles: ["Fake interview angle"],
      discussionTopics: ["Fake discussion topic"],
      sourceAngles: ["Fake source angle"],
      sources: [
        {
          id: "fake-source-1",
          title: `${input.topic}: source`,
          url: "https://example.local/fake",
          publisher: "FakePublisher",
          publishedAt: "2026-06-19T00:00:00.000Z",
          snippet: "Fake snippet",
          relevanceScore: 0.9,
          usage: "interview-context" as const,
        },
      ],
    };
  },
};

describe("search routes", () => {
  const app = Fastify();
  const initialState = createInitialProductState();
  const stateRepo = createInMemoryProductStateRepository(initialState);

  beforeAll(async () => {
    await registerSearchRoutes(app, stateRepo, {
      bailianSearchClient: fakeBailianSearchClient,
    });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  // -------------------------------------------------------------------------
  // POST /api/search/briefs — basic sanity (existing behaviour)
  // -------------------------------------------------------------------------
  describe("POST /api/search/briefs", () => {
    it("creates a brief with local-demo provider and returns 200", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/search/briefs",
        payload: { topic: "AI 商业化", providerId: "local-demo" },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.brief).toBeDefined();
      expect(body.brief.id).toBeTruthy();
      expect(body.brief.topic).toBe("AI 商业化");
    });
  });

  // -------------------------------------------------------------------------
  // POST /api/search/briefs/:id/refresh
  // -------------------------------------------------------------------------
  describe("POST /api/search/briefs/:id/refresh", () => {
    it("returns 200, updates brief content, and preserves id + tracked", async () => {
      // First: plant a brief in state via the domain helper so we have a known id
      const state = stateRepo.getState();
      const { brief: existing, nextState } = buildSearchBrief(state, "外部调研主题");
      // Manually mark as tracked
      const briefWithTracked = { ...existing, tracked: true };
      stateRepo.replaceState({
        ...nextState,
        searchBriefs: [briefWithTracked, ...nextState.searchBriefs.slice(1)],
      });

      const res = await app.inject({
        method: "POST",
        url: `/api/search/briefs/${existing.id}/refresh`,
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.brief).toBeDefined();
      // id must be preserved
      expect(body.brief.id).toBe(existing.id);
      // tracked must be preserved
      expect(body.brief.tracked).toBe(true);
      // appliedToSessionIds must survive refresh
      expect(Array.isArray(body.brief.appliedToSessionIds)).toBe(true);
      // content refreshed — summary must exist
      expect(body.brief.summary).toBeTruthy();
      // state returned
      expect(body.state).toBeDefined();
    });

    it("returns 404 when brief id does not exist", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/search/briefs/nonexistent-id/refresh",
      });
      expect(res.statusCode).toBe(404);
    });
  });

  // -------------------------------------------------------------------------
  // POST /api/search/briefs/:id/track
  // -------------------------------------------------------------------------
  describe("POST /api/search/briefs/:id/track", () => {
    it("sets tracked=true and persists", async () => {
      // Ensure a brief exists (use the first one in state)
      const state = stateRepo.getState();
      const brief = state.searchBriefs[0];
      expect(brief).toBeDefined();

      const res = await app.inject({
        method: "POST",
        url: `/api/search/briefs/${brief.id}/track`,
        payload: { tracked: true },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.brief.tracked).toBe(true);
      expect(body.brief.id).toBe(brief.id);

      // persisted in state
      const persisted = stateRepo.getState().searchBriefs.find((b) => b.id === brief.id);
      expect(persisted?.tracked).toBe(true);
    });

    it("sets tracked=false and persists", async () => {
      const state = stateRepo.getState();
      const brief = state.searchBriefs[0];

      const res = await app.inject({
        method: "POST",
        url: `/api/search/briefs/${brief.id}/track`,
        payload: { tracked: false },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.brief.tracked).toBe(false);
    });

    it("returns 404 when brief id does not exist", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/search/briefs/no-such-id/track",
        payload: { tracked: true },
      });
      expect(res.statusCode).toBe(404);
    });
  });
});
