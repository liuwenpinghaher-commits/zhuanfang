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

import {
  RealtimeVoiceConfig,
  RealtimeVoiceRouteOptions,
  RealtimeVoiceSessionPayload,
  RealtimeVoiceSessionRecord,
  embedRecallQuery,
  buildRealtimeVoiceConfig,
  normalizeTransport,
  normalizeVad,
  isAllowedWsOrigin,
  buildDefaultEnginePolicy,
  resolveEnginePolicy,
  createRealtimeVoiceSession,
  normalizeInstructions,
  normalizeOptionalString,
  normalizeCosyVoice,
  normalizeProsody,
  getSessionId,
  normalizeObject,
  InterruptPayload,
  AppendInterruptionSignalInput,
  appendInterruptionSignal,
  replaceSession,
  InterruptAiRunEventInput,
  withRealtimeInterruptAiRunEvent
} from "./realtime-voice-helpers";

export async function registerRealtimeVoiceRoutes(server: FastifyInstance, options: RealtimeVoiceRouteOptions = {}) {
  const sessions = new Map<string, RealtimeVoiceSessionRecord>();
  const runtimeEnv = options.env ?? process.env;
  const heartbeatIntervalMs = options.heartbeatIntervalMs ?? 15_000;
  const heartbeatMaxMissedPongs = options.heartbeatMaxMissedPongs ?? 2;
  const realtimeHandshakeTimeoutMs = options.realtimeHandshakeTimeoutMs ?? 10_000;
  const now = options.now ?? Date.now;
  const createRealtimeUpstream = options.createRealtimeUpstream ??
    ((url: string, init: { headers: Record<string, string> }) => new WebSocket(url, init));

  // 审计修复(P1-5):TTL 改为滑动续期——此前只在创建时设 10 分钟且从不续期,而产品核心场景
  // 就是长访谈:>10min 后 /interrupt 静默失效(截断跳过但仍回 interrupted:true → 归档失真)、
  // cascade TTS WS 断线重连撞 404 直到会话结束。活跃访问即续期;真僵尸(无流量)照旧过期。
  const SESSION_TTL_MS = 10 * 60 * 1000;
  // N-14:P1-5 的续期只落在 liveSession 的 4 个调用点(含 WS 升级那一次),但 WS 连上后整场访谈
  // 的 cascade 每轮流量(ASR 音频帧 / TTS speak)都走 ws.on("message"),【不经】liveSession →
  // >10min 后会话仍过期:/interrupt 410、TTS 断线重连 404 永死。两道防线补齐:
  //  ① 只要该会话有活跃 WS 连接,就不判过期(长访谈里用户静默思考几分钟也不该被踢);
  //  ② WS 每收到一帧就 touchSession 滑动续期(WS 关闭后仍保留完整一个 TTL 的宽限窗)。
  const activeWsCount = new Map<string, number>();
  function hasActiveWs(id: string): boolean {
    return (activeWsCount.get(id) ?? 0) > 0;
  }
  function addActiveWs(id: string): void {
    activeWsCount.set(id, (activeWsCount.get(id) ?? 0) + 1);
    touchSession(id);
  }
  function removeActiveWs(id: string): void {
    const next = (activeWsCount.get(id) ?? 0) - 1;
    if (next <= 0) {
      activeWsCount.delete(id);
      // 断开时刷新到完整 TTL:让关闭后仍有一整段宽限窗(重连/后续 REST 调用)。
      touchSession(id);
    } else {
      activeWsCount.set(id, next);
    }
  }
  /** 滑动续期:会话存在则把过期时刻推到 now+TTL。WS 每帧调用,成本极低。 */
  function touchSession(id: string): void {
    const rec = sessions.get(id);
    if (rec) rec.expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();
  }
  // 过期会话清理:记录带 expiresAt(10 分钟)但此前无人读取/无清理 → Map 单调增长且过期会话仍可被
  // WS 升级命中(expiresAt 形同虚设)。lazy 校验 + 创建时清扫,界定内存并让过期凭据失效。
  // N-14:有活跃 WS 的会话豁免清理(访谈进行中,连接还开着)。
  function pruneExpiredSessions(): void {
    const now = Date.now();
    for (const [id, rec] of sessions) {
      if (Date.parse(rec.expiresAt) <= now && !hasActiveWs(id)) sessions.delete(id);
    }
  }
  function liveSession(id: string | undefined): RealtimeVoiceSessionRecord | undefined {
    if (!id) return undefined;
    const rec = sessions.get(id);
    if (!rec) return undefined;
    // N-14:有活跃 WS 时不判过期(长访谈连接一直开着,静默期也不该被踢)。
    if (Date.parse(rec.expiresAt) <= Date.now() && !hasActiveWs(id)) {
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

  server.get("/api/realtime-voice/voices", async (_request, reply) => {
    if (!options.voiceEnrollmentClient) {
      // 配置边界:未配置声纹服务 → 只有系统预置音色可用(如实的能力边界,非失败)。
      return { preset: cosyvoiceFallbackPreset, custom: [] };
    }
    try {
      const voices = await options.voiceEnrollmentClient.listVoices();
      const preset = voices.filter((v) => !v.targetModel || v.targetModel === "qwen3.5-omni-plus-realtime");
      const custom = voices.filter((v) => v.targetModel && v.targetModel !== "qwen3.5-omni-plus-realtime");
      return { preset, custom };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(JSON.stringify({ event: "voice_list_failed", error: message }));
      // 上游失败如实 502——不再用预置列表冒充查询结果(那会隐藏用户的自定义克隆音色)。
      return reply.code(502).send({ error: `音色列表查询失败：${message}` });
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
        await replaceStateDurable(stateRepo, nextState);
      }
    }

    // Stage-3: barge-in success = session live + interrupt applied (truncated when we had speech).
    const bargeInSuccess = true;
    const interruptRecovery = truncated || spokenTextSoFar.length > 0;
    recordVoiceLatency({
      path: "interrupt",
      interrupted: true,
      bargeInSuccess,
      interruptRecovery,
      sessionId,
      ttfaMs: typeof interruptedAtMs === "number" ? interruptedAtMs : undefined
    });
    console.warn(JSON.stringify({
      event: "voice_interrupt",
      sessionId,
      truncated,
      spokenChars,
      originalChars,
      reason,
      bargeInSuccess,
      interruptRecovery
    }));
    return {
      interrupted: true,
      sessionId,
      truncated,
      spokenChars,
      originalChars,
      assistantTurnId: resolvedAssistantTurnId,
      providerTurnId,
      bargeInSuccess,
      /** Stash for next LLM turn: partial spoken text the user actually heard. */
      previousAgentUtteranceInterrupted: spokenTextSoFar || undefined
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
    // conversation instead of being frozen at the opening snapshot. 配置边界:无 client/无文本 →
    // 关键词召回。运行时失败(embed/召回错)→ 如实 502,由 agent 决定如何向用户暴露。
    // C-P1-02/04 + R-P1-01: mid-session native prefetch + persist guide (parity with /turns).
    const { latestUserText } = request.query as { latestUserText?: string };
    let queryEmbedding: number[] | undefined;
    let recall: Awaited<ReturnType<typeof prefetchRecall>> | undefined;
    const midTopic = resolveMidSessionRecallTopic(
      state,
      session.guide.topicHint || resolveInterviewTopicHint(state, {}),
      latestUserText
    );
    try {
      // A1: voice prefetch embed occupies knowledge_index. Do NOT fall back to createLlmBudget()
      // (would mask missing production wiring). Missing/exhausted → no vector; BM25/theme continues.
      // Only gate when embed would actually run (client + non-empty text); no-op paths skip tryConsume.
      const willEmbed = Boolean(options.embeddingClient && latestUserText?.trim());
      if (willEmbed) {
        const budget = options.llmBudget;
        if (!budget) {
          console.warn(JSON.stringify({ event: "llm_budget_missing", capability: "voice_prefetch_embed" }));
          queryEmbedding = undefined;
        } else if (!budget.tryConsume("knowledge_index")) {
          console.warn(JSON.stringify({ event: "llm_budget_exceeded", capability: "voice_prefetch_embed" }));
          queryEmbedding = undefined;
        } else {
          queryEmbedding = await embedRecallQuery(latestUserText, options.embeddingClient);
        }
      } else {
        queryEmbedding = await embedRecallQuery(latestUserText, options.embeddingClient);
      }
      const nativeRecall = asNativeRecall(stateRepo);
      // Prefetch when native is available; embedding optional (BM25/theme still useful).
      recall = nativeRecall
        ? await prefetchRecall(nativeRecall, state, midTopic.themeTopic, queryEmbedding, {
            includeSensitive: state.systemConfig.memory.includeSensitiveMemoriesInContext,
            topN: state.systemConfig.search.maxSources,
            queryText: midTopic.queryText
          })
        : undefined;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(JSON.stringify({ event: "agent_context_recall_failed", error: message }));
      return reply.status(502).send({ error: `agent 上下文召回失败：${message}` });
    }
    const guideTopicHint = midTopic.queryText || session.guide.topicHint || undefined;
    const refreshedGuide =
      queryEmbedding || recall
        ? buildInterviewGuide(
            state,
            {
              ...(guideTopicHint ? { topicHint: guideTopicHint } : {}),
              ...(session.card.searchBriefId ? { searchBriefId: session.card.searchBriefId } : {}),
              ...(queryEmbedding ? { queryEmbedding } : {})
            },
            recall
          )
        : session.guide;
    const livePack =
      queryEmbedding || recall
        ? buildInterviewContextPack(
            state,
            {
              ...(guideTopicHint ? { topicHint: guideTopicHint } : {}),
              ...(session.card.searchBriefId ? { searchBriefId: session.card.searchBriefId } : {}),
              ...(queryEmbedding ? { queryEmbedding } : {})
            },
            recall
          )
        : undefined;
    const refreshedCard = applyMidSessionCardRefresh(session.card, refreshedGuide, livePack);

    // IV-P0-02: embed/prefetch outside write slot; final merge re-enters writeGate and
    // re-reads LATEST inside exclusive section so concurrent record-turn cannot be clobbered.
    const commitAgentContext = async () => {
      const latestState = stateRepo.getState();
      const latestSession = await stateRepo.getInterviewSession(interviewSessionId);
      if (!latestSession) {
        return { missing: true as const };
      }
      const effectiveSession = mergeInterviewSessionRefresh(latestSession, {
        guide: refreshedGuide,
        card: refreshedCard,
        enginePolicy: buildInterviewEnginePolicy(latestState)
      });
      // Persist so archive/UI/quality see the same pack the agent just used (C-P1-04).
      if (queryEmbedding || recall) {
        await replaceStateDurable(stateRepo, replaceSession(latestState, effectiveSession));
      }
      return {
        missing: false as const,
        context: buildInterviewAgentContext(
          effectiveSession,
          latestState.memoryCorrections ?? [],
          latestState.profile.explicitBoundaries
        ),
        turnCount: effectiveSession.turns.length,
        turnIds: effectiveSession.turns.map((t) => t.id)
      };
    };
    const committed = options.writeGate
      ? await options.writeGate.runExclusive("agent-context-merge", commitAgentContext)
      : await commitAgentContext();
    if (committed.missing) {
      return reply.status(404).send({ error: "session_not_found" });
    }
    return committed.context;
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

    await replaceStateDurable(stateRepo, replaceSession(stateRepo.getState(), updated));
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
      tokenQuery: url.searchParams.get("token") ?? undefined,
      cookieToken: readCookieToken(
        typeof request.headers.cookie === "string"
          ? request.headers.cookie
          : undefined
      )
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
        // N-14:登记活跃 WS,连接存活期间该会话不判过期(长访谈 TTS 通道整场开着)。
        // 专门的 close 监听立即注册,确保任何早退路径(如无 key close)也能配平计数,不泄漏。
        addActiveWs(sessionId);
        const startedAt = now();
        let phase: "connecting" | "ready" | "closing" = "connecting";
        let cleaned = false;
        let abortController = new AbortController();
        let synthesisGeneration = 0;
        let disposeHeartbeat: () => void = () => undefined;

        const writeProxyLog = (event: string, code?: number, reason?: string) => {
          console.info(JSON.stringify(buildRealtimeProxyLog({
            event,
            sessionId,
            direction: "browser",
            code,
            reason,
            phase,
            durationMs: Math.max(0, now() - startedAt)
          })));
        };

        function cleanup() {
          if (cleaned) return;
          cleaned = true;
          phase = "closing";
          disposeHeartbeat();
          abortController.abort();
          synthesisGeneration += 1;
          ws.off("message", onBrowserMessage);
          ws.off("close", onBrowserClose);
          ws.off("error", onBrowserError);
          removeActiveWs(sessionId);
        }
        // Resolve TTS client: prefer injected (tests / server.ts wires one)
        // then fall back to constructing from env at upgrade time.
        const apiKey = resolveBailianApiKey(runtimeEnv);
        const ttsClient: BailianStreamingTtsClient | undefined =
          options.streamingTtsClient ??
          (apiKey ? createBailianStreamingTtsClient({ apiKey }) : undefined);

        ws.on("close", onBrowserClose);
        ws.on("error", onBrowserError);
        disposeHeartbeat = attachWebSocketHeartbeat(ws, {
          intervalMs: heartbeatIntervalMs,
          maxMissedPongs: heartbeatMaxMissedPongs,
          onTimeout: () => {
            if (cleaned) return;
            writeProxyLog("realtime_proxy_heartbeat_timeout");
            cleanup();
          }
        });

        if (!ttsClient) {
          ws.close(4001, "API key not configured");
          return;
        }

        const activeTtsClient = ttsClient;
        phase = "ready";

        function onBrowserMessage(data: Buffer) {
          if (cleaned) return;
          touchSession(sessionId);   // N-14:每帧滑动续期,长访谈 TTS 流量不再让会话过期。
          let msg: { type?: string; segments?: unknown; voice?: unknown; prosody?: unknown };
          try {
            msg = JSON.parse(data.toString());
          } catch {
            return; // ignore non-JSON frames
          }

          if (msg.type === "cancel") {
            abortController.abort();
            synthesisGeneration += 1;
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
            const generation = ++synthesisGeneration;
            const isCurrentSynthesis = () => !cleaned
              && generation === synthesisGeneration
              && !signal.aborted;

            // Tell the browser how to decode the binary frames that follow: raw
            // PCM (s16le, mono) at the streaming sample rate. The sink plays these
            // with sample-accurate scheduling for gapless audio.
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ type: "tts.start", format: "pcm", sampleRate: STREAMING_TTS_SAMPLE_RATE }));
            }

            activeTtsClient
              .synthesizeStream(
                { segments, voice, prosody },
                {
                  onAudio: (chunk) => {
                    if (isCurrentSynthesis() && ws.readyState === WebSocket.OPEN) {
                      ws.send(chunk);
                    }
                  },
                  onComplete: () => {
                    if (isCurrentSynthesis() && ws.readyState === WebSocket.OPEN) {
                      ws.send(JSON.stringify({ type: "tts.done" }));
                    }
                  },
                  onError: (e) => {
                    if (isCurrentSynthesis() && ws.readyState === WebSocket.OPEN) {
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
        }

        function onBrowserClose(code: number, reason: Buffer) {
          if (cleaned) return;
          writeProxyLog("realtime_proxy_browser_closed", code, reason.toString());
          cleanup();
        }

        function onBrowserError(error: Error) {
          if (cleaned) return;
          writeProxyLog("realtime_proxy_browser_error", undefined, error.message);
          cleanup();
        }

        ws.on("message", onBrowserMessage);
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
      // N-14:登记活跃 WS,连接存活期间该会话不判过期(长访谈 ASR 通道整场开着)。
      // close 监听立即注册,任何早退(如无 key close)也能配平计数。
      addActiveWs(sessionId);
      const apiKey = resolveBailianApiKey(runtimeEnv);
      if (!apiKey) {
        ws.close(4001, "API key not configured");
        removeActiveWs(sessionId);
        return;
      }
      connectRealtimeAsrProxy({
        browser: ws,
        sessionId,
        apiKey,
        primaryModel: record.model,
        fallbackModel: record.fallbackModel,
        createUpstream: createRealtimeUpstream,
        heartbeatIntervalMs,
        heartbeatMaxMissedPongs,
        handshakeTimeoutMs: realtimeHandshakeTimeoutMs,
        now,
        onBrowserActivity: () => touchSession(sessionId),
        onClosed: () => removeActiveWs(sessionId),
      });
    });
  });
}
