/** Helpers split from realtime-voice.ts */
import { recordVoiceLatency } from "../observability/runtime-metrics";
import type { FastifyInstance } from "fastify";
import type { IncomingMessage } from "node:http";
import { randomUUID } from "node:crypto";
import { isAuthGuardActive, isAuthorized, readCookieToken } from "../auth";
import { WebSocketServer, WebSocket } from "ws";
import {
  attachWebSocketHeartbeat,
  buildRealtimeProxyLog
} from "../realtime/websocketResilience";
import { connectRealtimeAsrProxy } from "../realtime/asrProxyConnection";
import {
  resolveBailianRealtimeModels,
  type BailianRealtimeVoiceClient,
  type BailianVoiceEnrollmentClient,
  type BailianEmbeddingClient
} from "../providers/bailian";
import { COSYVOICE_PRESET_VOICES } from "../voice-presets";
import {
  createBailianStreamingTtsClient,
  STREAMING_TTS_SAMPLE_RATE,
  type BailianStreamingTtsClient
} from "../providers/bailian-streaming-tts";
import type { ProductStateRepository } from "../product-state-repository";
import { replaceStateDurable } from "../product-state-repository";
import { asNativeRecall } from "../recall/native-recall-capability";
import { resolveBailianApiKey } from "../runtime-secrets";
import { prefetchRecall } from "../recall/prefetch-recall";
import {
  applyMidSessionCardRefresh,
  buildInterviewContextPack,
  resolveInterviewTopicHint,
  resolveMidSessionRecallTopic
} from "../../../../src/domain/context-pack";
import { mergeInterviewSessionRefresh } from "../../../../src/domain/session-merge";
import {
  appendRealtimeSignalTrace,
  buildInterviewEnginePolicy,
  truncateAssistantTurn
} from "../../../../src/domain/engine";
import { stripSpokenAsides } from "../../../../src/domain/speech-text";
import type {
  AiRunEvent,
  InterviewEnginePolicy,
  InterviewSession,
  ProductState,
  RealtimeSignal,
  RealtimeTurnState
} from "../../../../src/domain/types";

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

export interface RealtimeVoiceRouteOptions {
  bailianRealtimeVoiceClient?: BailianRealtimeVoiceClient;
  voiceEnrollmentClient?: BailianVoiceEnrollmentClient;
  stateRepo?: ProductStateRepository;
  /** 🔴-1: embeds the latest user utterance so livekit agent-context recall tracks the conversation. */
  embeddingClient?: BailianEmbeddingClient;
  /**
   * Injectable streaming TTS client for the TTS WebSocket proxy.
   * When omitted the proxy constructs one at upgrade time from the
   * DASHSCOPE_API_KEY / BAILIAN_API_KEY env var. If neither is set,
   * the upgrade is rejected with close code 4001.
   */
  streamingTtsClient?: BailianStreamingTtsClient;
  /** Runtime env for auth checks on the raw WS upgrade path (which bypasses Fastify hooks). */
  env?: Record<string, string | undefined>;
  /**
   * IV-P0-02: GET agent-context may persist guide/card refresh. GET bypasses the mutating
   * write preHandler, so final merge must re-enter writeGate (re-read+merge inside).
   */
  writeGate?: { runExclusive<T>(label: string, fn: () => Promise<T> | T): Promise<T> };
  createRealtimeUpstream?: (url: string, options: { headers: Record<string, string> }) => WebSocket;
  heartbeatIntervalMs?: number;
  heartbeatMaxMissedPongs?: number;
  realtimeHandshakeTimeoutMs?: number;
  now?: () => number;
}

export interface RealtimeVoiceSessionPayload {
  instructions?: unknown;
  interviewSessionId?: unknown;
  voice?: unknown;
}

export interface RealtimeVoiceSessionRecord extends RealtimeVoiceConfig {
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
  enginePolicy?: InterviewEnginePolicy;
  expiresAt: string;
}

// 🔴-1: embed the latest user utterance for semantic memory recall in agent-context.
// 配置边界:无 client / 空文本 → undefined(关键词召回配置态)。运行时 embed 失败 → 抛错,
// 由路由如实 5xx,不再静默退化成关键词召回。Mirrors embedQueryText in
// interview-sessions.ts (kept local to avoid cross-route coupling).
export async function embedRecallQuery(
  text: string | undefined,
  embeddingClient: BailianEmbeddingClient | undefined
): Promise<number[] | undefined> {
  const trimmed = text?.trim();
  if (!embeddingClient || !trimmed) {
    return undefined;
  }
  try {
    const vectors = await embeddingClient.embed([trimmed]);
    const vector = vectors[0];
    return Array.isArray(vector) && vector.length > 0 ? vector : undefined;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(JSON.stringify({ event: "agent_context_embed_failed", error: message }));
    throw new Error(`召回嵌入失败：${message}`);
  }
}



export function buildRealtimeVoiceConfig(env: Record<string, string | undefined>): RealtimeVoiceConfig {
  const apiKeyConfigured = Boolean(resolveBailianApiKey(env));
  // Public DashScope WebRTC signaling is always available; env override is optional (no whitelist).
  const webrtcEndpointConfigured = true;
  const transport = normalizeTransport(env.BAILIAN_REALTIME_TRANSPORT);
  const configured = apiKeyConfigured;
  const { model, fallbackModel } = resolveBailianRealtimeModels(env);
  return {
    provider: "bailian",
    model,
    fallbackModel,
    transport,
    fallbackTransport: "websocket",
    vad: normalizeVad(env.BAILIAN_REALTIME_VAD),
    enableSearch: env.BAILIAN_REALTIME_ENABLE_SEARCH === "true",
    configured,
    apiKeyConfigured,
    webrtcEndpointConfigured,
    requiresServerSession: true
  };
}

export function normalizeTransport(value: string | undefined): RealtimeVoiceConfig["transport"] {
  return value === "webrtc" ? "webrtc" : "websocket";
}

export function normalizeVad(value: string | undefined): RealtimeVoiceConfig["vad"] {
  return value === "client_vad" ? "client_vad" : "server_vad";
}

// P1-02: allow-set for WS Origin validation. Mirrors registerCors in server.ts —
// PRODUCT_WEB_ORIGINS (comma-separated production origins) when set, otherwise the Vite
// dev-server origins so local development connects with zero config.
const WS_DEV_ORIGINS = ["http://127.0.0.1:3220", "http://localhost:3220"];
export function isAllowedWsOrigin(origin: string, env: Record<string, string | undefined>): boolean {
  const configured = env.PRODUCT_WEB_ORIGINS
    ? env.PRODUCT_WEB_ORIGINS.split(",").map((o) => o.trim()).filter(Boolean)
    : null;
  const allowed = configured ?? WS_DEV_ORIGINS;
  return allowed.includes(origin);
}

export function buildDefaultEnginePolicy(state: ProductState): InterviewEnginePolicy {
  // P0-C: delegate to the canonical domain policy builder instead of hand-rolling the object
  // with `qualityGuardrails: []`. buildInterviewEnginePolicy fills qualityGuardrails with the
  // real remediation text the domain produces. 域层抛错就向上抛(由路由如实 5xx)——
  // 不再回退"config 拼装 + 空 guardrails"的替身策略掩盖域层缺陷。
  return buildInterviewEnginePolicy(state);
}

export function resolveEnginePolicy(
  interviewSessionId: string | undefined,
  stateRepo: { getState(): ProductState; getInterviewSession(id: string): InterviewSession | null } | undefined
): InterviewEnginePolicy | undefined {
  if (!stateRepo) return undefined;
  const state = stateRepo.getState();
  if (interviewSessionId) {
    const session = stateRepo.getInterviewSession(interviewSessionId);
    if (session?.enginePolicy) return session.enginePolicy;
  }
  return buildDefaultEnginePolicy(state);
}

export function createRealtimeVoiceSession(
  payload: RealtimeVoiceSessionPayload,
  realtimeClient: BailianRealtimeVoiceClient | undefined,
  stateRepo: { getState(): ProductState; getInterviewSession(id: string): InterviewSession | null } | undefined,
  env: Record<string, string | undefined>
): RealtimeVoiceSessionRecord {
  const config = buildRealtimeVoiceConfig(env);
  const sessionId = `rtv-${randomUUID()}`;
  const signalingPath = `/api/realtime-voice/sessions/${sessionId}/webrtc/answer`;
  const instructions = normalizeInstructions(payload.instructions);
  const interviewSessionId = normalizeOptionalString(payload.interviewSessionId);
  const enginePolicy = resolveEnginePolicy(interviewSessionId, stateRepo);

  return {
    ...config,
    status: config.configured
      ? "ready"
      : "not-configured",
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
        voice: normalizeOptionalString(payload.voice) ?? env.BAILIAN_REALTIME_VOICE ?? "Ethan",
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
    interviewSessionId,
    enginePolicy,
    expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString()
  };
}

export function normalizeInstructions(value: unknown) {
  return typeof value === "string" && value.trim()
    ? value.trim()
    : "你是一个真正的私人专访主持人，不是聊天助手也不是客服。这是对同一个人的持续跟踪——开场直接从一个跟踪点（上次要追的问题/反复出现的主题/未还的知识债）切入，绝不寒暄、不自我介绍、不要问'最近怎么样'。每次只问一个核心问题，优先追具体事件、真实张力和可验证假设。";
}

export function normalizeOptionalString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/**
 * Map a requested TTS voice to one CosyVoice v3 will accept.
 * The product config stores semantic aliases (warm-interviewer / calm-host) that
 * are product labels, NOT CosyVoice voice IDs — forwarding them to cosyvoice-v3-plus
 * yields engine error 418. Return undefined for aliases/empties so the streaming
 * client falls back to its v3 default (longanyang). Real v3 voice IDs pass through.
 * Mirrors the podcast route's voice normalization.
 */
const TTS_SEMANTIC_ALIASES = new Set(["warm-interviewer", "calm-host"]);
export function normalizeCosyVoice(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const v = value.trim();
  if (!v || TTS_SEMANTIC_ALIASES.has(v)) return undefined;
  return v;
}

// CosyVoice 官方情绪枚举白名单——只放行这 7 个值进 instruction 模板,杜绝把任意浏览器文本拼进
// 「你说话的情感是<...>。」(既防 428,也防 instruction 注入)。
const TTS_EMOTIONS = new Set(["neutral", "happy", "sad", "angry", "surprised", "fearful", "disgusted"]);

// The prosody comes from the browser, so clamp it to a safe range before forwarding to
// CosyVoice — a bad value must not produce cartoonish or rejected synthesis.
export function normalizeProsody(value: unknown): { emotion?: string; rate: number; pitch: number; volume: number } | undefined {
  if (!value || typeof value !== "object") return undefined;
  const v = value as { emotion?: unknown; rate?: unknown; pitch?: unknown; volume?: unknown };
  const num = (x: unknown, lo: number, hi: number, fallback: number) =>
    typeof x === "number" && Number.isFinite(x) ? Math.min(hi, Math.max(lo, x)) : fallback;
  const emotion = typeof v.emotion === "string" && TTS_EMOTIONS.has(v.emotion) ? v.emotion : undefined;
  return {
    ...(emotion ? { emotion } : {}),
    rate: num(v.rate, 0.5, 2, 1),
    pitch: num(v.pitch, 0.5, 2, 1),
    volume: num(v.volume, 1, 100, 50)
  };
}

export function getSessionId(params: unknown) {
  if (!params || typeof params !== "object") {
    return undefined;
  }
  const id = (params as { id?: unknown }).id;
  return typeof id === "string" && id ? id : undefined;
}

export function normalizeObject<T>(value: unknown): Partial<T> {
  return value && typeof value === "object" ? (value as Partial<T>) : {};
}

export interface InterruptPayload {
  spokenTextSoFar?: unknown;
  interruptedAtMs?: unknown;
  assistantTurnId?: unknown;
  providerTurnId?: unknown;
  reason?: unknown;
}

export interface AppendInterruptionSignalInput {
  spokenTextSoFar: string;
  interruptedAtMs?: number;
  assistantTurnId?: string;
  providerTurnId?: string;
  originalChars: number;
  spokenChars: number;
  reason: "user_interrupt" | "provider_error";
}

export function appendInterruptionSignal(session: InterviewSession, input: AppendInterruptionSignalInput): InterviewSession {
  const realtimeState: RealtimeTurnState = {
    phase: "listening",
    nextAction: "等待用户继续",
    shouldInterrupt: true,
    confidence: 0.9
  };
  const signal: RealtimeSignal = {
    inputLevel: 0,
    silenceMs: 0,
    isUserSpeaking: false,
    isAssistantSpeaking: false
  };
  const next = appendRealtimeSignalTrace(session, signal, realtimeState, {
    transcript: input.spokenTextSoFar
  });
  const traces = next.realtimeSignals ?? [];
  if (traces.length === 0) return next;
  const lastIndex = traces.length - 1;
  const lastTrace = {
    ...traces[lastIndex],
    eventType: "agent_speech_interrupted" as const,
    spokenTextSoFar: input.spokenTextSoFar,
    truncatedFromChars: input.originalChars,
    assistantTurnId: input.assistantTurnId ?? traces[lastIndex].assistantTurnId,
    metrics: {
      interruptedAtMs: input.interruptedAtMs,
      spokenCharsBeforeInterrupt: input.spokenChars
    }
  };
  const nextTraces = [...traces];
  nextTraces[lastIndex] = lastTrace;
  return { ...next, realtimeSignals: nextTraces };
}

export function replaceSession(state: ProductState, session: InterviewSession): ProductState {
  return {
    ...state,
    sessions: state.sessions.map((entry) => (entry.id === session.id ? session : entry))
  };
}

export interface InterruptAiRunEventInput {
  session: InterviewSession;
  assistantTurnId?: string;
  providerTurnId?: string;
  spokenChars: number;
  originalChars: number;
  interruptedAtMs?: number;
  truncated: boolean;
  reason: "user_interrupt" | "provider_error";
}

export function withRealtimeInterruptAiRunEvent(state: ProductState, input: InterruptAiRunEventInput): ProductState {
  const event: AiRunEvent = {
    id: `ai-run-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
    workflow: "interview_turn_generation",
    providerId: "bailian-realtime",
    status: input.truncated ? "succeeded" : "degraded",
    entityType: "interview_session",
    entityId: input.session.id,
    inputSummary: `实时打断回填：spokenChars=${input.spokenChars} reason=${input.reason}`,
    outputSummary: input.truncated
      ? `assistant turn 已截断为 ${input.spokenChars}/${input.originalChars} 字`
      : "未找到匹配的 assistant turn 或无须截断",
    degradedReason: input.truncated ? undefined : "未匹配到 assistant turn 或 spokenTextSoFar 为空",
    metrics: {
      interruptedAtMs: input.interruptedAtMs,
      spokenCharsBeforeInterrupt: input.spokenChars
    },
    createdAt: new Date().toISOString()
  };
  return {
    ...state,
    aiRunEvents: [event, ...(state.aiRunEvents ?? [])]
  };
}
