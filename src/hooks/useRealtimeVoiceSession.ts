import { useCallback, useRef, useState } from "react";
import type { CascadedPipeline, TtsSink } from "../realtime/cascadedPipeline";
import type { BailianRealtimeWebrtcConnection } from "../realtime/realtimeTypes";
import type { BailianRealtimeWebsocketConnection } from "../realtime/bailianWebsocket";
import type { LivekitVoiceSession } from "../realtime/livekitVoice";
import type { SessionAudioRecorder } from "../realtime/sessionAudioRecorder";
import type { RealtimeVoiceSessionResponse } from "../api/productApi";
import { productApiClient } from "../api/productApi";
import type { useInterruptedUtteranceStash } from "./useInterruptedUtteranceStash";

export type VoiceStatus = "idle" | "connecting" | "listening" | "speaking" | "interrupted";

type RealtimeConnection =
  | BailianRealtimeWebrtcConnection
  | BailianRealtimeWebsocketConnection
  | LivekitVoiceSession
  | null;

/**
 * Stage-3 residual: hold realtime voice transport state + close/interrupt lifecycle.
 * Full cascade/omni/livekit connect still lives in App (high coupling to session/card/adopt);
 * this hook removes ~80 lines of state/refs/close/interrupt plumbing from App.
 */
export function useRealtimeVoiceSession(opts: {
  interviewSessionId?: string | null;
  interruptedStash: ReturnType<typeof useInterruptedUtteranceStash>;
  onGuidanceReset?: () => void;
}) {
  const [recording, setRecording] = useState(false);
  const [realtimeVoiceSession, setRealtimeVoiceSession] = useState<RealtimeVoiceSessionResponse | null>(null);
  const [realtimeVoiceConnection, setRealtimeVoiceConnection] = useState<RealtimeConnection>(null);
  const [livekitVoiceSession, setLivekitVoiceSession] = useState<LivekitVoiceSession | null>(null);
  const cascadePipelineRef = useRef<CascadedPipeline | null>(null);
  const audioRecorderRef = useRef<SessionAudioRecorder | null>(null);
  const ttsSinkRef = useRef<TtsSink | null>(null);
  const assistantTranscriptTurnRef = useRef<number>(-1);
  const [audioLevel, setAudioLevel] = useState(0);
  const [voiceStatus, setVoiceStatus] = useState<VoiceStatus>("idle");
  const [liveUserTranscript, setLiveUserTranscript] = useState("");

  const closeRealtimeVoiceSession = useCallback(() => {
    if (livekitVoiceSession) {
      livekitVoiceSession.close();
      setLivekitVoiceSession(null);
    }
    realtimeVoiceConnection?.close();
    setRealtimeVoiceConnection(null);
    setRealtimeVoiceSession(null);
    if (cascadePipelineRef.current) {
      cascadePipelineRef.current.close();
      cascadePipelineRef.current = null;
    }
    ttsSinkRef.current = null;
    if (audioRecorderRef.current) {
      const orphan = audioRecorderRef.current;
      audioRecorderRef.current = null;
      void orphan.stop().catch(() => {
        /* discarded */
      });
    }
    setRecording(false);
    setAudioLevel(0);
    setVoiceStatus("idle");
  }, [livekitVoiceSession, realtimeVoiceConnection]);

  const interruptAssistant = useCallback(async () => {
    opts.onGuidanceReset?.();
    let interrupted = false;
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
    if (!interrupted) return;

    const realtimeSessionId = realtimeVoiceSession?.sessionId;
    if (realtimeSessionId) {
      try {
        const interruptResult = await productApiClient.interruptRealtimeVoiceSession(realtimeSessionId, {
          spokenTextSoFar,
          reason: "user_interrupt"
        });
        const stashText =
          (interruptResult as { previousAgentUtteranceInterrupted?: string } | undefined)
            ?.previousAgentUtteranceInterrupted ?? spokenTextSoFar;
        opts.interruptedStash.recordInterrupt(stashText, opts.interviewSessionId ?? undefined);
      } catch (error) {
        opts.interruptedStash.recordInterrupt(spokenTextSoFar, opts.interviewSessionId ?? undefined);
        console.warn(
          JSON.stringify({
            event: "interrupt_persist_failed",
            error: error instanceof Error ? error.message : String(error)
          })
        );
      }
    } else {
      opts.interruptedStash.recordInterrupt(spokenTextSoFar, opts.interviewSessionId ?? undefined);
    }
    setVoiceStatus("interrupted");
    setTimeout(() => setVoiceStatus("listening"), 1500);
  }, [
    livekitVoiceSession,
    opts.interviewSessionId,
    opts.interruptedStash,
    opts.onGuidanceReset,
    realtimeVoiceConnection,
    realtimeVoiceSession?.sessionId
  ]);

  return {
    recording,
    setRecording,
    realtimeVoiceSession,
    setRealtimeVoiceSession,
    realtimeVoiceConnection,
    setRealtimeVoiceConnection,
    livekitVoiceSession,
    setLivekitVoiceSession,
    cascadePipelineRef,
    audioRecorderRef,
    ttsSinkRef,
    assistantTranscriptTurnRef,
    audioLevel,
    setAudioLevel,
    voiceStatus,
    setVoiceStatus,
    liveUserTranscript,
    setLiveUserTranscript,
    closeRealtimeVoiceSession,
    interruptAssistant
  };
}
