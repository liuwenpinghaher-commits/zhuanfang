/**
 * Realtime voice session controls extracted from App.tsx (architecture split).
 * Owns: closeRealtimeVoiceSession / interruptAssistant / toggleRealtimeRecording.
 * Product callbacks (adoptServerState, setSession, …) stay injected from App.
 */
import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import {
  getProductApiBaseUrl,
  productApiClient,
  type RealtimeVoiceSessionResponse
} from "../api/productApi";
import { ApiError } from "../api/productApi.types";
import {
  appendAssistantTranscriptFinal,
  buildRealtimeVoiceInstructions,
  receiveUserTurn
} from "../domain/engine";
import type { InterviewCard, InterviewSession, ProductState } from "../domain/types";
import type { BailianRealtimeWebrtcConnection } from "../realtime/realtimeTypes";
import {
  connectBailianRealtimeWebsocket,
  type BailianRealtimeWebsocketConnection
} from "../realtime/bailianWebsocket";
import { createLivekitVoiceSession, type LivekitVoiceSession } from "../realtime/livekitVoice";
import {
  connectCascadedPipeline,
  type CascadedPipeline,
  type TranscriptReviewItem,
  type TtsSink
} from "../realtime/cascadedPipeline";
import { createBrowserAsrSource } from "../realtime/cascadedAsrSource";
import { createBrowserTtsSink, TTS_AUTOPLAY_BLOCKED_MESSAGE } from "../realtime/cascadedTtsSink";
import { createSessionAudioRecorder, type SessionAudioRecorder } from "../realtime/sessionAudioRecorder";
import { probeVadWorkletCapability } from "../realtime/vadWorkletCapability";
import {
  createVoiceTransportStateGuard,
  terminateVoicePipelineAfterExhaustion,
  type VoiceUiStatus
} from "../realtime/voiceTransportLifecycle";
import { deriveRealtimeWsBaseUrl } from "../realtime/wsBaseUrl";
import { buildNotice, type UiNotice } from "../ui";
import { useCascadeVoiceMetrics } from "./useCascadeVoiceMetrics";

export type RealtimeVoiceConnection =
  | BailianRealtimeWebrtcConnection
  | BailianRealtimeWebsocketConnection
  | LivekitVoiceSession
  | null;

export interface UseRealtimeVoiceControlsArgs {
  session: InterviewSession | null;
  setSession: Dispatch<SetStateAction<InterviewSession | null>>;
  productState: ProductState;
  card: InterviewCard;
  recording: boolean;
  setRecording: Dispatch<SetStateAction<boolean>>;
  voiceStatus: VoiceUiStatus;
  setVoiceStatus: Dispatch<SetStateAction<VoiceUiStatus>>;
  realtimeVoiceSession: RealtimeVoiceSessionResponse | null;
  setRealtimeVoiceSession: Dispatch<SetStateAction<RealtimeVoiceSessionResponse | null>>;
  realtimeVoiceConnection: RealtimeVoiceConnection;
  setRealtimeVoiceConnection: Dispatch<SetStateAction<RealtimeVoiceConnection>>;
  livekitVoiceSession: LivekitVoiceSession | null;
  setLivekitVoiceSession: Dispatch<SetStateAction<LivekitVoiceSession | null>>;
  cascadePipelineRef: MutableRefObject<CascadedPipeline | null>;
  voiceTransportStateGuardRef: MutableRefObject<ReturnType<typeof createVoiceTransportStateGuard>>;
  audioRecorderRef: MutableRefObject<SessionAudioRecorder | null>;
  ttsSinkRef: MutableRefObject<TtsSink | null>;
  assistantTranscriptTurnRef: MutableRefObject<number>;
  voiceReviewItemRef: MutableRefObject<TranscriptReviewItem | null>;
  setVoiceReviewItem: Dispatch<SetStateAction<TranscriptReviewItem | null>>;
  setLiveUserTranscript: Dispatch<SetStateAction<string>>;
  setAudioLevel: Dispatch<SetStateAction<number>>;
  setInterviewInput: Dispatch<SetStateAction<string>>;
  setFailedTurnContent: Dispatch<SetStateAction<string | null>>;
  setGuidanceState: Dispatch<
    SetStateAction<{
      active: boolean;
      kind: string | null;
      text: string | null;
      countThisTurn: number;
      lastTimestamp: string | null;
    }>
  >;
  setNotice: Dispatch<SetStateAction<UiNotice | null>>;
  setApiPersistenceEnabled: Dispatch<SetStateAction<boolean>>;
  togglingRef: MutableRefObject<boolean>;
  adoptServerState: (state: ProductState) => void;
  recordTurnFailedFallback: (text: string, err: unknown) => void;
  voiceRecallRefreshSucceeded: () => void;
  voiceRecallRefreshFailed: (kind: "pre_signals" | "voice_instructions", err: unknown) => void;
}

export function useRealtimeVoiceControls(args: UseRealtimeVoiceControlsArgs) {
  const {
    session,
    setSession,
    productState,
    card,
    recording,
    setRecording,
    voiceStatus,
    setVoiceStatus,
    realtimeVoiceSession,
    setRealtimeVoiceSession,
    realtimeVoiceConnection,
    setRealtimeVoiceConnection,
    livekitVoiceSession,
    setLivekitVoiceSession,
    cascadePipelineRef,
    voiceTransportStateGuardRef,
    audioRecorderRef,
    ttsSinkRef,
    assistantTranscriptTurnRef,
    voiceReviewItemRef,
    setVoiceReviewItem,
    setLiveUserTranscript,
    setAudioLevel,
    setInterviewInput,
    setFailedTurnContent,
    setGuidanceState,
    setNotice,
    setApiPersistenceEnabled,
    togglingRef,
    adoptServerState,
    recordTurnFailedFallback,
    voiceRecallRefreshSucceeded,
    voiceRecallRefreshFailed
  } = args;

  // Phase-0: cascade TTFA + barge-in + false-trigger → POST runtime-metrics/voice
  const { reportLatency } = useCascadeVoiceMetrics(session?.id ?? null);

  function closeRealtimeVoiceSession() {
    // Invalidate callbacks before closing resources: pipeline.close() may synchronously
    // emit a final state, and an older pipeline must never mutate a newer voice session.
    voiceTransportStateGuardRef.current.invalidate();
    if (livekitVoiceSession) {
      livekitVoiceSession.close();
      setLivekitVoiceSession(null);
    }
    realtimeVoiceConnection?.close();
    setRealtimeVoiceConnection(null);
    setRealtimeVoiceSession(null);
    const cascadePipeline = cascadePipelineRef.current;
    cascadePipelineRef.current = null;
    cascadePipeline?.close();
    // Drop the host TTS sink ref. The pipeline.close() above already closed the
    // sink (releasing its WS + AudioContext); we just clear the handle so a torn-
    // down session can't leak a stale sink (and its recorded PCM) into the next.
    ttsSinkRef.current = null;
    // Discard any orphan whole-session recorder (voice session torn down without a
    // proper /end upload — e.g. new interview / purge / reset). finishInterview()
    // already nulls the ref BEFORE calling us when it wants to upload, so reaching
    // here with a recorder means the recording is intentionally dropped. Stop it to
    // release the MediaRecorder; ignore the resulting blob.
    if (audioRecorderRef.current) {
      const orphan = audioRecorderRef.current;
      audioRecorderRef.current = null;
      void orphan.stop().catch(() => { /* discarded */ });
    }
    setRecording(false);
    setAudioLevel(0);
    setVoiceStatus("idle");
    voiceReviewItemRef.current = null;
    setVoiceReviewItem(null);
  }

  async function interruptAssistant() {
    setGuidanceState(prev => ({ ...prev, countThisTurn: 0, active: false }));
    // Hit whichever transport is live. cascade (pipeline.interrupt) and omni
    // (connection.interruptAssistant) have real barge-in; livekit's interrupt is a
    // best-effort no-op (SDK-limited) but harmless. Previously only livekit was wired,
    // so the manual 打断 button did nothing in the default cascade / omni modes.
    let interrupted = false;
    // Capture how much of the reply was actually spoken aloud so the server can truncate the
    // persisted assistant turn to what the guest really heard (P0-2). Without this the session
    // record keeps the full reply the AI never finished saying, and downstream memory/extraction
    // treats unspoken text as spoken.
    let spokenTextSoFar = "";
    if (cascadePipelineRef.current) {
      const info = cascadePipelineRef.current.interrupt();
      spokenTextSoFar = info?.spokenTextSoFar ?? "";
      interrupted = true;
    }
    const conn = realtimeVoiceConnection as
      | { interruptAssistant?: () => Promise<{ spokenTextSoFar?: string } | null> | void }
      | null;
    if (conn?.interruptAssistant) {
      const result = await conn.interruptAssistant();
      if (result && typeof result.spokenTextSoFar === "string") {
        spokenTextSoFar = result.spokenTextSoFar;
      }
      interrupted = true;
    }
    if (livekitVoiceSession) {
      livekitVoiceSession.interrupt();
      interrupted = true;
    }
    if (interrupted) {
      // Persist the interruption server-side so the assistant turn is truncated to the spoken
      // portion. Best-effort: a failure here must not break the local barge-in UX.
      const realtimeSessionId = realtimeVoiceSession?.sessionId;
      if (realtimeSessionId) {
        try {
          await productApiClient.interruptRealtimeVoiceSession(realtimeSessionId, {
            spokenTextSoFar,
            reason: "user_interrupt"
          });
        } catch (error) {
          console.warn(JSON.stringify({ event: "interrupt_persist_failed", error: error instanceof Error ? error.message : String(error) }));
        }
      }
      setVoiceStatus("interrupted");
      setTimeout(() => setVoiceStatus("listening"), 1500);
    }
  }

  async function toggleRealtimeRecording() {
    if (recording) {
      closeRealtimeVoiceSession();
      return;
    }
    if (voiceStatus === "exhausted") {
      closeRealtimeVoiceSession();
    }
    // P3-19:连接建立窗口内的二次触发直接短路(停止路径在上方,幂等 close,无需守卫)。
    if (togglingRef.current) return;
    togglingRef.current = true;

    try {
      let playbackCtx: AudioContext | undefined;
      try {
        const AC = window.AudioContext;
        if (AC) {
          // Both contexts must be constructed and resume() called before any await,
          // otherwise the playback graph is created outside the click gesture and stays silent.
          const unlock = new AC({ sampleRate: 16000 });
          playbackCtx = new AC();
          const unlockResume = unlock.resume();
          const playbackResume = playbackCtx.resume();
          await unlockResume;
          await playbackResume;
          (window as unknown as { __zhuanfangAudioUnlock?: AudioContext }).__zhuanfangAudioUnlock = unlock;
        }
      } catch {
        /* headless / autoplay policy: capture resume happens again in ASR start */
      }
      const voiceSession = await productApiClient.createRealtimeVoiceSession({
        ...(session ? { interviewSessionId: session.id } : {}),
        instructions: buildRealtimeVoiceInstructions(session, card, productState.memoryCorrections ?? []),
        voice: productState.systemConfig.voice.defaultVoice
      });
      setRealtimeVoiceSession(voiceSession);
      setApiPersistenceEnabled(true);

      if (voiceSession.status === "ready") {
        const voiceMode = productState.systemConfig.voice.realtimeMode ?? "cascade";

        if (voiceMode === "cascade") {
          // Cascade pipeline: real ASR (text-only omni WS) → LLM HTTP → CosyVoice TTS WS
          try {
            setVoiceStatus("connecting");
            const vadCapability = await probeVadWorkletCapability();
            let asrWasReconnecting = false;
            const voiceEpoch = voiceTransportStateGuardRef.current.beginSession();
            const baseWsUrl = deriveRealtimeWsBaseUrl(getProductApiBaseUrl());
            const asrWsUrl = `${baseWsUrl}/api/realtime-voice/ws/${voiceSession.sessionId}`;
            const ttsWsUrl = `${baseWsUrl}/api/realtime-voice/ws/tts/${voiceSession.sessionId}`;
            const interviewId = session?.id
              ?? productState.sessions.find((entry) => entry.status === "active")?.id
              ?? "";
            if (!interviewId) {
              setNotice(buildNotice("warning", "还没有这场专访", "先开始一场专访，再点录音。说的话才能写进书里。"));
              setVoiceStatus("idle");
              return;
            }

            const asr = createBrowserAsrSource({
              asrWsUrl,
              instructions: voiceSession.sessionUpdate.session.instructions,
              onConnectionStateChange: (event) => {
                if (event.state === "reconnecting") {
                  if (!voiceTransportStateGuardRef.current.transition(voiceEpoch, event.state)) return;
                  asrWasReconnecting = true;
                  setVoiceStatus("reconnecting");
                }
                if (event.state === "ready") {
                  if (!voiceTransportStateGuardRef.current.transition(voiceEpoch, event.state)) return;
                  setVoiceStatus(vadCapability.supported ? "listening" : "degraded");
                  if (asrWasReconnecting) {
                    setNotice(buildNotice("success", "语音连接已恢复", "可以继续口述，已确认的专访内容不受影响。"));
                    asrWasReconnecting = false;
                  }
                }
                if (event.state === "exhausted") {
                  const pendingReview = voiceReviewItemRef.current;
                  const result = terminateVoicePipelineAfterExhaustion({
                    epoch: voiceEpoch,
                    guard: voiceTransportStateGuardRef.current,
                    pipelineRef: cascadePipelineRef,
                    ttsRef: ttsSinkRef,
                    pendingReview,
                    updateInterviewInput: (merge) => setInterviewInput(merge),
                    clearReview: () => {
                      voiceReviewItemRef.current = null;
                      setVoiceReviewItem(null);
                    },
                    setRecording,
                    setVoiceStatus,
                    clearLiveTranscript: () => setLiveUserTranscript("")
                  });
                  if (!result.terminated) return;
                  if (result.preservedReview) setFailedTurnContent(null);
                  setNotice(buildNotice(
                    "warning",
                    "语音连接未恢复",
                    result.noticeDetail
                  ));
                }
              },
              onRecoveryTranscript: (item) => {
                if (!voiceTransportStateGuardRef.current.isCurrent(voiceEpoch)) return;
                cascadePipelineRef.current?.reviewRecoveryTranscript(item);
              },
              onConnectionLost: (error) => {
                if (!voiceTransportStateGuardRef.current.isCurrent(voiceEpoch)) return;
                setNotice(buildNotice("warning", "语音连接未恢复", `${error.message}。本场文字专访仍可继续。`));
              },
              // Tee the live mic into a whole-session recorder. Best-effort: guard
              // construction so a recorder failure never breaks ASR start. The
              // recording is uploaded at /end (see finishInterview).
              onMicStream: (stream) => {
                if (!voiceTransportStateGuardRef.current.isCurrent(voiceEpoch)) {
                  stream.getTracks().forEach((track) => track.stop());
                  return;
                }
                try {
                  const recorder = createSessionAudioRecorder(stream);
                  recorder.start();
                  audioRecorderRef.current = recorder;
                } catch (err) {
                  audioRecorderRef.current = null;
                  console.warn(JSON.stringify({
                    event: "session_recorder_start_failed",
                    error: err instanceof Error ? err.message : String(err),
                  }));
                }
              }
            });
            const tts = createBrowserTtsSink(
              ttsWsUrl,
              productState.systemConfig.voice.defaultVoice,
              playbackCtx
            );
            // Hold the sink so finishInterview() can drain its host-audio PCM tap.
            ttsSinkRef.current = tts;

            // sendUserTurn: JSON fallback if stream is missing (404/405 only).
            const sendUserTurn = async (text: string, signal: AbortSignal) => {
              if (!interviewId || !voiceTransportStateGuardRef.current.isCurrent(voiceEpoch)) {
                return { assistantText: "" };
              }
              const r = await productApiClient.sendInterviewTurn(interviewId, { content: text }, signal);
              if (!voiceTransportStateGuardRef.current.isCurrent(voiceEpoch)) {
                return { assistantText: "" };
              }
              setSession(r.session);
              adoptServerState(r.state);
              setApiPersistenceEnabled(true);
              if (r.preSignals) cascadePipelineRef.current?.updatePreSignals(r.preSignals);
              const lastTurn = r.session.turns.at(-1);
              return { assistantText: lastTurn?.content ?? "", prosody: lastTurn?.prosody };
            };

            const sendUserTurnStream = async (
              text: string,
              signal: AbortSignal,
              onDelta: (chunk: string) => void
            ) => {
              if (!interviewId || !voiceTransportStateGuardRef.current.isCurrent(voiceEpoch)) {
                console.warn(JSON.stringify({
                  event: "voice_turn_skipped",
                  hasInterview: Boolean(interviewId),
                  epochCurrent: voiceTransportStateGuardRef.current.isCurrent(voiceEpoch)
                }));
                return { assistantText: "" };
              }
              console.warn(JSON.stringify({ event: "voice_turn_send", n: text.length }));
              try {
                const r = await productApiClient.sendInterviewTurnStream(interviewId, { content: text }, {
                  signal,
                  onDelta,
                  onUserPersisted: (next) => {
                    if (!voiceTransportStateGuardRef.current.isCurrent(voiceEpoch)) return;
                    setSession(next);
                    setApiPersistenceEnabled(true);
                  }
                });
                if (!voiceTransportStateGuardRef.current.isCurrent(voiceEpoch)) {
                  return { assistantText: r.assistantText ?? "" };
                }
                if (r.session) setSession(r.session);
                if (r.state) {
                  adoptServerState(r.state);
                  setApiPersistenceEnabled(true);
                }
                if (r.preSignals) cascadePipelineRef.current?.updatePreSignals(r.preSignals);
                const lastTurn = r.session?.turns.at(-1);
                return {
                  assistantText: r.assistantText ?? lastTurn?.content ?? "",
                  ...(lastTurn?.prosody ? { prosody: lastTurn.prosody } : {})
                };
              } catch (error) {
                if (error instanceof ApiError && (error.status === 404 || error.status === 405)) {
                  console.warn(JSON.stringify({ event: "voice_stream_fallback", status: error.status }));
                  return sendUserTurn(text, signal);
                }
                throw error;
              }
            };

            const preSignals = session?.interactionPreSignals ?? null;

            const pipeline = connectCascadedPipeline({
              asr,
              tts,
              sendUserTurn,
              sendUserTurnStream,
              preSignals,
              callbacks: {
                onStateChange: (s) => {
                  if (!voiceTransportStateGuardRef.current.allowsPipelineState(voiceEpoch)) return;
                  if (s === "listening" || s === "transcribing") {
                    setVoiceStatus(vadCapability.supported ? "listening" : "degraded");
                  }
                  else if (s === "thinking") setVoiceStatus("thinking");
                  else if (s === "speaking") setVoiceStatus("speaking");
                  else if (s === "interrupted") setVoiceStatus("interrupted");
                  else if (s === "idle") setVoiceStatus("idle");
                },
                onUserTranscript: (text, isFinal) => {
                  if (!voiceTransportStateGuardRef.current.isCurrent(voiceEpoch)) return;
                  // Live transcript chip only. The final user turn is persisted
                  // authoritatively by sendUserTurn → sendInterviewTurn (which adds
                  // BOTH the user turn and the assistant reply). Recording it again
                  // here was double-logging every turn (语音用户输入 + 用户表达).
                  setLiveUserTranscript(isFinal ? "" : text);
                },
                onAssistantText: () => {
                  // No-op: sendUserTurn already called setSession(r.session) with the
                  // assistant turn. Recording it again here double-logged the reply
                  // (百炼角色扮演追问 + 语音助手回应).
                },
                onError: (err) => {
                  if (!voiceTransportStateGuardRef.current.isCurrent(voiceEpoch)) return;
                  setNotice(buildNotice("warning", "级联语音错误", err.message));
                },
                onTtsPlaybackInterrupted: (err) => {
                  if (!voiceTransportStateGuardRef.current.isCurrent(voiceEpoch)) return;
                  if (err.message === TTS_AUTOPLAY_BLOCKED_MESSAGE) {
                    setNotice(buildNotice("warning", "浏览器拦住了声音", "请再点一次语音"));
                    return;
                  }
                  setNotice(buildNotice("warning", "语音播放中断", "本轮语音播放中断，文字内容已保留"));
                },
                onLatency: (sample) => {
                  if (!voiceTransportStateGuardRef.current.isCurrent(voiceEpoch)) return;
                  reportLatency(sample);
                },
                onSpokenBarge: ({ spokenTextSoFar }) => {
                  if (!voiceTransportStateGuardRef.current.isCurrent(voiceEpoch)) return;
                  const realtimeSessionId = voiceSession.sessionId;
                  if (!realtimeSessionId) return;
                  void productApiClient.interruptRealtimeVoiceSession(realtimeSessionId, {
                    spokenTextSoFar,
                    reason: "user_interrupt"
                  }).catch((error) => {
                    console.warn(JSON.stringify({
                      event: "barge_truncate_failed",
                      error: error instanceof Error ? error.message : String(error)
                    }));
                  });
                },
                onTranscriptQuarantined: (item) => {
                  if (!voiceTransportStateGuardRef.current.isCurrent(voiceEpoch)) return;
                  setLiveUserTranscript("");
                  voiceReviewItemRef.current = item;
                  setVoiceReviewItem(item);
                  setNotice(buildNotice(
                    "info",
                    "转写等待确认",
                    item.source === "recovery"
                      ? "连接中断前的尾段尚未确认，请确认、修改或丢弃；确认前不会写入专访。"
                      : "检测到内容可能来自刚才的 AI 播放，请确认、修改或丢弃后再写入专访。"
                  ));
                }
              },
              decisionOpts: {
                minPauseMs: Math.max(300, Math.min(6000, productState.systemConfig.interview.silenceHoldMs)),
                finalStabilityMs: 450,
                echoWindowMs: 1_500,
                echoSimilarityThreshold: 0.8,
                ...(productState.systemConfig.voice.minBargeInMs != null
                  ? { minBargeInMs: productState.systemConfig.voice.minBargeInMs }
                  : {}),
                ...(productState.systemConfig.voice.endpointingMode
                  ? { endpointingMode: productState.systemConfig.voice.endpointingMode }
                  : {})
              },
              classifyEndpoint: interviewId && productState.systemConfig.voice.useLayer2Endpoint
                ? (text: string, signal: AbortSignal) => productApiClient.classifyTurnComplete(interviewId, text, signal)
                : undefined,
              onDecision: (trace) => {
                if (!voiceTransportStateGuardRef.current.isCurrent(voiceEpoch)) return;
                console.debug("[cascade decision]", trace);
                if (interviewId) void productApiClient.logCascadeDecision(interviewId, trace);
              },
            });

            cascadePipelineRef.current = pipeline;

            // Render the recording UI IMMEDIATELY. The opening playback + mic open
            // run in the BACKGROUND (not awaited): awaiting startListening here froze
            // the page for the whole ~9s opening before setRecording ran, and the
            // opening played while the UI was still stuck on "connecting".
            // voiceStatus is driven by the pipeline's onStateChange (speaking → listening).
            setRecording(true);
            setNotice(buildNotice(
              "success",
              "实时语音会话已就绪",
              vadCapability.supported
                ? "级联模式 (ASR→分析→TTS) 已连接"
                : "级联模式已连接；AudioWorklet 不可用，当前使用语音兼容模式。"
            ));
            void pipeline.startListening(card.suggestedOpening || undefined).catch((err) => {
              if (!voiceTransportStateGuardRef.current.isCurrent(voiceEpoch)) return;
              setNotice(buildNotice("warning", "级联语音连接失败", err instanceof Error ? err.message : "请确认后端在线且 API key 已配置"));
            });
            return;
          } catch (err) {
            setNotice(buildNotice("warning", "级联语音连接失败", err instanceof Error ? err.message : "请确认后端在线且 API key 已配置"));
            return;
          }
        }

        if (voiceMode === "livekit") {
          // LiveKit cascaded pipeline (browser → LiveKit server → Python agent → DashScope)
          try {
            setVoiceStatus("connecting");
            const sessionId = voiceSession.sessionId;
            const interviewId = session?.id ?? "";
            // 走 productApi 的 authedFetch（getLivekitToken）：production bearer 鉴权下
            // 裸 fetch 不带 Authorization 恒 401。失败仍抛错 → 下方 catch 提示连接失败。
            const { token, serverUrl } = await productApiClient.getLivekitToken(sessionId, interviewId);

            const livekitSession = await createLivekitVoiceSession({
              serverUrl: serverUrl ?? "ws://127.0.0.1:7880",
              token,
              interviewSessionId: interviewId,
              callbacks: {
                onStateChange: (state) => {
                  if (state === "connected") setVoiceStatus("listening");
                  if (state === "disconnected") { setRecording(false); setVoiceStatus("idle"); }
                },
                onUserTranscript: (text, isFinal) => {
                  setLiveUserTranscript(text);
                  if (!isFinal || !text.trim()) return;
                  // Record on the server session to keep it authoritative (no fork).
                  productApiClient
                    .recordInterviewTurn(interviewId, { role: "user", content: text })
                    .then((r) => {
                      setSession(r.session);
                      if (r.state) adoptServerState(r.state);
                    })
                    .catch((err) => recordTurnFailedFallback(text, err));
                  // Phase 8: regenerate pre_signals for the next turn (voice path).
                  if (interviewId) {
                    productApiClient
                      .generateInterviewPreSignals(interviewId)
                      .then((res) => {
                        setSession((prev) => (prev ? { ...prev, interactionPreSignals: res.preSignals } : prev));
                      })
                      .catch(() => {
                        // keep existing signals on failure
                      });
                  }
                  // 🔴-1 (honest scope): NO per-turn instruction refresh here. The
                  // LiveKit cascade's instructions live in the Python agent
                  // (agent-context), not in a client-side session.update — so memory
                  // recall freshness on this path depends on whether that Python agent
                  // re-fetches /api/realtime-voice/agent-context each turn (that side's
                  // concern). This task fixed ONLY the bailian omni (WS/WebRTC) path,
                  // which DOES refresh via connection.updateInstructions above.
                },
                onAssistantTranscript: (text, isFinal) => {
                  if (!isFinal || !text.trim()) return;
                  setVoiceStatus("speaking");
                  if (!interviewId) {
                    setSession((prev) =>
                      prev ? appendAssistantTranscriptFinal(prev, text, assistantTranscriptTurnRef) : prev
                    );
                    return;
                  }
                  productApiClient
                    .recordInterviewTurn(interviewId, { role: "assistant", content: text })
                    .then((r) => {
                      setSession(r.session);
                      if (r.state) adoptServerState(r.state);
                    })
                    .catch(() => {
                      setSession((prev) =>
                        prev ? appendAssistantTranscriptFinal(prev, text, assistantTranscriptTurnRef) : prev
                      );
                    });
                },
                onAudioLevel: (level) => setAudioLevel(level),
                onError: (err) => {
                  setNotice(buildNotice("warning", "语音连接失败", err.message));
                },
                // Residual metrics (PR-2o): livekit interrupt publish outcome → runtime-metrics.
                onBargeInMetric: (sample) => {
                  void productApiClient.reportVoiceLatency({
                    path: "livekit",
                    interrupted: sample.interrupted,
                    bargeInSuccess: sample.bargeInSuccess,
                    ...(interviewId ? { sessionId: interviewId } : {})
                  });
                },
              },
            });

            // Publish the microphone — without this the agent never hears the user.
            await livekitSession.startListening();
            setLivekitVoiceSession(livekitSession);
            setRecording(true);
            setVoiceStatus("listening");
            setNotice(
              buildNotice(
                "success",
                "实时语音会话已就绪",
                "LiveKit 级联 (Paraformer→Qwen→CosyVoice) 已连接"
              )
            );
            return;
          } catch {
            setNotice(buildNotice("warning", "LiveKit 连接失败", "请确认 LiveKit Server 和 Python Agent 已启动"));
            return;
          }
        }

        // Bailian mode (default): direct DashScope omni via WebSocket proxy
        // or WebRTC — single hop, integrated STT+LLM+TTS with server VAD.
        try {
          setVoiceStatus("connecting");
          // Augment the session with the scripted opening line (sourced from the
          // interview card's suggestedOpening). The WS path uses this to send an
          // initial response.create so the AI proactively opens with the prepared
          // tracking-point question rather than improvising small-talk.
          const sessionWithOpening = {
            ...voiceSession,
            ...(card.suggestedOpening ? { openingLine: card.suggestedOpening } : {})
          };
          if (voiceSession.transport === "webrtc") {
            // ponytail: the WebRTC omni client is incomplete (no transcript/audio/turn
            // callbacks, no DataChannel parsing) — it would connect but record nothing.
            // Until it's finished, fall back to the working WebSocket path.
            console.warn(JSON.stringify({ event: "webrtc_incomplete_fallback_to_ws" }));
            setNotice(buildNotice("info", "已改用 WebSocket 实时语音", "WebRTC 通道尚未完整支持，已自动切换。"));
          }
          const connection = await connectBailianRealtimeWebsocket(sessionWithOpening, {
                productApiBaseUrl: deriveRealtimeWsBaseUrl(getProductApiBaseUrl()),
                preSignals: session?.interactionPreSignals,
                guidanceEnabled: productState.systemConfig.interview.guidanceEnabled !== false,
                guidanceBudget: {
                  maxPerTurn: productState.systemConfig.interview.maxGuidancePerTurn ?? 2,
                  minIntervalMs: productState.systemConfig.interview.minGuidanceIntervalMs ?? 5000
                },
                onAudioLevel: (level) => setAudioLevel(level),
                onSpeechStart: () => setVoiceStatus("listening"),
                onSpeechEnd: () => setVoiceStatus("speaking"),
                onGuidance: (text) => {
                  // Light up the in-conversation guidance indicator (the visual badge
                  // in InterviewView), and whisper short guidance via SpeechSynthesis.
                  setGuidanceState(prev => ({
                    active: true,
                    kind: "nudge",
                    text,
                    countThisTurn: prev.countThisTurn + 1,
                    lastTimestamp: new Date().toISOString()
                  }));
                  if (text.length < 40) {
                    try {
                      const utterance = new SpeechSynthesisUtterance(text);
                      utterance.lang = "zh-CN";
                      utterance.rate = 1.1;
                      utterance.volume = 0.7;
                      speechSynthesis.cancel();
                      speechSynthesis.speak(utterance);
                    } catch { /* SpeechSynthesis not available */ }
                  }
                },
                onUserTranscript: (text, isFinal) => {
                  setLiveUserTranscript(text);
                  if (!isFinal || !text.trim()) return;
                  // Record on the server session to keep it authoritative (no fork).
                  const voiceSid = session?.id ?? "";
                  if (voiceSid) {
                    productApiClient
                      .recordInterviewTurn(voiceSid, { role: "user", content: text })
                      .then((r) => {
                        setSession(r.session);
                        if (r.state) adoptServerState(r.state);
                      })
                      .catch((err) => recordTurnFailedFallback(text, err));
                  } else {
                    setSession((prev) => (prev ? receiveUserTurn(prev, text) : prev));
                  }
                  // Phase 8: regenerate pre_signals for the next turn and push
                  // them into the live connection (the voice model can't emit them).
                  if (voiceSid) {
                    productApiClient
                      .generateInterviewPreSignals(voiceSid)
                      .then((res) => {
                        voiceRecallRefreshSucceeded();
                        setSession((prev) => (prev ? { ...prev, interactionPreSignals: res.preSignals } : prev));
                        if ("updatePreSignals" in connection) connection.updatePreSignals(res.preSignals);
                      })
                      .catch((err) => voiceRecallRefreshFailed("pre_signals", err));
                    // 🔴-1: recompute the omni voice model's instructions against THIS
                    // turn's utterance so its memory recall tracks the conversation
                    // (the realtime session set instructions only once at open — an
                    // opening-time snapshot). Push the refreshed string via
                    // session.update. Non-blocking（实时策略）但失败可观测,
                    // 连续失败会向用户提示（见 voiceRecallRefreshFailed）。
                    productApiClient
                      .refreshVoiceInstructions(voiceSid, text)
                      .then((res) => {
                        voiceRecallRefreshSucceeded();
                        if ("updateInstructions" in connection) connection.updateInstructions(res.instructions);
                      })
                      .catch((err) => voiceRecallRefreshFailed("voice_instructions", err));
                  }
                },
                onAssistantTranscript: (text, isFinal) => {
                  if (!isFinal || !text.trim()) return;
                  const assistantSid = session?.id ?? "";
                  if (!assistantSid) {
                    setSession((prev) =>
                      prev ? appendAssistantTranscriptFinal(prev, text, assistantTranscriptTurnRef) : prev
                    );
                    return;
                  }
                  productApiClient
                    .recordInterviewTurn(assistantSid, { role: "assistant", content: text })
                    .then((r) => {
                      setSession(r.session);
                      if (r.state) adoptServerState(r.state);
                    })
                    .catch(() => {
                      setSession((prev) =>
                        prev ? appendAssistantTranscriptFinal(prev, text, assistantTranscriptTurnRef) : prev
                      );
                    });
                },
                // 重连过程对用户可见（此前 3 次重连期间 UI 仍显示"聆听中"，用户不知连接已断）。
                // Residual (PR-2o): UX + bailianWebsocket structured logs (omni_reconnecting/…)
                // make reconnect countable without new metrics schema fields.
                onReconnecting: (attempt, maxAttempts) => {
                  setVoiceStatus("connecting");
                  setNotice(buildNotice("warning", "语音连接中断", `正在重连（第 ${attempt}/${maxAttempts} 次）…`));
                },
                onReconnected: () => {
                  setVoiceStatus("listening");
                  setNotice(buildNotice("success", "语音连接已恢复", "可以继续对话。"));
                },
                onError: (err) => {
                  setNotice(buildNotice("warning", "语音连接异常", err.message));
                }
              });
          setRealtimeVoiceConnection(connection);
          setRecording(true);
          setVoiceStatus("listening");
          setNotice(
            buildNotice(
              "success",
              "实时语音会话已就绪",
              `${voiceSession.model} · WebSocket 已连接`
            )
          );
        } catch {
          setNotice(
            buildNotice(
              "warning",
              "语音连接失败",
              "百炼 WebSocket 连接失败。"
            )
          );
          return;
        }
      } else {
        setRecording(false);
        setNotice(
          buildNotice(
            "warning",
            "实时语音未完全配置",
            "请检查 API Key 配置。"
          )
        );
      }
      return;
    } catch {
      setApiPersistenceEnabled(false);
    } finally {
      // P3-19:连接流程 settle(成功就绪 / 失败 / 早返回)后复位,让后续开关正常工作。
      togglingRef.current = false;
    }

    setRealtimeVoiceSession(null);
    setNotice(buildNotice("warning", "实时语音不可用", "Product API 不可用，无法开始语音专访，请检查服务后重试。"));
  }

  function refreshLiveVoiceInstructions() {
    const voiceSid = session?.id;
    const connection = realtimeVoiceConnection as { updateInstructions?: (text: string) => void } | null;
    if (!voiceSid || !connection?.updateInstructions) return;
    void productApiClient
      .refreshVoiceInstructions(voiceSid)
      .then((res) => {
        connection.updateInstructions?.(res.instructions);
      })
      .catch((err) => voiceRecallRefreshFailed("voice_instructions", err));
  }

  return {
    closeRealtimeVoiceSession,
    interruptAssistant,
    toggleRealtimeRecording,
    refreshLiveVoiceInstructions
  };
}
