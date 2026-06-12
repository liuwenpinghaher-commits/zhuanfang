import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import type { BailianRealtimeVoiceClient } from "../providers/bailian";

export interface RealtimeVoiceConfig {
  provider: "bailian";
  model: string;
  fallbackModel: string;
  transport: "webrtc" | "websocket";
  fallbackTransport: "websocket";
  vad: "server_vad" | "client_vad";
  enableSearch: boolean;
  configured: boolean;
  apiKeyConfigured: boolean;
  webrtcEndpointConfigured: boolean;
  requiresServerSession: boolean;
}

interface RealtimeVoiceRouteOptions {
  bailianRealtimeVoiceClient?: BailianRealtimeVoiceClient;
}

interface RealtimeVoiceSessionPayload {
  instructions?: unknown;
  interviewSessionId?: unknown;
}

interface RealtimeVoiceSessionRecord extends RealtimeVoiceConfig {
  sessionId: string;
  status: "ready" | "not-configured" | "needs-webrtc-endpoint";
  signaling: {
    method: "POST";
    path: string;
    contentType: "application/sdp";
  };
  sessionUpdate: {
    type: "session.update";
    session: {
      modalities: ["text", "audio"];
      voice: string;
      input_audio_format: "pcm";
      output_audio_format: "pcm";
      instructions: string;
      turn_detection: {
        type: "server_vad" | "semantic_vad";
        threshold: number;
        silence_duration_ms: number;
      };
    };
  };
  interviewSessionId?: string;
  expiresAt: string;
}

export async function registerRealtimeVoiceRoutes(server: FastifyInstance, options: RealtimeVoiceRouteOptions = {}) {
  const sessions = new Map<string, RealtimeVoiceSessionRecord>();
  server.addContentTypeParser("application/sdp", { parseAs: "string" }, (_request, body, done) => {
    done(null, body);
  });

  server.get("/api/realtime-voice/config", async () => buildRealtimeVoiceConfig());
  server.post("/api/realtime-voice/sessions", async (request) => {
    const record = createRealtimeVoiceSession(normalizeObject<RealtimeVoiceSessionPayload>(request.body), options.bailianRealtimeVoiceClient);
    sessions.set(record.sessionId, record);
    return record;
  });
  server.post("/api/realtime-voice/sessions/:id/webrtc/answer", async (request, reply) => {
    const sessionId = getSessionId(request.params);
    const record = sessionId ? sessions.get(sessionId) : undefined;
    if (!record) {
      return reply.code(404).send({ error: "Realtime voice session not found." });
    }
    if (!options.bailianRealtimeVoiceClient) {
      return reply.code(503).send({ error: "Bailian Realtime WebRTC endpoint is not configured." });
    }

    const offerSdp = typeof request.body === "string" ? request.body : "";
    if (!offerSdp.trim()) {
      return reply.code(422).send({ error: "Offer SDP is required." });
    }

    const answerSdp = await options.bailianRealtimeVoiceClient.createWebrtcAnswer({
      model: record.model,
      offerSdp
    });
    return reply.type("application/sdp").send(answerSdp);
  });
}

function buildRealtimeVoiceConfig(): RealtimeVoiceConfig {
  const apiKeyConfigured = Boolean(process.env.DASHSCOPE_API_KEY ?? process.env.BAILIAN_API_KEY);
  const webrtcEndpointConfigured = Boolean(process.env.BAILIAN_REALTIME_WEBRTC_ENDPOINT);
  return {
    provider: "bailian",
    model: process.env.BAILIAN_REALTIME_MODEL ?? "qwen3.5-omni-plus-realtime",
    fallbackModel: process.env.BAILIAN_REALTIME_FALLBACK_MODEL ?? "qwen3.5-omni-flash-realtime",
    transport: normalizeTransport(process.env.BAILIAN_REALTIME_TRANSPORT),
    fallbackTransport: "websocket",
    vad: normalizeVad(process.env.BAILIAN_REALTIME_VAD),
    enableSearch: process.env.BAILIAN_REALTIME_ENABLE_SEARCH === "true",
    configured: apiKeyConfigured,
    apiKeyConfigured,
    webrtcEndpointConfigured,
    requiresServerSession: true
  };
}

function normalizeTransport(value: string | undefined): RealtimeVoiceConfig["transport"] {
  return value === "websocket" ? "websocket" : "webrtc";
}

function normalizeVad(value: string | undefined): RealtimeVoiceConfig["vad"] {
  return value === "client_vad" ? "client_vad" : "server_vad";
}

function createRealtimeVoiceSession(
  payload: RealtimeVoiceSessionPayload,
  realtimeClient: BailianRealtimeVoiceClient | undefined
): RealtimeVoiceSessionRecord {
  const config = buildRealtimeVoiceConfig();
  const sessionId = `rtv-${randomUUID()}`;
  const signalingPath = `/api/realtime-voice/sessions/${sessionId}/webrtc/answer`;
  const instructions = normalizeInstructions(payload.instructions);

  return {
    ...config,
    status: realtimeClient ? "ready" : config.apiKeyConfigured ? "needs-webrtc-endpoint" : "not-configured",
    sessionId,
    signaling: {
      method: "POST",
      path: signalingPath,
      contentType: "application/sdp"
    },
    sessionUpdate: {
      type: "session.update",
      session: {
        modalities: ["text", "audio"],
        voice: process.env.BAILIAN_REALTIME_VOICE ?? "Ethan",
        input_audio_format: "pcm",
        output_audio_format: "pcm",
        instructions,
        turn_detection: {
          type: config.vad === "client_vad" ? "server_vad" : config.vad,
          threshold: 0.5,
          silence_duration_ms: 800
        }
      }
    },
    interviewSessionId: normalizeOptionalString(payload.interviewSessionId),
    expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString()
  };
}

function normalizeInstructions(value: unknown) {
  return typeof value === "string" && value.trim()
    ? value.trim()
    : "你是一个真正的私人专访主持人。每次只问一个核心问题，优先追具体事件、真实张力和可验证假设。";
}

function normalizeOptionalString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function getSessionId(params: unknown) {
  if (!params || typeof params !== "object") {
    return undefined;
  }
  const id = (params as { id?: unknown }).id;
  return typeof id === "string" && id ? id : undefined;
}

function normalizeObject<T>(value: unknown): Partial<T> {
  return value && typeof value === "object" ? (value as Partial<T>) : {};
}
