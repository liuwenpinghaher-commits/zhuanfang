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
import { decideCascadeTurn } from "./cascadeTurnDecision";
import type { EndpointingMode } from "./pvadEndpointing";
import { decideTurn } from "./turnEngine";
import { assessTurnCompleteness, type Completeness } from "./turnCompleteness";
import { createBackchannelPicker } from "./backchannel";
import { createTurnAssembler } from "./turnAssembler";

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

export interface CascadedPipelineCallbacks {
  onStateChange: (s: CascadePipelineState) => void;
  onUserTranscript: (text: string, isFinal: boolean) => void;
  onAssistantText: (text: string) => void;
  onError: (e: Error) => void;
  /** Stage-2 TTFA probe */
  onLatency?: (sample: {
    ttfaMs: number;
    vadEndToSttMs?: number;
    sttToLlmMs?: number;
    llmTtftMs?: number;
    ttsTtfbMs?: number;
  }) => void;
  onTranscriptQuarantined?: (item: { text: string; reason: string }) => void;
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
    minPauseMs?: number;
    maxWaitMs?: number;
    minBargeInMs?: number;
    finalStabilityMs?: number;
    echoWindowMs?: number;
    echoSimilarityThreshold?: number;
    /** Stage-3: silence | semantic | pvad-experimental */
    endpointingMode?: EndpointingMode;
  };
  /** Layer-2 LLM endpoint: returns done=true when the transcript reads complete. */
  classifyEndpoint?: (transcript: string, signal: AbortSignal) => Promise<{ done: boolean; reason?: string }>;
  /** Called after every turn-taking decision with a structured trace. */
  onDecision?: (trace: DecisionTrace) => void;
  /** Override completeness assessment (default: assessTurnCompleteness). */
  assessCompleteness?: (transcript: string) => Completeness;
}

export interface CascadedPipeline {
  startListening(openingText?: string): Promise<void>;
  updatePreSignals(next: InteractionPreSignals | null): void;
  interrupt(): { spokenTextSoFar: string };
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

  let state: CascadePipelineState = "idle";
  let closed = false;
  // Turn transcript = committed (sum of finalized segments) + partial (latest
  // cumulative delta of the in-progress segment). omni deltas are CUMULATIVE, so
  // partial is REPLACED on each delta; appending would duplicate every word
  // ("我今天的我今天的主题…"). On completed, the segment moves committed += text.
  let committedTranscript = "";
  let partialTranscript = "";
  // AbortController for the active LLM call (null when not thinking)
  let activeAbort: AbortController | null = null;
  let speechStoppedAt = 0;
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

  function surfaceQuarantine(item: { text: string; reason: string }) {
    const key = `${item.text}\n${item.reason}`;
    if (key === surfacedQuarantineKey) return;
    surfacedQuarantineKey = key;
    callbacks.onTranscriptQuarantined?.(item);
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
    clearMaxWaitTimer();
    if (stableCommitTimer !== null) {
      clearTimeout(stableCommitTimer);
      stableCommitTimer = null;
    }
  }

  function requestStableCommit(allowCommit: boolean) {
    if (closed || state === "thinking" || state === "speaking") return;
    const decision = turnAssembler.decide({ atMs: Date.now(), allowCommit, questionContext: true });
    if (decision.action === "quarantine") {
      surfaceQuarantine({ text: decision.transcript, reason: decision.reason });
      return;
    }
    if (decision.action === "commit") {
      if (stableCommitTimer !== null) {
        clearTimeout(stableCommitTimer);
        stableCommitTimer = null;
      }
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

  // ── Barge-in ──────────────────────────────────────────────────────────────
  /**
   * Called when ASR fires speech_started.
   * Returns true if a barge-in was performed (was thinking/speaking).
   */
  function handleSpeechStarted(): boolean {
    if (closed) return false;
    // Echo guard: while the AI's TTS is playing, the mic is hearing the AI's own
    // voice — do NOT treat it as the user barging in. (Real user barge-in during
    // the LLM "thinking" window — before any audio plays — is still honored.)
    if (micSuppressed) return false;
    const wasActive = state === "thinking" || state === "speaking";
    if (wasActive) {
      // Abort in-flight LLM call
      if (activeAbort) {
        activeAbort.abort();
        activeAbort = null;
      }
      // Stop TTS playback
      tts.stop();
      // Cancel any in-flight layer-2 classify call
      classifyAbort?.abort();
      classifyAbort = null;
      clearMaxWaitTimer();
      setState("interrupted");
      // Barge-in discards the superseded turn → reset so the new utterance starts fresh.
      // CRITICAL: only reset on barge-in. A listening-state speech_started is the SAME
      // utterance RESUMING after a VAD-induced pause (server_vad cuts on silence). Resetting
      // there dropped everything said before the pause — the "话被断成很多段 + 前段丢失" bug:
      // committedTranscript kept only the last fragment (or emptied → turn never met
      // completeness → never committed → session.turns stayed 0 → /end 422 "结束失败").
      // Normal turn boundaries are cleared by resetTurn() after doRespond() instead.
      committedTranscript = "";
      partialTranscript = "";
      turnAssembler.reset();
    }
    return wasActive;
  }

  // ── Speech stopped: analysis gate ─────────────────────────────────────────
  async function handleSpeechStopped(silenceMs: number) {
    speechStoppedAt = Date.now();
    if (closed) return;
    if (micSuppressed) return;
    if (state === "thinking" || state === "speaking") return;

    const transcript = (committedTranscript + partialTranscript).trim();
    const expressionState = asr.getExpressionState();
    // "concluding" is a strong prosodic/semantic cue that the utterance is
    // wrapping up — treat it as complete regardless of surface grammar analysis.
    const completeness: Completeness =
      expressionState === "concluding" ? "complete" : assessCompleteness(transcript);
    const energy = typeof asr.getRecentEnergy === "function" ? asr.getRecentEnergy() : undefined;
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
      suppressMic();
      try { await tts.speak([text]); } catch { /* stopped */ }
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

    const flushCompletedSentences = async (forceAll = false) => {
      const source = stripSpokenAsides(pendingText);
      // Match splitSentences logic for complete clauses ending with 。！？\n
      // Hard stops: 。！？\n ; soft clause stops: ，、；;, when length>=8 (token-level-ish TTFA)
      const parts = source.split(/(?<=[。！？\n，、；;,])/u);
      let keep = "";
      const ready: string[] = [];
      for (let i = 0; i < parts.length; i++) {
        const p = parts[i]?.trim() ?? "";
        if (!p) continue;
        const hard = /[。！？]$/u.test(p) || p.endsWith("\n");
        const soft = /[，、；;,]$/u.test(p) && p.replace(/[，、；;,。！？\s]/gu, "").length >= 8;
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
          suppressMic();
          ttsStartedAtMs = Date.now();
          callbacks.onLatency?.({
            ttfaMs: ttsStartedAtMs - (speechStoppedAt || thinkingStartedAt),
            vadEndToSttMs: speechStoppedAt ? Math.max(0, thinkingStartedAt - speechStoppedAt) : undefined,
            sttToLlmMs: 0,
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
        } catch {
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

    const spokenSource = stripSpokenAsides(assistantText);
    const prosody = providedProsody ?? deriveSpeechProsody(assistantText);
    if (spokenSentences.length === 0) {
      const sentences = splitSentences(spokenSource);
      if (sentences.length === 0) {
        const filler = "嗯，我在听，你可以继续说。";
        callbacks.onAssistantText(filler);
        setState("speaking");
        suppressMic();
        const startedAtMs = Date.now();
        try {
          await tts.speak([filler]);
        } catch {
          /* barge-in */
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
      suppressMic();
      ttsStartedAtMs = Date.now();
      callbacks.onLatency?.({
        ttfaMs: ttsStartedAtMs - (speechStoppedAt || thinkingStartedAt),
        vadEndToSttMs: speechStoppedAt ? Math.max(0, thinkingStartedAt - speechStoppedAt) : undefined,
        llmTtftMs: llmFirstTokenAt ? Math.max(0, llmFirstTokenAt - thinkingStartedAt) : undefined,
        ttsTtfbMs: 0
      });
      spokenText = "";
      lastPlannedSpokenText = spokenSource;
      try {
        await tts.speak(sentences, undefined, prosody);
        if (!closed && !ctrl.signal.aborted) spokenText = spokenSource;
      } catch {
        /* barge-in */
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

  // ── Register ASR handlers ──────────────────────────────────────────────────
  asr.register({
    onTranscriptDelta(text: string, isFinal: boolean) {
      if (closed || micSuppressed) return; // ignore the AI's own echoed transcription
      const assembled = turnAssembler.ingest({
        text,
        isFinal,
        atMs: Date.now(),
        hasUserEnergyEvidence: asr.hasRecentUserEnergyEvidence?.() ?? true
      });
      if (assembled.action === "quarantine") {
        surfaceQuarantine({ text: assembled.transcript, reason: assembled.reason });
        return;
      }
      if (isFinal) {
        // Finalized segment: commit it and clear the in-progress partial.
        committedTranscript += text;
        partialTranscript = "";
      } else {
        // Cumulative delta: REPLACE the partial (appending duplicates every word,
        // since each delta already carries the full text-so-far for this segment).
        partialTranscript = text;
      }
      setState("transcribing");
      callbacks.onUserTranscript(committedTranscript + partialTranscript, false);
    },
    onSpeechStarted() {
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
    },
    onSpeechStopped(silenceMs: number) {
      if (closed) return;
      void handleSpeechStopped(silenceMs);
    },
  });

  // ── Public API ─────────────────────────────────────────────────────────────
  return {
    async startListening(openingText?: string) {
      setState("listening");
      if (openingText && openingText.trim()) {
        setState("speaking");
        suppressMic();
        const startedAtMs = Date.now();
        try { await tts.speak([openingText.trim()]); } catch { /* stopped */ }
        turnAssembler.noteTtsPlayback({ text: openingText.trim(), startedAtMs, endedAtMs: Date.now() });
        releaseMicAfterGuard();
        if (!closed) setState("listening");
      }
      if (closed) return; // closed mid-opening — don't open the mic
      await asr.start();
    },

    updatePreSignals(next: InteractionPreSignals | null) {
      currentPreSignals = next;
    },

    interrupt() {
      if (activeAbort) { activeAbort.abort(); activeAbort = null; }
      classifyAbort?.abort(); classifyAbort = null;
      tts.stop();
      clearMaxWaitTimer();
      setState("interrupted");
      return { spokenTextSoFar: spokenText || lastPlannedSpokenText };
    },

    confirmQuarantinedTranscript(text: string) {
      turnAssembler.confirmQuarantined(text, Date.now());
      surfacedQuarantineKey = "";
      committedTranscript = text.trim();
      partialTranscript = "";
      requestStableCommit(true);
    },

    discardQuarantinedTranscript() {
      resetTurn();
      callbacks.onUserTranscript("", false);
    },

    close() {
      closed = true;
      clearMaxWaitTimer();
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
