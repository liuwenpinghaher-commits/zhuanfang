import type { FastifyInstance } from "fastify";
import type { IncomingMessage } from "node:http";
import { randomUUID } from "node:crypto";
import { isAuthGuardActive, isAuthorized } from "../auth";
import { WebSocketServer, WebSocket } from "ws";
import type { BailianRealtimeVoiceClient, BailianVoiceEnrollmentClient, BailianEmbeddingClient } from "../providers/bailian";
import { COSYVOICE_PRESET_VOICES } from "../voice-presets";
import {
  createBailianStreamingTtsClient,
  STREAMING_TTS_SAMPLE_RATE,
  type BailianStreamingTtsClient
} from "../providers/bailian-streaming-tts";
import type { ProductStateRepository } from "../product-state-repository";
import { asNativeRecall } from "../recall/native-recall-capability";
import { prefetchRecall } from "../recall/prefetch-recall";
import { resolveInterviewTopicHint } from "../../../../src/domain/context-pack";
import {
  appendRealtimeSignalTrace,
  buildInterviewEnginePolicy,
  truncateAssistantTurn
} from "../../../../src/domain/engine";
import { collectAppliedPlaybookRules, collectAppliedPlaybookRuleTypes } from "../../../../src/domain/context-pack";
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

interface RealtimeVoiceRouteOptions {
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
}

interface RealtimeVoiceSessionPayload {
  instructions?: unknown;
  interviewSessionId?: unknown;
  voice?: unknown;
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
  enginePolicy?: InterviewEnginePolicy;
  expiresAt: string;
}

// 🔴-1: embed the latest user utterance for semantic memory recall in agent-context.
// Fail-safe — undefined on no client / empty text / embed error, so recall silently
// degrades to keyword ranking (unchanged behaviour). Mirrors embedQueryText in
// interview-sessions.ts (kept local to avoid cross-route coupling).
async function embedRecallQuery(
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
    console.warn(
      JSON.stringify({ event: "agent_context_embed_failed", error: error instanceof Error ? error.message : String(error) })
    );
    return undefined;
  }
}

export async function registerRealtimeVoiceRoutes(server: FastifyInstance, options: RealtimeVoiceRouteOptions = {}) {
  const sessions = new Map<string, RealtimeVoiceSessionRecord>();
  const runtimeEnv = options.env ?? process.env;

  // 过期会话清理:记录带 expiresAt(10 分钟)但此前无人读取/无清理 → Map 单调增长且过期会话仍可被
  // WS 升级命中(expiresAt 形同虚设)。lazy 校验 + 创建时清扫,界定内存并让过期凭据失效。
  function pruneExpiredSessions(): void {
    const now = Date.now();
    for (const [id, rec] of sessions) {
      if (Date.parse(rec.expiresAt) <= now) sessions.delete(id);
    }
  }
  // 审计修复(P1-5):TTL 改为滑动续期——此前只在创建时设 10 分钟且从不续期,而产品核心场景
  // 就是长访谈:>10min 后 /interrupt 静默失效(截断跳过但仍回 interrupted:true → 归档失真)、
  // cascade TTS WS 断线重连撞 404 直到会话结束。活跃访问即续期;真僵尸(无流量)照旧过期。
  const SESSION_TTL_MS = 10 * 60 * 1000;
  function liveSession(id: string | undefined): RealtimeVoiceSessionRecord | undefined {
    if (!id) return undefined;
    const rec = sessions.get(id);
    if (!rec) return undefined;
    if (Date.parse(rec.expiresAt) <= Date.now()) {
      sessions.delete(id);
      return undefined;
    }
    rec.expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();
    return rec;
  }

  server.addContentTypeParser("application/sdp", { parseAs: "string" }, (_request, body, done) => {
    done(null, body);
  });

  const cosyvoiceFallbackPreset = COSYVOICE_PRESET_VOICES.map((v) => ({
    voice: v.voice,
    name: v.name,
    description: v.name,
    targetModel: undefined as string | undefined,
    createdAt: undefined as string | undefined
  }));

  server.get("/api/realtime-voice/voices", async () => {
    if (!options.voiceEnrollmentClient) {
      return { preset: cosyvoiceFallbackPreset, custom: [] };
    }
    try {
      const voices = await options.voiceEnrollmentClient.listVoices();
      const preset = voices.filter((v) => !v.targetModel || v.targetModel === "qwen3.5-omni-plus-realtime");
      const custom = voices.filter((v) => v.targetModel && v.targetModel !== "qwen3.5-omni-plus-realtime");
      return { preset, custom };
    } catch (err) {
      // 审计修复(P3):上游查询失败时此前零日志静默隐藏自定义克隆音色。保留回退但响亮+可判别。
      console.warn(JSON.stringify({ event: "voice_list_degraded", error: err instanceof Error ? err.message : String(err) }));
      return { preset: cosyvoiceFallbackPreset, custom: [], degraded: true };
    }
  });

  server.post("/api/realtime-voice/voices", async (request, reply) => {
    if (!options.voiceEnrollmentClient) {
      return reply.code(503).send({ error: "Voice enrollment is not configured." });
    }
    const body = request.body as { audioBase64?: string; preferredName?: string } | undefined;
    if (!body?.audioBase64) {
      return reply.code(422).send({ error: "audioBase64 is required." });
    }
    try {
      const voice = await options.voiceEnrollmentClient.createVoice({
        audioBase64: body.audioBase64,
        preferredName: body.preferredName
      });
      return voice;
    } catch (err) {
      // 不把上游 provider 原始错误(可能含内部 endpoint/模型名/配额提示)回传客户端。
      console.warn(JSON.stringify({ event: "voice_create_failed", error: err instanceof Error ? err.message : String(err) }));
      return reply.code(500).send({ error: "Voice creation failed." });
    }
  });

  server.delete("/api/realtime-voice/voices/:voiceId", async (request, reply) => {
    if (!options.voiceEnrollmentClient) {
      return reply.code(503).send({ error: "Voice enrollment is not configured." });
    }
    const voiceId = (request.params as { voiceId?: string }).voiceId;
    if (!voiceId) {
      return reply.code(422).send({ error: "voiceId is required." });
    }
    try {
      await options.voiceEnrollmentClient.deleteVoice(voiceId);
      return { deleted: true };
    } catch (err) {
      console.warn(JSON.stringify({ event: "voice_delete_failed", error: err instanceof Error ? err.message : String(err) }));
      return reply.code(500).send({ error: "Voice deletion failed." });
    }
  });

  server.get("/api/realtime-voice/config", async () => buildRealtimeVoiceConfig(runtimeEnv));
  server.post("/api/realtime-voice/sessions", async (request) => {
    pruneExpiredSessions();
    const record = createRealtimeVoiceSession(
      normalizeObject<RealtimeVoiceSessionPayload>(request.body),
      options.bailianRealtimeVoiceClient,
      options.stateRepo,
      runtimeEnv
    );
    sessions.set(record.sessionId, record);
    return record;
  });
  // 端点定位(审计说明):WebRTC 语音信令(SDP answer 交换)。WebRTC 传输通道尚未完成、当前强制回退
  // WebSocket(见前端 realtimeMode),故本端点暂无生产流量。保留作 WebRTC 通道的半成品骨架(删除
  // 将来重做成本高),未接入不是遗漏。启用 WebRTC 时前端 exchangeRealtimeVoiceSdp 会调它。
  server.post("/api/realtime-voice/sessions/:id/webrtc/answer", async (request, reply) => {
    const sessionId = getSessionId(request.params);
    const record = sessionId ? liveSession(sessionId) : undefined;
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
  server.post("/api/realtime-voice/sessions/:id/interrupt", async (request, reply) => {
    const sessionId = getSessionId(request.params);
    if (!sessionId) {
      return reply.code(400).send({ error: "sessionId is required." });
    }
    const record = liveSession(sessionId);
    // 审计修复(P1-5 对偶):会话已过期/不存在时,此前静默跳过截断却回 interrupted:true——
    // 逐字稿保留用户没听到的助手长文,归档失真且零信号。改为如实 410,客户端可感知。
    if (!record) {
      return reply.code(410).send({ error: "Realtime voice session expired or not found.", interrupted: false });
    }
    const body = normalizeObject<InterruptPayload>(request.body);
    const spokenTextSoFar = typeof body.spokenTextSoFar === "string" ? body.spokenTextSoFar : "";
    const interruptedAtMs =
      typeof body.interruptedAtMs === "number" && Number.isFinite(body.interruptedAtMs)
        ? Math.max(0, Math.round(body.interruptedAtMs))
        : undefined;
    const assistantTurnId = normalizeOptionalString(body.assistantTurnId);
    const providerTurnId = normalizeOptionalString(body.providerTurnId);
    const reason: "user_interrupt" | "provider_error" =
      body.reason === "provider_error" ? "provider_error" : "user_interrupt";

    const interviewSessionId = record?.interviewSessionId;
    const stateRepo = options.stateRepo;

    let truncated = false;
    let spokenChars = spokenTextSoFar.length;
    let originalChars = spokenTextSoFar.length;
    let resolvedAssistantTurnId: string | undefined = assistantTurnId;

    if (stateRepo && interviewSessionId) {
      const state = stateRepo.getState();
      const session = state.sessions.find((entry) => entry.id === interviewSessionId);
      if (session) {
        const truncationResult = truncateAssistantTurn(session, {
          turnId: assistantTurnId,
          providerTurnId,
          spokenTextSoFar,
          reason
        });
        if (truncationResult.changed && truncationResult.truncatedTurn) {
          truncated = true;
          spokenChars = truncationResult.truncatedTurn.truncated?.spokenChars ?? spokenChars;
          originalChars = truncationResult.truncatedTurn.truncated?.originalChars ?? originalChars;
          resolvedAssistantTurnId = truncationResult.truncatedTurn.id;
        } else if (truncationResult.truncatedTurn) {
          resolvedAssistantTurnId = truncationResult.truncatedTurn.id;
          originalChars = truncationResult.truncatedTurn.content.length;
        }
        const sessionWithTrace = appendInterruptionSignal(
          truncationResult.session,
          {
            spokenTextSoFar,
            interruptedAtMs,
            assistantTurnId: resolvedAssistantTurnId,
            originalChars,
            spokenChars,
            providerTurnId,
            reason
          }
        );
        const nextState = withRealtimeInterruptAiRunEvent(
          replaceSession(state, sessionWithTrace),
          {
            session: sessionWithTrace,
            assistantTurnId: resolvedAssistantTurnId,
            providerTurnId,
            spokenChars,
            originalChars,
            interruptedAtMs,
            truncated,
            reason
          }
        );
        stateRepo.replaceState(nextState);
      }
    }

    return {
      interrupted: true,
      sessionId,
      truncated,
      spokenChars,
      originalChars,
      assistantTurnId: resolvedAssistantTurnId,
      providerTurnId
    };
  });
  server.get("/api/realtime-voice/sessions/:id/memory-context", async (request) => {
    const stateRepo = options.stateRepo;
    if (!stateRepo) {
      return { recentMemories: [], activeThemes: [] };
    }
    const state = stateRepo.getState();
    // 审查修复(安全):与 context-pack / 原生召回的 A3+A4 门控一致 —— 只返回 confirmed 且非 sensitive
    // (策略开启时才含 sensitive)的记忆,杜绝 deprecated/deleted/敏感记忆经此端点泄漏给语音客户端。
    const memoryPolicy = state.systemConfig.memory;
    const recentMemories = (state.memoryRecords || [])
      .filter((r) => r.status === "confirmed" && (memoryPolicy.includeSensitiveMemoriesInContext || (r.sensitivity ?? "normal") !== "sensitive"))
      .slice(-5);
    const activeThemes = (state.themes || []).filter((t) => t.maturity !== "关闭");
    return { recentMemories, activeThemes };
  });

  server.get("/api/realtime-voice/agent-context/:interviewSessionId", async (request, reply) => {
    const { interviewSessionId } = request.params as { interviewSessionId: string };
    const stateRepo = options.stateRepo;
    if (!stateRepo) {
      return reply.status(503).send({ error: "state_repo_unavailable" });
    }
    const session = await stateRepo.getInterviewSession(interviewSessionId);
    if (!session) {
      return reply.status(404).send({ error: "session_not_found" });
    }
    const { buildInterviewAgentContext, buildInterviewGuide } = await import("../../../../src/domain/engine");
    const state = stateRepo.getState();
    const corrections = state.memoryCorrections ?? [];

    // 🔴-1 (livekit): when the Python agent passes the latest user utterance (?latestUserText=),
    // refresh memory recall (queryEmbedding) so the persona's 【可引用的历史】 tracks the
    // conversation instead of being frozen at the opening snapshot. Fail-safe: no client /
    // no text / embed error → keyword recall (current behaviour), never throws.
    const { latestUserText } = request.query as { latestUserText?: string };
    const queryEmbedding = await embedRecallQuery(latestUserText, options.embeddingClient);
    // P2b:surreal 权威时预召回原生图遍历/HNSW/溯源,刷新 guide(主题资产/记忆/证据原话);
    // 非原生 repo 或无 queryEmbedding → recall undefined,buildInterviewGuide 走域层回落。
    const nativeRecall = asNativeRecall(stateRepo);
    const recall = nativeRecall && queryEmbedding
      ? await prefetchRecall(nativeRecall, state, session.guide.topicHint || resolveInterviewTopicHint(state, {}), queryEmbedding, {
          includeSensitive: state.systemConfig.memory.includeSensitiveMemoriesInContext,
          topN: state.systemConfig.search.maxSources
        })
      : undefined;
    const refreshedGuide = queryEmbedding
      ? buildInterviewGuide(state, {
          topicHint: session.guide.topicHint || undefined,
          ...(session.card.searchBriefId ? { searchBriefId: session.card.searchBriefId } : {}),
          queryEmbedding
        }, recall)
      : session.guide;
    // Re-stamp enginePolicy from latest state so a mid-session PlaybookPatch reaches the
    // LiveKit agent's instructions (not frozen at the opening snapshot) — same as /turns.
    const effectiveSession = {
      ...session,
      enginePolicy: buildInterviewEnginePolicy(state),
      guide: refreshedGuide
    };

    return buildInterviewAgentContext(effectiveSession, corrections, state.profile.explicitBoundaries);
  });

  server.get("/api/realtime-voice/livekit-token", async (request, reply) => {
    const { sessionId, interviewSessionId } = request.query as {
      sessionId?: string;
      interviewSessionId?: string;
    };

    // P1-03: when the caller asks for an interview room, only sign a publish/subscribe token
    // for an interview session that actually exists. Previously ANY interviewSessionId minted a
    // room token, so a guessed/forged id granted access to (or pre-created) another person's
    // interview room. We only validate when a state repo is wired; without one (dev/no-repo)
    // there are no interview rooms to protect, so the ad-hoc session path is left untouched.
    if (interviewSessionId && options.stateRepo) {
      const interviewSession = await options.stateRepo.getInterviewSession(interviewSessionId);
      if (!interviewSession) {
        return reply.code(404).send({ error: "Interview session not found." });
      }
    }

    const roomName = interviewSessionId
      ? `interview-${interviewSessionId}`
      : `session-${sessionId ?? randomUUID()}`;

    // In production, refuse to sign with the well-known dev defaults — anyone could forge
    // an equivalent token. Local/dev keeps the devkey fallback for zero-config.
    if (isAuthGuardActive(runtimeEnv) && (!runtimeEnv.LIVEKIT_API_KEY || !runtimeEnv.LIVEKIT_API_SECRET)) {
      return reply.code(503).send({ error: "LiveKit credentials not configured." });
    }

    const { AccessToken } = await import("livekit-server-sdk");
    const token = new AccessToken(
      runtimeEnv.LIVEKIT_API_KEY ?? "devkey",
      runtimeEnv.LIVEKIT_API_SECRET ?? "secret",
      {
        identity: `user-${randomUUID().slice(0, 8)}`,
        name: "Interview User",
      }
    );
    token.addGrant({
      room: roomName,
      roomJoin: true,
      canPublish: true,
      canSubscribe: true,
    });

    return {
      token: await token.toJwt(),
      serverUrl: runtimeEnv.LIVEKIT_URL ?? "ws://127.0.0.1:7880",
      room: roomName,
    };
  });

  // 端点定位(审计说明):LiveKit Python agent 集成接口(agent-context 取引导 + agent-turn 记轮次的
  // 服务端权威路径)。当前 Python agent(agent/main.py)只调 agent-context;agent-turn 的记轮职责在
  // 浏览器路径由 /record-turn 顶替,故 agent 未调它。保留作 agent 侧集成的对称能力(浏览器不可用/
  // 纯服务端 agent 场景),非死代码。同理 memory-context/config 是 agent 的记忆与配置拉取接口。
  server.post("/api/realtime-voice/agent-turn/:interviewSessionId", async (request, reply) => {
    const { interviewSessionId } = request.params as { interviewSessionId: string };
    const { role, text, strategy } = request.body as {
      role: string;
      text: string;
      strategy?: string;
    };
    const stateRepo = options.stateRepo;
    if (!stateRepo) {
      return reply.status(503).send({ error: "state_repo_unavailable" });
    }
    const session = await stateRepo.getInterviewSession(interviewSessionId);
    if (!session) {
      return reply.status(404).send({ error: "session_not_found" });
    }

    const { receiveUserTurn, addTurn } = await import("../../../../src/domain/engine");
    const updated = role === "user"
      ? receiveUserTurn(session, text)
      : addTurn(session, { role: "assistant", content: text, strategy });

    stateRepo.replaceState(replaceSession(stateRepo.getState(), updated));
    return { status: "recorded" };
  });

  const wss = new WebSocketServer({ noServer: true });
  const ttsWss = new WebSocketServer({ noServer: true });

  server.server.on("upgrade", (request: IncomingMessage, socket, head) => {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "127.0.0.1"}`);

    // P1-02 (CSWSH): the WS handshake is the one same-origin request a browser CAN'T forge
    // a header on, so a malicious page could open a cross-site WS to this proxy and burn
    // provider quota. Reject a browser-supplied Origin that isn't in the allow-set. A missing
    // Origin (non-browser clients: the Python agent, server-to-server, tests) is allowed —
    // CSWSH is a browser-only threat and the bearer check below still gates production.
    const origin = request.headers.origin;
    if (origin && !isAllowedWsOrigin(origin, runtimeEnv)) {
      socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
      socket.destroy();
      return;
    }

    // This raw Node upgrade handler runs OUTSIDE Fastify's onRequest auth hook, so the WS
    // path would otherwise bypass production bearer auth entirely. Apply the same check here.
    // Browsers can't set WS headers, so a ?token= query value is also accepted.
    if (!isAuthorized(runtimeEnv, {
      authHeader: request.headers.authorization,
      tokenQuery: url.searchParams.get("token") ?? undefined
    })) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }

    // ── TTS proxy branch (/api/realtime-voice/ws/tts/:sessionId) ────────────
    //
    // Browser↔proxy message contract:
    //
    //   Browser → proxy (JSON text frames):
    //     { type: "speak", segments: string[], voice?: string }
    //       — start streaming synthesis; proxy calls synthesizeStream and forwards
    //         binary audio chunks + tts.done back to the browser.
    //     { type: "cancel" }
    //       — abort the in-flight synthesis (AbortController signal).
    //
    //   Proxy → browser:
    //     <binary frames>          — raw CosyVoice MP3 audio chunks
    //     { type: "tts.done" }     — synthesis completed normally
    //     { type: "error", message: string }
    //                              — synthesis error (includes key-not-configured)
    //
    const ttsMatch = url.pathname.match(/^\/api\/realtime-voice\/ws\/tts\/(.+)$/);
    if (ttsMatch) {
      const sessionId = ttsMatch[1];
      const record = liveSession(sessionId);
      if (!record) {
        socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
        socket.destroy();
        return;
      }

      ttsWss.handleUpgrade(request, socket, head, (ws: WebSocket) => {
        // Resolve TTS client: prefer injected (tests / server.ts wires one)
        // then fall back to constructing from env at upgrade time.
        const apiKey = runtimeEnv.DASHSCOPE_API_KEY ?? runtimeEnv.BAILIAN_API_KEY;
        const ttsClient: BailianStreamingTtsClient | undefined =
          options.streamingTtsClient ??
          (apiKey ? createBailianStreamingTtsClient({ apiKey }) : undefined);

        if (!ttsClient) {
          ws.close(4001, "API key not configured");
          return;
        }

        let abortController = new AbortController();

        ws.on("message", (data: Buffer) => {
          let msg: { type?: string; segments?: unknown; voice?: unknown; prosody?: unknown };
          try {
            msg = JSON.parse(data.toString());
          } catch {
            return; // ignore non-JSON frames
          }

          if (msg.type === "cancel") {
            abortController.abort();
            abortController = new AbortController();
            return;
          }

          if (msg.type === "speak") {
            const segments = (Array.isArray(msg.segments)
              ? msg.segments.filter((s): s is string => typeof s === "string")
              : [])
              // Defense-in-depth: strip （…） manner/stage-direction asides server-side too, so
              // they are never synthesized regardless of which client sent the text (the cascade
              // client already strips, but any other caller is covered here). Drop emptied segments.
              .map((segment) => stripSpokenAsides(segment))
              .filter((segment) => segment.length > 0);
            const voice = normalizeCosyVoice(msg.voice);
            const prosody = normalizeProsody(msg.prosody);

            // Abort any prior in-flight synthesis before starting a new one
            abortController.abort();
            abortController = new AbortController();
            const signal = abortController.signal;

            // Tell the browser how to decode the binary frames that follow: raw
            // PCM (s16le, mono) at the streaming sample rate. The sink plays these
            // with sample-accurate scheduling for gapless audio.
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ type: "tts.start", format: "pcm", sampleRate: STREAMING_TTS_SAMPLE_RATE }));
            }

            ttsClient
              .synthesizeStream(
                { segments, voice, prosody },
                {
                  onAudio: (chunk) => {
                    if (ws.readyState === WebSocket.OPEN) {
                      ws.send(chunk);
                    }
                  },
                  onComplete: () => {
                    if (ws.readyState === WebSocket.OPEN) {
                      ws.send(JSON.stringify({ type: "tts.done" }));
                    }
                  },
                  onError: (e) => {
                    if (ws.readyState === WebSocket.OPEN) {
                      ws.send(JSON.stringify({ type: "error", message: e.message }));
                    }
                  }
                },
                signal
              )
              .catch(() => {
                // synthesizeStream rejects on error; onError already sent the
                // message — nothing more to do here.
              });
          }
        });

        ws.on("close", () => {
          abortController.abort();
        });

        ws.on("error", () => {
          abortController.abort();
        });
      });
      return;
    }

    // ── ASR proxy branch (/api/realtime-voice/ws/:sessionId) ────────────────
    const match = url.pathname.match(/^\/api\/realtime-voice\/ws\/(.+)$/);
    if (!match) return;

    const sessionId = match[1];
    const record = liveSession(sessionId);
    if (!record) {
      socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
      socket.destroy();
      return;
    }

    wss.handleUpgrade(request, socket, head, (ws: WebSocket) => {
      const apiKey = runtimeEnv.DASHSCOPE_API_KEY ?? runtimeEnv.BAILIAN_API_KEY;
      if (!apiKey) {
        ws.close(4001, "API key not configured");
        return;
      }

      const model = record.model;
      const dashscopeUrl = `wss://dashscope.aliyuncs.com/api-ws/v1/realtime?model=${encodeURIComponent(model)}`;

      let dashscopeWs: WebSocket | null = null;
      let closed = false;

      function cleanup() {
        if (closed) return;
        closed = true;
        if (dashscopeWs && dashscopeWs.readyState === WebSocket.OPEN) {
          dashscopeWs.close(1000, "client disconnected");
        }
      }

      try {
        dashscopeWs = new WebSocket(dashscopeUrl, {
          headers: { Authorization: `Bearer ${apiKey}` }
        });

        dashscopeWs.on("open", () => {
          if (closed) return;
          ws.send(JSON.stringify({ type: "proxy.connected" }));
        });

        dashscopeWs.on("message", (data: Buffer) => {
          if (closed) return;
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(data.toString());
          }
        });

        dashscopeWs.on("error", (err: Error) => {
          if (closed) return;
          ws.send(JSON.stringify({
            type: "error",
            error: { type: "proxy_error", message: err.message }
          }));
          cleanup();
        });

        dashscopeWs.on("close", (code: number, reason: Buffer) => {
          if (closed) return;
          ws.close(1000, reason.toString() || "dashscope closed");
          cleanup();
        });

        ws.on("message", (data: Buffer) => {
          if (closed) return;
          if (dashscopeWs && dashscopeWs.readyState === WebSocket.OPEN) {
            dashscopeWs.send(data.toString());
          }
        });

        ws.on("close", () => {
          cleanup();
        });

        ws.on("error", () => {
          cleanup();
        });
      } catch (err) {
        ws.close(4002, `Failed to connect to DashScope: ${err instanceof Error ? err.message : "unknown"}`);
      }
    });
  });
}

function buildRealtimeVoiceConfig(env: Record<string, string | undefined>): RealtimeVoiceConfig {
  const apiKeyConfigured = Boolean(env.DASHSCOPE_API_KEY ?? env.BAILIAN_API_KEY);
  const webrtcEndpointConfigured = Boolean(env.BAILIAN_REALTIME_WEBRTC_ENDPOINT);
  const transport = normalizeTransport(env.BAILIAN_REALTIME_TRANSPORT);
  const configured = apiKeyConfigured && (transport === "websocket" || webrtcEndpointConfigured);
  return {
    provider: "bailian",
    model: env.BAILIAN_REALTIME_MODEL ?? "qwen3.5-omni-plus-realtime",
    fallbackModel: env.BAILIAN_REALTIME_FALLBACK_MODEL ?? "qwen3.5-omni-flash-realtime",
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

function normalizeTransport(value: string | undefined): RealtimeVoiceConfig["transport"] {
  return value === "webrtc" ? "webrtc" : "websocket";
}

function normalizeVad(value: string | undefined): RealtimeVoiceConfig["vad"] {
  return value === "client_vad" ? "client_vad" : "server_vad";
}

// P1-02: allow-set for WS Origin validation. Mirrors registerCors in server.ts —
// PRODUCT_WEB_ORIGINS (comma-separated production origins) when set, otherwise the Vite
// dev-server origins so local development connects with zero config.
const WS_DEV_ORIGINS = ["http://127.0.0.1:3220", "http://localhost:3220"];
function isAllowedWsOrigin(origin: string, env: Record<string, string | undefined>): boolean {
  const configured = env.PRODUCT_WEB_ORIGINS
    ? env.PRODUCT_WEB_ORIGINS.split(",").map((o) => o.trim()).filter(Boolean)
    : null;
  const allowed = configured ?? WS_DEV_ORIGINS;
  return allowed.includes(origin);
}

function buildDefaultEnginePolicy(state: ProductState): InterviewEnginePolicy {
  // P0-C: delegate to the canonical domain policy builder instead of hand-rolling the object
  // with `qualityGuardrails: []`. This is the only place that decided the voice session's
  // policy when no per-session policy exists, so writing an empty array here was the third
  // failure that severed the quality-guardrail closed loop. buildInterviewEnginePolicy fills
  // qualityGuardrails with the real remediation text the domain produces.
  try {
    return buildInterviewEnginePolicy(state);
  } catch (error) {
    // Robustness: the domain quality-report path can throw on edge-case state shapes. A voice
    // session must still be creatable, so fall back to a config-derived policy. qualityGuardrails
    // is honestly empty here (we couldn't compute it) — NOT a hardcoded design choice.
    console.warn(JSON.stringify({
      event: "engine_policy_fallback",
      capability: "realtime_voice",
      error: error instanceof Error ? error.message : String(error)
    }));
    const cfg = state.systemConfig;
    return {
      allowWebInInterview: cfg.search.allowWebInInterview,
      maxFollowUpDepth: cfg.interview.maxFollowUpDepth,
      silenceHoldMs: cfg.interview.silenceHoldMs,
      playbookVersion: cfg.interview.playbookVersion,
      appliedPlaybookRules: collectAppliedPlaybookRules(state),
      appliedPlaybookRuleTypes: collectAppliedPlaybookRuleTypes(state),
      qualityGuardrails: [],
      memory: { ...cfg.memory },
      guidanceEnabled: cfg.interview.guidanceEnabled ?? true,
      guidanceFrequency: cfg.interview.guidanceFrequency ?? "medium",
      maxGuidancePerTurn: cfg.interview.maxGuidancePerTurn ?? 2,
      minGuidanceIntervalMs: cfg.interview.minGuidanceIntervalMs ?? 5000,
      challengeBudgetPerSession: cfg.interview.challengeBudgetPerSession ?? 3
    };
  }
}

function resolveEnginePolicy(
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

function createRealtimeVoiceSession(
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
      : config.apiKeyConfigured
        ? (config.transport === "webrtc" ? "needs-webrtc-endpoint" : "ready")
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

function normalizeInstructions(value: unknown) {
  return typeof value === "string" && value.trim()
    ? value.trim()
    : "你是一个真正的私人专访主持人，不是聊天助手也不是客服。这是对同一个人的持续跟踪——开场直接从一个跟踪点（上次要追的问题/反复出现的主题/未还的知识债）切入，绝不寒暄、不自我介绍、不要问'最近怎么样'。每次只问一个核心问题，优先追具体事件、真实张力和可验证假设。";
}

function normalizeOptionalString(value: unknown) {
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
function normalizeCosyVoice(value: unknown): string | undefined {
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
function normalizeProsody(value: unknown): { emotion?: string; rate: number; pitch: number; volume: number } | undefined {
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

interface InterruptPayload {
  spokenTextSoFar?: unknown;
  interruptedAtMs?: unknown;
  assistantTurnId?: unknown;
  providerTurnId?: unknown;
  reason?: unknown;
}

interface AppendInterruptionSignalInput {
  spokenTextSoFar: string;
  interruptedAtMs?: number;
  assistantTurnId?: string;
  providerTurnId?: string;
  originalChars: number;
  spokenChars: number;
  reason: "user_interrupt" | "provider_error";
}

function appendInterruptionSignal(session: InterviewSession, input: AppendInterruptionSignalInput): InterviewSession {
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

function replaceSession(state: ProductState, session: InterviewSession): ProductState {
  return {
    ...state,
    sessions: state.sessions.map((entry) => (entry.id === session.id ? session : entry))
  };
}

interface InterruptAiRunEventInput {
  session: InterviewSession;
  assistantTurnId?: string;
  providerTurnId?: string;
  spokenChars: number;
  originalChars: number;
  interruptedAtMs?: number;
  truncated: boolean;
  reason: "user_interrupt" | "provider_error";
}

function withRealtimeInterruptAiRunEvent(state: ProductState, input: InterruptAiRunEventInput): ProductState {
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
