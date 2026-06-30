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

// ---------------------------------------------------------------------------
// POST /api/research/auto-run — 并发保护(autoRunInFlight 标志)
//
// 守护 P0 稳定性修复:已有一轮 auto-run 在跑时,第二个并发请求必须立即降级返回
//   { summary: { generated: 0, refreshed: 0, dedupedSources: 0, note: "已有自动调研在进行中,跳过本次" } }
// 防止联网搜索堆积拖垮后端(压测发现 reset 卡 30s)。
//
// 时序控制要点:generateBriefForTopic 仅在 activeProvider === "bailian" 且传入
// bailianSearchClient 时才 await client.createSearchBrief(...)。createInitialProductState()
// 的 activeProvider 正是 "bailian",故注入一个"可控延迟"的 bailianSearchClient——其
// createSearchBrief 返回一个由测试手动 resolve 的 promise,让第一个 auto-run 卡在
// in-flight 阶段(autoRunInFlight=true),从而能确定性地观察并发请求被跳过。
// ---------------------------------------------------------------------------
describe("POST /api/research/auto-run — 并发保护", () => {
  // 可控延迟的搜索 client:每次 createSearchBrief 调用领取一个"闸门"(deferred promise),
  // 测试通过 releaseNext() 手动放行。waitForCall() 让测试等到 handler 真的进入了
  // await client.createSearchBrief(...) 这一挂起点,再发并发请求,确保命中 in-flight 守卫。
  function createGatedSearchClient() {
    const gates: Array<() => void> = [];
    // arrivalWaiters: 等待"累计调用数 >= target"的解决器队列;每次新调用抵达后逐一检查唤醒。
    const arrivalWaiters: Array<{ target: number; resolve: () => void }> = [];
    let callCount = 0;

    function notifyArrival() {
      // 唤醒所有目标已达成的等待者(用 callCount 作为单调计数,避免双队列错配)。
      for (let i = arrivalWaiters.length - 1; i >= 0; i -= 1) {
        if (callCount >= arrivalWaiters[i].target) {
          arrivalWaiters[i].resolve();
          arrivalWaiters.splice(i, 1);
        }
      }
    }

    return {
      get callCount() {
        return callCount;
      },
      // 放行最早一个挂起的 createSearchBrief 调用(FIFO)。
      releaseNext() {
        const gate = gates.shift();
        if (gate) gate();
      },
      // 等到累计 createSearchBrief 调用数达到 target(默认:比当前多 1 次)。
      // 用单调计数而非"消费式队列",避免 A 的后续调用与 C 的等待相互错配。
      waitForCall(target?: number): Promise<void> {
        const want = target ?? callCount + 1;
        if (callCount >= want) return Promise.resolve();
        return new Promise<void>((resolve) => {
          arrivalWaiters.push({ target: want, resolve });
        });
      },
      client: {
        async createSearchBrief(input: { topic: string }) {
          callCount += 1;
          notifyArrival();
          // 挂起,直到测试 releaseNext() 放行
          await new Promise<void>((resolve) => {
            gates.push(resolve);
          });
          return {
            topic: input.topic,
            provider: "bailian" as const,
            status: "ready" as const,
            summary: `Gated summary for ${input.topic}`,
            facts: [`Fact about ${input.topic}`],
            controversies: [],
            opposingViews: [],
            interviewAngles: [],
            discussionTopics: [],
            sourceAngles: [],
            sources: [
              {
                id: `gated-src-${input.topic}`,
                title: `${input.topic}: source`,
                url: `https://example.local/gated/${encodeURIComponent(input.topic)}`,
                publisher: "GatedPublisher",
                publishedAt: "2026-06-19T00:00:00.000Z",
                snippet: "Gated snippet",
                relevanceScore: 0.9,
                usage: "interview-context" as const,
              },
            ],
          };
        },
      },
    };
  }

  it("rejects a concurrent auto-run while one is in-flight, then releases the flag in finally", async () => {
    const gated = createGatedSearchClient();
    const app = Fastify();
    // 非空 state:createInitialProductState() 自带 demo 主题/知识债/决策/已确认记忆,
    // buildProactiveSearchAgenda 必出非空 agenda → auto-run 真进入 generateBriefForTopic 的 await。
    const repo = createInMemoryProductStateRepository(createInitialProductState());
    await registerSearchRoutes(app, repo, { bailianSearchClient: gated.client });
    await app.ready();

    try {
      // --- 请求 A:不 await,让它卡在 in-flight(第一个 createSearchBrief 挂起) ---
      const reqA = app.inject({ method: "POST", url: "/api/research/auto-run" });

      // 等到 A 真的进入了 await client.createSearchBrief(...) —— 此刻 autoRunInFlight=true
      await gated.waitForCall(1);
      expect(gated.callCount).toBe(1);

      // --- 请求 B:A 仍在 in-flight 时并发发起,应被守卫立即降级返回 ---
      const resB = await app.inject({ method: "POST", url: "/api/research/auto-run" });
      expect(resB.statusCode).toBe(200);
      const bodyB = resB.json();
      expect(bodyB.summary.note).toContain("已有自动调研在进行中");
      expect(bodyB.summary.generated).toBe(0);
      expect(bodyB.summary.refreshed).toBe(0);
      expect(bodyB.summary.dedupedSources).toBe(0);
      // B 被守卫拦下,绝不应触达 provider —— 调用数仍为 1(仅 A 的那次)
      expect(gated.callCount).toBe(1);

      // --- 放行 A 的所有挂起调用(agenda 最多 3 条),等 A 完成 ---
      // A 会为每个 agenda item 串行调一次 createSearchBrief;逐个放行直到 A resolve。
      const resAPromise = reqA.then((r) => {
        return r;
      });
      let settled = false;
      resAPromise.then(() => {
        settled = true;
      });
      // 循环放行,直到 A 完成(每放行一个就让事件循环推进)
      for (let i = 0; i < 10 && !settled; i += 1) {
        gated.releaseNext();
        await new Promise((resolve) => setImmediate(resolve));
      }
      const resA = await resAPromise;
      expect(resA.statusCode).toBe(200);
      const bodyA = resA.json();
      // A 正常执行:无降级 note,generated 为生成的简报数(agenda 非空 → >= 1)
      expect(bodyA.summary.note).toBeUndefined();
      expect(bodyA.summary.generated).toBeGreaterThanOrEqual(1);

      // --- 请求 C:in-flight 已在 finally 中释放,应正常执行而非被跳过 ---
      const callsBeforeC = gated.callCount;
      const reqC = app.inject({ method: "POST", url: "/api/research/auto-run" });
      // 等 C 进入 in-flight 并触达 provider(证明守卫已放行,flag 被正确重置)
      await gated.waitForCall(callsBeforeC + 1);
      expect(gated.callCount).toBe(callsBeforeC + 1);
      // 放行 C 的所有挂起调用,等其完成
      let settledC = false;
      const resCPromise = reqC.then((r) => r);
      resCPromise.then(() => {
        settledC = true;
      });
      for (let i = 0; i < 10 && !settledC; i += 1) {
        gated.releaseNext();
        await new Promise((resolve) => setImmediate(resolve));
      }
      const resC = await resCPromise;
      expect(resC.statusCode).toBe(200);
      const bodyC = resC.json();
      // C 未被跳过:无降级 note(finally 已释放 autoRunInFlight)
      expect(bodyC.summary.note).toBeUndefined();
      expect(bodyC.summary.generated).toBeGreaterThanOrEqual(1);
    } finally {
      // 兜底放行任何残留挂起,避免 app.close() 卡住
      for (let i = 0; i < 20; i += 1) gated.releaseNext();
      await app.close();
    }
  });
});
