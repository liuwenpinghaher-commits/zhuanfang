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
import { assessTurnCompleteness, type Completeness } from "./turnCompleteness";
import { createBackchannelPicker } from "./backchannel";

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
  callbacks: CascadedPipelineCallbacks;
  preSignals?: InteractionPreSignals | null;
  decisionOpts?: { minPauseMs?: number; maxWaitMs?: number };
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
    asr, tts, sendUserTurn, callbacks, preSignals = null, decisionOpts = {},
    classifyEndpoint, onDecision, assessCompleteness = assessTurnCompleteness,
  } = opts;
  const { minPauseMs = 600, maxWaitMs = 8000 } = decisionOpts;

  const pickBackchannel = createBackchannelPicker();
  let currentPreSignals: InteractionPreSignals | null = preSignals;
  let classifyAbort: AbortController | null = null;

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
  // Text of the assistant reply actually spoken aloud so far this turn (completed sentences
  // only). interrupt() returns it so the server can truncate the persisted assistant turn to
  // what the guest really heard, instead of the full reply the AI never finished saying.
  let spokenText = "";
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
    committedTranscript = "";
    partialTranscript = "";
    clearMaxWaitTimer();
  }

  // Arm the max-wait safety net (留白 timeout). When it fires, emit a layer-0
  // decision trace (so timer-driven responses are audited too — not just the
  // synchronous heuristic ones) and respond.
  function armMaxWait(transcript: string, expressionState: ExpressionState) {
    if (maxWaitTimer !== null) return;
    maxWaitTimer = setTimeout(() => {
      maxWaitTimer = null;
      // P2-14: don't fire while the mic is suppressed (AI is speaking / echo
      // window). Otherwise a timer armed before the AI started talking can fire
      // mid-TTS and respond to the AI's own echoed transcript — the half-duplex
      // feedback loop the echo guard exists to prevent.
      if (!closed && !micSuppressed && state !== "thinking" && state !== "speaking") {
        onDecision?.({ layer: 0, action: "respond", reason: "max-wait timer fired", transcript, silenceMs: maxWaitMs, expressionState });
        void doRespond();
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
    }
    // Reset accumulator — new utterance starts fresh
    committedTranscript = "";
    partialTranscript = "";
    return wasActive;
  }

  // ── Speech stopped: analysis gate ─────────────────────────────────────────
  async function handleSpeechStopped(silenceMs: number) {
    if (closed) return;
    if (micSuppressed) return;
    if (state === "thinking" || state === "speaking") return;

    const transcript = (committedTranscript + partialTranscript).trim();
    const expressionState = asr.getExpressionState();
    // "concluding" is a strong prosodic/semantic cue that the utterance is
    // wrapping up — treat it as complete regardless of surface grammar analysis.
    const completeness: Completeness =
      expressionState === "concluding" ? "complete" : assessCompleteness(transcript);
    const decision = decideCascadeTurn({ expressionState, silenceMs, completeness, minPauseMs, maxWaitMs });

    onDecision?.({
      // layer 0 = VAD max-wait timeout fired synchronously; layer 1 = heuristic.
      layer: silenceMs >= maxWaitMs ? 0 : 1,
      action: decision.action, reason: decision.reason, transcript, silenceMs, expressionState,
    });

    if (decision.action === "wait") {
      armMaxWait(transcript, expressionState);
      return;
    }

    if (decision.action === "backchannel") {
      clearMaxWaitTimer();
      const text = pickBackchannel(expressionState, currentPreSignals?.depthDirection?.guidance);
      suppressMic();
      try { await tts.speak([text]); } catch { /* stopped */ }
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
      if (done) { await doRespond(); }
      else { armMaxWait(transcript, expressionState); }
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

    const fullTranscript = (committedTranscript + partialTranscript).trim();
    callbacks.onUserTranscript(fullTranscript, true);

    setState("thinking");
    const ctrl = new AbortController();
    activeAbort = ctrl;

    let assistantText: string;
    let providedProsody: SpeechProsody | undefined;
    try {
      const result = await sendUserTurn(fullTranscript, ctrl.signal);
      assistantText = result.assistantText;
      providedProsody = result.prosody;
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

    // A barge-in may have superseded this turn while sendUserTurn was in flight.
    // The REAL sendUserTurn is a non-abortable HTTP call that RESOLVES late (it
    // does not throw AbortError), so the catch above won't fire — guard here so
    // we never speak a stale/superseded reply. handleSpeechStarted calls
    // ctrl.abort(), so ctrl.signal.aborted is the supersession signal.
    if (closed || ctrl.signal.aborted) return;

    // Strip （…）/(…) manner & stage-direction asides BEFORE TTS so they are never read aloud.
    // The character model emits them to convey HOW it would speak (e.g. 「（轻笑）」), not as
    // words to say. The transcript (onAssistantText) keeps the full text; only the spoken
    // stream is cleaned.
    const spokenSource = stripSpokenAsides(assistantText); // no-op if already stripped server-side
    // Prefer the server-distilled prosody (it parsed the （…）asides before stripping them out of
    // the stored question); fall back to deriving from the text for any path that didn't strip.
    const prosody = providedProsody ?? deriveSpeechProsody(assistantText);
    const sentences = splitSentences(spokenSource);
    if (sentences.length === 0) {
      // 卫生: empty reply (no terminal punctuation / pure whitespace). Previously
      // this silently dropped the whole turn — the user got no audio and no UI
      // change, indistinguishable from a frozen app. Give explicit feedback:
      // surface a visible filler line AND speak a short audible prompt so the
      // user knows their turn registered and that it's their turn again.
      const filler = "嗯，我在听，你可以继续说。";
      callbacks.onAssistantText(filler);
      setState("speaking");
      suppressMic();
      try {
        await tts.speak([filler]);
      } catch {
        /* TTS stopped (barge-in) — handled by barge-in path */
      } finally {
        releaseMicAfterGuard();
      }
      if (!closed && (state as string) === "speaking") setState("listening");
      resetTurn();
      return;
    }

    callbacks.onAssistantText(assistantText);

    setState("speaking");
    suppressMic();
    spokenText = ""; // set to the full spoken text ONLY if the utterance finishes uninterrupted
    try {
      // ONE batch call: the TTS sink streams every sentence gaplessly off a single scheduling
      // clock. Calling speak() per-sentence resets that clock and waits for each sentence to
      // fully drain before requesting the next → a synthesis-latency gap between sentences
      // (audible "断"). So we hand it all sentences at once and only track spoken text coarsely:
      // a manual interrupt happens DURING playback, so spokenText stays "" (conservative — we
      // never claim words we can't confirm were heard); a clean finish records the full text.
      await tts.speak(sentences, undefined, prosody);
      if (!closed && !ctrl.signal.aborted) {
        spokenText = spokenSource;
      }
    } catch {
      // TTS stopped (barge-in) — already handled; state will be "interrupted"/"listening"
    } finally {
      releaseMicAfterGuard();
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
    onTranscriptDelta(text: string, isFinal: boolean) {
      if (closed || micSuppressed) return; // ignore the AI's own echoed transcription
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
        try { await tts.speak([openingText.trim()]); } catch { /* stopped */ }
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
      return { spokenTextSoFar: spokenText };
    },

    close() {
      closed = true;
      clearMaxWaitTimer();
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
