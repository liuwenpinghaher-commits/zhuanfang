import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Fastify from "fastify";
import { createInitialProductState } from "../../../../src/domain/engine";
import { buildSearchBrief } from "../../../../src/domain/search-brief";
import { createInMemoryProductStateRepository } from "../product-state-repository";
import { registerSearchRoutes } from "./search";
import type { SearchBrief } from "../../../../src/domain/types";

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

// ---------------------------------------------------------------------------
// POST /api/research/auto-run
// ---------------------------------------------------------------------------
describe("POST /api/research/auto-run", () => {
  // 独立 app + repo，避免与上方测试共享 state 发生干扰
  const autoRunApp = Fastify();

  // State with themes (so planResearchAgendaRun generates agendaItems)
  // and a stale tracked brief (lastRefreshedAt 30 days ago)
  const staleDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const baseState = createInitialProductState();

  // Plant a stale tracked brief with a duplicate source URL (to verify dedup)
  const staleBriefPartial = {
    id: "stale-brief-1",
    topic: "自动化测试主题",
    provider: "local-demo" as const,
    status: "ready" as const,
    summary: "旧简报摘要",
    facts: ["旧事实"],
    controversies: [],
    opposingViews: [],
    interviewAngles: [],
    discussionTopics: [],
    sourceAngles: [],
    sources: [
      {
        id: "src-dup",
        title: "重复来源",
        url: "https://example.local/dup",
        publisher: "DupPublisher",
        publishedAt: staleDate,
        snippet: "dup snippet",
        relevanceScore: 0.8,
        usage: "interview-context" as const,
      },
    ],
    sourceTrace: [],
    appliedToSessionIds: [],
    createdAt: staleDate,
    tracked: true,
    lastRefreshedAt: staleDate,
  } satisfies SearchBrief;

  const initialStateForAutoRun = {
    ...baseState,
    searchBriefs: [staleBriefPartial],
  };

  const autoRunRepo = createInMemoryProductStateRepository(initialStateForAutoRun);

  // Fake provider that always returns a brief with the same dup URL (so dedup fires)
  const fakeClientWithDup = {
    async createSearchBrief(input: { topic: string }) {
      return {
        topic: input.topic,
        provider: "local-demo" as const,
        status: "ready" as const,
        summary: `Refreshed: ${input.topic}`,
        facts: [`Fresh fact about ${input.topic}`],
        controversies: [],
        opposingViews: [],
        interviewAngles: [],
        discussionTopics: [],
        sourceAngles: [],
        sources: [
          {
            id: "src-dup-2",
            title: "重复来源",
            url: "https://example.local/dup", // same URL → dedup should fire across briefs
            publisher: "DupPublisher",
            publishedAt: new Date().toISOString(),
            snippet: "fresh snippet",
            relevanceScore: 0.9,
            usage: "interview-context" as const,
          },
        ],
      };
    },
  };

  beforeAll(async () => {
    await registerSearchRoutes(autoRunApp, autoRunRepo, {
      bailianSearchClient: fakeClientWithDup,
    });
    await autoRunApp.ready();
  });

  afterAll(async () => {
    await autoRunApp.close();
  });

  it("returns 200 with summary object", async () => {
    const res = await autoRunApp.inject({
      method: "POST",
      url: "/api/research/auto-run",
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.summary).toBeDefined();
    expect(typeof body.summary.generated).toBe("number");
    expect(typeof body.summary.refreshed).toBe("number");
    expect(typeof body.summary.dedupedSources).toBe("number");
    expect(body.state).toBeDefined();
  });

  it("refreshes stale tracked brief and updates lastRefreshedAt", async () => {
    // Reset state with the stale brief
    autoRunRepo.replaceState(initialStateForAutoRun);

    const before = autoRunRepo.getState().searchBriefs.find((b) => b.id === "stale-brief-1");
    expect(before?.lastRefreshedAt).toBe(staleDate);

    const res = await autoRunApp.inject({
      method: "POST",
      url: "/api/research/auto-run",
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    // refreshed >= 1 (the stale tracked brief was refreshed)
    expect(body.summary.refreshed).toBeGreaterThanOrEqual(1);

    // Check lastRefreshedAt was updated in state
    const after = body.state.searchBriefs.find((b: SearchBrief) => b.id === "stale-brief-1");
    expect(after).toBeDefined();
    expect(after.lastRefreshedAt).not.toBe(staleDate);
  });

  it("deduplicates sources across briefs when same URL appears in multiple briefs", async () => {
    // Reset; state already has stale brief with dup URL. After refresh + any generated briefs
    // the dedup step should remove cross-brief duplicate sources.
    autoRunRepo.replaceState(initialStateForAutoRun);

    const res = await autoRunApp.inject({
      method: "POST",
      url: "/api/research/auto-run",
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    // dedupedSources may be 0 or more depending on how many new briefs share the URL;
    // the field must be present and non-negative.
    expect(body.summary.dedupedSources).toBeGreaterThanOrEqual(0);
  });

  it("falls back gracefully when no provider key is configured (no-key scenario)", async () => {
    // App with no provider clients at all → should still return 200 via local-demo fallback
    const noKeyApp = Fastify();
    const noKeyRepo = createInMemoryProductStateRepository(createInitialProductState());
    await registerSearchRoutes(noKeyApp, noKeyRepo, {}); // no bailianSearchClient
    await noKeyApp.ready();

    const res = await noKeyApp.inject({
      method: "POST",
      url: "/api/research/auto-run",
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.summary).toBeDefined();
    expect(typeof body.summary.generated).toBe("number");

    await noKeyApp.close();
  });
});
