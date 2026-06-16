/**
 * cascadedPipeline.ts
 *
 * Browser orchestrator for the three-stream cascaded voice pipeline:
 *
 *   流① ASR  — injected AsrSource (real impl: WS proxy + mic + feature tracking)
 *   流② gate — ExpressionState from AsrSource + decideCascadeTurn()
 *   流③ TTS  — injected TtsSink (real impl: WS to /api/realtime-voice/ws/tts/:id)
 *
 * All dependencies are injected so the orchestrator is fully testable without
 * real WS / mic / network. Real wiring lives in Task 5.
 */

import type { ExpressionState, InteractionPreSignals } from "../domain/types";
import { decideCascadeTurn } from "./cascadeTurnDecision";

// ---------------------------------------------------------------------------
// Public interfaces — shared between orchestrator, tests and Task 5 wiring
// ---------------------------------------------------------------------------

/**
 * Callbacks the orchestrator fires on lifecycle events.
 * Matches the shape convention of livekitVoice / bailianWebsocket.
 */
export interface AsrEventHandlers {
  onTranscriptDelta: (text: string) => void;
  onSpeechStarted: () => void;
  onSpeechStopped: (silenceMs: number) => void;
}

/**
 * Injected ASR event source.
 * Real implementation wraps the proxy WS + Web Audio mic + featureTracker.
 * Test implementation pushes synthetic events.
 */
export interface AsrSource {
  /** Register all event handlers before calling start(). */
  register(handlers: AsrEventHandlers): void;
  /** Open mic + WS, begin streaming PCM. */
  start(): Promise<void>;
  /** Stop mic + WS. */
  stop(): void;
  /**
   * Return the current ExpressionState.
   * Real impl: runs expressionDetector.evaluate(featureTracker.features(...)).
   * Test impl: returns a fixed or dynamically-set value.
   */
  getExpressionState(): ExpressionState;
}

/**
 * Injected TTS sink.
 * Real implementation sends to WS /api/realtime-voice/ws/tts/:id.
 * Test implementation records calls.
 */
export interface TtsSink {
  /**
   * Speak a list of sentence segments in order.
   * Resolves when all audio is done (or immediately for tests).
   */
  speak(segments: string[], voice?: string): Promise<void>;
  /** Stop any in-progress playback immediately. */
  stop(): void;
}

export type CascadePipelineState =
  | "idle"
  | "listening"
  | "transcribing"
  | "thinking"
  | "speaking"
  | "interrupted";

export interface CascadedPipelineCallbacks {
  onStateChange: (s: CascadePipelineState) => void;
  onUserTranscript: (text: string, isFinal: boolean) => void;
  onAssistantText: (text: string) => void;
  onError: (e: Error) => void;
}

export interface ConnectCascadedPipelineOptions {
  asr: AsrSource;
  tts: TtsSink;
  sendUserTurn: (
    text: string,
    signal: AbortSignal
  ) => Promise<{ assistantText: string }>;
  callbacks: CascadedPipelineCallbacks;
  preSignals?: InteractionPreSignals | null;
  decisionOpts?: { minPauseMs?: number; maxWaitMs?: number };
}

export interface CascadedPipeline {
  startListening(): Promise<void>;
  interrupt(): void;
  close(): void;
}

// ---------------------------------------------------------------------------
// Sentence splitter  (keep delimiters attached to preceding sentence)
// ---------------------------------------------------------------------------
function splitSentences(text: string): string[] {
  // Split after 。！？\n — keep delimiter with the preceding clause
  const parts = text.split(/(?<=[。！？\n])/u);
  return parts.map((s) => s.trim()).filter((s) => s.length > 0);
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------
export function connectCascadedPipeline(
  opts: ConnectCascadedPipelineOptions
): CascadedPipeline {
  const { asr, tts, sendUserTurn, callbacks, preSignals = null, decisionOpts = {} } = opts;
  const { minPauseMs = 600, maxWaitMs = 3500 } = decisionOpts;

  let state: CascadePipelineState = "idle";
  let closed = false;
  let transcriptAccumulator = "";
  // AbortController for the active LLM call (null when not thinking)
  let activeAbort: AbortController | null = null;
  // Max-wait safety-net timer handle
  let maxWaitTimer: ReturnType<typeof setTimeout> | null = null;

  function setState(next: CascadePipelineState) {
    if (state === next) return;
    state = next;
    callbacks.onStateChange(next);
  }

  function clearMaxWaitTimer() {
    if (maxWaitTimer !== null) {
      clearTimeout(maxWaitTimer);
      maxWaitTimer = null;
    }
  }

  function resetTurn() {
    transcriptAccumulator = "";
    clearMaxWaitTimer();
  }

  // ── Barge-in ──────────────────────────────────────────────────────────────
  /**
   * Called when ASR fires speech_started.
   * Returns true if a barge-in was performed (was thinking/speaking).
   */
  function handleSpeechStarted(): boolean {
    if (closed) return false;
    const wasActive = state === "thinking" || state === "speaking";
    if (wasActive) {
      // Abort in-flight LLM call
      if (activeAbort) {
        activeAbort.abort();
        activeAbort = null;
      }
      // Stop TTS playback
      tts.stop();
      clearMaxWaitTimer();
      setState("interrupted");
    }
    // Reset accumulator — new utterance starts fresh
    transcriptAccumulator = "";
    return wasActive;
  }

  // ── Speech stopped: analysis gate ─────────────────────────────────────────
  async function handleSpeechStopped(silenceMs: number) {
    if (closed) return;
    // If already thinking / speaking, barge-in path handles it
    if (state === "thinking" || state === "speaking") return;

    const expressionState = asr.getExpressionState();
    const decision = decideCascadeTurn({
      expressionState,
      silenceMs,
      preSignals: preSignals ?? null,
      minPauseMs,
      maxWaitMs,
    });

    if (decision.action === "wait") {
      // 留白: arm the max-wait safety-net timer if not already running
      if (maxWaitTimer === null) {
        maxWaitTimer = setTimeout(() => {
          maxWaitTimer = null;
          if (!closed && state !== "thinking" && state !== "speaking") {
            void doRespond();
          }
        }, maxWaitMs);
      }
      return;
    }

    if (decision.action === "backchannel") {
      clearMaxWaitTimer();
      const text = decision.backchannelText ?? "嗯。";
      await tts.speak([text]);
      // Stay in listening state; do NOT reset the accumulator
      return;
    }

    // action === "respond"
    clearMaxWaitTimer();
    await doRespond();
  }

  // ── Core respond flow ──────────────────────────────────────────────────────
  async function doRespond() {
    if (closed) return;
    if (state === "thinking" || state === "speaking") return;

    const fullTranscript = transcriptAccumulator.trim();
    callbacks.onUserTranscript(fullTranscript, true);

    setState("thinking");
    const ctrl = new AbortController();
    activeAbort = ctrl;

    let assistantText: string;
    try {
      const result = await sendUserTurn(fullTranscript, ctrl.signal);
      assistantText = result.assistantText;
    } catch (err) {
      // Aborted by barge-in — normal, not an error
      if ((err as DOMException)?.name === "AbortError") {
        // barge-in already called setState("interrupted") → "listening"
        return;
      }
      callbacks.onError(err instanceof Error ? err : new Error(String(err)));
      setState("listening");
      return;
    } finally {
      if (activeAbort === ctrl) {
        activeAbort = null;
      }
    }

    if (closed) return;

    callbacks.onAssistantText(assistantText);

    const sentences = splitSentences(assistantText);
    if (sentences.length === 0) {
      setState("listening");
      resetTurn();
      return;
    }

    setState("speaking");
    try {
      await tts.speak(sentences);
    } catch {
      // TTS stopped (barge-in) — already handled; state will be "interrupted"/"listening"
    }

    // After TTS completes naturally, transition back to listening.
    // If barge-in fired, state has already changed (interrupted → listening), so
    // we cast state to string to avoid TS narrowing false-positive.
    if (!closed && (state as string) === "speaking") {
      setState("listening");
    }
    resetTurn();
  }

  // ── Register ASR handlers ──────────────────────────────────────────────────
  asr.register({
    onTranscriptDelta(text: string) {
      if (closed) return;
      transcriptAccumulator += text;
      setState("transcribing");
      callbacks.onUserTranscript(transcriptAccumulator, false);
    },
    onSpeechStarted() {
      if (closed) return;
      // NB: call handleSpeechStarted BEFORE setState("listening") so that
      // the barge-in check (state === "thinking" | "speaking") still fires.
      const didBargeIn = handleSpeechStarted();
      if (!didBargeIn) {
        // Wasn't in thinking/speaking — just transition to listening normally.
        setState("listening");
      } else {
        // Barge-in set state to "interrupted"; now move to listening
        // so new speech accumulates cleanly.
        setState("listening");
      }
    },
    onSpeechStopped(silenceMs: number) {
      if (closed) return;
      void handleSpeechStopped(silenceMs);
    },
  });

  // ── Public API ─────────────────────────────────────────────────────────────
  return {
    async startListening() {
      setState("listening");
      await asr.start();
    },

    interrupt() {
      if (activeAbort) {
        activeAbort.abort();
        activeAbort = null;
      }
      tts.stop();
      clearMaxWaitTimer();
      setState("interrupted");
    },

    close() {
      closed = true;
      clearMaxWaitTimer();
      if (activeAbort) {
        activeAbort.abort();
        activeAbort = null;
      }
      tts.stop();
      asr.stop();
    },
  };
}
