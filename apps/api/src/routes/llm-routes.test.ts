/**
 * LLM-route honesty tests（真实性重构后）.
 *
 * TWO halves:
 *
 * 1. No-key exposure: build the server with no provider clients (env: {}).
 *    For every LLM-backed route, drive it and assert 503 + 明确的"未配置"错误
 *    （确定性兜底已剔除——不能用就暴露，不再返回模板数据冒充）。
 *
 * 2. LLM path: inject minimal mock clients. Drive the same routes and assert
 *    the response is structurally correct (LLM path used)；LLM 返回坏 JSON 时
 *    如实 502 且不落任何变更（原子失败）。
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
// HALF 1: No-key exposure — LLM routes return 503（未配置即不可用，如实暴露）
// -----------------------------------------------------------------------

describe("No-key exposure (env: {})", () => {
  it("/api/corpus/insights → 503 语料分析 LLM 未配置（不再回落关键词模板分析）", async () => {
    const server = buildNoKeyServer();
    await server.ready();

    const resp = await inject(server, "POST", "/api/corpus/insights", {
      title: "测试语料",
      content: "主持人：你好。\n被访者：你好，很高兴参加这次专访。"
    });

    expect(resp.statusCode).toBe(503);
    const body = JSON.parse(resp.payload) as { error: string };
    expect(body.error).toContain("未配置");
    await server.close();
  });

  it("/api/reviews → 503 复盘 LLM 未配置（不再返回确定性复盘数据）", async () => {
    const server = buildNoKeyServer();
    await server.ready();

    const resp = await inject(server, "GET", "/api/reviews");

    expect(resp.statusCode).toBe(503);
    const body = JSON.parse(resp.payload) as { error: string };
    expect(body.error).toContain("未配置");
    await server.close();
  });

  it("/api/import/documents → 503 导入分析 LLM 未配置（不再静默 0 候选照常导入）", async () => {
    const server = buildNoKeyServer();
    await server.ready();

    const resp = await inject(server, "POST", "/api/import/documents", {
      title: "测试文档",
      content: "这是一些测试内容，用来验证无 LLM key 时的暴露行为。"
    });

    expect(resp.statusCode).toBe(503);
    const body = JSON.parse(resp.payload) as { error: string };
    expect(body.error).toContain("未配置");
    await server.close();
  });

  it("/api/interview-sessions/:id/end → 503 归档 LLM 未配置，会话保持 active 可重试", async () => {
    const server = buildNoKeyServer();
    await server.ready();

    const sessionId = await setupSessionWithTurn(server);
    const resp = await inject(server, "POST", `/api/interview-sessions/${sessionId}/end`);

    expect(resp.statusCode).toBe(503);
    const body = JSON.parse(resp.payload) as { error: string };
    expect(body.error).toContain("未配置");

    // 会话必须保持可重试：未被 finalize、未被归档。
    const after = await inject(server, "GET", `/api/interview-sessions/${sessionId}`);
    expect(after.statusCode).toBe(200);
    const { session } = JSON.parse(after.payload) as { session: { status: string } };
    expect(session.status).not.toBe("completed");
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

  it("/end: finalize timeout keeps extract checkpoint; retry skips extract", async () => {
    const extractJson = JSON.stringify({
      candidates: [{ text: "判断力稀缺", evidenceQuote: "这是我的第一条回答", sensitivity: "normal" }]
    });
    const finalizeJson = JSON.stringify({
      summary: "这次对话推进了判断力这个题目",
      keyQuote: "这是我的第一条回答，用于触发 finalize",
      saidTrack: ["讲了判断力"],
      learnedTrack: ["需要把问题定义清楚"],
      nextQuestions: ["下一次怎么验证？"],
      points: [],
      questions: [],
      decisions: [],
      debts: [],
      themes: []
    });
    let extractCalls = 0;
    let finalizeCalls = 0;
    const mockChatClient: BailianChatClient = {
      async complete(input) {
        const sys = input.messages.find((m) => m.role === "system")?.content ?? "";
        if (sys.includes("长期记住")) {
          extractCalls += 1;
          return extractJson;
        }
        finalizeCalls += 1;
        if (finalizeCalls === 1) throw new Error("The operation was aborted due to timeout");
        return finalizeJson;
      }
    };
    const server = buildApiServer({ env: {}, bailianChatClient: mockChatClient });
    await server.ready();
    const sessionId = await setupSessionWithTurn(server);

    const first = await inject(server, "POST", `/api/interview-sessions/${sessionId}/end`);
    expect(first.statusCode).toBe(502);
    expect(extractCalls).toBe(1);
    expect(finalizeCalls).toBe(1);

    const mid = await inject(server, "GET", `/api/interview-sessions/${sessionId}`);
    const midSession = JSON.parse(mid.payload).session as { status: string; endCheckpoint?: { extractCandidates: unknown[] } };
    expect(midSession.status).toBe("active");
    expect(midSession.endCheckpoint?.extractCandidates?.length).toBe(1);

    const second = await inject(server, "POST", `/api/interview-sessions/${sessionId}/end`);
    expect(second.statusCode).toBe(200);
    expect(extractCalls).toBe(1);
    expect(JSON.parse(second.payload).session.status).toBe("completed");
    expect(JSON.parse(second.payload).session.endCheckpoint).toBeUndefined();
    await server.close();
  });

  it("/api/import/documents: LLM returns malformed JSON → 502 且本次不导入（原子失败）", async () => {
    // Mock LLM returns garbage → extractCandidateMemories throws → 路由如实 502，导入不落库
    const server = buildMockLlmServer("totally not json garbage !!!");
    await server.ready();

    const resp = await inject(server, "POST", "/api/import/documents", {
      title: "测试文档",
      content: "这是测试内容"
    });

    expect(resp.statusCode).toBe(502);
    const body = JSON.parse(resp.payload) as { error: string };
    expect(body.error).toContain("记忆抽取失败");
    // 原子失败：state 里不得出现这条 importSource
    const stateResp = await inject(server, "GET", "/api/state");
    const state = JSON.parse(stateResp.payload) as { importSources: Array<{ title: string }> };
    expect(state.importSources.some((s) => s.title === "测试文档")).toBe(false);
    await server.close();
  });

  it("/api/corpus/insights: LLM returns malformed JSON → 502 语料分析失败（不再回落确定性分析）", async () => {
    const server = buildMockLlmServer("this is not json at all");
    await server.ready();

    const resp = await inject(server, "POST", "/api/corpus/insights", {
      title: "样本",
      content: "主持人：你好。\n被访者：你好。"
    });

    expect(resp.statusCode).toBe(502);
    const body = JSON.parse(resp.payload) as { error: string };
    expect(body.error).toContain("语料分析失败");
    await server.close();
  });
});
