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
import { stripSpokenAsides, deriveSpeechProsody, type SpeechProsody } from "../domain/speech-text";
import { decideCascadeTurn, shouldAcceptBargeIn } from "./cascadeTurnDecision";
import type { EndpointingMode } from "./pvadEndpointing";
import { decideTurn } from "./turnEngine";
import { assessTurnCompleteness, type Completeness } from "./turnCompleteness";
import { createBackchannelPicker } from "./backchannel";
import { createTurnAssembler } from "./turnAssembler";
import {
  createRecoveryTranscriptBuffer,
  type BufferedRecoveryTranscript,
} from "./recoveryTranscriptBuffer";

// ---------------------------------------------------------------------------
// Public interfaces — shared between orchestrator, tests and Task 5 wiring
// ---------------------------------------------------------------------------

/**
 * Callbacks the orchestrator fires on lifecycle events.
 * Matches the shape convention of livekitVoice / bailianWebsocket.
 */
export interface AsrEventHandlers {
  /**
   * Fired for each transcription update.
   * @param text   For a delta (isFinal=false) this is the CUMULATIVE text-so-far
   *               for the current segment (omni sends cumulative, not incremental,
   *               deltas — so the orchestrator REPLACES the partial, never appends).
   *               For a completed segment (isFinal=true) this is that segment's final text.
   * @param isFinal true on conversation.item.input_audio_transcription.completed.
   */
  onTranscriptDelta: (text: string, isFinal: boolean) => void;
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
  /** Optional peak |sample| energy 0..1 from the latest speech window (pVAD-lite). */
  getRecentEnergy?(): number;
  hasRecentUserEnergyEvidence?(): boolean;
  /** True when getUserMedia reported echoCancellation:true. */
  getEchoCancellationEnabled?(): boolean;
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
  speak(segments: string[], voice?: string, prosody?: SpeechProsody): Promise<void>;
  /** Stop any in-progress playback immediately. */
  stop(): void;
  /**
   * Release all underlying resources permanently (WS socket + AudioContext).
   * Unlike stop() (which only halts the current utterance and keeps the socket
   * warm for the next turn), close() is terminal — call it when the pipeline is
   * shutting down so the proxy WS and AudioContext don't leak across repeated
   * open/close cycles (P1-08: leaked AudioContexts eventually exhaust the
   * browser's context budget → TTS goes silent). Optional for backward
   * compatibility with test doubles that don't implement it.
   */
  close?(): void;
  /**
   * Return the host (interviewer) TTS audio captured so far as a single
   * contiguous PCM buffer (s16le, mono) plus its sample rate, for persisting as
   * a WAV (role=interviewer). null when nothing was recorded (text path / no
   * audio). Optional — only the real browser sink taps the PCM stream; test
   * doubles omit it. Read-only side channel; never affects playback.
   */
  getRecordedPcm?(): { pcm: Uint8Array; sampleRate: number } | null;
}

export type CascadePipelineState =
  | "idle"
  | "listening"
  | "transcribing"
  | "thinking"
  | "speaking"
  | "interrupted";

export interface TranscriptReviewItem {
  text: string;
  reason: string;
  source: "echo" | "recovery";
}

export interface CascadedPipelineCallbacks {
  onStateChange: (s: CascadePipelineState) => void;
  onUserTranscript: (text: string, isFinal: boolean) => void;
  onAssistantText: (text: string) => void;
  onError: (e: Error) => void;
  /** TTS playback stopped unexpectedly; the assistant text remains available. */
  onTtsPlaybackInterrupted?: (e: Error) => void;
  /**
   * Stage-2/3: TTFA probe + barge-in / false-trigger countable events.
   * ttfaMs optional so event-only samples (quarantine, max_wait_suppressed, barge-in) can fire without latency.
   */
  onLatency?: (sample: {
    ttfaMs?: number;
    vadEndToSttMs?: number;
    sttToLlmMs?: number;
    llmTtftMs?: number;
    ttsTtfbMs?: number;
    interrupted?: boolean;
    bargeInSuccess?: boolean;
    interruptRecovery?: boolean;
    falseTriggerKind?: "quarantine_echo_suspect" | "max_wait_suppressed" | "auto_committed_echo_suspect";
  }) => void;
  onTranscriptQuarantined?: (item: TranscriptReviewItem) => void;
}

/** Trace emitted for each layer-0/1/2 turn decision, for logging / UI. */
export interface DecisionTrace {
  layer: 0 | 1 | 2;
  action: string;
  reason: string;
  transcript: string;
  silenceMs: number;
  expressionState: ExpressionState;
}

export interface ConnectCascadedPipelineOptions {
  asr: AsrSource;
  tts: TtsSink;
  sendUserTurn: (
    text: string,
    signal: AbortSignal
    // prosody is the server-distilled manner for the assistant turn (the （…）asides are now
    // stripped server-side, so the client can no longer derive it from assistantText).
  ) => Promise<{ assistantText: string; prosody?: SpeechProsody }>;
  /** Streaming turn path: onDelta gets token text; speak complete sentences ASAP for TTFA. */
  sendUserTurnStream?: (
    text: string,
    signal: AbortSignal,
    onDelta: (chunk: string) => void
  ) => Promise<{ assistantText: string; prosody?: SpeechProsody }>;
  callbacks: CascadedPipelineCallbacks;
  preSignals?: InteractionPreSignals | null;
  decisionOpts?: {
    /**
     * Silence before cascade may commit a turn (ms). Default 600.
     * Lower → snappier endpoint / higher false end-of-turn risk; raise if users are cut off mid-thought.
     */
    minPauseMs?: number;
    /** Hard max wait before forced respond (ms). Default 8000. */
    maxWaitMs?: number;
    /**
     * Minimum user speech sustain while agent is speaking before barge-in (ms). Default 280.
     * Lower → easier interrupt (more false barge risk); higher → harder to cut in.
     * Wired from `systemConfig.voice.minBargeInMs` when set.
     */
    minBargeInMs?: number;
    finalStabilityMs?: number;
    echoWindowMs?: number;
    echoSimilarityThreshold?: number;
    /**
     * Endpointing policy (Stage-3). Default `semantic`.
     * - silence: pause-only
     * - semantic: completion phrases + minPause (default path)
     * - pvad-experimental: Silero-ish browser VAD bias when available; soft-falls back
     * See `systemConfig.voice.endpointingMode`. Does not change ASR model.
     */
    endpointingMode?: EndpointingMode;
  };
  /**
   * Layer-2 LLM endpoint. Live path default is off; pass only when
   * `systemConfig.voice.useLayer2Endpoint` is true.
   */
  classifyEndpoint?: (transcript: string, signal: AbortSignal) => Promise<{ done: boolean; reason?: string }>;
  /**
   * When true, TTS does not mute the mic. Barge uses turnAssembler + minBargeInMs.
   * When false/undefined, half-duplex suppressMic (today's behavior).
   * After asr.start(), pipeline also reads asr.getEchoCancellationEnabled?.().
   */
  echoCancellationEnabled?: boolean;
  /** Called after every turn-taking decision with a structured trace. */
  onDecision?: (trace: DecisionTrace) => void;
  /** Override completeness assessment (default: assessTurnCompleteness). */
  assessCompleteness?: (transcript: string) => Completeness;
}

export interface CascadedPipeline {
  startListening(openingText?: string): Promise<void>;
  updatePreSignals(next: InteractionPreSignals | null): void;
  interrupt(): { spokenTextSoFar: string };
  reviewRecoveryTranscript(item: { text: string; reason: string; code?: number }): void;
  confirmQuarantinedTranscript(text: string): void;
  discardQuarantinedTranscript(): void;
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
  const {
    asr, tts, sendUserTurn, sendUserTurnStream, callbacks, preSignals = null, decisionOpts = {},
    classifyEndpoint, onDecision, assessCompleteness = assessTurnCompleteness,
    echoCancellationEnabled: echoCancellationEnabledOpt,
  } = opts;
  const {
    minPauseMs = 600,
    maxWaitMs = 8000,
    minBargeInMs = 280,
    finalStabilityMs = 0,
    echoWindowMs = 1_200,
    echoSimilarityThreshold = 0.8,
    endpointingMode = "semantic"
  } = decisionOpts;

  const pickBackchannel = createBackchannelPicker();
  let currentPreSignals: InteractionPreSignals | null = preSignals;
  let classifyAbort: AbortController | null = null;
  const turnAssembler = createTurnAssembler({
    stabilityWindowMs: finalStabilityMs,
    echoWindowMs,
    similarityThreshold: echoSimilarityThreshold
  });
  const recoveryTranscriptBuffer = createRecoveryTranscriptBuffer();

  let state: CascadePipelineState = "idle";
  let closed = false;
  let asrStarted = false;
  // Turn transcript = committed (sum of finalized segments) + partial (latest
  // cumulative delta of the in-progress segment). omni deltas are CUMULATIVE, so
  // partial is REPLACED on each delta; appending would duplicate every word
  // ("我今天的我今天的主题…"). On completed, the segment moves committed += text.
  let committedTranscript = "";
  let partialTranscript = "";
  // AbortController for the active LLM call (null when not thinking)
  let activeAbort: AbortController | null = null;
  let speechStoppedAt = 0;
  let sttFinalAtMs = 0;
  let llmFirstTokenAt = 0;
  let markThinkingAt = 0;
  // Text of the assistant reply actually spoken aloud so far this turn (completed sentences
  // only). interrupt() returns it so the server can truncate the persisted assistant turn to
  // what the guest really heard, instead of the full reply the AI never finished saying.
  let spokenText = "";
  let lastPlannedSpokenText = "";
  // Max-wait safety-net timer handle
  let maxWaitTimer: ReturnType<typeof setTimeout> | null = null;
  let stableCommitTimer: ReturnType<typeof setTimeout> | null = null;
  let surfacedQuarantineKey = "";
  let activeReview: TranscriptReviewItem | null = null;
  const queuedRecoveryReviews: Array<{
    item: { text: string; reason: string; code?: number };
    before: BufferedRecoveryTranscript | null;
  }> = [];

  function surfaceQuarantine(item: TranscriptReviewItem) {
    const key = `${item.source}\n${item.text}\n${item.reason}`;
    if (key === surfacedQuarantineKey) return;
    surfacedQuarantineKey = key;
    activeReview = item;
    callbacks.onTranscriptQuarantined?.(item);
    // Phase-0: echo-window quarantine is a countable false-trigger (not recovery review).
    if (item.source === "echo") {
      callbacks.onLatency?.({ falseTriggerKind: "quarantine_echo_suspect" });
    }
  }

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
    committedTranscript = "";
    partialTranscript = "";
    turnAssembler.reset();
    surfacedQuarantineKey = "";
    activeReview = null;
    queuedRecoveryReviews.length = 0;
    recoveryTranscriptBuffer.clear();
    speechStoppedAt = 0;
    sttFinalAtMs = 0;
    clearMaxWaitTimer();
    if (stableCommitTimer !== null) {
      clearTimeout(stableCommitTimer);
      stableCommitTimer = null;
    }
  }

  function noteAuthoritativeTranscript(text: string) {
    const trimmed = text.trim();
    if (!trimmed) return;
    turnAssembler.ingest({
      text: trimmed,
      isFinal: true,
      atMs: Date.now(),
      hasUserEnergyEvidence: asr.hasRecentUserEnergyEvidence?.() ?? true
    });
  }

  function requestStableCommit(allowCommit: boolean) {
    if (closed || state === "thinking" || state === "speaking") return;
    if (activeReview?.source === "recovery") return;
    const pending = (committedTranscript + partialTranscript).trim();
    if (allowCommit && pending) noteAuthoritativeTranscript(pending);
    const decision = turnAssembler.decide({ atMs: Date.now(), allowCommit, questionContext: true });
    if (decision.action === "quarantine") {
      surfaceQuarantine({ text: decision.transcript, reason: decision.reason, source: "echo" });
      return;
    }
    if (decision.action === "commit") {
      if (stableCommitTimer !== null) {
        clearTimeout(stableCommitTimer);
        stableCommitTimer = null;
      }
      console.warn(JSON.stringify({
        event: "cascade_commit",
        n: decision.transcript.length,
        halfDuplex: halfDuplexMute,
        state
      }));
      void doRespond(decision.transcript);
      return;
    }
    if (allowCommit && decision.waitMs !== undefined) {
      if (stableCommitTimer !== null) clearTimeout(stableCommitTimer);
      stableCommitTimer = setTimeout(() => {
        stableCommitTimer = null;
        requestStableCommit(true);
      }, Math.max(0, decision.waitMs));
    }
  }

  // Arm the max-wait safety net (留白 timeout). When it fires, emit a layer-0
  // decision trace (so timer-driven responses are audited too — not just the
  // synchronous heuristic ones) and respond.
  function armMaxWait(transcript: string, expressionState: ExpressionState) {
    if (!transcript.trim()) return;
    if (maxWaitTimer !== null) return;
    maxWaitTimer = setTimeout(() => {
      maxWaitTimer = null;
      // P2-14: don't fire while the mic is suppressed (AI is speaking / echo
      // window). Otherwise a timer armed before the AI started talking can fire
      // mid-TTS and respond to the AI's own echoed transcript — the half-duplex
      // feedback loop the echo guard exists to prevent.
      if (!closed && !micSuppressed && state !== "thinking" && state !== "speaking") {
        onDecision?.({ layer: 0, action: "respond", reason: "max-wait timer fired", transcript, silenceMs: maxWaitMs, expressionState });
        requestStableCommit(true);
      } else if (!closed && (micSuppressed || state === "thinking" || state === "speaking")) {
        // Phase-0: maxWait attempted but suppressed by half-duplex / active turn.
        callbacks.onLatency?.({ falseTriggerKind: "max_wait_suppressed" });
      }
    }, maxWaitMs);
  }

  // ── Echo guard (half-duplex during AI speech) ─────────────────────────────
  // While the AI is speaking (and ~ECHO_GUARD_MS after it stops), the mic hears
  // the AI's own TTS output. Suppress ASR-driven turns/barge-in during that
  // window so the AI does NOT barge in on / respond to its own voice — that
  // feedback loop is what causes "two voices talking over each other".
  let micSuppressed = false;
  let echoGuardTimer: ReturnType<typeof setTimeout> | null = null;
  const ECHO_GUARD_MS = 600;
  let halfDuplexMute = echoCancellationEnabledOpt !== true;
  let bargeArmTimer: ReturnType<typeof setTimeout> | null = null;
  let bargeSpeechStartedAt = 0;

  function usesHalfDuplexMute(): boolean {
    return halfDuplexMute;
  }
  function muteForTts() {
    if (usesHalfDuplexMute()) suppressMic();
  }
  function clearBargeArm() {
    if (bargeArmTimer !== null) {
      clearTimeout(bargeArmTimer);
      bargeArmTimer = null;
    }
    bargeSpeechStartedAt = 0;
  }
  function performBarge(): boolean {
    if (closed) return false;
    if (state !== "thinking" && state !== "speaking") return false;
    if (activeAbort) {
      activeAbort.abort();
      activeAbort = null;
    }
    tts.stop();
    classifyAbort?.abort();
    classifyAbort = null;
    clearMaxWaitTimer();
    clearBargeArm();
    setState("interrupted");
    committedTranscript = "";
    partialTranscript = "";
    turnAssembler.reset();
    callbacks.onLatency?.({ interrupted: true, bargeInSuccess: true });
    return true;
  }
  function suppressMic() {
    micSuppressed = true;
    if (echoGuardTimer !== null) {
      clearTimeout(echoGuardTimer);
      echoGuardTimer = null;
    }
    // P2-14: cancel any pending 留白 safety-net timer when we enter the
    // suppression window. The AI is about to speak; a timer that survives into
    // the echo window would otherwise fire against stale/echoed transcript.
    clearMaxWaitTimer();
  }
  function releaseMicAfterGuard() {
    if (echoGuardTimer !== null) clearTimeout(echoGuardTimer);
    echoGuardTimer = setTimeout(() => {
      micSuppressed = false;
      echoGuardTimer = null;
    }, ECHO_GUARD_MS);
  }

  function reportTtsPlaybackInterrupted(error: unknown) {
    if (closed || (error as DOMException)?.name === "AbortError") return;
    const interruption = error instanceof Error ? error : new Error(String(error));
    callbacks.onTtsPlaybackInterrupted?.(interruption);
    releaseMicAfterGuard();
    // Opening TTS can fail before the mic/ASR graph exists. Flipping to
    // "listening" here races the guest into a dead capture. After ASR start,
    // the same interrupt should return the UI to listening.
    if (asrStarted && !closed) setState("listening");
  }

  // ── Barge-in ──────────────────────────────────────────────────────────────
  /**
   * Called when ASR fires speech_started.
   * Returns true if a barge-in was performed (was thinking/speaking).
   */
  function handleSpeechStarted(): boolean {
    if (closed) return false;
    if (micSuppressed) return false;
    const wasActive = state === "thinking" || state === "speaking";
    if (!wasActive) return false;
    if (shouldAcceptBargeIn(0, minBargeInMs)) {
      return performBarge();
    }
    bargeSpeechStartedAt = Date.now();
    if (bargeArmTimer !== null) clearTimeout(bargeArmTimer);
    bargeArmTimer = setTimeout(() => {
      bargeArmTimer = null;
      if (closed || micSuppressed) return;
      if (state !== "thinking" && state !== "speaking") return;
      performBarge();
      if (!closed) setState("listening");
    }, minBargeInMs);
    return false;
  }

  // ── Speech stopped: analysis gate ─────────────────────────────────────────
  async function handleSpeechStopped(silenceMs: number) {
    speechStoppedAt = Date.now();
    if (closed) return;
    if (bargeArmTimer !== null && bargeSpeechStartedAt > 0
      && Date.now() - bargeSpeechStartedAt < minBargeInMs) {
      clearBargeArm();
    }
    if (micSuppressed) return;
    if (state === "thinking" || state === "speaking") return;

    const transcript = (committedTranscript + partialTranscript).trim();
    const expressionState = asr.getExpressionState();
    // "concluding" is a strong prosodic/semantic cue that the utterance is
    // wrapping up — treat it as complete regardless of surface grammar analysis.
    const completeness: Completeness =
      expressionState === "concluding" ? "complete" : assessCompleteness(transcript);
    const energy = typeof asr.getRecentEnergy === "function" ? asr.getRecentEnergy() : undefined;
    const energyHigh = typeof energy === "number" && energy > 0.08;
    if (
      completeness === "incomplete"
      || (energyHigh && expressionState !== "concluding")
      || (expressionState === "organizing" && completeness !== "complete")
    ) {
      onDecision?.({
        layer: 1, action: "wait",
        reason: energyHigh ? "energy still high — keep this turn open" : "transcript still hanging",
        transcript, silenceMs, expressionState,
      });
      if (completeness === "incomplete" || expressionState === "organizing") {
        armMaxWait(transcript, expressionState);
      }
      return;
    }
    if (classifyEndpoint && completeness === "ambiguous") {
      clearMaxWaitTimer();
      classifyAbort?.abort();
      classifyAbort = new AbortController();
      const sig = classifyAbort.signal;
      let done = true;
      try {
        const r = await classifyEndpoint(transcript, sig);
        if (sig.aborted || closed) return;
        done = r.done;
        onDecision?.({ layer: 2, action: done ? "respond" : "wait", reason: r.reason ?? "llm endpoint", transcript, silenceMs, expressionState });
      } catch {
        if (sig.aborted || closed) return;
        done = true;
      } finally {
        if (classifyAbort?.signal === sig) classifyAbort = null;
      }
      if (done) { requestStableCommit(true); }
      else { armMaxWait(transcript, expressionState); }
      return;
    }
    const decision = decideTurn({
      mode: endpointingMode,
      expressionState,
      silenceMs,
      completeness,
      ...(energy != null ? { recentEnergy: energy } : {}),
      baseMinPauseMs: minPauseMs,
      baseMaxWaitMs: maxWaitMs
    });
    onDecision?.({
      // layer 0 = VAD max-wait timeout fired synchronously; layer 1 = heuristic.
      layer: silenceMs >= decision.maxWaitMs ? 0 : 1,
      action: decision.action, reason: decision.reason, transcript, silenceMs, expressionState,
    });

    if (decision.action === "wait") {
      armMaxWait(transcript, expressionState);
      return;
    }

    if (decision.action === "backchannel") {
      clearMaxWaitTimer();
      const text = pickBackchannel(expressionState, currentPreSignals?.depthDirection?.guidance);
      const startedAtMs = Date.now();
      muteForTts();
      try { await tts.speak([text]); } catch (error) { reportTtsPlaybackInterrupted(error); }
      turnAssembler.noteTtsPlayback({ text, startedAtMs, endedAtMs: Date.now() });
      releaseMicAfterGuard();
      return;
    }

    if (decision.action === "uncertain") {
      clearMaxWaitTimer();
      if (!classifyEndpoint) {
        // No layer-2 endpoint — arm max-wait and hold
        armMaxWait(transcript, expressionState);
        return;
      }
      classifyAbort?.abort();
      classifyAbort = new AbortController();
      const sig = classifyAbort.signal;
      let done = true; // fail safe: classify error → respond
      try {
        const r = await classifyEndpoint(transcript, sig);
        if (sig.aborted || closed) return; // superseded by barge-in or close
        done = r.done;
        onDecision?.({ layer: 2, action: done ? "respond" : "wait", reason: r.reason ?? "llm endpoint", transcript, silenceMs, expressionState });
      } catch {
        if (sig.aborted || closed) return;
        done = true; // classify failed → respond
      } finally {
        if (classifyAbort?.signal === sig) classifyAbort = null;
      }
      if (done) { requestStableCommit(true); }
      else { armMaxWait(transcript, expressionState); }
      return;
    }

    // action === "respond"
    clearMaxWaitTimer();
    requestStableCommit(true);
  }

  // ── Core respond flow ──────────────────────────────────────────────────────
  async function doRespond(authoritativeTranscript?: string) {
    if (closed) return;
    if (state === "thinking" || state === "speaking") return;

    const fullTranscript = authoritativeTranscript?.trim() || (committedTranscript + partialTranscript).trim();
    if (!fullTranscript) {
      resetTurn();
      return;
    }
    callbacks.onUserTranscript(fullTranscript, true);

    const thinkingStartedAt = Date.now();
    markThinkingAt = thinkingStartedAt;
    llmFirstTokenAt = 0;
    setState("thinking");
    const ctrl = new AbortController();
    activeAbort = ctrl;

    let assistantText = "";
    let providedProsody: SpeechProsody | undefined;
    const spokenSentences: string[] = [];
    let pendingText = "";
    let firstSpeakStarted = false;
    let ttsStartedAtMs = 0;
    let ttsPlaybackInterrupted = false;
    const handleTtsFailure = (error: unknown) => {
      if (closed || ctrl.signal.aborted) return;
      ttsPlaybackInterrupted = true;
      reportTtsPlaybackInterrupted(error);
    };

    const flushCompletedSentences = async (forceAll = false) => {
      if (ttsPlaybackInterrupted) return;
      const source = stripSpokenAsides(pendingText);
      // Match splitSentences logic for complete clauses ending with 。！？\n
      // Hard stops: 。！？\n
      // Soft clause stops: ，、；;, — first segment uses a lower char floor so Cosy
      // can start on the opening clause sooner (TTFA); later segments keep ≥8 to
      // avoid choppy mid-sentence splits.
      const minSoftChars = firstSpeakStarted ? 8 : 4;
      const parts = source.split(/(?<=[。！？\n，、；;,])/u);
      let keep = "";
      const ready: string[] = [];
      for (let i = 0; i < parts.length; i++) {
        const p = parts[i]?.trim() ?? "";
        if (!p) continue;
        const hard = /[。！？]$/u.test(p) || p.endsWith("\n");
        const soft =
          /[，、；;,]$/u.test(p) &&
          p.replace(/[，、；;,。！？\s]/gu, "").length >= minSoftChars;
        if (hard || soft || (forceAll && i === parts.length - 1 && p)) {
          ready.push(p.replace(/[\n]$/u, "").trim());
        } else {
          keep += parts[i];
        }
      }
      pendingText = keep;
      for (const sentence of ready) {
        if (!sentence || ctrl.signal.aborted || closed) return;
        if (!firstSpeakStarted) {
          firstSpeakStarted = true;
          setState("speaking");
          muteForTts();
          ttsStartedAtMs = Date.now();
          callbacks.onLatency?.({
            ttfaMs: ttsStartedAtMs - (speechStoppedAt || thinkingStartedAt),
            vadEndToSttMs: speechStoppedAt
              ? Math.max(0, (sttFinalAtMs || thinkingStartedAt) - speechStoppedAt)
              : undefined,
            sttToLlmMs: sttFinalAtMs
              ? Math.max(0, thinkingStartedAt - sttFinalAtMs)
              : undefined,
            llmTtftMs: llmFirstTokenAt ? Math.max(0, llmFirstTokenAt - thinkingStartedAt) : undefined,
            ttsTtfbMs: llmFirstTokenAt ? Math.max(0, ttsStartedAtMs - llmFirstTokenAt) : Math.max(0, ttsStartedAtMs - thinkingStartedAt)
          });
        }
        spokenSentences.push(sentence);
        lastPlannedSpokenText = spokenSentences.join("");
        try {
          await tts.speak([sentence], undefined, providedProsody);
          if (!closed && !ctrl.signal.aborted) {
            spokenText = lastPlannedSpokenText;
          }
        } catch (error) {
          handleTtsFailure(error);
          return;
        }
      }
    };

    try {
      if (sendUserTurnStream) {
        let flushChain: Promise<void> = Promise.resolve();
        const result = await sendUserTurnStream(fullTranscript, ctrl.signal, (chunk) => {
          if (!llmFirstTokenAt && chunk) llmFirstTokenAt = Date.now();
          pendingText += chunk;
          flushChain = flushChain.then(() => flushCompletedSentences(false));
        });
        await flushChain;
        assistantText = result.assistantText;
        providedProsody = result.prosody;
        const fullSpoken = stripSpokenAsides(assistantText);
        const already = spokenSentences.join("");
        const rest = fullSpoken.startsWith(already) ? fullSpoken.slice(already.length) : fullSpoken;
        pendingText = rest;
        await flushCompletedSentences(true);
      } else {
        const result = await sendUserTurn(fullTranscript, ctrl.signal);
        assistantText = result.assistantText;
        providedProsody = result.prosody;
        llmFirstTokenAt = Date.now();
        pendingText = assistantText;
        await flushCompletedSentences(true);
      }
    } catch (err) {
      if ((err as DOMException)?.name === "AbortError") {
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

    if (closed || ctrl.signal.aborted) return;

    if (ttsPlaybackInterrupted) {
      if (assistantText) callbacks.onAssistantText(assistantText);
      resetTurn();
      return;
    }

    const spokenSource = stripSpokenAsides(assistantText);
    const prosody = providedProsody ?? deriveSpeechProsody(assistantText);
    if (spokenSentences.length === 0) {
      const sentences = splitSentences(spokenSource);
      if (sentences.length === 0) {
        const filler = "嗯，我在听，你可以继续说。";
        callbacks.onAssistantText(filler);
        setState("speaking");
        muteForTts();
        const startedAtMs = Date.now();
        try {
          await tts.speak([filler]);
        } catch (error) {
          handleTtsFailure(error);
        } finally {
          turnAssembler.noteTtsPlayback({ text: filler, startedAtMs, endedAtMs: Date.now() });
          releaseMicAfterGuard();
        }
        if (!closed && (state as string) === "speaking") setState("listening");
        resetTurn();
        return;
      }
      callbacks.onAssistantText(assistantText);
      setState("speaking");
      muteForTts();
      ttsStartedAtMs = Date.now();
      callbacks.onLatency?.({
        ttfaMs: ttsStartedAtMs - (speechStoppedAt || thinkingStartedAt),
        vadEndToSttMs: speechStoppedAt
          ? Math.max(0, (sttFinalAtMs || thinkingStartedAt) - speechStoppedAt)
          : undefined,
        sttToLlmMs: sttFinalAtMs ? Math.max(0, thinkingStartedAt - sttFinalAtMs) : undefined,
        llmTtftMs: llmFirstTokenAt ? Math.max(0, llmFirstTokenAt - thinkingStartedAt) : undefined,
        ttsTtfbMs: llmFirstTokenAt ? Math.max(0, ttsStartedAtMs - llmFirstTokenAt) : undefined
      });
      spokenText = "";
      lastPlannedSpokenText = spokenSource;
      try {
        await tts.speak(sentences, undefined, prosody);
        if (!closed && !ctrl.signal.aborted) spokenText = spokenSource;
      } catch (error) {
        handleTtsFailure(error);
      } finally {
        turnAssembler.noteTtsPlayback({ text: spokenSource, startedAtMs: ttsStartedAtMs, endedAtMs: Date.now() });
        releaseMicAfterGuard();
      }
    } else {
      callbacks.onAssistantText(assistantText);
      lastPlannedSpokenText = spokenSource;
      if (!closed && !ctrl.signal.aborted) spokenText = spokenSource;
      turnAssembler.noteTtsPlayback({
        text: spokenSource,
        startedAtMs: ttsStartedAtMs || Date.now(),
        endedAtMs: Date.now()
      });
      releaseMicAfterGuard();
    }

    if (!closed && (state as string) === "speaking") {
      setState("listening");
    }
    resetTurn();
  }

  function processTranscriptDelta(text: string, isFinal: boolean) {
    if (closed || micSuppressed) return; // ignore the AI's own echoed transcription
    const speaking = state === "thinking" || state === "speaking";
    const assembled = turnAssembler.ingest({
      text,
      isFinal,
      atMs: Date.now(),
      hasUserEnergyEvidence: asr.hasRecentUserEnergyEvidence?.() ?? !speaking
    });
    if (assembled.action === "quarantine") {
      surfaceQuarantine({ text: assembled.transcript, reason: assembled.reason, source: "echo" });
      return;
    }
    if (isFinal) {
      // Finalized segment: commit it and clear the in-progress partial.
      committedTranscript += text;
      partialTranscript = "";
      if (!sttFinalAtMs) sttFinalAtMs = Date.now();
    } else {
      // Cumulative delta: REPLACE the partial (appending duplicates every word,
      // since each delta already carries the full text-so-far for this segment).
      partialTranscript = text;
    }
    setState("transcribing");
    callbacks.onUserTranscript(committedTranscript + partialTranscript, false);
  }

  function processSpeechStarted() {
    if (closed || micSuppressed) return; // echo: AI is speaking, ignore its own voice
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
  }

  function processSpeechStopped(silenceMs: number) {
    if (closed) return;
    void handleSpeechStopped(silenceMs);
  }

  function replayBufferedRecoveryTranscript(buffered: BufferedRecoveryTranscript | null) {
    if (!buffered) return false;
    const hasBufferedEvents = buffered.speechStarted
      || Boolean(buffered.committed)
      || Boolean(buffered.partial)
      || buffered.speechStoppedSilenceMs !== null;
    if (buffered.speechStarted) processSpeechStarted();
    if (buffered.committed) processTranscriptDelta(buffered.committed, true);
    if (buffered.partial) processTranscriptDelta(buffered.partial, false);
    if (buffered.speechStoppedSilenceMs !== null) {
      processSpeechStopped(buffered.speechStoppedSilenceMs);
    }
    return hasBufferedEvents;
  }

  function releaseBufferedRecoveryTranscript() {
    return replayBufferedRecoveryTranscript(recoveryTranscriptBuffer.release());
  }

  function queueNextRecoveryReview(item: { text: string; reason: string; code?: number }) {
    const before = recoveryTranscriptBuffer.release();
    if (before) {
      // The latest provider partial is represented by the review item itself and
      // must never be replayed as authoritative transcript. A preceding final is
      // safe and remains ordered before this review boundary.
      before.partial = "";
      before.speechStoppedSilenceMs = null;
    }
    queuedRecoveryReviews.push({ item, before });
    recoveryTranscriptBuffer.begin();
  }

  function advanceRecoveryReview(): boolean {
    const next = queuedRecoveryReviews.shift();
    if (!next) return false;
    replayBufferedRecoveryTranscript(next.before);
    surfacedQuarantineKey = "";
    surfaceQuarantine({
      text: next.item.text,
      reason: next.item.reason,
      source: "recovery",
    });
    callbacks.onUserTranscript(`${committedTranscript}${partialTranscript}`, false);
    return true;
  }

  // ── Register ASR handlers ──────────────────────────────────────────────────
  asr.register({
    onTranscriptDelta(text: string, isFinal: boolean) {
      if (recoveryTranscriptBuffer.captureTranscript(text, isFinal)) return;
      processTranscriptDelta(text, isFinal);
    },
    onSpeechStarted() {
      if (recoveryTranscriptBuffer.captureSpeechStarted()) return;
      processSpeechStarted();
    },
    onSpeechStopped(silenceMs: number) {
      if (recoveryTranscriptBuffer.captureSpeechStopped(silenceMs)) return;
      processSpeechStopped(silenceMs);
    },
  });

  // ── Public API ─────────────────────────────────────────────────────────────
  return {
    async startListening(openingText?: string) {
      const opening = openingText?.trim() || "";
      await asr.start();
      asrStarted = true;
      if (closed) return; // closed while the mic was coming up — don't speak
      halfDuplexMute = !(echoCancellationEnabledOpt ?? asr.getEchoCancellationEnabled?.() ?? false);
      if (opening && usesHalfDuplexMute()) suppressMic();
      if (opening) {
        setState("speaking");
        const startedAtMs = Date.now();
        try { await tts.speak([opening]); } catch (error) { reportTtsPlaybackInterrupted(error); }
        turnAssembler.noteTtsPlayback({ text: opening, startedAtMs, endedAtMs: Date.now() });
        releaseMicAfterGuard();
      }
      if (!closed) setState("listening");
    },

    updatePreSignals(next: InteractionPreSignals | null) {
      currentPreSignals = next;
    },

    interrupt() {
      if (activeAbort) { activeAbort.abort(); activeAbort = null; }
      classifyAbort?.abort(); classifyAbort = null;
      tts.stop();
      clearMaxWaitTimer();
      clearBargeArm();
      setState("interrupted");
      return { spokenTextSoFar: spokenText || lastPlannedSpokenText };
    },

    reviewRecoveryTranscript(item: { text: string; reason: string; code?: number }) {
      if (closed) return;
      if (activeReview?.source === "recovery") {
        // Every interrupted provider partial remains a separate human-review
        // boundary. Checkpoint only the safe final events before it, keep the
        // current review visible, and queue this partial for later review.
        queueNextRecoveryReview(item);
        return;
      }
      recoveryTranscriptBuffer.begin();
      partialTranscript = "";
      turnAssembler.confirmQuarantined(committedTranscript, Date.now());
      clearMaxWaitTimer();
      if (stableCommitTimer !== null) {
        clearTimeout(stableCommitTimer);
        stableCommitTimer = null;
      }
      surfaceQuarantine({ text: item.text, reason: item.reason, source: "recovery" });
      callbacks.onUserTranscript(committedTranscript, false);
    },

    confirmQuarantinedTranscript(text: string) {
      if (activeReview?.source === "recovery") {
        const confirmedTranscript = `${committedTranscript}${text.trim()}`;
        turnAssembler.confirmQuarantined(confirmedTranscript, Date.now());
        committedTranscript = confirmedTranscript;
        partialTranscript = "";
        if (advanceRecoveryReview()) return;
        surfacedQuarantineKey = "";
        activeReview = null;
        if (!releaseBufferedRecoveryTranscript()) requestStableCommit(true);
        return;
      }
      turnAssembler.confirmQuarantined(text, Date.now());
      surfacedQuarantineKey = "";
      activeReview = null;
      committedTranscript = text.trim();
      partialTranscript = "";
      requestStableCommit(true);
    },

    discardQuarantinedTranscript() {
      if (activeReview?.source === "recovery") {
        turnAssembler.confirmQuarantined(committedTranscript, Date.now());
        if (advanceRecoveryReview()) return;
        surfacedQuarantineKey = "";
        activeReview = null;
        partialTranscript = "";
        if (!releaseBufferedRecoveryTranscript()) {
          callbacks.onUserTranscript(committedTranscript, false);
        }
        return;
      }
      resetTurn();
      callbacks.onUserTranscript("", false);
    },

    close() {
      closed = true;
      queuedRecoveryReviews.length = 0;
      recoveryTranscriptBuffer.clear();
      clearMaxWaitTimer();
      clearBargeArm();
      if (stableCommitTimer !== null) { clearTimeout(stableCommitTimer); stableCommitTimer = null; }
      if (echoGuardTimer !== null) { clearTimeout(echoGuardTimer); echoGuardTimer = null; }
      micSuppressed = false;
      classifyAbort?.abort(); classifyAbort = null;
      if (activeAbort) { activeAbort.abort(); activeAbort = null; }
      // stop() halts the current utterance; close() then tears down the socket +
      // AudioContext for good (P1-08). stop-before-close so any in-flight speak()
      // resolves first, then resources are released.
      tts.stop();
      tts.close?.();
      asr.stop();
    },
  };
}
