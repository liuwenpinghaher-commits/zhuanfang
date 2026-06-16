// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { createInitialProductState } from "../../../../src/domain/engine";
import {
  createInMemoryProductStateRepository,
  type ProductStateRepository
} from "../product-state-repository";
import { registerRealtimeVoiceRoutes } from "./realtime-voice";
import type { InterviewSession } from "../../../../src/domain/types";

function buildAssistantSession(content: string): InterviewSession {
  return {
    id: "sess-1",
    mode: "daily",
    strength: "standard",
    status: "active",
    title: "实时打断回填测试",
    card: { historyReferences: [], suggestedPerspectives: [] } as unknown as InterviewSession["card"],
    guide: { questions: [] } as unknown as InterviewSession["guide"],
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
