// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { createServer } from "node:http";
import { createInitialProductState } from "../../../../src/domain/engine";
import {
  createInMemoryProductStateRepository,
  type ProductStateRepository
} from "../product-state-repository";
import { registerRealtimeVoiceRoutes } from "./realtime-voice";
import type { BailianStreamingTtsClient } from "../providers/bailian-streaming-tts";
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

  it("closes with 4001 when no TTS client is provided and no API key env var is set", async () => {
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
});
