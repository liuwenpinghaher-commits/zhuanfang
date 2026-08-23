/**
 * Stage-3: cascade / livekit / bailian connect orchestration (was inline in App).
 * App supplies product callbacks; this module owns transport wiring only.
 */
import { productApiClient, withAuthTokenQuery, type RealtimeVoiceSessionResponse } from "../api/productApi";
import type { InterviewSession, ProductState } from "../domain/types";
import type { UiNotice } from "../ui";
import { connectCascadedPipeline, type CascadedPipeline, type TtsSink } from "./cascadedPipeline";
import { createBrowserAsrSource } from "./cascadedAsrSource";
import { createBrowserTtsSink } from "./cascadedTtsSink";
import { createSessionAudioRecorder, type SessionAudioRecorder } from "./sessionAudioRecorder";
import { createLivekitVoiceSession, type LivekitVoiceSession } from "./livekitVoice";
import {
  connectBailianRealtimeWebsocket,
  type BailianRealtimeWebsocketConnection
} from "./bailianWebsocket";
import { connectBailianRealtimeWebrtc } from "./bailianWebrtc";
import type { BailianRealtimeWebrtcConnection } from "./realtimeTypes";
import { appendAssistantTranscriptFinal } from "../domain/session-transcript";
import { receiveUserTurn } from "../domain/engine";
import type { MutableRefObject } from "react";

export type VoiceConnectNotice = (notice: UiNotice) => void;

export interface StartRealtimeVoiceConnectDeps {
  voiceSession: RealtimeVoiceSessionResponse;
  voiceMode: "cascade" | "livekit" | "bailian";
  interviewSession: InterviewSession | null;
  defaultVoice: string;
  suggestedOpening?: string;
  baseWsUrl: string;
  cascadePipelineRef: MutableRefObject<CascadedPipeline | null>;
  audioRecorderRef: MutableRefObject<SessionAudioRecorder | null>;
  ttsSinkRef: MutableRefObject<TtsSink | null>;
  assistantTranscriptTurnRef: MutableRefObject<number>;
  setRealtimeVoiceConnection: (
    c: BailianRealtimeWebrtcConnection | BailianRealtimeWebsocketConnection | LivekitVoiceSession | null
  ) => void;
  setLivekitVoiceSession: (s: LivekitVoiceSession | null) => void;
  setRecording: (v: boolean) => void;
  setVoiceStatus: (s: "idle" | "connecting" | "thinking" | "listening" | "speaking" | "interrupted") => void;
  setLiveUserTranscript: (t: string) => void;
  setAudioLevel: (n: number) => void;
  setSession: (updater: InterviewSession | null | ((prev: InterviewSession | null) => InterviewSession | null)) => void;
  setGuidanceState: (
    updater:
      | {
          active: boolean;
          kind: string | null;
          text: string | null;
          countThisTurn: number;
          lastTimestamp: string | null;
        }
      | ((prev: {
          active: boolean;
          kind: string | null;
          text: string | null;
          countThisTurn: number;
          lastTimestamp: string | null;
        }) => {
          active: boolean;
          kind: string | null;
          text: string | null;
          countThisTurn: number;
          lastTimestamp: string | null;
        })
  ) => void;
  setNotice: VoiceConnectNotice;
  setApiPersistenceEnabled: (v: boolean) => void;
  adoptServerState: (state: ProductState) => void;
  closeRealtimeVoiceSession: () => void;
  reportLatency: (sample: {
    ttfaMs?: number;
    vadEndToSttMs?: number;
    sttToLlmMs?: number;
    llmTtftMs?: number;
    ttsTtfbMs?: number;
    ttsPcmTtfbMs?: number;
    openingAudible?: boolean;
    playbackContextState?: "running" | "suspended";
    interrupted?: boolean;
    bargeInSuccess?: boolean;
    takeFloor?: boolean;
    interruptRecovery?: boolean;
    falseTriggerKind?:
      | "quarantine_echo_suspect"
      | "max_wait_suppressed"
      | "auto_committed_echo_suspect"
      | "opening_second_turn_abort";
  }) => void;
  consumeInterruptStashPrompt: () => string;
  recordTurnFailedFallback: (text: string, err: unknown) => void;
  voiceRecallRefreshSucceeded: () => void;
  voiceRecallRefreshFailed: (kind: "pre_signals" | "voice_instructions", err: unknown) => void;
  buildNotice: (severity: "success" | "warning" | "danger" | "info", title: string, detail: string) => UiNotice;
  /**
   * Cascade endpointing policy (default L1). See `systemConfig.voice.endpointingMode`
   * and docs/cascade-l1-ttfa-baseline.md. Does not change ASR model.
   */
  endpointingMode?: "silence" | "semantic" | "pvad-experimental";
  /** Barge-in sustain ms while agent speaks; pipeline default 280 if omitted. */
  minBargeInMs?: number;
  /** Cascade pause before treating the user turn as complete. */
  minPauseMs?: number;
  guidanceEnabled?: boolean;
  guidanceBudget?: { maxPerTurn: number; minIntervalMs: number };
}

export async function startRealtimeVoiceConnect(deps: StartRealtimeVoiceConnectDeps): Promise<"connected" | "failed" | "not-ready"> {
  const {
    voiceSession,
    voiceMode,
    interviewSession,
    defaultVoice,
    suggestedOpening,
    baseWsUrl,
    buildNotice
  } = deps;

  if (voiceSession.status !== "ready") {
    deps.setRecording(false);
    deps.setNotice(buildNotice("warning", "实时语音未完全配置", "请检查 API Key 配置。"));
    return "not-ready";
  }

  if (voiceMode === "cascade") {
    try {
      deps.setVoiceStatus("connecting");
      const asrWsUrl = withAuthTokenQuery(`${baseWsUrl}/api/realtime-voice/ws/${voiceSession.sessionId}`);
      const ttsWsUrl = withAuthTokenQuery(`${baseWsUrl}/api/realtime-voice/ws/tts/${voiceSession.sessionId}`);
      const interviewId = interviewSession?.id ?? "";

      const asr = createBrowserAsrSource({
        asrWsUrl,
        silenceDurationMs: 900,
        instructions: voiceSession.sessionUpdate.session.instructions,
        onConnectionLost: () => {
          deps.setNotice(buildNotice("warning", "语音连接已断开", "语音识别中断,请重新点击录音继续。文字输入不受影响。"));
          deps.closeRealtimeVoiceSession();
        },
        onMicStream: (stream) => {
          try {
            const recorder = createSessionAudioRecorder(stream);
            recorder.start();
            deps.audioRecorderRef.current = recorder;
          } catch (err) {
            deps.audioRecorderRef.current = null;
            console.warn(
              JSON.stringify({
                event: "session_recorder_start_failed",
                error: err instanceof Error ? err.message : String(err)
              })
            );
          }
        }
      });
      const tts = createBrowserTtsSink(ttsWsUrl, defaultVoice);
      deps.ttsSinkRef.current = tts;

      const sendUserTurn = async (text: string, signal: AbortSignal) => {
        if (!interviewId) return { assistantText: "" };
        const stashFragment = deps.consumeInterruptStashPrompt();
        if (stashFragment) {
          try {
            await productApiClient.refreshVoiceInstructions(interviewId, `${stashFragment}\n\n用户新输入：${text}`);
          } catch {
            /* best-effort */
          }
        }
        const r = await productApiClient.sendInterviewTurn(interviewId, { content: text }, signal);
        deps.setSession(r.session);
        deps.adoptServerState(r.state);
        deps.setApiPersistenceEnabled(true);
        if (r.preSignals) deps.cascadePipelineRef.current?.updatePreSignals(r.preSignals);
        const lastTurn = r.session.turns.at(-1);
        return { assistantText: lastTurn?.content ?? "", prosody: lastTurn?.prosody };
      };

      const sendUserTurnStream = interviewId
        ? async (text: string, signal: AbortSignal, onDelta: (chunk: string) => void) => {
            const stashFragment = deps.consumeInterruptStashPrompt();
            if (stashFragment) {
              try {
                await productApiClient.refreshVoiceInstructions(interviewId, `${stashFragment}\n\n用户新输入：${text}`);
              } catch {
                /* best-effort */
              }
            }
            const r = await productApiClient.sendInterviewTurnStream(
              interviewId,
              { content: text },
              { signal, onDelta }
            );
            if (r.session) deps.setSession(r.session);
            if (r.state) {
              deps.adoptServerState(r.state);
              deps.setApiPersistenceEnabled(true);
            }
            if (r.preSignals) deps.cascadePipelineRef.current?.updatePreSignals(r.preSignals);
            const lastTurn = r.session?.turns.at(-1);
            return {
              assistantText: r.assistantText ?? lastTurn?.content ?? "",
              ...(lastTurn?.prosody ? { prosody: lastTurn.prosody } : {})
            };
          }
        : undefined;

      const pipeline = connectCascadedPipeline({
        asr,
        tts,
        sendUserTurn,
        ...(sendUserTurnStream ? { sendUserTurnStream } : {}),
        preSignals: interviewSession?.interactionPreSignals ?? null,
        decisionOpts: {
          ...(deps.minPauseMs != null ? { minPauseMs: deps.minPauseMs } : {}),
          ...(deps.minBargeInMs != null ? { minBargeInMs: deps.minBargeInMs } : {}),
          ...(deps.endpointingMode ? { endpointingMode: deps.endpointingMode } : {})
        },
        callbacks: {
          onStateChange: (s) => {
            if (s === "listening" || s === "transcribing") deps.setVoiceStatus("listening");
            else if (s === "thinking") deps.setVoiceStatus("thinking");
            else if (s === "speaking") deps.setVoiceStatus("speaking");
            else if (s === "interrupted") deps.setVoiceStatus("interrupted");
            else if (s === "idle") deps.setVoiceStatus("idle");
          },
          onUserTranscript: (text, isFinal) => {
            deps.setLiveUserTranscript(isFinal ? "" : text);
          },
          onAssistantText: () => {},
          onError: (err) => {
            deps.setNotice(buildNotice("warning", "级联语音错误", err.message));
          },
          onLatency: (sample) => {
            deps.reportLatency(sample);
          },
          onSpokenBarge: ({ spokenTextSoFar }) => {
            const realtimeSessionId = deps.voiceSession.sessionId;
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
          }
        },
        classifyEndpoint: interviewId
          ? (text: string, signal: AbortSignal) => productApiClient.classifyTurnComplete(interviewId, text, signal)
          : undefined,
        onDecision: (trace) => {
          console.debug("[cascade decision]", trace);
          if (interviewId) void productApiClient.logCascadeDecision(interviewId, trace);
        }
      });

      deps.cascadePipelineRef.current = pipeline;
      deps.setRecording(true);
      const eotNote =
        deps.endpointingMode === "pvad-experimental"
          ? "（endpointing: pVAD-lite；LLM→TTS 已支持首句流式）"
          : deps.endpointingMode === "semantic"
            ? "（endpointing: semantic；LLM→TTS 首句流式）"
            : deps.endpointingMode === "silence"
              ? "（endpointing: silence）"
              : "";
      deps.setNotice(buildNotice("success", "实时语音会话已就绪", `级联模式 (ASR→分析→TTS) 已连接${eotNote}`));
      void pipeline.startListening(suggestedOpening || undefined).catch((err) => {
        deps.setNotice(
          buildNotice("warning", "级联语音连接失败", err instanceof Error ? err.message : "请确认后端在线且 API key 已配置")
        );
      });
      return "connected";
    } catch (err) {
      deps.setNotice(
        buildNotice("warning", "级联语音连接失败", err instanceof Error ? err.message : "请确认后端在线且 API key 已配置")
      );
      return "failed";
    }
  }

  if (voiceMode === "livekit") {
    try {
      deps.setVoiceStatus("connecting");
      const sessionId = voiceSession.sessionId;
      const interviewId = interviewSession?.id ?? "";
      const { token, serverUrl } = await productApiClient.getLivekitToken(sessionId, interviewId);
      const livekitSession = await createLivekitVoiceSession({
        serverUrl: serverUrl ?? "ws://127.0.0.1:7880",
        token,
        interviewSessionId: interviewId,
        callbacks: {
          onStateChange: (state) => {
            if (state === "connected") deps.setVoiceStatus("listening");
            if (state === "disconnected") {
              deps.setRecording(false);
              deps.setVoiceStatus("idle");
            }
          },
          onUserTranscript: (text, isFinal) => {
            deps.setLiveUserTranscript(text);
            if (!isFinal || !text.trim()) return;
            productApiClient
              .recordInterviewTurn(interviewId, { role: "user", content: text })
              .then((r) => {
                deps.setSession(r.session);
                // R-P1-03: adopt authoritative state so strategyTrace / referencedMemory
                // from server-side derive land in productState (not only local session).
                if (r.state) deps.adoptServerState(r.state);
              })
              .catch((err) => deps.recordTurnFailedFallback(text, err));
            if (interviewId) {
              productApiClient
                .generateInterviewPreSignals(interviewId)
                .then((res) => {
                  deps.voiceRecallRefreshSucceeded();
                  deps.setSession((prev) => (prev ? { ...prev, interactionPreSignals: res.preSignals } : prev));
                })
                .catch((err) => deps.voiceRecallRefreshFailed("pre_signals", err));
            }
          },
          onAssistantTranscript: (text, isFinal) => {
            if (!isFinal || !text.trim()) return;
            deps.setVoiceStatus("speaking");
            if (interviewId) {
              productApiClient
                .recordInterviewTurn(interviewId, { role: "assistant", content: text })
                .then((r) => {
                deps.setSession(r.session);
                // R-P1-03: adopt authoritative state so strategyTrace / referencedMemory
                // from server-side derive land in productState (not only local session).
                if (r.state) deps.adoptServerState(r.state);
              })
                .catch(() => {
                  deps.setSession((prev) =>
                    prev ? appendAssistantTranscriptFinal(prev, text, deps.assistantTranscriptTurnRef) : prev
                  );
                });
            } else {
              deps.setSession((prev) =>
                prev ? appendAssistantTranscriptFinal(prev, text, deps.assistantTranscriptTurnRef) : prev
              );
            }
          },
          onAudioLevel: (level) => deps.setAudioLevel(level),
          onError: (err) => {
            deps.setNotice(buildNotice("warning", "语音连接失败", err.message));
          },
          // Residual metrics (PR-2o): livekit interrupt publish outcome → runtime-metrics.
          onBargeInMetric: (sample) => {
            void productApiClient.reportVoiceLatency({
              path: "livekit",
              interrupted: sample.interrupted,
              bargeInSuccess: sample.bargeInSuccess,
              ...(interviewId ? { sessionId: interviewId } : {})
            });
          }
        }
      });
      await livekitSession.startListening();
      deps.setLivekitVoiceSession(livekitSession);
      deps.setRecording(true);
      deps.setVoiceStatus("listening");
      deps.setNotice(buildNotice("success", "实时语音会话已就绪", "LiveKit 级联 (Paraformer→Qwen→CosyVoice) 已连接"));
      return "connected";
    } catch {
      deps.setNotice(buildNotice("warning", "LiveKit 连接失败", "请确认 LiveKit Server 和 Python Agent 已启动"));
      return "failed";
    }
  }

  // bailian omni websocket (default fallback path)
  try {
    deps.setVoiceStatus("connecting");
    const sessionWithOpening = {
      ...voiceSession,
      ...(suggestedOpening ? { openingLine: suggestedOpening } : {})
    };
    let connection: BailianRealtimeWebrtcConnection | BailianRealtimeWebsocketConnection | null = null;
    if (voiceSession.transport === "webrtc") {
      try {
        connection = await connectBailianRealtimeWebrtc(sessionWithOpening, {
          productApiBaseUrl: baseWsUrl.replace(/^ws/i, "http"),
          onAudioLevel: (level) => deps.setAudioLevel(level),
          onSpeechStart: () => deps.setVoiceStatus("listening"),
          onSpeechEnd: () => deps.setVoiceStatus("speaking"),
          onConnectionLost: () => {
            deps.setNotice(buildNotice("warning", "WebRTC 连接已断开", "可重试录音；或切换 cascade/WebSocket 路径。"));
            deps.closeRealtimeVoiceSession();
          }
        });
        deps.setRealtimeVoiceConnection(connection);
        deps.setRecording(true);
        deps.setVoiceStatus("listening");
        deps.setNotice(buildNotice("success", "实时语音会话已就绪", "百炼 Omni WebRTC 已连接"));
        return "connected";
      } catch (err) {
        console.warn(JSON.stringify({
          event: "webrtc_connect_failed_fallback_to_ws",
          error: err instanceof Error ? err.message : String(err)
        }));
        deps.setNotice(
          buildNotice(
            "info",
            "WebRTC 建连失败，已回退 WebSocket",
            err instanceof Error ? err.message : "将使用 WebSocket 实时语音继续。"
          )
        );
      }
    }
    connection = await connectBailianRealtimeWebsocket(sessionWithOpening, {
      productApiBaseUrl: baseWsUrl,
      preSignals: interviewSession?.interactionPreSignals,
      guidanceEnabled: deps.guidanceEnabled,
      guidanceBudget: deps.guidanceBudget,
      onAudioLevel: (level) => deps.setAudioLevel(level),
      onSpeechStart: () => deps.setVoiceStatus("listening"),
      onSpeechEnd: () => deps.setVoiceStatus("speaking"),
      onGuidance: (text) => {
        deps.setGuidanceState((prev) => ({
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
          } catch {
            /* SpeechSynthesis not available */
          }
        }
      },
      onUserTranscript: (text, isFinal) => {
        deps.setLiveUserTranscript(text);
        if (!isFinal || !text.trim()) return;
        const voiceSid = interviewSession?.id ?? "";
        if (voiceSid) {
          productApiClient
            .recordInterviewTurn(voiceSid, { role: "user", content: text })
            .then((r) => {
                deps.setSession(r.session);
                // R-P1-03: adopt authoritative state so strategyTrace / referencedMemory
                // from server-side derive land in productState (not only local session).
                if (r.state) deps.adoptServerState(r.state);
              })
            .catch((err) => deps.recordTurnFailedFallback(text, err));
        } else {
          deps.setSession((prev) => (prev ? receiveUserTurn(prev, text) : prev));
        }
        if (voiceSid) {
          productApiClient
            .generateInterviewPreSignals(voiceSid)
            .then((res) => {
              deps.voiceRecallRefreshSucceeded();
              deps.setSession((prev) => (prev ? { ...prev, interactionPreSignals: res.preSignals } : prev));
              if (connection && "updatePreSignals" in connection) connection.updatePreSignals(res.preSignals);
            })
            .catch((err) => deps.voiceRecallRefreshFailed("pre_signals", err));
          productApiClient
            .refreshVoiceInstructions(voiceSid, text)
            .then((res) => {
              deps.voiceRecallRefreshSucceeded();
              if (connection && "updateInstructions" in connection) connection.updateInstructions(res.instructions);
              if ("state" in res && res.state) deps.adoptServerState(res.state as never);
              if ("session" in res && res.session) deps.setSession(res.session as never);
            })
            .catch((err) => deps.voiceRecallRefreshFailed("voice_instructions", err));
        }
      },
      onAssistantTranscript: (text, isFinal) => {
        if (!isFinal || !text.trim()) return;
        const assistantSid = interviewSession?.id ?? "";
        if (assistantSid) {
          productApiClient
            .recordInterviewTurn(assistantSid, { role: "assistant", content: text })
            .then((r) => {
                deps.setSession(r.session);
                // R-P1-03: adopt authoritative state so strategyTrace / referencedMemory
                // from server-side derive land in productState (not only local session).
                if (r.state) deps.adoptServerState(r.state);
              })
            .catch(() => {
              deps.setSession((prev) =>
                prev ? appendAssistantTranscriptFinal(prev, text, deps.assistantTranscriptTurnRef) : prev
              );
            });
        } else {
          deps.setSession((prev) =>
            prev ? appendAssistantTranscriptFinal(prev, text, deps.assistantTranscriptTurnRef) : prev
          );
        }
      },
      // Residual (PR-2o): reconnect UX is user-visible + countable via bailianWebsocket
      // structured logs (omni_reconnecting / omni_reconnected / omni_reconnect_exhausted).
      onReconnecting: (attempt, maxAttempts) => {
        deps.setVoiceStatus("connecting");
        deps.setNotice(buildNotice("warning", "语音连接中断", `正在重连（第 ${attempt}/${maxAttempts} 次）…`));
      },
      onReconnected: () => {
        deps.setVoiceStatus("listening");
        deps.setNotice(buildNotice("success", "语音连接已恢复", "可以继续对话。"));
      },
      onError: (err) => {
        deps.setNotice(buildNotice("warning", "语音连接异常", err.message));
      }
    });
    deps.setRealtimeVoiceConnection(connection);
    deps.setRecording(true);
    deps.setVoiceStatus("listening");
    deps.setNotice(buildNotice("success", "实时语音会话已就绪", `${voiceSession.model} · WebSocket 已连接`));
    return "connected";
  } catch {
    deps.setNotice(buildNotice("warning", "语音连接失败", "百炼 WebSocket 连接失败。"));
    return "failed";
  }
}
