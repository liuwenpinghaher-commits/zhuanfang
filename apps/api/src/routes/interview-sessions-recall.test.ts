import { describe, it, expect } from "vitest";
import Fastify from "fastify";
import { registerInterviewSessionRoutes } from "./interview-sessions";
import { createInMemoryProductStateRepository } from "../product-state-repository";
import { createFakeInterviewClient } from "../test-helpers/fake-llm-clients";

function nativeRecallRepo(
  repo: ReturnType<typeof createInMemoryProductStateRepository>,
  hooks?: {
    onMemories?: () => void;
    onTheme?: () => void;
    memories?: Array<{ id: string; text: string }>;
    failMemories?: Error;
  }
) {
  return Object.assign(repo, {
    recallThemeAssets: async () => {
      hooks?.onTheme?.();
      return { points: [] as string[], decisions: ["de_1"], questions: [] as string[], memories: [] as string[] };
    },
    recallMemoriesByVector: async () => {
      hooks?.onMemories?.();
      if (hooks?.failMemories) throw hooks.failMemories;
      return hooks?.memories ?? ([] as Array<{ id: string; text: string }>);
    },
    recallProvenanceTurns: async () => [] as Array<{ id: string; content: string; sessionId: string; role: string }>
  });
}

function seedThemeState(repo: ReturnType<typeof createInMemoryProductStateRepository>) {
  const base = repo.getState();
  repo.replaceState({
    ...base,
    themes: [
      {
        id: "th_1",
        name: "放权",
        summary: "",
        maturity: "聚焦",
        representativeQuote: "",
        appearances: 9,
        nextQuestion: "",
        updatedAt: "2026-06-27T00:00:00.000Z"
      }
    ],
    decisions: [
      {
        id: "de_1",
        title: "挂主题决策",
        decisionKind: "用户决策",
        confirmationStatus: "用户确认",
        choice: "放手让团队自己拍板",
        tradeOff: "",
        riskHypothesis: "",
        reviewAt: "",
        status: "待复盘",
        updatedAt: "2026-06-27T00:00:00.000Z",
        relatedThemeIds: ["th_1"]
      }
    ],
    memoryRecords: [
      {
        id: "me_live",
        // include topic tokens so mid-session relevance floor keeps HNSW/substring hits
        text: "【本轮可召回】放权与审批权先小范围验证再扩大",
        status: "confirmed",
        sensitivity: "normal",
        sourceType: "interview_session",
        sourceId: "s0",
        evidenceQuote: "",
        createdAt: "2026-06-01T00:00:00.000Z",
        updatedAt: "2026-06-01T00:00:00.000Z",
        embedding: [1, 0, 0]
      } as never
    ]
  });
}

describe("interview-sessions:P2b surreal 权威原生召回接线", () => {
  it("surreal 权威 repo → 创建 session 走原生图遍历召回(挂主题决策经 recallThemeAssets 召回)", async () => {
    const repo = createInMemoryProductStateRepository();
    seedThemeState(repo);
    const fakeSurreal = nativeRecallRepo(repo);
    const server = Fastify({ logger: false });
    await registerInterviewSessionRoutes(server, fakeSurreal);
    const created = (
      await server.inject({ method: "POST", url: "/api/interview-sessions", payload: { mode: "daily", topicHint: "放权" } })
    ).json();
    expect(created.session.guide.relevantMemories.join(" | ")).toContain("挂主题决策");
    await server.close();
  });

  it("非原生 repo(in-memory)→ 回落域层召回,session 正常创建(零回归)", async () => {
    const repo = createInMemoryProductStateRepository();
    const server = Fastify({ logger: false });
    await registerInterviewSessionRoutes(server, repo);
    const res = await server.inject({ method: "POST", url: "/api/interview-sessions", payload: { mode: "daily" } });
    expect(res.statusCode).toBe(200);
    await server.close();
  });
});

describe("C-P1-02/04 mid-session /turns + voice-instructions prefetch + guide persist", () => {
  it("/turns: native repo → 调用 recallMemoriesByVector 并刷新/持久化 guide", async () => {
    const repo = createInMemoryProductStateRepository();
    seedThemeState(repo);
    let vectorCalls = 0;
    const fakeSurreal = nativeRecallRepo(repo, {
      onMemories: () => {
        vectorCalls += 1;
      },
      memories: [{ id: "me_live", text: "【本轮可召回】放权与审批权先小范围验证再扩大" }]
    });
    const server = Fastify({ logger: false });
    await registerInterviewSessionRoutes(server, fakeSurreal, {
      bailianInterviewClient: createFakeInterviewClient(),
      embeddingClient: {
        providerId: "fake-emb",
        embed: async () => [[1, 0, 0]]
      } as never
    });

    const created = (
      await server.inject({ method: "POST", url: "/api/interview-sessions", payload: { mode: "daily", topicHint: "放权" } })
    ).json();
    const id = created.session.id as string;
    const createVectorCalls = vectorCalls;
    expect(createVectorCalls).toBeGreaterThan(0);

    const turnRes = await server.inject({
      method: "POST",
      url: `/api/interview-sessions/${id}/turns`,
      payload: { content: "我还是不敢把审批权交出去，放权让我焦虑" }
    });
    expect(turnRes.statusCode).toBe(200);
    // mid-session turn must invoke native vector recall again (not create-only)
    expect(vectorCalls).toBeGreaterThan(createVectorCalls);

    const body = turnRes.json();
    expect(body.session.guide.relevantMemories.join(" | ")).toMatch(/本轮可召回|挂主题决策|审批权|放权/);
    // persisted authoritative session matches response guide
    const stored = fakeSurreal.getState().sessions.find((s) => s.id === id);
    expect(stored?.guide.relevantMemories).toEqual(body.session.guide.relevantMemories);
    await server.close();
  });

  it("/turns: native prefetch 抛错 → 降级 frozen_guide 继续 200,不阻塞追问", async () => {
    const repo = createInMemoryProductStateRepository();
    seedThemeState(repo);
    let createDone = false;
    const fakeSurreal = nativeRecallRepo(repo, {
      failMemories: new Error("hnsw boom"),
      onMemories: () => {
        // allow create to succeed once by not throwing until after first successful create path…
      }
    });
    // Prefer a controllable throw only after session exists: wrap port methods.
    let failNext = false;
    const controllable = Object.assign(fakeSurreal, {
      recallMemoriesByVector: async () => {
        if (failNext) throw new Error("hnsw boom");
        return [] as Array<{ id: string; text: string }>;
      }
    });

    const server = Fastify({ logger: false });
    await registerInterviewSessionRoutes(server, controllable, {
      bailianInterviewClient: createFakeInterviewClient(),
      embeddingClient: { providerId: "fake-emb", embed: async () => [[1, 0, 0]] } as never
    });
    const created = (
      await server.inject({ method: "POST", url: "/api/interview-sessions", payload: { mode: "daily", topicHint: "放权" } })
    ).json();
    expect(created.session?.id).toBeTruthy();
    createDone = true;
    failNext = true;
    void createDone;

    const beforeTurns = controllable.getState().sessions.find((s) => s.id === created.session.id)?.turns.length ?? 0;
    const res = await server.inject({
      method: "POST",
      url: `/api/interview-sessions/${created.session.id}/turns`,
      payload: { content: "第二轮" }
    });
    expect(res.statusCode).toBe(200);
    const afterTurns = controllable.getState().sessions.find((s) => s.id === created.session.id)?.turns.length ?? 0;
    expect(afterTurns).toBe(beforeTurns + 2);
    await server.close();
  });

  it("/voice-instructions: native prefetch + guidePersisted + state.session.guide 更新", async () => {
    const repo = createInMemoryProductStateRepository();
    seedThemeState(repo);
    let vectorCalls = 0;
    const fakeSurreal = nativeRecallRepo(repo, {
      onMemories: () => {
        vectorCalls += 1;
      },
      memories: [{ id: "me_live", text: "【本轮可召回】放权与审批权先小范围验证再扩大" }]
    });
    const server = Fastify({ logger: false });
    await registerInterviewSessionRoutes(server, fakeSurreal, {
      embeddingClient: { providerId: "fake-emb", embed: async () => [[1, 0, 0]] } as never
    });

    const created = (
      await server.inject({ method: "POST", url: "/api/interview-sessions", payload: { mode: "daily", topicHint: "放权" } })
    ).json();
    const id = created.session.id as string;
    const afterCreate = vectorCalls;

    const res = await server.inject({
      method: "POST",
      url: `/api/interview-sessions/${id}/voice-instructions`,
      payload: { latestUserText: "我还是不敢把审批权交出去，放权让我焦虑" }
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.guidePersisted).toBe(true);
    expect(typeof body.instructions).toBe("string");
    expect(body.instructions.length).toBeGreaterThan(0);
    expect(body.session?.guide?.relevantMemories?.join(" | ")).toMatch(/本轮可召回|审批权|挂主题决策|放权/);
    expect(vectorCalls).toBeGreaterThan(afterCreate);

    const stored = fakeSurreal.getState().sessions.find((s) => s.id === id);
    expect(stored?.guide.relevantMemories).toEqual(body.session.guide.relevantMemories);
    expect(body.state?.sessions?.find((s: { id: string }) => s.id === id)?.guide.relevantMemories).toEqual(
      body.session.guide.relevantMemories
    );
    await server.close();
  });

  it("R-P1-01: mid-session /turns BM25 queryText uses latest user text not open-time topicHint", async () => {
    const repo = createInMemoryProductStateRepository();
    seedThemeState(repo);
    let lastQueryText: string | undefined;
    let lastThemeCallTopic: string | undefined;
    const fakeSurreal = Object.assign(repo, {
      recallThemeAssets: async (themeId: string) => {
        lastThemeCallTopic = themeId;
        return { points: [] as string[], decisions: ["de_1"], questions: [] as string[], memories: [] as string[] };
      },
      recallMemoriesByVector: async (_e: number[], _k: number, o?: { queryText?: string }) => {
        lastQueryText = o?.queryText;
        return [{ id: "me_live", text: "【本轮可召回】放权与审批权先小范围验证再扩大" }];
      },
      recallProvenanceTurns: async () => [] as Array<{ id: string; content: string; sessionId: string; role: string }>
    });
    const server = Fastify({ logger: false });
    await registerInterviewSessionRoutes(server, fakeSurreal, {
      bailianInterviewClient: createFakeInterviewClient(),
      embeddingClient: { providerId: "fake-emb", embed: async () => [[1, 0, 0]] } as never
    });
    const created = (
      await server.inject({ method: "POST", url: "/api/interview-sessions", payload: { mode: "daily", topicHint: "放权" } })
    ).json();
    const id = created.session.id as string;
    const drifted = "今天我想谈第二增长曲线的焦虑";
    const turnRes = await server.inject({
      method: "POST",
      url: `/api/interview-sessions/${id}/turns`,
      payload: { content: drifted }
    });
    expect(turnRes.statusCode).toBe(200);
    expect(lastQueryText).toBe(drifted);
    // queryText must be latest utterance, not open-time topic alone
    expect(lastQueryText).not.toBe("放权");
    void lastThemeCallTopic;
    await server.close();
  });

  it("R-P1-03: record-turn persists assistant strategyDecision onto strategyTrace", async () => {
    const repo = createInMemoryProductStateRepository();
    const server = Fastify({ logger: false });
    await registerInterviewSessionRoutes(server, repo, {
      bailianInterviewClient: createFakeInterviewClient()
    });
    const created = (
      await server.inject({ method: "POST", url: "/api/interview-sessions", payload: { mode: "daily", topicHint: "放权" } })
    ).json();
    const id = created.session.id as string;
    await server.inject({
      method: "POST",
      url: `/api/interview-sessions/${id}/record-turn`,
      payload: { role: "user", content: "用户说了一句" }
    });
    const res = await server.inject({
      method: "POST",
      url: `/api/interview-sessions/${id}/record-turn`,
      payload: {
        role: "assistant",
        content: "语音助手追问",
        referencedMemory: "策略选中记忆",
        strategyDecision: {
          strategy: "mechanism_probe",
          label: "机制追问",
          reason: "voice",
          depth: "surface",
          turnIndex: 1,
          referencedMemory: "策略选中记忆"
        }
      }
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    const assistant = body.session.turns.filter((t: { role: string }) => t.role === "assistant").at(-1);
    expect(assistant.referencedMemory).toBe("策略选中记忆");
    expect(assistant.strategy).toBe("mechanism_probe");
    expect(body.session.strategyTrace?.some((d: { referencedMemory?: string }) => d.referencedMemory === "策略选中记忆")).toBe(
      true
    );
    await server.close();
  });

  it("R-P1-04: /end returns pendingMemoryCandidateCount when candidates remain pending", async () => {
    const repo = createInMemoryProductStateRepository();
    const server = Fastify({ logger: false });
    const { createFakeChatClient } = await import("../test-helpers/fake-llm-clients");
    await registerInterviewSessionRoutes(server, repo, {
      bailianInterviewClient: createFakeInterviewClient(),
      bailianChatClient: createFakeChatClient()
    });
    const created = (
      await server.inject({ method: "POST", url: "/api/interview-sessions", payload: { mode: "daily", topicHint: "放权" } })
    ).json();
    const id = created.session.id as string;
    await server.inject({
      method: "POST",
      url: `/api/interview-sessions/${id}/turns`,
      payload: { content: "我现在带 12 个人，最难的是放权。" }
    });
    const end = await server.inject({ method: "POST", url: `/api/interview-sessions/${id}/end` });
    expect(end.statusCode).toBe(200);
    const body = end.json();
    expect(typeof body.pendingMemoryCandidateCount).toBe("number");
    expect(body.pendingMemoryCandidateCount).toBeGreaterThanOrEqual(0);
    if (body.pendingMemoryCandidateCount > 0) {
      expect(body.longTermRecallRequiresApproval).toBe(true);
    }
    await server.close();
  });

  it("/voice-instructions: native prefetch 抛错 → 502,不写坏 guide", async () => {
    const repo = createInMemoryProductStateRepository();
    seedThemeState(repo);
    let fail = false;
    const fakeSurreal = Object.assign(repo, {
      recallThemeAssets: async () => ({ points: [], decisions: ["de_1"], questions: [], memories: [] }),
      recallMemoriesByVector: async () => {
        if (fail) throw new Error("voice hnsw boom");
        return [] as Array<{ id: string; text: string }>;
      },
      recallProvenanceTurns: async () => []
    });
    const server = Fastify({ logger: false });
    await registerInterviewSessionRoutes(server, fakeSurreal, {
      embeddingClient: { providerId: "fake-emb", embed: async () => [[1, 0, 0]] } as never
    });
    const created = (
      await server.inject({ method: "POST", url: "/api/interview-sessions", payload: { mode: "daily", topicHint: "放权" } })
    ).json();
    const id = created.session.id as string;
    const guideBefore = JSON.stringify(fakeSurreal.getState().sessions.find((s) => s.id === id)?.guide);
    fail = true;
    const res = await server.inject({
      method: "POST",
      url: `/api/interview-sessions/${id}/voice-instructions`,
      payload: { latestUserText: "刷新" }
    });
    expect(res.statusCode).toBe(502);
    expect(res.json().error).toMatch(/记忆召回|voice hnsw boom/);
    const guideAfter = JSON.stringify(fakeSurreal.getState().sessions.find((s) => s.id === id)?.guide);
    expect(guideAfter).toBe(guideBefore);
    await server.close();
  });
});
