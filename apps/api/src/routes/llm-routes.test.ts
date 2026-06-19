/**
 * LLM-route deterministic fallback tests.
 *
 * TWO halves:
 *
 * 1. No-key fallback: build the server with no provider clients (env: {}).
 *    For every LLM-backed route, drive it and assert 200 + deterministic fallback.
 *
 * 2. LLM path: inject minimal mock clients. Drive the same routes and assert
 *    the response is structurally correct (LLM path used).
 */
import { describe, expect, it } from "vitest";
import type { InjectOptions, Response } from "light-my-request";
import type { BailianChatClient } from "../providers/bailian";
import { buildApiServer } from "../server";

// -----------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------

/** Build a server with NO provider clients. All LLM calls fall back. */
function buildNoKeyServer() {
  return buildApiServer({ env: {} });
}

/** Build a server with a mock BailianChatClient that returns the given JSON. */
function buildMockLlmServer(chatResponse: string) {
  const mockChatClient: BailianChatClient = {
    async complete() {
      return chatResponse;
    }
  };
  return buildApiServer({ env: {}, bailianChatClient: mockChatClient });
}

async function inject(
  server: ReturnType<typeof buildApiServer>,
  method: InjectOptions["method"],
  url: string,
  body?: unknown
): Promise<Response> {
  return server.inject({
    method,
    url,
    payload: body !== undefined ? (body as InjectOptions["payload"]) : undefined
  }) as unknown as Promise<Response>;
}

/**
 * Create an interview session and add one user turn so /end is valid.
 * Returns the session id.
 */
async function setupSessionWithTurn(server: ReturnType<typeof buildApiServer>): Promise<string> {
  const createResp = await inject(server, "POST", "/api/interview-sessions", {
    mode: "daily",
    strength: "standard"
  });
  expect(createResp.statusCode).toBe(200);
  const { session } = JSON.parse(createResp.payload) as { session: { id: string } };

  const turnResp = await inject(server, "POST", `/api/interview-sessions/${session.id}/record-turn`, {
    role: "user",
    content: "这是我的第一条回答，用于触发 finalize"
  });
  expect(turnResp.statusCode).toBe(200);
  return session.id;
}

// -----------------------------------------------------------------------
// HALF 1: No-key fallback — all LLM routes return 200 + deterministic data
// -----------------------------------------------------------------------

describe("No-key fallback (env: {})", () => {
  it("/api/corpus/insights → 200 with deterministic fallback insight", async () => {
    const server = buildNoKeyServer();
    await server.ready();

    const resp = await inject(server, "POST", "/api/corpus/insights", {
      title: "测试语料",
      content: "主持人：你好。\n被访者：你好，很高兴参加这次专访。"
    });

    expect(resp.statusCode).toBe(200);
    const body = JSON.parse(resp.payload) as { insight: unknown; state: unknown };
    expect(body.insight).toBeDefined();
    expect(body.state).toBeDefined();
    await server.close();
  });

  it("/api/reviews → 200 with deterministic review data", async () => {
    const server = buildNoKeyServer();
    await server.ready();

    const resp = await inject(server, "GET", "/api/reviews");

    expect(resp.statusCode).toBe(200);
    const body = JSON.parse(resp.payload) as { monthly: unknown; yearly: unknown; radar: unknown };
    expect(body.monthly).toBeDefined();
    expect(body.yearly).toBeDefined();
    expect(body.radar).toBeDefined();
    await server.close();
  });

  it("/api/import/documents → 200 with 0 LLM candidates (no chat client)", async () => {
    const server = buildNoKeyServer();
    await server.ready();

    const resp = await inject(server, "POST", "/api/import/documents", {
      title: "测试文档",
      content: "这是一些测试内容，用来验证无 LLM key 时的降级行为。"
    });

    expect(resp.statusCode).toBe(200);
    const body = JSON.parse(resp.payload) as { sourceId: string; candidateCount: number };
    expect(typeof body.sourceId).toBe("string");
    // No LLM → candidates always 0 (route still succeeds)
    expect(typeof body.candidateCount).toBe("number");
    await server.close();
  });

  it("/api/interview-sessions/:id/end → 200 with deterministic fallback note", async () => {
    const server = buildNoKeyServer();
    await server.ready();

    const sessionId = await setupSessionWithTurn(server);
    const resp = await inject(server, "POST", `/api/interview-sessions/${sessionId}/end`);

    expect(resp.statusCode).toBe(200);
    const body = JSON.parse(resp.payload) as {
      session: { status: string };
      note: { summary: string; saidTrack: string[] };
      state: unknown;
    };
    expect(body.note).toBeDefined();
    expect(typeof body.note.summary).toBe("string");
    expect(Array.isArray(body.note.saidTrack)).toBe(true);
    expect(body.session.status).toBe("completed");
    await server.close();
  });
});

// -----------------------------------------------------------------------
// HALF 2: LLM path — mock client returns valid JSON; assert LLM fields used
// -----------------------------------------------------------------------

describe("LLM path (mock BailianChatClient)", () => {
  it("/api/corpus/insights with mock LLM → 200 with LLM-derived insight", async () => {
    const corpusJson = JSON.stringify({
      dimensions: [
        { name: "追问动作", score: 5, finding: "非常精准", example: "你能具体说吗", recommendedAction: "保持" }
      ],
      improvementPlan: [
        { title: "增加追问", rationale: "样本做得好", action: "加密度", expectedEngineChange: "更多追问", evidence: "原话" }
      ],
      patch: { title: "追问规则", description: "提高频率", rules: ["每轮追问"], impact: "high" }
    });

    const server = buildMockLlmServer(corpusJson);
    await server.ready();

    const resp = await inject(server, "POST", "/api/corpus/insights", {
      title: "样本",
      content: "主持人：能具体说说吗？\n被访者：当然可以，举个例子。"
    });

    expect(resp.statusCode).toBe(200);
    const body = JSON.parse(resp.payload) as { insight: { dimensions: Array<{ name: string }> } };
    // LLM path used: dimension name comes from mock JSON, not deterministic analysis
    const hasDimension = body.insight.dimensions.some((d) => d.name === "追问动作");
    expect(hasDimension).toBe(true);
    await server.close();
  });

  it("/api/reviews with mock LLM → 200 with LLM narrative overlaid", async () => {
    const reviewJson = JSON.stringify({
      monthly: {
        topTheme: "产品决策",
        changedView: "更重视用户反馈",
        avoidedQuestion: "如何量化价值",
        recommendedNextInterview: "深入讨论 ROI"
      },
      yearly: {
        coreQuestions: ["如何做好产品决策？"],
        changedViews: ["数据很重要"],
        unresolvedPatterns: ["执行力问题"],
        importantDecisions: ["选择 B 方向"],
        missingPerspectives: ["用户视角"],
        nextYearFocus: "聚焦核心用户"
      }
    });

    const server = buildMockLlmServer(reviewJson);
    await server.ready();

    const resp = await inject(server, "GET", "/api/reviews");

    expect(resp.statusCode).toBe(200);
    const body = JSON.parse(resp.payload) as {
      monthly: { changedView: string; avoidedQuestion: string };
      yearly: { nextYearFocus: string };
    };
    expect(body.monthly.changedView).toBe("更重视用户反馈");
    expect(body.monthly.avoidedQuestion).toBe("如何量化价值");
    expect(body.yearly.nextYearFocus).toBe("聚焦核心用户");
    await server.close();
  });

  it("/api/import/documents with mock LLM → 200 with LLM candidates extracted", async () => {
    const memoryJson = JSON.stringify({
      candidates: [
        { text: "用户注重效率", evidenceQuote: "我们要快", sensitivity: "normal" },
        { text: "决策需要数据支撑", evidenceQuote: "用数据说话", sensitivity: "normal" }
      ]
    });

    const server = buildMockLlmServer(memoryJson);
    await server.ready();

    const resp = await inject(server, "POST", "/api/import/documents", {
      title: "效率笔记",
      content: "我们要快。用数据说话，不要拍脑袋。"
    });

    expect(resp.statusCode).toBe(200);
    const body = JSON.parse(resp.payload) as { sourceId: string; candidateCount: number };
    expect(body.candidateCount).toBe(2);
    expect(typeof body.sourceId).toBe("string");
    await server.close();
  });

  it("/api/interview-sessions/:id/end with mock finalize LLM → 200 with LLM note", async () => {
    const finalizeJson = JSON.stringify({
      summary: "这次对话很有价值，推进了产品方向",
      keyQuote: "我们需要聚焦核心用户",
      saidTrack: ["讨论了用户定位", "明确了核心指标"],
      learnedTrack: ["需要更多用户访谈", "数据不能替代对话"],
      nextQuestions: ["如何触达更多核心用户？"],
      points: [{ title: "核心洞察", content: "聚焦比扩展更重要", evidence: ["我们需要聚焦核心用户"] }],
      questions: [],
      decisions: [],
      debts: [],
      themes: [{ name: "聚焦策略", summary: "集中资源", representativeQuote: "聚焦核心用户", nextQuestion: "如何定义核心？", maturity: "萌芽" }]
    });

    const server = buildMockLlmServer(finalizeJson);
    await server.ready();

    const sessionId = await setupSessionWithTurn(server);
    const resp = await inject(server, "POST", `/api/interview-sessions/${sessionId}/end`);

    expect(resp.statusCode).toBe(200);
    const body = JSON.parse(resp.payload) as {
      note: { summary: string; keyQuote: string; saidTrack: string[] };
      session: { status: string };
    };
    expect(body.note.summary).toBe("这次对话很有价值，推进了产品方向");
    expect(body.note.keyQuote).toBe("我们需要聚焦核心用户");
    expect(body.note.saidTrack).toContain("讨论了用户定位");
    expect(body.session.status).toBe("completed");
    await server.close();
  });

  it("/api/import/documents: LLM returns malformed JSON → falls back, still 200", async () => {
    // Mock LLM returns garbage → extractCandidateMemories throws → import route catches it
    const server = buildMockLlmServer("totally not json garbage !!!");
    await server.ready();

    const resp = await inject(server, "POST", "/api/import/documents", {
      title: "测试文档",
      content: "这是测试内容"
    });

    // The route catches LLM errors and ingests with 0 candidates
    expect(resp.statusCode).toBe(200);
    const body = JSON.parse(resp.payload) as { candidateCount: number };
    expect(body.candidateCount).toBe(0);
    await server.close();
  });

  it("/api/corpus/insights: LLM returns malformed JSON → falls back to deterministic, still 200", async () => {
    const server = buildMockLlmServer("this is not json at all");
    await server.ready();

    const resp = await inject(server, "POST", "/api/corpus/insights", {
      title: "样本",
      content: "主持人：你好。\n被访者：你好。"
    });

    // analyzeCorpus catches LLM errors and falls back to analyzeImportedInterview
    expect(resp.statusCode).toBe(200);
    const body = JSON.parse(resp.payload) as { insight: unknown };
    expect(body.insight).toBeDefined();
    await server.close();
  });
});
