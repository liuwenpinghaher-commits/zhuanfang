// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { createServer } from "node:http";
import { EventEmitter, once } from "node:events";
import { createInitialProductState } from "../../../../src/domain/engine";
import {
  createInMemoryProductStateRepository,
  type ProductStateRepository
} from "../product-state-repository";
import { registerRealtimeVoiceRoutes } from "./realtime-voice";
import type { BailianStreamingTtsClient } from "../providers/bailian-streaming-tts";
import type { InterviewEnginePolicy, InterviewSession } from "../../../../src/domain/types";

function buildAssistantSession(content: string): InterviewSession {
  return {
    id: "sess-1",
    mode: "daily",
    strength: "standard",
    status: "active",
    title: "实时打断回填测试",
    card: { historyReferences: [], suggestedPerspectives: [] } as unknown as InterviewSession["card"],
    // 真实性重构:POST /sessions 的 enginePolicy 不再有 config 拼装兜底,恒走域层
    // buildInterviewEnginePolicy(内部读 guide.relevantMemories/graphReferences)——
    // fixture 必须给全这些字段,否则域层如实抛错、路由 5xx(暴露而非掩盖)。
    guide: { questions: [], relevantMemories: [], graphReferences: [] } as unknown as InterviewSession["guide"],
    turns: [
      {
        id: "turn-user",
        role: "user",
        content: "我最近在思考一个产品决策。",
        intent: "陈述",
        timestamp: new Date().toISOString()
      },
      {
        id: "turn-assistant",
        role: "assistant",
        content,
        intent: "深问",
        timestamp: new Date().toISOString(),
        providerTurnId: "resp-1"
      }
    ],
    realtimeSignals: [],
    startedAt: new Date().toISOString()
  } as InterviewSession;
}

class FakeRealtimeUpstream extends EventEmitter {
  readyState = 0;
  readonly sent: string[] = [];
  readonly closeCalls: Array<{ code: number; reason: string }> = [];
  pingCalls = 0;
  terminateCalls = 0;

  constructor(private readonly autoPong = true) {
    super();
  }

  open() {
    this.readyState = 1;
    this.emit("open");
  }

  remoteClose(code: number, reason: string) {
    this.readyState = 3;
    this.emit("close", code, Buffer.from(reason));
  }

  send(data: Buffer | string) {
    this.sent.push(data.toString());
  }

  ping() {
    this.pingCalls += 1;
    this.emit("ping");
    if (this.autoPong) queueMicrotask(() => this.emit("pong"));
  }

  terminate() {
    this.terminateCalls += 1;
    this.readyState = 3;
    this.emit("terminated");
  }

  close(code = 1000, reason = "") {
    this.closeCalls.push({ code, reason });
    this.readyState = 3;
    this.emit("close", code, Buffer.from(reason));
  }
}

function waitForFirstBrowserPing(
  socket: import("ws").WebSocket,
  timeoutMs = 1_000
): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      socket.off("ping", onPing);
      socket.off("close", onPrematureClose);
    };
    const onPing = () => {
      cleanup();
      resolve();
    };
    const onPrematureClose = (code: number) => {
      cleanup();
      reject(new Error(`WebSocket 在首个 ping 前关闭：${code}`));
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("WebSocket 未在预期时间内收到首个 ping"));
    }, timeoutMs);
    socket.once("ping", onPing);
    socket.once("close", onPrematureClose);
  });
}

function waitForFirstUpstreamPing(
  upstream: FakeRealtimeUpstream,
  timeoutMs = 1_000
): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      upstream.off("ping", onPing);
      upstream.off("terminated", onPrematureTerminate);
      upstream.off("close", onPrematureClose);
    };
    const onPing = () => {
      cleanup();
      resolve();
    };
    const onPrematureTerminate = () => {
      cleanup();
      reject(new Error("upstream 在首个 ping 前 terminate"));
    };
    const onPrematureClose = () => {
      cleanup();
      reject(new Error("upstream 在首个 ping 前关闭"));
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("upstream 未在预期时间内收到首个 ping"));
    }, timeoutMs);
    upstream.once("ping", onPing);
    upstream.once("terminated", onPrematureTerminate);
    upstream.once("close", onPrematureClose);
  });
}

function waitForWsClose(
  socket: import("ws").WebSocket,
  timeoutMs = 1_000
): Promise<{ code: number; reason: string }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off("close", onClose);
      reject(new Error("WebSocket 未在预期时间内关闭"));
    }, timeoutMs);
    const onClose = (code: number, reason: Buffer) => {
      clearTimeout(timer);
      resolve({ code, reason: reason.toString() });
    };
    socket.once("close", onClose);
  });
}

async function expectRealtimeSessionExpired(
  app: FastifyInstance,
  sessionId: string
): Promise<void> {
  const nowSpy = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 10 * 60 * 1000 + 1_000);
  try {
    const response = await app.inject({
      method: "POST",
      url: `/api/realtime-voice/sessions/${sessionId}/interrupt`,
      payload: { spokenTextSoFar: "timeout" }
    });
    expect(response.statusCode).toBe(410);
  } finally {
    nowSpy.mockRestore();
  }
}

async function expectRealtimeSessionActivePastTtl(
  app: FastifyInstance,
  sessionId: string
): Promise<void> {
  const future = Date.now() + 10 * 60 * 1000 + 1_000;
  const nowSpy = vi.spyOn(Date, "now").mockReturnValue(future);
  try {
    const response = await app.inject({
      method: "POST",
      url: `/api/realtime-voice/sessions/${sessionId}/interrupt`,
      payload: { spokenTextSoFar: "first heartbeat" }
    });
    expect(response.statusCode).toBe(200);
  } finally {
    nowSpy.mockRestore();
  }
}

describe("realtime-voice /interrupt route", () => {
  let app: FastifyInstance;
  let stateRepo: ProductStateRepository;

  beforeEach(async () => {
    app = Fastify();
    const initial = createInitialProductState();
    initial.sessions = [buildAssistantSession("你最近这件事的核心冲突在哪里？")];
    stateRepo = createInMemoryProductStateRepository(initial);
    await registerRealtimeVoiceRoutes(app, { stateRepo });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  async function createSession(interviewSessionId: string) {
    const res = await app.inject({
      method: "POST",
      url: "/api/realtime-voice/sessions",
      payload: { interviewSessionId }
    });
    expect(res.statusCode).toBe(200);
    return JSON.parse(res.body) as { sessionId: string };
  }

  it("returns interrupted true even when state repo is absent", async () => {
    const lonelyApp = Fastify();
    await registerRealtimeVoiceRoutes(lonelyApp);
    await lonelyApp.ready();
    const create = await lonelyApp.inject({
      method: "POST",
      url: "/api/realtime-voice/sessions",
      payload: {}
    });
    const created = JSON.parse(create.body) as { sessionId: string };
    const res = await lonelyApp.inject({
      method: "POST",
      url: `/api/realtime-voice/sessions/${created.sessionId}/interrupt`,
      payload: { spokenTextSoFar: "abc" }
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.interrupted).toBe(true);
    expect(body.truncated).toBe(false);
    await lonelyApp.close();
  });

  it("truncates assistant turn and writes realtime signal + ai run event", async () => {
    const created = await createSession("sess-1");
    const res = await app.inject({
      method: "POST",
      url: `/api/realtime-voice/sessions/${created.sessionId}/interrupt`,
      payload: {
        spokenTextSoFar: "你最近这件事",
        interruptedAtMs: 1200,
        assistantTurnId: "turn-assistant"
      }
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.truncated).toBe(true);
    expect(body.spokenChars).toBe("你最近这件事".length);
    expect(body.assistantTurnId).toBe("turn-assistant");

    const state = stateRepo.getState();
    const session = state.sessions.find((s) => s.id === "sess-1");
    expect(session?.turns.find((t) => t.id === "turn-assistant")?.content).toBe("你最近这件事");
    expect(session?.turns.find((t) => t.id === "turn-assistant")?.truncated).toBeDefined();

    const lastSignal = session?.realtimeSignals?.at(-1);
    expect(lastSignal?.eventType).toBe("agent_speech_interrupted");
    expect(lastSignal?.spokenTextSoFar).toBe("你最近这件事");
    expect(lastSignal?.metrics?.interruptedAtMs).toBe(1200);

    expect(state.aiRunEvents?.[0]?.providerId).toBe("bailian-realtime");
    expect(state.aiRunEvents?.[0]?.workflow).toBe("interview_turn_generation");
    expect(state.aiRunEvents?.[0]?.metrics?.spokenCharsBeforeInterrupt).toBe("你最近这件事".length);
  });

  it("falls back to provider turn id when assistantTurnId missing", async () => {
    const created = await createSession("sess-1");
    const res = await app.inject({
      method: "POST",
      url: `/api/realtime-voice/sessions/${created.sessionId}/interrupt`,
      payload: {
        spokenTextSoFar: "你最近",
        providerTurnId: "resp-1"
      }
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.truncated).toBe(true);
    const state = stateRepo.getState();
    expect(state.sessions[0].turns.find((t) => t.id === "turn-assistant")?.content).toBe("你最近");
  });

  it("returns truncated=false if interview session is not found", async () => {
    const created = await createSession("missing");
    const res = await app.inject({
      method: "POST",
      url: `/api/realtime-voice/sessions/${created.sessionId}/interrupt`,
      payload: { spokenTextSoFar: "abc" }
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.truncated).toBe(false);
  });

  it("supports provider_error reason and records degraded ai run event", async () => {
    const created = await createSession("sess-1");
    const res = await app.inject({
      method: "POST",
      url: `/api/realtime-voice/sessions/${created.sessionId}/interrupt`,
      payload: {
        spokenTextSoFar: "你最近这件事",
        assistantTurnId: "turn-assistant",
        reason: "provider_error"
      }
    });
    expect(res.statusCode).toBe(200);
    const state = stateRepo.getState();
    const session = state.sessions.find((s) => s.id === "sess-1");
    expect(session?.turns.find((t) => t.id === "turn-assistant")?.truncated?.reason).toBe("provider_error");
  });

  it("POST /sessions fallback instructions carry opening discipline when no instructions passed", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/realtime-voice/sessions",
      payload: { interviewSessionId: "sess-1" }
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    const instructions: string = body.sessionUpdate?.session?.instructions ?? "";
    expect(instructions).toContain("专访主持人");
    expect(instructions).toMatch(/开场|不寒暄|跟踪点|最近怎么样/);
  });

  it("uses injected runtime env for /config and session creation instead of process.env", async () => {
    const keys = [
      "DASHSCOPE_API_KEY",
      "BAILIAN_API_KEY",
      "BAILIAN_REALTIME_TRANSPORT",
      "BAILIAN_REALTIME_WEBRTC_ENDPOINT",
      "BAILIAN_REALTIME_MODEL",
      "BAILIAN_REALTIME_VOICE"
    ];
    const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
    for (const key of keys) delete process.env[key];

    const envApp = Fastify();
    try {
      await registerRealtimeVoiceRoutes(envApp, {
        env: {
          DASHSCOPE_API_KEY: "dummy-key",
          BAILIAN_REALTIME_TRANSPORT: "websocket",
          BAILIAN_REALTIME_VOICE: "Cherry"
        }
      });
      await envApp.ready();

      const configRes = await envApp.inject({ method: "GET", url: "/api/realtime-voice/config" });
      const sessionRes = await envApp.inject({
        method: "POST",
        url: "/api/realtime-voice/sessions",
        payload: {}
      });
      const config = configRes.json();
      const session = sessionRes.json();

      expect(config).toMatchObject({
        apiKeyConfigured: true,
        configured: true,
        transport: "websocket"
      });
      expect(session.status).toBe("ready");
      expect(session.sessionUpdate.session.voice).toBe("Cherry");
    } finally {
      await envApp.close();
      for (const key of keys) {
        if (saved[key] === undefined) delete process.env[key];
        else process.env[key] = saved[key];
      }
    }
  });
});

describe("realtime-voice /agent-context route", () => {
  let app: FastifyInstance;
  let stateRepo: ProductStateRepository;

  beforeEach(async () => {
    app = Fastify();
    const initial = createInitialProductState();
    stateRepo = createInMemoryProductStateRepository(initial);
    await registerRealtimeVoiceRoutes(app, { stateRepo });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it("returns complete interview context for a session with turns", async () => {
    const { createInterviewSession, addTurn } = await import("../../../../src/domain/engine");
    const { generateSessionId } = await import("../../../../src/domain/identifiers");

    const sid = generateSessionId();
    let session = createInterviewSession({
      id: sid,
      title: "测试专访",
      createdAt: new Date().toISOString()
    });
    session = addTurn(session, { role: "user", content: "你好" });
    session = addTurn(session, { role: "assistant", content: "你好，欢迎！", strategy: "greeting" });

    stateRepo.replaceState({
      ...stateRepo.getState(),
      sessions: [session]
    });

    const res = await app.inject({
      method: "GET",
      url: `/api/realtime-voice/agent-context/${sid}`
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.instructions).toContain("专访主持人");
    expect(body.sessionTitle).toBe("测试专访");
    expect(body.turnCount).toBe(2);
    expect(body.history).toHaveLength(2);
    expect(body.history[0]).toEqual({ role: "user", text: "你好" });
    expect(body.history[1]).toEqual({ role: "assistant", text: "你好，欢迎！" });
  });

  it("returns 404 for unknown session", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/realtime-voice/agent-context/nonexistent"
    });
    expect(res.statusCode).toBe(404);
  });

  it("returns 503 when stateRepo is not configured", async () => {
    const lonelyApp = Fastify();
    await registerRealtimeVoiceRoutes(lonelyApp);
    await lonelyApp.ready();
    const res = await lonelyApp.inject({
      method: "GET",
      url: "/api/realtime-voice/agent-context/any-id"
    });
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toBe("state_repo_unavailable");
    await lonelyApp.close();
  });

  it("refreshes memory recall from ?latestUserText= so instructions track the conversation (🔴-1 livekit)", async () => {
    const { createInterviewSession } = await import("../../../../src/domain/engine");
    const { generateSessionId } = await import("../../../../src/domain/identifiers");
    const sid = generateSessionId();
    const session = createInterviewSession({ id: sid, title: "放权专访", createdAt: new Date().toISOString() });

    // Two confirmed memories distinguishable ONLY by embedding (keyword recall can't tell them apart).
    const near = { id: "m-near", text: "用户在放权这件事上反复强调先小范围验证再扩大", status: "confirmed",
      sourceType: "interview_session", sourceId: "s", evidenceQuote: "", createdAt: "2026-06-01T00:00:00Z",
      updatedAt: "2026-06-01T00:00:00Z", embedding: [1, 0, 0] };
    const far = { id: "m-far", text: "用户提到自己喜欢在清晨独自跑步", status: "confirmed",
      sourceType: "interview_session", sourceId: "s", evidenceQuote: "", createdAt: "2026-06-01T00:00:00Z",
      updatedAt: "2026-06-01T00:00:00Z", embedding: [0, 1, 0] };
    stateRepo.replaceState({ ...stateRepo.getState(), sessions: [session], memoryRecords: [near, far] as never });

    let embedCalls = 0;
    const fakeEmbed = { embed: async (_texts: string[]) => { embedCalls += 1; return [[1, 0, 0]]; } };
    const embApp = Fastify();
    await registerRealtimeVoiceRoutes(embApp, { stateRepo, embeddingClient: fakeEmbed as never });
    await embApp.ready();

    const res = await embApp.inject({
      method: "GET",
      url: `/api/realtime-voice/agent-context/${sid}?latestUserText=${encodeURIComponent("我还是不敢放权，审批权交不出去")}`
    });
    expect(res.statusCode).toBe(200);
    expect(embedCalls).toBe(1); // the latest utterance was embedded for recall
    // Mid-session query uses latest text; memory text shares 放权 (embeddings may be clamped in store).
    expect(res.json().instructions).toContain("先小范围验证再扩大");
    await embApp.close();
  });

  it("does not embed when ?latestUserText= is absent (recall unchanged, no-op safe)", async () => {
    const { createInterviewSession } = await import("../../../../src/domain/engine");
    const { generateSessionId } = await import("../../../../src/domain/identifiers");
    const sid = generateSessionId();
    const session = createInterviewSession({ id: sid, title: "x", createdAt: new Date().toISOString() });
    stateRepo.replaceState({ ...stateRepo.getState(), sessions: [session] });

    let embedCalls = 0;
    const fakeEmbed = { embed: async () => { embedCalls += 1; return [[1, 0, 0]]; } };
    const embApp = Fastify();
    await registerRealtimeVoiceRoutes(embApp, { stateRepo, embeddingClient: fakeEmbed as never });
    await embApp.ready();
    const res = await embApp.inject({ method: "GET", url: `/api/realtime-voice/agent-context/${sid}` });
    expect(res.statusCode).toBe(200);
    expect(embedCalls).toBe(0);
    await embApp.close();
  });

  it("C-P1-04: agent-context with latestUserText persists refreshed guide/card to state", async () => {
    const { createInterviewSession } = await import("../../../../src/domain/engine");
    const { generateSessionId } = await import("../../../../src/domain/identifiers");
    const sid = generateSessionId();
    const session = createInterviewSession({ id: sid, title: "放权专访", createdAt: new Date().toISOString() });
    // freeze open-time guide so we can detect a mid-session write-back
    session.guide = {
      ...session.guide,
      topicHint: "放权",
      relevantMemories: ["【开场冻结】旧记忆占位"]
    };
    session.card = {
      ...session.card,
      historyReferences: ["【开场冻结】旧历史引用"]
    };

    const near = {
      id: "m-near",
      text: "用户在放权这件事上反复强调先小范围验证再扩大",
      status: "confirmed",
      sourceType: "interview_session",
      sourceId: "s",
      evidenceQuote: "",
      createdAt: "2026-06-01T00:00:00Z",
      updatedAt: "2026-06-01T00:00:00Z",
      embedding: [1, 0, 0]
    };
    stateRepo.replaceState({
      ...stateRepo.getState(),
      sessions: [session],
      memoryRecords: [near] as never
    });

    let vectorCalls = 0;
    const nativeRepo = Object.assign(stateRepo, {
      recallThemeAssets: async () => ({ points: [], decisions: [], questions: [], memories: [] }),
      recallMemoriesByVector: async () => {
        vectorCalls += 1;
        return [{ id: "m-near", text: near.text }];
      },
      recallProvenanceTurns: async () => []
    });

    const embApp = Fastify();
    await registerRealtimeVoiceRoutes(embApp, {
      stateRepo: nativeRepo,
      embeddingClient: { embed: async () => [[1, 0, 0]] } as never
    });
    await embApp.ready();

    const res = await embApp.inject({
      method: "GET",
      url: `/api/realtime-voice/agent-context/${sid}?latestUserText=${encodeURIComponent("我还是不敢放权，审批权交不出去")}`
    });
    expect(res.statusCode).toBe(200);
    expect(vectorCalls).toBeGreaterThan(0);
    expect(res.json().instructions).toContain("先小范围验证再扩大");

    const stored = nativeRepo.getState().sessions.find((s) => s.id === sid);
    expect(stored).toBeDefined();
    // guide was written back (no longer only the frozen open-time placeholder)
    expect(stored!.guide.relevantMemories.join(" | ")).toContain("先小范围验证再扩大");
    expect(stored!.guide.relevantMemories.join(" | ")).not.toBe("【开场冻结】旧记忆占位");
    // card history channel is live-only (no dual merge with open-time freeze)
    expect(stored!.card.historyReferences.some((h) => h.includes("先小范围验证再扩大"))).toBe(true);
    await embApp.close();
  });

  it("IV-P0-02: record-turn interleaved with agent-context keeps the new turn (writeGate)", async () => {
    const { createInterviewSession } = await import("../../../../src/domain/engine");
    const { generateSessionId } = await import("../../../../src/domain/identifiers");
    const { registerInterviewSessionRoutes } = await import("./interview-sessions");
    const sid = generateSessionId();
    const session = createInterviewSession({ id: sid, title: "并发专访", createdAt: new Date().toISOString() });
    session.guide = { ...session.guide, topicHint: "放权" };
    stateRepo.replaceState({ ...stateRepo.getState(), sessions: [session] });

    let releaseEmbed!: (v: number[][]) => void;
    const hang = new Promise<number[][]>((resolve) => {
      releaseEmbed = resolve;
    });
    const embed = vi.fn(async () => hang);
    let chain: Promise<unknown> = Promise.resolve();
    const writeGate = {
      async runExclusive<T>(_label: string, fn: () => Promise<T> | T): Promise<T> {
        const run = chain.then(() => fn());
        chain = run.then(
          () => undefined,
          () => undefined
        );
        return run;
      }
    };

    // Shared writeGate: agent-context final merge + interview record-turn (via mutex if we wrap).
    // record-turn on interview routes does not use writeGate itself, but production preHandler
    // serializes it with writeGate.runExclusive. For this unit test we pass writeGate to both
    // and also wrap record-turn traffic by awaiting it after starting agent-context.
    const voiceApp = Fastify();
    await registerRealtimeVoiceRoutes(voiceApp, {
      stateRepo,
      embeddingClient: { embed } as never,
      writeGate
    });
    await registerInterviewSessionRoutes(voiceApp, stateRepo, { writeGate });
    await voiceApp.ready();

    const ctxPromise = voiceApp.inject({
      method: "GET",
      url: `/api/realtime-voice/agent-context/${sid}?latestUserText=${encodeURIComponent("刷新召回")}`
    });
    for (let i = 0; i < 50 && embed.mock.calls.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(embed.mock.calls.length).toBeGreaterThan(0);

    const raceContent = "agent-context 竞态轮-必须保留";
    const rt = await voiceApp.inject({
      method: "POST",
      url: `/api/interview-sessions/${sid}/record-turn`,
      payload: { role: "user", content: raceContent }
    });
    expect(rt.statusCode).toBe(200);

    releaseEmbed([[1, 0, 0]]);
    const ctx = await ctxPromise;
    expect(ctx.statusCode).toBe(200);

    const stored = stateRepo.getState().sessions.find((s) => s.id === sid)!;
    expect(stored.turns.some((t) => t.content === raceContent)).toBe(true);
    // agent context history should reflect turns present at commit time
    expect(ctx.json().history.some((h: { text: string }) => h.text === raceContent)).toBe(true);

    await voiceApp.close();
  });

  it("C-P1-02: agent-context native prefetch failure → 502 fail-closed", async () => {
    const { createInterviewSession } = await import("../../../../src/domain/engine");
    const { generateSessionId } = await import("../../../../src/domain/identifiers");
    const sid = generateSessionId();
    const session = createInterviewSession({ id: sid, title: "x", createdAt: new Date().toISOString() });
    session.guide = { ...session.guide, topicHint: "放权" };
    stateRepo.replaceState({ ...stateRepo.getState(), sessions: [session] });

    const nativeRepo = Object.assign(stateRepo, {
      recallThemeAssets: async () => ({ points: [], decisions: [], questions: [], memories: [] }),
      recallMemoriesByVector: async () => {
        throw new Error("agent hnsw boom");
      },
      recallProvenanceTurns: async () => []
    });
    const embApp = Fastify();
    await registerRealtimeVoiceRoutes(embApp, {
      stateRepo: nativeRepo,
      embeddingClient: { embed: async () => [[1, 0, 0]] } as never
    });
    await embApp.ready();
    const res = await embApp.inject({
      method: "GET",
      url: `/api/realtime-voice/agent-context/${sid}?latestUserText=${encodeURIComponent("刷新")}`
    });
    expect(res.statusCode).toBe(502);
    expect(res.json().error).toMatch(/agent 上下文召回失败|agent hnsw boom/);
    // failed path must not mutate session guide
    const stored = nativeRepo.getState().sessions.find((s) => s.id === sid);
    expect(stored?.guide.topicHint).toBe("放权");
    await embApp.close();
  });
});

describe("realtime-voice /livekit-token route", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = Fastify();
    await registerRealtimeVoiceRoutes(app);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it("returns token and room info", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/realtime-voice/livekit-token?sessionId=test&interviewSessionId=int-1"
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toHaveProperty("token");
    expect(body).toHaveProperty("serverUrl");
    expect(body).toHaveProperty("room");
    expect(body.room).toBe("interview-int-1");
  });

  it("uses session-based room name when interviewSessionId is missing", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/realtime-voice/livekit-token?sessionId=abc"
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().room).toBe("session-abc");
  });

  it("generates random room name when no params provided", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/realtime-voice/livekit-token"
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().room).toMatch(/^session-/);
  });

  // P1-03: when a state repo is wired, an interviewSessionId must belong to a real session
  // before a publish/subscribe room token is minted (no signing for guessed/forged ids).
  it("returns 404 for an interviewSessionId that does not exist when a stateRepo is wired (P1-03)", async () => {
    const repoApp = Fastify();
    const stateRepo = createInMemoryProductStateRepository(createInitialProductState());
    await registerRealtimeVoiceRoutes(repoApp, { stateRepo });
    await repoApp.ready();
    const res = await repoApp.inject({
      method: "GET",
      url: "/api/realtime-voice/livekit-token?interviewSessionId=does-not-exist"
    });
    expect(res.statusCode).toBe(404);
    await repoApp.close();
  });

  it("signs a token for an interviewSessionId that exists when a stateRepo is wired (P1-03)", async () => {
    const { createInterviewSession } = await import("../../../../src/domain/engine");
    const { generateSessionId } = await import("../../../../src/domain/identifiers");
    const repoApp = Fastify();
    const stateRepo = createInMemoryProductStateRepository(createInitialProductState());
    const sid = generateSessionId();
    const session = createInterviewSession({ id: sid, title: "Owned", createdAt: new Date().toISOString() });
    stateRepo.replaceState({ ...stateRepo.getState(), sessions: [session] });
    await registerRealtimeVoiceRoutes(repoApp, { stateRepo });
    await repoApp.ready();
    const res = await repoApp.inject({
      method: "GET",
      url: `/api/realtime-voice/livekit-token?interviewSessionId=${sid}`
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().room).toBe(`interview-${sid}`);
    await repoApp.close();
  });
});

describe("realtime-voice /agent-turn route", () => {
  let app: FastifyInstance;
  let stateRepo: ProductStateRepository;

  beforeEach(async () => {
    app = Fastify();
    const initial = createInitialProductState();
    stateRepo = createInMemoryProductStateRepository(initial);
    await registerRealtimeVoiceRoutes(app, { stateRepo });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it("records a user turn", async () => {
    const { createInterviewSession } = await import("../../../../src/domain/engine");
    const { generateSessionId } = await import("../../../../src/domain/identifiers");
    const sid = generateSessionId();
    const session = createInterviewSession({ id: sid, title: "Test", createdAt: new Date().toISOString() });
    stateRepo.replaceState({ ...stateRepo.getState(), sessions: [session] });

    const res = await app.inject({
      method: "POST",
      url: `/api/realtime-voice/agent-turn/${sid}`,
      payload: { role: "user", text: "hello" }
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("recorded");
  });

  it("records an assistant turn", async () => {
    const { createInterviewSession } = await import("../../../../src/domain/engine");
    const { generateSessionId } = await import("../../../../src/domain/identifiers");
    const sid = generateSessionId();
    const session = createInterviewSession({ id: sid, title: "Test", createdAt: new Date().toISOString() });
    stateRepo.replaceState({ ...stateRepo.getState(), sessions: [session] });

    const res = await app.inject({
      method: "POST",
      url: `/api/realtime-voice/agent-turn/${sid}`,
      payload: { role: "assistant", text: "hello back", strategy: "greeting" }
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("recorded");
  });

  it("returns 404 for unknown session", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/realtime-voice/agent-turn/nonexistent",
      payload: { role: "user", text: "hello" }
    });
    expect(res.statusCode).toBe(404);
  });

  it("returns 503 when stateRepo is not configured", async () => {
    const lonelyApp = Fastify();
    await registerRealtimeVoiceRoutes(lonelyApp);
    await lonelyApp.ready();
    const res = await lonelyApp.inject({
      method: "POST",
      url: "/api/realtime-voice/agent-turn/any-id",
      payload: { role: "user", text: "hello" }
    });
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toBe("state_repo_unavailable");
    await lonelyApp.close();
  });
});

describe("realtime-voice 会话 TTL 滑动续期与活跃 WS 豁免(N-14/P3-20)", () => {
  const TTL_MS = 10 * 60 * 1000;
  let app: FastifyInstance;
  afterEach(async () => {
    vi.restoreAllMocks();
    if (app) await app.close();
  });

  async function freshSession(): Promise<string> {
    app = Fastify();
    await registerRealtimeVoiceRoutes(app);
    await app.ready();
    const res = await app.inject({ method: "POST", url: "/api/realtime-voice/sessions", payload: {} });
    expect(res.statusCode).toBe(200);
    return (res.json() as { sessionId: string }).sessionId;
  }

  it("无流量超 TTL → /interrupt 返回 410(会话确实过期,不是永不过期)", async () => {
    const base = Date.now();
    const sessionId = await freshSession();
    // 时钟推过 TTL,期间无任何访问/WS → 会话应过期。
    vi.spyOn(Date, "now").mockReturnValue(base + TTL_MS + 1000);
    const res = await app.inject({
      method: "POST",
      url: `/api/realtime-voice/sessions/${sessionId}/interrupt`,
      payload: { spokenTextSoFar: "abc" }
    });
    expect(res.statusCode).toBe(410);
  });

  it("TTL 内的 REST 访问滑动续期 → 超过原始过期点仍存活", async () => {
    const base = Date.now();
    const sessionId = await freshSession();
    const nowSpy = vi.spyOn(Date, "now");
    // +9min 访问一次:此刻未过期,访问后续期到 +19min。
    nowSpy.mockReturnValue(base + 9 * 60 * 1000);
    const first = await app.inject({
      method: "POST",
      url: `/api/realtime-voice/sessions/${sessionId}/interrupt`,
      payload: { spokenTextSoFar: "abc" }
    });
    expect(first.statusCode).toBe(200);
    // +15min:已超过原始 +10min 过期点,但因上一步续期到 +19min → 仍存活。
    nowSpy.mockReturnValue(base + 15 * 60 * 1000);
    const second = await app.inject({
      method: "POST",
      url: `/api/realtime-voice/sessions/${sessionId}/interrupt`,
      payload: { spokenTextSoFar: "abc" }
    });
    expect(second.statusCode).toBe(200);
  });

  it("活跃 TTS WS 存在期间,时钟超 TTL 也不判过期(长访谈 cascade 核心场景)", async () => {
    const base = Date.now();
    app = Fastify();
    await registerRealtimeVoiceRoutes(app);
    await app.ready();
    const sessionRes = await app.inject({ method: "POST", url: "/api/realtime-voice/sessions", payload: {} });
    const { sessionId } = sessionRes.json() as { sessionId: string };

    await new Promise<void>((resolve, reject) => {
      const httpServer = app.server;
      httpServer.listen(0, "127.0.0.1", () => {
        const port = (httpServer.address() as { port: number }).port;
        const { WebSocket: WsClient } = require("ws") as typeof import("ws");
        const ws = new WsClient(`ws://127.0.0.1:${port}/api/realtime-voice/ws/tts/${sessionId}`);
        ws.on("open", () => {
          void (async () => {
            try {
              // WS 已连上(addActiveWs)。把时钟推过 TTL——无活跃 WS 时这会让会话过期。
              vi.spyOn(Date, "now").mockReturnValue(base + TTL_MS + 60 * 1000);
              const res = await app.inject({
                method: "POST",
                url: `/api/realtime-voice/sessions/${sessionId}/interrupt`,
                payload: { spokenTextSoFar: "abc" }
              });
              // 活跃 WS 豁免过期 → 200(而非 410)。这正是长访谈 interrupt 不再静默失效的证据。
              expect(res.statusCode).toBe(200);
              ws.close();
            } catch (err) {
              ws.close();
              reject(err as Error);
            }
          })();
        });
        ws.on("close", () => resolve());
        ws.on("error", (err: Error) => reject(err));
        setTimeout(() => ws.close(), 2000);
      });
    });
  });
});

describe("realtime-voice ASR WebSocket proxy resilience", () => {
  it("安全透传 upstream 1011 与 reason，并清理日志和全部 upstream listener", async () => {
    const testApp = Fastify();
    const upstream = new FakeRealtimeUpstream();
    let now = 1_000;
    let factoryHeaders: Record<string, string> | undefined;
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => undefined);

    await registerRealtimeVoiceRoutes(testApp, {
      env: { DASHSCOPE_API_KEY: "test-secret" },
      createRealtimeUpstream: (_url: string, init: { headers: Record<string, string> }) => {
        factoryHeaders = init.headers;
        return upstream;
      },
      heartbeatIntervalMs: 10_000,
      heartbeatMaxMissedPongs: 2,
      now: () => now
    } as never);
    await testApp.ready();
    const sessionRes = await testApp.inject({
      method: "POST",
      url: "/api/realtime-voice/sessions",
      payload: {}
    });
    const { sessionId } = sessionRes.json() as { sessionId: string };
    await testApp.listen({ port: 0, host: "127.0.0.1" });
    const port = (testApp.server.address() as { port: number }).port;
    const { WebSocket: WsClient } = require("ws") as typeof import("ws");
    const ws = new WsClient(`ws://127.0.0.1:${port}/api/realtime-voice/ws/${sessionId}`);

    try {
      const closeResult = await Promise.race([
        new Promise<{ code: number; reason: string }>((resolve, reject) => {
          ws.on("open", () => upstream.open());
          ws.on("message", (data: Buffer) => {
            if (!data.toString().includes("proxy.connected")) return;
            now = 2_234;
            upstream.remoteClose(1011, "temporary upstream close");
          });
          ws.on("close", (code: number, reason: Buffer) => resolve({ code, reason: reason.toString() }));
          ws.on("error", reject);
        }),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("ASR proxy 未使用 injected upstream")), 500))
      ]);

      expect(closeResult).toEqual({ code: 1011, reason: "temporary upstream close" });
      expect(factoryHeaders).toEqual({ Authorization: "Bearer test-secret" });
      const logs = infoSpy.mock.calls.map(([line]) => JSON.parse(String(line)) as Record<string, unknown>);
      expect(logs).toContainEqual({
        event: "realtime_proxy_upstream_closed",
        sessionId,
        direction: "upstream",
        code: 1011,
        reason: "temporary upstream close",
        phase: "ready",
        durationMs: 1234
      });
      expect(JSON.stringify(logs)).not.toMatch(/Authorization|Bearer|transcript|input_audio_buffer|test-secret/);
      for (const event of ["open", "message", "error", "close", "pong"]) {
        expect(upstream.listenerCount(event)).toBe(0);
      }
    } finally {
      if (ws.readyState !== WsClient.CLOSED) ws.terminate();
      await testApp.close();
      infoSpy.mockRestore();
    }
  });

  it("同时为浏览器和 upstream 安装心跳，浏览器关闭时按约定关闭 upstream", async () => {
    const testApp = Fastify();
    const upstream = new FakeRealtimeUpstream();
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => undefined);
    await registerRealtimeVoiceRoutes(testApp, {
      env: { DASHSCOPE_API_KEY: "test-secret" },
      createRealtimeUpstream: () => upstream,
      heartbeatIntervalMs: 100,
      heartbeatMaxMissedPongs: 2
    } as never);
    await testApp.ready();
    const sessionRes = await testApp.inject({
      method: "POST",
      url: "/api/realtime-voice/sessions",
      payload: {}
    });
    const { sessionId } = sessionRes.json() as { sessionId: string };
    await testApp.listen({ port: 0, host: "127.0.0.1" });
    const port = (testApp.server.address() as { port: number }).port;
    const { WebSocket: WsClient } = require("ws") as typeof import("ws");
    const ws = new WsClient(`ws://127.0.0.1:${port}/api/realtime-voice/ws/${sessionId}`);

    try {
      await once(ws, "open");
      upstream.open();
      await Promise.all([
        once(ws, "ping"),
        vi.waitFor(() => expect(upstream.pingCalls).toBeGreaterThan(0), { timeout: 500, interval: 5 })
      ]);

      const closed = once(ws, "close");
      ws.close(1000, "user done");
      await closed;

      await vi.waitFor(() => expect(upstream.closeCalls).toHaveLength(1), { timeout: 500, interval: 5 });
      expect(upstream.closeCalls).toEqual([{ code: 1000, reason: "client disconnected" }]);
      for (const event of ["open", "message", "error", "close", "pong"]) {
        expect(upstream.listenerCount(event)).toBe(0);
      }
      const logs = infoSpy.mock.calls.map(([line]) => JSON.parse(String(line)) as Record<string, unknown>);
      expect(logs).toContainEqual(expect.objectContaining({
        event: "realtime_proxy_browser_closed",
        sessionId,
        direction: "browser",
        code: 1000,
        reason: "user done"
      }));
    } finally {
      if (ws.readyState !== WsClient.CLOSED) ws.terminate();
      await testApp.close();
      infoSpy.mockRestore();
    }
  });

  it("ASR browser 连续两个周期无 pong 后终止并清理 upstream 与活跃会话", async () => {
    const testApp = Fastify();
    const upstream = new FakeRealtimeUpstream();
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => undefined);
    await registerRealtimeVoiceRoutes(testApp, {
      env: { DASHSCOPE_API_KEY: "test-secret" },
      createRealtimeUpstream: () => upstream,
      heartbeatIntervalMs: 10,
      heartbeatMaxMissedPongs: 2
    } as never);
    await testApp.ready();
    const sessionRes = await testApp.inject({ method: "POST", url: "/api/realtime-voice/sessions", payload: {} });
    const { sessionId } = sessionRes.json() as { sessionId: string };
    await testApp.listen({ port: 0, host: "127.0.0.1" });
    const port = (testApp.server.address() as { port: number }).port;
    const { WebSocket: WsClient } = require("ws") as typeof import("ws");
    const ws = new WsClient(
      `ws://127.0.0.1:${port}/api/realtime-voice/ws/${sessionId}`,
      { autoPong: false }
    );
    let browserPingCount = 0;
    const onBrowserPing = () => { browserPingCount += 1; };
    ws.on("ping", onBrowserPing);

    try {
      const closePromise = waitForWsClose(ws);
      const firstPing = waitForFirstBrowserPing(ws);
      await once(ws, "open");
      upstream.open();
      await firstPing;

      expect(browserPingCount).toBe(1);
      expect(ws.readyState).toBe(WsClient.OPEN);
      expect(upstream.readyState).toBe(1);
      expect(upstream.closeCalls).toHaveLength(0);
      expect(upstream.terminateCalls).toBe(0);
      expect(upstream.listenerCount("pong")).toBe(1);
      await expectRealtimeSessionActivePastTtl(testApp, sessionId);

      const close = await closePromise;

      expect(close.code).toBe(1006);
      expect(browserPingCount).toBe(1);
      await vi.waitFor(() => expect(upstream.closeCalls).toHaveLength(1), { timeout: 500, interval: 5 });
      expect(upstream.closeCalls).toEqual([{ code: 1000, reason: "client disconnected" }]);
      for (const event of ["open", "message", "error", "close", "pong"]) {
        expect(upstream.listenerCount(event)).toBe(0);
      }
      const logs = infoSpy.mock.calls.map(([line]) => JSON.parse(String(line)) as Record<string, unknown>);
      expect(logs).toContainEqual(expect.objectContaining({
        event: "realtime_proxy_heartbeat_timeout",
        sessionId,
        direction: "browser"
      }));
      await expectRealtimeSessionExpired(testApp, sessionId);
    } finally {
      ws.off("ping", onBrowserPing);
      if (ws.readyState !== WsClient.CLOSED) ws.terminate();
      await testApp.close();
      infoSpy.mockRestore();
    }
  });

  it("ASR upstream 连续两个周期无 pong 后 terminate 并关闭 browser", async () => {
    const testApp = Fastify();
    const upstream = new FakeRealtimeUpstream(false);
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => undefined);
    await registerRealtimeVoiceRoutes(testApp, {
      env: { DASHSCOPE_API_KEY: "test-secret" },
      createRealtimeUpstream: () => upstream,
      heartbeatIntervalMs: 100,
      heartbeatMaxMissedPongs: 2
    } as never);
    await testApp.ready();
    const sessionRes = await testApp.inject({ method: "POST", url: "/api/realtime-voice/sessions", payload: {} });
    const { sessionId } = sessionRes.json() as { sessionId: string };
    await testApp.listen({ port: 0, host: "127.0.0.1" });
    const port = (testApp.server.address() as { port: number }).port;
    const { WebSocket: WsClient } = require("ws") as typeof import("ws");
    const ws = new WsClient(`ws://127.0.0.1:${port}/api/realtime-voice/ws/${sessionId}`);

    try {
      const closePromise = waitForWsClose(ws);
      const firstUpstreamPing = waitForFirstUpstreamPing(upstream);
      await once(ws, "open");
      upstream.open();
      await firstUpstreamPing;

      expect(ws.readyState).toBe(WsClient.OPEN);
      expect(upstream.readyState).toBe(1);
      expect(upstream.terminateCalls).toBe(0);
      expect(upstream.closeCalls).toHaveLength(0);
      expect(upstream.listenerCount("pong")).toBe(1);
      await expectRealtimeSessionActivePastTtl(testApp, sessionId);

      const close = await closePromise;

      expect(close).toEqual({ code: 1011, reason: "upstream heartbeat timeout" });
      expect(upstream.pingCalls).toBe(1);
      expect(upstream.terminateCalls).toBe(1);
      expect(upstream.closeCalls).toHaveLength(0);
      for (const event of ["open", "message", "error", "close", "pong"]) {
        expect(upstream.listenerCount(event)).toBe(0);
      }
      const logs = infoSpy.mock.calls.map(([line]) => JSON.parse(String(line)) as Record<string, unknown>);
      expect(logs).toContainEqual(expect.objectContaining({
        event: "realtime_proxy_heartbeat_timeout",
        sessionId,
        direction: "upstream"
      }));
      await expectRealtimeSessionExpired(testApp, sessionId);
    } finally {
      if (ws.readyState !== WsClient.CLOSED) ws.terminate();
      await testApp.close();
      infoSpy.mockRestore();
    }
  });
});

describe("realtime-voice TTS WebSocket proxy (/api/realtime-voice/ws/tts/:sessionId)", () => {
  /**
   * Browser↔proxy message contract (documented here for reference):
   *
   * Browser → proxy (JSON text frames):
   *   { type: "speak", segments: string[], voice?: string }
   *   { type: "cancel" }
   *
   * Proxy → browser:
   *   binary audio frames (forwarded directly from CosyVoice)
   *   { type: "tts.done" }   — synthesis complete
   *   { type: "error", message: string }  — synthesis error or config error
   */

  it("upgrade handler is registered: unknown-session TTS upgrade is rejected with 404", async () => {
    // Simulate a raw HTTP Upgrade request. When the session is unknown the
    // upgrade handler must destroy the socket without calling handleUpgrade.
    const testApp = Fastify();
    await registerRealtimeVoiceRoutes(testApp);
    await testApp.ready();

    await new Promise<void>((resolve, reject) => {
      const httpServer = testApp.server;
      httpServer.listen(0, "127.0.0.1", () => {
        const port = (httpServer.address() as { port: number }).port;
        const net = require("node:net") as typeof import("node:net");
        const socket = net.connect(port, "127.0.0.1", () => {
          socket.write(
            "GET /api/realtime-voice/ws/tts/unknown-session-id HTTP/1.1\r\n" +
            `Host: 127.0.0.1:${port}\r\n` +
            "Upgrade: websocket\r\nConnection: Upgrade\r\n" +
            "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n" +
            "Sec-WebSocket-Version: 13\r\n\r\n"
          );
        });
        socket.on("data", (data: Buffer) => {
          // The server must send a 4xx or close — NOT a 101 Switching Protocols
          expect(data.toString()).not.toMatch(/^HTTP\/1\.1 101/);
        });
        socket.on("close", () => {
          httpServer.close(() => testApp.close().then(() => resolve()));
        });
        socket.on("error", () => {
          // Socket destroyed without response — also acceptable
          httpServer.close(() => testApp.close().then(() => resolve()));
        });
      });
    });
  });

  it("rejects a WS upgrade from a disallowed browser Origin (CSWSH, P1-02)", async () => {
    // A browser-supplied Origin not in the allow-set (dev origins, since PRODUCT_WEB_ORIGINS
    // is unset) must be refused BEFORE handleUpgrade — no 101 Switching Protocols.
    const testApp = Fastify();
    await registerRealtimeVoiceRoutes(testApp);
    await testApp.ready();

    await new Promise<void>((resolve) => {
      const httpServer = testApp.server;
      httpServer.listen(0, "127.0.0.1", () => {
        const port = (httpServer.address() as { port: number }).port;
        const net = require("node:net") as typeof import("node:net");
        const socket = net.connect(port, "127.0.0.1", () => {
          socket.write(
            "GET /api/realtime-voice/ws/tts/any-session HTTP/1.1\r\n" +
            `Host: 127.0.0.1:${port}\r\n` +
            "Origin: http://evil.example.com\r\n" +
            "Upgrade: websocket\r\nConnection: Upgrade\r\n" +
            "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n" +
            "Sec-WebSocket-Version: 13\r\n\r\n"
          );
        });
        socket.on("data", (data: Buffer) => {
          const text = data.toString();
          expect(text).not.toMatch(/^HTTP\/1\.1 101/);
          expect(text).toMatch(/^HTTP\/1\.1 403/);
        });
        socket.on("close", () => {
          httpServer.close(() => testApp.close().then(() => resolve()));
        });
        socket.on("error", () => {
          httpServer.close(() => testApp.close().then(() => resolve()));
        });
      });
    });
  });

  it("synthesizeStream is called with correct segments when browser sends a speak message", async () => {
    // Use a mock TTS client to verify the proxy relays browser messages correctly.
    const calls: Array<{ segments: string[]; voice?: string }> = [];
    const mockTtsClient: BailianStreamingTtsClient = {
      async synthesizeStream(input, handlers) {
        calls.push({ segments: input.segments, voice: input.voice });
        // Immediately complete without producing audio
        handlers.onComplete();
      }
    };

    const testApp = Fastify();
    await registerRealtimeVoiceRoutes(testApp, { streamingTtsClient: mockTtsClient });
    await testApp.ready();

    // Create a realtime voice session first (the TTS proxy reuses the sessions map)
    const sessionRes = await testApp.inject({
      method: "POST",
      url: "/api/realtime-voice/sessions",
      payload: {}
    });
    expect(sessionRes.statusCode).toBe(200);
    const { sessionId } = sessionRes.json() as { sessionId: string };

    await new Promise<void>((resolve, reject) => {
      const httpServer = testApp.server;
      httpServer.listen(0, "127.0.0.1", () => {
        const port = (httpServer.address() as { port: number }).port;
        const { WebSocket: WsClient } = require("ws") as typeof import("ws");
        const ws = new WsClient(`ws://127.0.0.1:${port}/api/realtime-voice/ws/tts/${sessionId}`);

        const received: string[] = [];
        ws.on("open", () => {
          ws.send(JSON.stringify({ type: "speak", segments: ["你好", "世界"] }));
        });
        ws.on("message", (data: Buffer) => {
          received.push(data.toString());
        });
        ws.on("close", () => {
          try {
            // Verify the proxy called synthesizeStream with our segments
            expect(calls).toHaveLength(1);
            expect(calls[0].segments).toEqual(["你好", "世界"]);
            // Verify the proxy sent tts.done after completion
            expect(received.some((m) => m.includes("tts.done"))).toBe(true);
            httpServer.close(() => testApp.close().then(() => resolve()));
          } catch (err) {
            httpServer.close(() => testApp.close().then(() => reject(err as Error)));
          }
        });
        ws.on("error", (err: Error) => {
          httpServer.close(() => testApp.close().then(() => reject(err)));
        });
        // Safety timeout — close ws after 1s if still open
        setTimeout(() => ws.close(), 1000);
      });
    });
  });

  it("closes with 4001 when no TTS client is provided and no API key env var is set (after session create)", async () => {
    const originalKey = process.env.DASHSCOPE_API_KEY;
    const originalBailian = process.env.BAILIAN_API_KEY;
    delete process.env.DASHSCOPE_API_KEY;
    delete process.env.BAILIAN_API_KEY;

    const testApp = Fastify();
    await registerRealtimeVoiceRoutes(testApp);
    await testApp.ready();

    const sessionRes = await testApp.inject({
      method: "POST",
      url: "/api/realtime-voice/sessions",
      payload: {}
    });
    const { sessionId } = sessionRes.json() as { sessionId: string };

    await new Promise<void>((resolve, reject) => {
      const httpServer = testApp.server;
      httpServer.listen(0, "127.0.0.1", () => {
        const port = (httpServer.address() as { port: number }).port;
        const { WebSocket: WsClient } = require("ws") as typeof import("ws");
        const ws = new WsClient(`ws://127.0.0.1:${port}/api/realtime-voice/ws/tts/${sessionId}`);
        ws.on("close", (code: number) => {
          try {
            expect(code).toBe(4001);
            if (originalKey !== undefined) process.env.DASHSCOPE_API_KEY = originalKey;
            if (originalBailian !== undefined) process.env.BAILIAN_API_KEY = originalBailian;
            httpServer.close(() => testApp.close().then(() => resolve()));
          } catch (err) {
            httpServer.close(() => testApp.close().then(() => reject(err as Error)));
          }
        });
        ws.on("error", () => { /* ignore upgrade-rejection errors */ });
      });
    });
  });

  it("为 TTS 浏览器 socket 安装可注入的心跳并在关闭后停止", async () => {
    const testApp = Fastify();
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => undefined);
    await registerRealtimeVoiceRoutes(testApp, {
      streamingTtsClient: {
        async synthesizeStream() {
          return undefined;
        }
      },
      heartbeatIntervalMs: 10,
      heartbeatMaxMissedPongs: 2,
      now: () => 1_000
    } as never);
    await testApp.ready();
    const sessionRes = await testApp.inject({
      method: "POST",
      url: "/api/realtime-voice/sessions",
      payload: {}
    });
    const { sessionId } = sessionRes.json() as { sessionId: string };
    await testApp.listen({ port: 0, host: "127.0.0.1" });
    const port = (testApp.server.address() as { port: number }).port;
    const { WebSocket: WsClient } = require("ws") as typeof import("ws");
    const ws = new WsClient(`ws://127.0.0.1:${port}/api/realtime-voice/ws/tts/${sessionId}`);

    try {
      await Promise.race([
        once(ws, "ping"),
        new Promise((_, reject) => setTimeout(() => reject(new Error("TTS proxy 未发送心跳")), 250))
      ]);
      ws.close(1000, "done");
      await once(ws, "close");
      await vi.waitFor(() => {
        const logs = infoSpy.mock.calls.map(([line]) => JSON.parse(String(line)) as Record<string, unknown>);
        expect(logs).toContainEqual({
          event: "realtime_proxy_browser_closed",
          sessionId,
          direction: "browser",
          code: 1000,
          reason: "done",
          phase: "ready",
          durationMs: 0
        });
      }, { timeout: 500, interval: 5 });
    } finally {
      if (ws.readyState !== WsClient.CLOSED) ws.terminate();
      await testApp.close();
      infoSpy.mockRestore();
    }
  });

  it("TTS browser 连续两个周期无 pong 后终止并中止合成与活跃会话", async () => {
    const testApp = Fastify();
    let synthesisSignal: AbortSignal | undefined;
    let abortCount = 0;
    const synthesizeStream = vi.fn(async (_input, _handlers, signal?: AbortSignal) => {
      synthesisSignal = signal;
      await new Promise<void>((resolve) => {
        if (signal?.aborted) {
          abortCount += 1;
          resolve();
          return;
        }
        signal?.addEventListener("abort", () => {
          abortCount += 1;
          resolve();
        }, { once: true });
      });
    });
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => undefined);
    await registerRealtimeVoiceRoutes(testApp, {
      streamingTtsClient: { synthesizeStream } as BailianStreamingTtsClient,
      heartbeatIntervalMs: 100,
      heartbeatMaxMissedPongs: 2
    } as never);
    await testApp.ready();
    const sessionRes = await testApp.inject({ method: "POST", url: "/api/realtime-voice/sessions", payload: {} });
    const { sessionId } = sessionRes.json() as { sessionId: string };
    await testApp.listen({ port: 0, host: "127.0.0.1" });
    const port = (testApp.server.address() as { port: number }).port;
    const { WebSocket: WsClient } = require("ws") as typeof import("ws");
    const ws = new WsClient(
      `ws://127.0.0.1:${port}/api/realtime-voice/ws/tts/${sessionId}`,
      { autoPong: false }
    );
    let browserPingCount = 0;
    const onBrowserPing = () => { browserPingCount += 1; };
    ws.on("ping", onBrowserPing);

    try {
      const closePromise = waitForWsClose(ws);
      const firstPing = waitForFirstBrowserPing(ws);
      await once(ws, "open");
      ws.send(JSON.stringify({ type: "speak", segments: ["需要被中止的合成"] }));
      await vi.waitFor(() => expect(synthesizeStream).toHaveBeenCalledOnce(), { timeout: 500, interval: 5 });
      await firstPing;

      expect(browserPingCount).toBe(1);
      expect(ws.readyState).toBe(WsClient.OPEN);
      expect(synthesisSignal?.aborted).toBe(false);
      expect(abortCount).toBe(0);
      await expectRealtimeSessionActivePastTtl(testApp, sessionId);

      const close = await closePromise;

      expect(close.code).toBe(1006);
      expect(browserPingCount).toBe(1);
      expect(synthesisSignal?.aborted).toBe(true);
      expect(abortCount).toBe(1);
      const logs = infoSpy.mock.calls.map(([line]) => JSON.parse(String(line)) as Record<string, unknown>);
      expect(logs).toContainEqual(expect.objectContaining({
        event: "realtime_proxy_heartbeat_timeout",
        sessionId,
        direction: "browser"
      }));
      await expectRealtimeSessionExpired(testApp, sessionId);
    } finally {
      ws.off("ping", onBrowserPing);
      if (ws.readyState !== WsClient.CLOSED) ws.terminate();
      await testApp.close();
      infoSpy.mockRestore();
    }
  });
});

describe("realtime-voice GET /api/realtime-voice/voices — 配置态 preset / 上游失败 502", () => {
  it("returns cosyvoice presets (not empty) when voiceEnrollmentClient is absent", async () => {
    const lonelyApp = Fastify();
    await registerRealtimeVoiceRoutes(lonelyApp); // no voiceEnrollmentClient
    await lonelyApp.ready();

    const res = await lonelyApp.inject({
      method: "GET",
      url: "/api/realtime-voice/voices"
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as { preset: Array<{ voice: string; name: string }>; custom: unknown[] };

    expect(body.custom).toEqual([]);

    const voices = body.preset.map((v) => v.voice);
    expect(voices).toContain("longanyang");
    expect(voices).toContain("longanhuan");

    const longanyang = body.preset.find((v) => v.voice === "longanyang");
    const longanhuan = body.preset.find((v) => v.voice === "longanhuan");
    expect(longanyang?.name).toBe("龙安洋·阳光男声");
    expect(longanhuan?.name).toBe("龙安欢·元气女声");

    await lonelyApp.close();
  });

  // 真实性重构:上游失败不再用预置列表冒充查询结果(那会隐藏用户的自定义克隆音色)——如实 502。
  it("voiceEnrollmentClient 上游失败 → 502（不再回 preset 冒充查询结果）", async () => {
    const failingClient = {
      listVoices: async () => { throw new Error("network error"); },
      createVoice: async () => { throw new Error("network error"); }
    };
    const testApp = Fastify();
    await registerRealtimeVoiceRoutes(testApp, { voiceEnrollmentClient: failingClient as never });
    await testApp.ready();

    const res = await testApp.inject({
      method: "GET",
      url: "/api/realtime-voice/voices"
    });

    expect(res.statusCode).toBe(502);
    const body = res.json() as { error: string };
    expect(body.error).toContain("音色列表查询失败");
    expect(body.error).toContain("network error");

    await testApp.close();
  });
});

describe("realtime-voice POST /sessions — enginePolicy (P1-21)", () => {
  let app: FastifyInstance;
  let stateRepo: ProductStateRepository;

  beforeEach(async () => {
    app = Fastify();
    const initial = createInitialProductState();
    stateRepo = createInMemoryProductStateRepository(initial);
    await registerRealtimeVoiceRoutes(app, { stateRepo });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it("returns enginePolicy when interviewSessionId links to a session that has enginePolicy", async () => {
    const { createInterviewSession } = await import("../../../../src/domain/engine");
    const { generateSessionId } = await import("../../../../src/domain/identifiers");

    const sid = generateSessionId();
    const enginePolicy: InterviewEnginePolicy = {
      allowWebInInterview: false,
      maxFollowUpDepth: 3,
      silenceHoldMs: 1000,
      playbookVersion: "v-test-1",
      appliedPlaybookRules: ["具体时刻", "追问"],
      qualityGuardrails: ["no_filler"],
      memory: { includeSensitiveMemoriesInContext: false, includePendingCandidatesInContext: false, externalMaterialMemoryPolicy: "review-only" },
      guidanceEnabled: true,
      guidanceFrequency: "medium",
      maxGuidancePerTurn: 2,
      minGuidanceIntervalMs: 5000,
      challengeBudgetPerSession: 3
    };
    const session: InterviewSession = {
      ...createInterviewSession({ id: sid, title: "Test with policy", createdAt: new Date().toISOString() }),
      enginePolicy
    };
    stateRepo.replaceState({ ...stateRepo.getState(), sessions: [session] });

    const res = await app.inject({
      method: "POST",
      url: "/api/realtime-voice/sessions",
      payload: { interviewSessionId: sid }
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.enginePolicy).toBeDefined();
    expect(body.enginePolicy.playbookVersion).toBe("v-test-1");
    expect(body.enginePolicy.maxFollowUpDepth).toBe(3);
    expect(body.enginePolicy.allowWebInInterview).toBe(false);
  });

  it("returns enginePolicy (default from state) when linked session has no enginePolicy set", async () => {
    const { createInterviewSession } = await import("../../../../src/domain/engine");
    const { generateSessionId } = await import("../../../../src/domain/identifiers");

    const sid = generateSessionId();
    const session = createInterviewSession({ id: sid, title: "Test no policy", createdAt: new Date().toISOString() });
    // session.enginePolicy is undefined by default
    stateRepo.replaceState({ ...stateRepo.getState(), sessions: [session] });

    const res = await app.inject({
      method: "POST",
      url: "/api/realtime-voice/sessions",
      payload: { interviewSessionId: sid }
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.enginePolicy).toBeDefined();
    // Default policy must have required fields
    expect(typeof body.enginePolicy.maxFollowUpDepth).toBe("number");
    expect(typeof body.enginePolicy.silenceHoldMs).toBe("number");
    expect(typeof body.enginePolicy.playbookVersion).toBe("string");
  });

  it("returns enginePolicy (default) when no interviewSessionId is given but stateRepo is present", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/realtime-voice/sessions",
      payload: {}
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.enginePolicy).toBeDefined();
    expect(typeof body.enginePolicy.maxFollowUpDepth).toBe("number");
  });

  it("enginePolicy is absent when no stateRepo is configured", async () => {
    const lonelyApp = Fastify();
    await registerRealtimeVoiceRoutes(lonelyApp);
    await lonelyApp.ready();
    const res = await lonelyApp.inject({
      method: "POST",
      url: "/api/realtime-voice/sessions",
      payload: {}
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.enginePolicy).toBeUndefined();
    await lonelyApp.close();
  });
});
