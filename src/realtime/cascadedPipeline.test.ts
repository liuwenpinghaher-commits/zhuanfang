/**
 * cascadedPipeline.test.ts
 *
 * TDD for the cascaded three-stream voice orchestrator.
 * All external dependencies (ASR, sendUserTurn, TTS) are injected as mocks
 * so tests run without real WebSocket / mic / network.
 *
 * Scenarios:
 *   1. 留白: speech_stopped + state "organizing" → sendUserTurn NOT called
 *   2. respond: speech_stopped + state "concluding" → sendUserTurn called; TTS gets split sentences
 *   3. barge-in: speech_started while speaking → TTS stopped, LLM aborted
 *   4. max-wait: long organizing silence → eventually calls sendUserTurn (safety net)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type {
  AsrSource,
  TtsSink,
  ConnectCascadedPipelineOptions,
  AsrEventHandlers,
} from "./cascadedPipeline";
import { connectCascadedPipeline } from "./cascadedPipeline";
import type { ExpressionState } from "../domain/types";

// ---------------------------------------------------------------------------
// Fake ASR source — lets the test push events and control ExpressionState
// ---------------------------------------------------------------------------
function makeFakeAsr(fixedState: ExpressionState = "concluding"): AsrSource & {
  _handlers: AsrEventHandlers;
  pushDelta(text: string, isFinal?: boolean): void;
  pushSpeechStarted(): void;
  pushSpeechStopped(silenceMs: number): void;
  setExpressionState(s: ExpressionState): void;
} {
  let handlers: AsrEventHandlers = {
    onTranscriptDelta: () => {},
    onSpeechStarted: () => {},
    onSpeechStopped: () => {},
  };
  let currentState: ExpressionState = fixedState;
  let started = false;
  return {
    _handlers: handlers as AsrEventHandlers,

    register(h: AsrEventHandlers) {
      handlers = h;
      // also keep _handlers in sync
      (this as any)._handlers = h;
    },
    start() {
      started = true;
      return Promise.resolve();
    },
    stop() {
      started = false;
    },
    getExpressionState() {
      return currentState;
    },

    // test helpers
    pushDelta(text: string, isFinal = false) {
      handlers.onTranscriptDelta(text, isFinal);
    },
    pushSpeechStarted() {
      handlers.onSpeechStarted();
    },
    pushSpeechStopped(silenceMs: number) {
      handlers.onSpeechStopped(silenceMs);
    },
    setExpressionState(s: ExpressionState) {
      currentState = s;
    },
  };
}

// ---------------------------------------------------------------------------
// Fake TTS sink
// ---------------------------------------------------------------------------
function makeFakeTts(): TtsSink & {
  segments: string[][];
  stopCalls: number;
  reset(): void;
} {
  const segments: string[][] = [];
  let stopCalls = 0;
  return {
    segments,
    stopCalls: 0 as number,
    speak(segs: string[]) {
      segments.push([...segs]);
      (this as any).stopCalls = stopCalls; // snapshot unused — mutated below
      return Promise.resolve();
    },
    stop() {
      stopCalls++;
      (this as any).stopCalls = stopCalls;
    },
    reset() {
      segments.length = 0;
      stopCalls = 0;
      (this as any).stopCalls = 0;
    },
  };
}

// ---------------------------------------------------------------------------
// Shared setup
// ---------------------------------------------------------------------------
const FIXED_ASSISTANT_TEXT = "我理解。你继续说。";
function makeSendUserTurn() {
  const calls: { text: string; aborted: boolean }[] = [];
  // Resolves immediately (one await tick) to make test timing deterministic.
  // Abort is still honoured so the barge-in test can override with a slow mock.
  const fn = vi.fn(async (text: string, signal: AbortSignal): Promise<{ assistantText: string }> => {
    calls.push({ text, aborted: false });
    if (signal.aborted) {
      throw new DOMException("Aborted", "AbortError");
    }
    // Schedule the abort listener before yielding so it's in place during the await
    return new Promise<{ assistantText: string }>((resolve, reject) => {
      const handler = () => {
        calls[calls.length - 1].aborted = true;
        reject(new DOMException("Aborted", "AbortError"));
      };
      signal.addEventListener("abort", handler, { once: true });
      // Immediate resolve — no extra async hop needed for the happy-path tests.
      resolve({ assistantText: FIXED_ASSISTANT_TEXT });
    });
  });
  return { fn, calls };
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------
describe("connectCascadedPipeline", () => {
  let asr: ReturnType<typeof makeFakeAsr>;
  let tts: ReturnType<typeof makeFakeTts>;
  let sendUserTurn: ReturnType<typeof makeSendUserTurn>;
  let stateChanges: string[];
  let userTranscripts: { text: string; isFinal: boolean }[];
  let assistantTexts: string[];
  let errors: Error[];

  function makeOpts(
    overrides: Partial<ConnectCascadedPipelineOptions> = {}
  ): ConnectCascadedPipelineOptions {
    return {
      asr,
      tts,
      sendUserTurn: sendUserTurn.fn,
      callbacks: {
        onStateChange: (s) => stateChanges.push(s),
        onUserTranscript: (text, isFinal) => userTranscripts.push({ text, isFinal }),
        onAssistantText: (text) => assistantTexts.push(text),
        onError: (e) => errors.push(e),
      },
      preSignals: null,
      ...overrides,
    };
  }

  beforeEach(() => {
    asr = makeFakeAsr("concluding");
    tts = makeFakeTts();
    sendUserTurn = makeSendUserTurn();
    stateChanges = [];
    userTranscripts = [];
    assistantTexts = [];
    errors = [];
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // -------------------------------------------------------------------------
  // 1. 留白: organizing state → do NOT call sendUserTurn
  // -------------------------------------------------------------------------
  it("留白: speech_stopped with 'organizing' state does NOT call sendUserTurn", async () => {
    asr.setExpressionState("organizing");
    const pipeline = connectCascadedPipeline(makeOpts());
    await pipeline.startListening();

    asr.pushDelta("那个……我在想");
    asr.pushSpeechStopped(700); // silenceMs=700 >= minPauseMs default (600), but state=organizing → wait

    // Wait one microtask for any async handling
    await Promise.resolve();

    expect(sendUserTurn.fn).not.toHaveBeenCalled();
    expect(tts.segments).toHaveLength(0);

    pipeline.close();
  });

  // -------------------------------------------------------------------------
  // 2. respond: concluding state → sendUserTurn called, TTS gets split sentences
  // -------------------------------------------------------------------------
  it("respond: speech_stopped with 'concluding' state calls sendUserTurn and splits sentences to TTS", async () => {
    asr.setExpressionState("concluding");
    const pipeline = connectCascadedPipeline(makeOpts());
    await pipeline.startListening();

    asr.pushDelta("这件事情我想清楚了");
    asr.pushSpeechStopped(1000); // concluding + 1000ms → respond

    // Flush the microtask queue so the async doRespond chain completes:
    //   handleSpeechStopped (void) → doRespond → await sendUserTurn → tts.speak
    // sendUserTurn is mocked to resolve immediately inside its Promise
    // constructor, so two microtask ticks are enough.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve(); // one extra for safety

    expect(sendUserTurn.fn).toHaveBeenCalledOnce();
    expect(sendUserTurn.fn.mock.calls[0][0]).toBe("这件事情我想清楚了");

    // Assistant text "我理解。你继续说。" should be split on 。
    const flat = tts.segments.flat();
    expect(flat).toContain("我理解。");
    expect(flat).toContain("你继续说。");

    pipeline.close();
  });

  // -------------------------------------------------------------------------
  // 2b. barge-in supersedes a NON-abortable (late-resolving) sendUserTurn →
  //     must NOT speak the stale reply. The real sendUserTurn is an HTTP call
  //     that can't be cancelled; its promise RESOLVES late after the barge-in.
  // -------------------------------------------------------------------------
  it("does NOT speak a stale reply when barge-in supersedes a late-resolving sendUserTurn", async () => {
    asr.setExpressionState("concluding");
    let resolveLate!: (v: { assistantText: string }) => void;
    const lateSend = vi.fn(
      (_text: string, _signal: AbortSignal) =>
        new Promise<{ assistantText: string }>((res) => {
          resolveLate = res;
        })
    );
    const pipeline = connectCascadedPipeline(makeOpts({ sendUserTurn: lateSend }));
    await pipeline.startListening();

    asr.pushDelta("我把一个完整的想法说完了");
    asr.pushSpeechStopped(1000); // concluding → respond → lateSend called, awaiting (thinking)
    await Promise.resolve();
    expect(lateSend).toHaveBeenCalledOnce();

    asr.pushSpeechStarted(); // BARGE-IN while thinking → ctrl.abort()
    resolveLate({ assistantText: "这是被打断后才返回的陈旧回复。" }); // HTTP can't cancel → late resolve
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    // The stale, superseded reply must NOT be spoken nor surfaced.
    expect(tts.segments.flat().join("")).not.toContain("陈旧");
    expect(assistantTexts.join("")).not.toContain("陈旧");

    pipeline.close();
  });

  // -------------------------------------------------------------------------
  // 2c. echo guard: while the AI's TTS is playing, the AI's own voice coming
  //     back through the mic must NOT barge-in or start a new turn (the cause
  //     of the "two voices talking over each other" loop).
  // -------------------------------------------------------------------------
  it("echo guard: speech during AI TTS playback does NOT barge-in or start a new turn", async () => {
    asr.setExpressionState("concluding");
    // A TTS that stays "playing" (pending) until we resolve it, so the pipeline
    // holds the "speaking" state with the mic suppressed.
    let resolveSpeak!: () => void;
    const heldSpeak = vi.fn((_segs: string[]) => new Promise<void>((res) => { resolveSpeak = res; }));
    const heldStop = vi.fn();
    const heldTts = { speak: heldSpeak, stop: heldStop } as unknown as typeof tts;
    const pipeline = connectCascadedPipeline(makeOpts({ tts: heldTts }));
    await pipeline.startListening();

    asr.pushDelta("我把一个想法说完了");
    asr.pushSpeechStopped(1000); // concluding → respond → sendUserTurn → speaking + suppress + heldSpeak(pending)
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(heldSpeak).toHaveBeenCalledTimes(1); // AI is now speaking (held)

    const sendCallsBefore = sendUserTurn.fn.mock.calls.length;
    const stopCallsBefore = heldStop.mock.calls.length;

    // Echo: the AI's own voice comes back through the mic while TTS plays.
    asr.pushSpeechStarted();
    asr.pushDelta("我理解你"); // echoed AI words — must be ignored
    asr.pushSpeechStopped(1000);
    await Promise.resolve();
    await Promise.resolve();

    // The echo must NOT abort the AI (no extra stop) nor start a new turn.
    expect(heldStop.mock.calls.length).toBe(stopCallsBefore);
    expect(sendUserTurn.fn.mock.calls.length).toBe(sendCallsBefore);

    resolveSpeak();
    pipeline.close();
  });

  // -------------------------------------------------------------------------
  // 3. barge-in: speech_started while speaking → TTS stopped, LLM aborted
  // -------------------------------------------------------------------------
  it("barge-in: speech_started while thinking/speaking stops TTS and aborts LLM", async () => {
    asr.setExpressionState("concluding");

    // Use a slow sendUserTurn that never resolves on its own (we'll barge-in before)
    let abortSignalFired = false;
    const slowSend = vi.fn((_text: string, signal: AbortSignal) => {
      return new Promise<{ assistantText: string }>((_resolve, reject) => {
        signal.addEventListener("abort", () => {
          abortSignalFired = true;
          reject(new DOMException("Aborted", "AbortError"));
        });
        // intentionally never resolves
      });
    });

    const pipeline = connectCascadedPipeline(
      makeOpts({ sendUserTurn: slowSend })
    );
    await pipeline.startListening();

    asr.pushDelta("我决定了");
    asr.pushSpeechStopped(1000); // triggers respond → thinking

    // Wait until thinking state is entered (sendUserTurn called)
    await vi.waitFor(() => slowSend.mock.calls.length > 0, { timeout: 500 });

    // Now barge-in
    asr.setExpressionState("fluent");
    asr.pushSpeechStarted();

    await Promise.resolve();
    await Promise.resolve();

    expect(abortSignalFired).toBe(true);
    expect(tts.stopCalls).toBeGreaterThanOrEqual(1);
    // state should be "interrupted" or "listening"
    expect(stateChanges).toContain("interrupted");

    pipeline.close();
  });

  // -------------------------------------------------------------------------
  // 4. max-wait: organizing + long silence → eventually calls sendUserTurn
  // -------------------------------------------------------------------------
  it("max-wait: organizing state eventually responds after maxWaitMs", async () => {
    vi.useFakeTimers();

    asr.setExpressionState("organizing");
    const pipeline = connectCascadedPipeline(
      makeOpts({ decisionOpts: { maxWaitMs: 1000, minPauseMs: 600 } })
    );
    await pipeline.startListening();

    asr.pushDelta("嗯……");
    // First speech_stopped at 700ms — organizing → wait
    asr.pushSpeechStopped(700);

    // Advance time past maxWaitMs → the safety-net timer should fire
    vi.advanceTimersByTime(1100);

    // Allow microtasks to flush
    await Promise.resolve();
    await Promise.resolve();

    // By now the max-wait should have forced a respond
    expect(sendUserTurn.fn).toHaveBeenCalled();

    pipeline.close();
    vi.useRealTimers();
  });

  // -------------------------------------------------------------------------
  // 5. backchannel: circling state → TTS gets backchannel text, sendUserTurn NOT called
  // -------------------------------------------------------------------------
  it("backchannel: circling state emits backchannel to TTS, does NOT call sendUserTurn", async () => {
    asr.setExpressionState("circling");
    const pipeline = connectCascadedPipeline(makeOpts());
    await pipeline.startListening();

    asr.pushDelta("就是……就是……就是那种感觉");
    asr.pushSpeechStopped(1000);

    await vi.waitFor(() => tts.segments.length > 0, { timeout: 1000 });

    expect(sendUserTurn.fn).not.toHaveBeenCalled();
    // Some backchannel text should have been sent to TTS
    expect(tts.segments.flat().join("").length).toBeGreaterThan(0);

    pipeline.close();
  });

  // -------------------------------------------------------------------------
  // 6. cumulative deltas must NOT duplicate. omni sends the full text-so-far on
  //    every delta, so the partial is REPLACED (not appended); .completed commits
  //    the segment. Regresses "我今天的我今天的主题我今天的主题是…".
  // -------------------------------------------------------------------------
  it("replaces cumulative deltas (no duplication) and commits the segment on isFinal", async () => {
    asr.setExpressionState("concluding");
    const pipeline = connectCascadedPipeline(makeOpts());
    await pipeline.startListening();

    // Cumulative deltas — each carries the full text-so-far for the segment.
    asr.pushDelta("我");
    asr.pushDelta("我今天");
    asr.pushDelta("我今天的主题");
    // The live partial is the LAST delta, never the concatenation.
    expect(userTranscripts.at(-1)?.text).toBe("我今天的主题");

    // .completed finalizes the segment; partial clears, committed holds the text.
    asr.pushDelta("我今天的主题是什么？", true);
    expect(userTranscripts.at(-1)?.text).toBe("我今天的主题是什么？");

    asr.pushSpeechStopped(1000); // concluding → respond
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    // The turn sent to the LLM is the clean, de-duplicated transcript.
    expect(sendUserTurn.fn).toHaveBeenCalledOnce();
    expect(sendUserTurn.fn.mock.calls[0][0]).toBe("我今天的主题是什么？");

    pipeline.close();
  });

  // -------------------------------------------------------------------------
  // 7. State transitions: idle → listening on startListening
  // -------------------------------------------------------------------------
  it("transitions to 'listening' after startListening()", async () => {
    asr.setExpressionState("organizing");
    const pipeline = connectCascadedPipeline(makeOpts());
    await pipeline.startListening();

    expect(stateChanges).toContain("listening");

    pipeline.close();
  });
});
