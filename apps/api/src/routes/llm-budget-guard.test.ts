/**
 * P1-13: llm-budget 守卫覆盖全部 LLM 入口
 *
 * 真实性重构后：budget 耗尽时端点不再"跳过 LLM 走本地 fallback 返回 200"，
 * 而是跳过 LLM 并如实返回 429（预算已用尽）。守卫的核心不变量仍然是：
 * 预算耗尽时 LLM 绝不能被调用。
 *
 * 测试的端点：
 *   - POST /api/corpus/insights         (analyzeCorpusWithLlm)
 *   - GET  /api/reviews                 (buildReviewsWithLlm)
 *   - POST /api/import/documents        (extractCandidateMemories)
 *   - POST /api/search/briefs           (enrichBriefInput)
 *   - POST /api/podcast/episodes        (generatePodcastScript — note path)
 */
import { describe, it, expect, vi } from "vitest";
import Fastify from "fastify";
import { createLlmBudget } from "../llm-budget";
import { createInMemoryProductStateRepository } from "../product-state-repository";
import { createInitialProductState } from "../../../../src/domain/engine";
import { registerCorpusRoutes } from "./corpus";
import { registerReviewRoutes } from "./reviews";
import { registerImportRoutes } from "./import";
import { registerSearchRoutes } from "./search";
import { registerPodcastRoutes } from "./podcast";

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** A mock BailianChatClient that tracks call count and returns valid JSON. */
function makeMockChatClient(response: string) {
  const complete = vi.fn(async () => response);
  const client = { complete };
  return { client, complete };
}

/** A budget already exhausted: create with max=1, then consume the single slot. */
function makeExhaustedBudget() {
  const budget = createLlmBudget({ maxCallsPerSession: 1 });
  budget.tryConsume("system"); // exhaust the one available slot
  return budget;
}

// ---------------------------------------------------------------------------
// POST /api/corpus/insights — budget guard
// ---------------------------------------------------------------------------

describe("llm-budget guard: POST /api/corpus/insights", () => {
  it("budget exhausted → LLM is NOT called, 429 预算已用尽（不再回落确定性分析）", async () => {
    const { client, complete } = makeMockChatClient(
      JSON.stringify({
        dimensions: [{ name: "追问", score: 5, finding: "好", example: "x", recommendedAction: "keep" }],
        improvementPlan: [{ title: "t", rationale: "r", action: "a", expectedEngineChange: "e", evidence: "ev" }],
        patch: { title: "p", description: "d", rules: [], impact: "low" }
      })
    );

    const repo = createInMemoryProductStateRepository();
    const server = Fastify({ logger: false });
    const budget = makeExhaustedBudget();

    await registerCorpusRoutes(server, repo, {
      bailianChatClient: client as any,
      llmBudget: budget
    });
    await server.ready();

    const resp = await server.inject({
      method: "POST",
      url: "/api/corpus/insights",
      payload: { title: "测试", content: "主持人：你好。\n被访者：你好。" }
    });

    expect(resp.statusCode).toBe(429);
    expect((resp.json() as { error: string }).error).toContain("预算已用尽");
    // 核心不变量：预算耗尽时 LLM 绝不能被调用
    expect(complete).not.toHaveBeenCalled();

    await server.close();
  });

  it("budget available → LLM IS called", async () => {
    const { client, complete } = makeMockChatClient(
      JSON.stringify({
        dimensions: [{ name: "节奏", score: 4, finding: "ok", example: "y", recommendedAction: "keep" }],
        improvementPlan: [],
        patch: { title: "p2", description: "d2", rules: [], impact: "medium" }
      })
    );

    const repo = createInMemoryProductStateRepository();
    const server = Fastify({ logger: false });
    const budget = createLlmBudget({ maxCallsPerSession: 10 });

    await registerCorpusRoutes(server, repo, {
      bailianChatClient: client as any,
      llmBudget: budget
    });
    await server.ready();

    const resp = await server.inject({
      method: "POST",
      url: "/api/corpus/insights",
      payload: { title: "测试", content: "主持人：你好。\n被访者：你好。" }
    });

    expect(resp.statusCode).toBe(200);
    expect(complete).toHaveBeenCalledTimes(1);

    await server.close();
  });
});

// ---------------------------------------------------------------------------
// GET /api/reviews — budget guard
// ---------------------------------------------------------------------------

describe("llm-budget guard: GET /api/reviews", () => {
  it("reviews budget exhausted → LLM is NOT called, 429（独立于 system 桶）", async () => {
    const { client, complete } = makeMockChatClient(
      JSON.stringify({ monthly: { topTheme: "x" }, yearly: {} })
    );

    const repo = createInMemoryProductStateRepository();
    const server = Fastify({ logger: false });
    // RV-P1-01: reviews uses its own capability key, not "system".
    const budget = createLlmBudget({ maxCallsPerSession: 1 });
    budget.tryConsume("reviews");

    await registerReviewRoutes(server, repo, {
      bailianChatClient: client as any,
      llmBudget: budget
    });
    await server.ready();

    const resp = await server.inject({ method: "GET", url: "/api/reviews" });

    expect(resp.statusCode).toBe(429);
    expect((resp.json() as { error: string }).error).toContain("预算已用尽");
    expect(complete).not.toHaveBeenCalled();

    await server.close();
  });

  it("system 桶耗尽不影响 reviews（预算隔离）", async () => {
    const { client, complete } = makeMockChatClient(
      JSON.stringify({
        monthly: {
          periodLabel: "本月",
          topTheme: "x",
          progress: "p",
          stillOpen: "o",
          nextAction: "n",
          keyQuote: "q"
        },
        yearly: {
          periodLabel: "本年",
          topTheme: "y",
          progress: "p",
          stillOpen: "o",
          nextAction: "n",
          keyQuote: "q"
        },
        radar: { dimensions: [] }
      })
    );

    const repo = createInMemoryProductStateRepository();
    const server = Fastify({ logger: false });
    const budget = makeExhaustedBudget(); // exhausts "system" only

    await registerReviewRoutes(server, repo, {
      bailianChatClient: client as any,
      llmBudget: budget
    });
    await server.ready();

    const resp = await server.inject({ method: "GET", url: "/api/reviews" });
    // Isolation: reviews must still be allowed when only system is exhausted.
    expect(resp.statusCode).not.toBe(429);
    if (resp.statusCode === 200) {
      expect(complete).toHaveBeenCalled();
    }

    await server.close();
  });

  // reviews 已纳入 SYSTEM_BUDGET_KEYS：HTTP 耗尽 429 → 滑窗滚动后 GET 可再成功（不再是孤立单调桶）。
  // tryConsume 层 rollover 单测在 llm-budget.test.ts；此处覆盖路由端到端恢复。
  it("reviews 滑窗：HTTP 429 后窗口滚动 → GET 可再成功且 LLM 被调用", async () => {
    const reviewsJson = JSON.stringify({
      monthly: {
        periodLabel: "本月",
        topTheme: "x",
        progress: "p",
        stillOpen: "o",
        nextAction: "n",
        keyQuote: "q"
      },
      yearly: {
        periodLabel: "本年",
        topTheme: "y",
        progress: "p",
        stillOpen: "o",
        nextAction: "n",
        keyQuote: "q"
      },
      radar: { dimensions: [] }
    });
    const { client, complete } = makeMockChatClient(reviewsJson);

    const repo = createInMemoryProductStateRepository();
    const server = Fastify({ logger: false });
    const budget = createLlmBudget({ maxCallsPerSession: 1, systemWindowMs: 20 });
    budget.tryConsume("reviews"); // exhaust within window

    await registerReviewRoutes(server, repo, {
      bailianChatClient: client as any,
      llmBudget: budget
    });
    await server.ready();

    const blocked = await server.inject({ method: "GET", url: "/api/reviews" });
    expect(blocked.statusCode).toBe(429);
    expect(complete).not.toHaveBeenCalled();

    await new Promise((r) => setTimeout(r, 30)); // let the window elapse

    const recovered = await server.inject({ method: "GET", url: "/api/reviews" });
    expect(recovered.statusCode).toBe(200);
    expect(complete).toHaveBeenCalledTimes(1);

    await server.close();
  });
});

// ---------------------------------------------------------------------------
// POST /api/import/documents — budget guard
// ---------------------------------------------------------------------------

describe("llm-budget guard: POST /api/import/documents", () => {
  it("budget exhausted → LLM is NOT called, 429 预算已用尽且本次不导入（原子失败）", async () => {
    const memoryJson = JSON.stringify({
      candidates: [
        { text: "用户注重效率", evidenceQuote: "我们要快", sensitivity: "normal" }
      ]
    });
    const { client, complete } = makeMockChatClient(memoryJson);

    const repo = createInMemoryProductStateRepository();
    const server = Fastify({ logger: false });
    const budget = makeExhaustedBudget();

    await registerImportRoutes(server, repo, {
      bailianChatClient: client as any,
      llmBudget: budget
    });
    await server.ready();

    const importSourcesBefore = repo.getState().importSources.length;
    const resp = await server.inject({
      method: "POST",
      url: "/api/import/documents",
      payload: { title: "测试文档", content: "我们要快。" }
    });

    expect(resp.statusCode).toBe(429);
    expect((resp.json() as { error: string }).error).toContain("预算已用尽");
    expect(complete).not.toHaveBeenCalled();
    // 导入是原子操作：预算被拒时不得留下"0 候选照常导入"的半成品
    expect(repo.getState().importSources.length).toBe(importSourcesBefore);

    await server.close();
  });
});

// ---------------------------------------------------------------------------
// POST /api/search/briefs — budget guard (enrichBriefInput)
// ---------------------------------------------------------------------------

describe("llm-budget guard: POST /api/search/briefs", () => {
  it("budget exhausted → enrichBriefInput LLM is NOT called, 429 预算已用尽", async () => {
    const { client, complete } = makeMockChatClient(
      JSON.stringify({ summary: "合成摘要", facts: [], controversies: [], opposingViews: [], interviewAngles: [], discussionTopics: [], sourceAngles: [] })
    );

    const repo = createInMemoryProductStateRepository();
    const server = Fastify({ logger: false });
    const budget = makeExhaustedBudget();

    // Use AnySearch mock that returns status:ready with sources so enrich path runs.
    // (local-demo is intentionally needs-review and skips LLM enrichment after honesty fix.)
    const anySearchClient = {
      createSearchBrief: async () => ({
        topic: "AI 产品",
        provider: "anysearch" as const,
        status: "ready" as const,
        summary: "raw",
        facts: ["f1"],
        controversies: [],
        opposingViews: [],
        interviewAngles: [],
        discussionTopics: [],
        sourceAngles: [],
        sources: [
          {
            id: "s1",
            title: "t",
            url: "https://example.com/1",
            publisher: "p",
            publishedAt: "2026-06-01T00:00:00.000Z",
            snippet: "snip",
            relevanceScore: 0.9,
            usage: "interview-context" as const
          }
        ]
      })
    };

    await registerSearchRoutes(server, repo, {
      bailianChatClient: client as any,
      anySearchClient: anySearchClient as any,
      llmBudget: budget
    });
    await server.ready();

    const resp = await server.inject({
      method: "POST",
      url: "/api/search/briefs",
      payload: { topic: "AI 产品", providerId: "anysearch" }
    });

    expect(resp.statusCode).toBe(429);
    expect((resp.json() as { error: string }).error).toContain("预算已用尽");
    // enrichBriefInput with chat client must NOT be called when budget exhausted
    expect(complete).not.toHaveBeenCalled();

    await server.close();
  });
});

// ---------------------------------------------------------------------------
// POST /api/podcast/episodes — budget guard (note path generatePodcastScript)
// ---------------------------------------------------------------------------

describe("llm-budget guard: POST /api/podcast/episodes", () => {
  it("budget exhausted → generatePodcastScript LLM is NOT called, 429 预算已用尽（note 路径）", async () => {
    const { client, complete } = makeMockChatClient("这是一段 LLM 生成的播客脚本");

    // 初始 state 无笔记会在预算守卫之前 422 短路——种一条笔记，让请求真正走到守卫。
    const seededState = {
      ...createInitialProductState(),
      notes: [
        {
          id: "note-budget-1",
          sessionId: "se_budget_1",
          title: "测试笔记",
          summary: "用于播客预算守卫测试的笔记摘要。",
          keyQuote: "我在测试里说过这句话。",
          saidTrack: ["谈了预算守卫"],
          learnedTrack: ["预算耗尽必须如实 429"],
          nextQuestions: [],
          createdAt: "2026-06-01T00:00:00.000Z"
        }
      ]
    };
    const repo = createInMemoryProductStateRepository(seededState);
    const server = Fastify({ logger: false });
    const budget = makeExhaustedBudget();

    await registerPodcastRoutes(server, repo, {
      bailianChatClient: client as any,
      llmBudget: budget
    });
    await server.ready();

    const resp = await server.inject({
      method: "POST",
      url: "/api/podcast/episodes",
      payload: { sourceType: "note" }
    });

    expect(resp.statusCode).toBe(429);
    expect((resp.json() as { error: string }).error).toContain("预算已用尽");
    expect(complete).not.toHaveBeenCalled();
    // 429 时不得留下半成品 episode
    expect(repo.getState().podcastEpisodes.length).toBe(seededState.podcastEpisodes.length);

    await server.close();
  });
});
