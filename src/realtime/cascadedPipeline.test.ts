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
import { TtsPlaybackInterruptedError } from "./cascadedTtsSink";
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
  setUserEnergyEvidence(value: boolean): void;
} {
  let handlers: AsrEventHandlers = {
    onTranscriptDelta: () => {},
    onSpeechStarted: () => {},
    onSpeechStopped: () => {},
  };
  let currentState: ExpressionState = fixedState;
  let userEnergyEvidence = true;
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
    hasRecentUserEnergyEvidence() {
      return userEnergyEvidence;
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
    setUserEnergyEvidence(value: boolean) {
      userEnergyEvidence = value;
    },
  };
}

// ---------------------------------------------------------------------------
// Fake TTS sink
// ---------------------------------------------------------------------------
function makeFakeTts(): TtsSink & {
  segments: string[][];
  stopCalls: number;
  closeCalls: number;
  reset(): void;
} {
  const segments: string[][] = [];
  let stopCalls = 0;
  let closeCalls = 0;
  return {
    segments,
    stopCalls: 0 as number,
    closeCalls: 0 as number,
    speak(segs: string[]) {
      segments.push([...segs]);
      (this as any).stopCalls = stopCalls; // snapshot unused — mutated below
      return Promise.resolve();
    },
    stop() {
      stopCalls++;
      (this as any).stopCalls = stopCalls;
    },
    close() {
      closeCalls++;
      (this as any).closeCalls = closeCalls;
    },
    reset() {
      segments.length = 0;
      stopCalls = 0;
      closeCalls = 0;
      (this as any).stopCalls = 0;
      (this as any).closeCalls = 0;
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

    asr.pushDelta("这件事情我想清楚了", true);
    asr.pushSpeechStopped(1000); // concluding + 1000ms → respond

    // Flush all pending microtasks so the async doRespond chain completes:
    //   handleSpeechStopped (void) → doRespond → await sendUserTurn → speak each sentence.
    // The reply is now spoken sentence-by-sentence (one await per sentence) so a macrotask
    // turn is the robust way to drain the whole chain.
    await new Promise((r) => setTimeout(r, 0));

    expect(sendUserTurn.fn).toHaveBeenCalledOnce();
    expect(sendUserTurn.fn.mock.calls[0][0]).toBe("这件事情我想清楚了");

    // Assistant text "我理解。你继续说。" should be split on 。
    const flat = tts.segments.flat();
    expect(flat).toContain("我理解。");
    expect(flat).toContain("你继续说。");

    pipeline.close();
  });

  // -------------------------------------------------------------------------
  // 2c. VAD 误切同一句:listening 态 speech_started 不清累积(前段不丢)
  //     回归:server_vad 在思考停顿处切段 → 用户续说触发 speech_started(非 barge-in)。
  //     旧实现每次 speech_started 都清 committedTranscript → 前段丢失 → 残段不完整不
  //     respond → session.turns 永远 0 → /end 返回 422「结束失败,本次未生成档案」。
  // -------------------------------------------------------------------------
  it("VAD 误切同一句:listening 态 speech_started 累积前段(不丢),最终合并提交", async () => {
    const pipeline = connectCascadedPipeline(makeOpts());
    await pipeline.startListening();

    // 第一段:用户说半句后思考停顿,被 server_vad 切段(短停顿 → wait,未 respond)
    asr.setExpressionState("organizing");
    asr.pushDelta("我觉得这个产品的核心，", true);
    asr.pushSpeechStopped(300); // silenceMs < minPauseMs(600) → wait
    await new Promise((r) => setTimeout(r, 0));
    expect(sendUserTurn.fn).not.toHaveBeenCalled();

    // 用户继续说同一句:listening 态 speech_started(非 barge-in)——必须保留前段
    asr.pushSpeechStarted();
    asr.setExpressionState("concluding");
    asr.pushDelta("是认知沉淀。", true);
    asr.pushSpeechStopped(1000); // concluding → respond
    await new Promise((r) => setTimeout(r, 0));

    // sendUserTurn 必须收到累积的完整句,而不是只有最后一段("是认知沉淀。")
    expect(sendUserTurn.fn).toHaveBeenCalledOnce();
    expect(sendUserTurn.fn.mock.calls[0][0]).toBe("我觉得这个产品的核心，是认知沉淀。");

    pipeline.close();
  });

  // -------------------------------------------------------------------------
  // 2a. interrupt() during playback: batch TTS cannot report exact heard chars, but we
  //     fall back to the planned full reply (lastPlannedSpokenText) so truncateAssistantTurn
  //     does not wipe the assistant turn to empty content.
  // -------------------------------------------------------------------------
  it("interrupt() during playback keeps planned spoken text non-empty (no empty wipe)", async () => {
    asr.setExpressionState("concluding");
    const heldTts = {
      segments: [] as string[][],
      speak(segs: string[]) {
        this.segments.push([...segs]);
        return new Promise<void>(() => {}); // never resolves → utterance is "in progress"
      },
      stop() {},
      close() {},
    };
    const pipeline = connectCascadedPipeline(makeOpts({ tts: heldTts as never }));
    await pipeline.startListening();
    asr.pushDelta("这件事情我想清楚了", true);
    asr.pushSpeechStopped(1000);
    await new Promise((r) => setTimeout(r, 0)); // now speaking (held)

    const info = pipeline.interrupt();
    expect(info.spokenTextSoFar.length).toBeGreaterThan(0);
    // the whole reply went to the sink in a SINGLE speak() call (gapless), not one-per-sentence
    expect(heldTts.segments).toHaveLength(1);

    pipeline.close();
  });

  // -------------------------------------------------------------------------
  // 2c. parenthetical stage directions (（…）) must NOT be sent to TTS — they describe the
  //     interviewer's manner, not words to speak.
  // -------------------------------------------------------------------------
  it("strips parenthetical stage directions before TTS (never read aloud)", async () => {
    asr.setExpressionState("concluding");
    const send = vi.fn(async () => ({ assistantText: "你认同这个顺序吗？（温和但明确地观察对方反应）能说说理由吗？" }));
    const pipeline = connectCascadedPipeline(makeOpts({ sendUserTurn: send }));
    await pipeline.startListening();
    asr.pushDelta("嗯", true);
    asr.pushSpeechStopped(1000);
    await new Promise((r) => setTimeout(r, 0));

    const spoken = tts.segments.flat().join("");
    expect(spoken).not.toContain("温和但明确地观察对方反应");
    expect(spoken).not.toContain("（");
    expect(spoken).toContain("你认同这个顺序吗？");
    expect(spoken).toContain("能说说理由吗？");
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

    asr.pushDelta("我把一个完整的想法说完了", true);
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

    asr.pushDelta("我把一个想法说完了", true);
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

  it("回声保护窗后的高相似低能量转写进入待确认区，确认后才提交", async () => {
    vi.useFakeTimers();
    asr.setExpressionState("concluding");
    asr.setUserEnergyEvidence(false);
    const quarantined: Array<{ text: string; reason: string }> = [];
    const opts = makeOpts({
      decisionOpts: { finalStabilityMs: 0, echoWindowMs: 1_500, echoSimilarityThreshold: 0.8 }
    });
    opts.callbacks.onTranscriptQuarantined = (item) => quarantined.push(item);
    const pipeline = connectCascadedPipeline(opts);

    await pipeline.startListening("你能讲一个具体例子吗？");
    vi.advanceTimersByTime(601);
    asr.pushDelta("你能讲一个具体例子吗？", true);
    asr.pushSpeechStopped(1_000);
    await Promise.resolve();

    expect(quarantined).toHaveLength(1);
    expect(sendUserTurn.fn).not.toHaveBeenCalled();

    pipeline.confirmQuarantinedTranscript("我可以讲一个具体例子。");
    await Promise.resolve();
    await Promise.resolve();
    expect(sendUserTurn.fn).toHaveBeenCalledOnce();
    expect(sendUserTurn.fn.mock.calls[0][0]).toBe("我可以讲一个具体例子。");
    pipeline.close();
  });

  it("recovery partial 只进入待确认区，确认后才提交", async () => {
    const onTranscriptQuarantined = vi.fn();
    const base = makeOpts();
    const pipeline = connectCascadedPipeline({
      ...base,
      callbacks: { ...base.callbacks, onTranscriptQuarantined },
    });
    await pipeline.startListening();

    asr.pushDelta("前半段", true);
    pipeline.reviewRecoveryTranscript({ text: "未确认尾段", reason: "连接中断", code: 1006 });

    expect(onTranscriptQuarantined).toHaveBeenCalledWith({
      text: "未确认尾段",
      reason: "连接中断",
      source: "recovery",
    });
    expect(sendUserTurn.fn).not.toHaveBeenCalled();

    pipeline.confirmQuarantinedTranscript("修改后的尾段");
    await vi.waitFor(() => expect(sendUserTurn.fn).toHaveBeenCalledWith(
      "前半段修改后的尾段",
      expect.any(AbortSignal)
    ));
    pipeline.close();
  });

  it("丢弃 recovery partial 后保留已 final 的当前表达", async () => {
    const pipeline = connectCascadedPipeline(makeOpts());
    await pipeline.startListening();

    asr.pushDelta("已确认前半段", true);
    pipeline.reviewRecoveryTranscript({ text: "不要的尾段", reason: "连接中断", code: 1006 });
    pipeline.discardQuarantinedTranscript();

    expect(userTranscripts).toContainEqual({ text: "已确认前半段", isFinal: false });
    expect(sendUserTurn.fn).not.toHaveBeenCalled();
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

    asr.pushDelta("我决定了", true);
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

    asr.pushDelta("嗯……", true);
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

  it("空转写即使触发 max-wait 也绝不创建 phantom user turn", async () => {
    vi.useFakeTimers();
    asr.setExpressionState("organizing");
    const pipeline = connectCascadedPipeline(
      makeOpts({ decisionOpts: { maxWaitMs: 500, minPauseMs: 100 } })
    );
    await pipeline.startListening();

    asr.pushSpeechStopped(200);
    vi.advanceTimersByTime(800);
    await Promise.resolve();
    await Promise.resolve();

    expect(sendUserTurn.fn).not.toHaveBeenCalled();
    expect(userTranscripts.some((item) => item.isFinal)).toBe(false);
    pipeline.close();
  });

  it("首个 final 后等待稳定窗口并合并迟到的第二个 final，再只提交一次", async () => {
    vi.useFakeTimers();
    asr.setExpressionState("concluding");
    const pipeline = connectCascadedPipeline(makeOpts({
      decisionOpts: { minPauseMs: 100, maxWaitMs: 3000, finalStabilityMs: 300 } as any
    }));
    await pipeline.startListening();

    asr.pushDelta("个人提效很快，", true);
    asr.pushSpeechStopped(500);
    vi.advanceTimersByTime(150);
    asr.pushDelta("但组织价值流没有缩短。", true);
    vi.advanceTimersByTime(400);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(sendUserTurn.fn).toHaveBeenCalledOnce();
    expect(sendUserTurn.fn.mock.calls[0][0]).toBe("个人提效很快，但组织价值流没有缩短。");
    pipeline.close();
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

  // -------------------------------------------------------------------------
  // 8. completeness=complete → respond
  // -------------------------------------------------------------------------
  it("completeness=complete → respond", async () => {
    asr.setExpressionState("fluent");
    const pipeline = connectCascadedPipeline(makeOpts({ assessCompleteness: () => "complete" }));
    await pipeline.startListening();
    asr.pushDelta("我昨天去了公司", true);
    asr.pushSpeechStopped(1000);
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(sendUserTurn.fn).toHaveBeenCalledOnce();
    pipeline.close();
  });

  // -------------------------------------------------------------------------
  // 9. completeness=incomplete → wait
  // -------------------------------------------------------------------------
  it("completeness=incomplete → wait", async () => {
    asr.setExpressionState("fluent");
    const pipeline = connectCascadedPipeline(makeOpts({ assessCompleteness: () => "incomplete" }));
    await pipeline.startListening();
    asr.pushDelta("我觉得吧，因为");
    asr.pushSpeechStopped(1000);
    await Promise.resolve(); await Promise.resolve();
    expect(sendUserTurn.fn).not.toHaveBeenCalled();
    pipeline.close();
  });

  // -------------------------------------------------------------------------
  // 10. ambiguous + classifyEndpoint done:true → respond
  // -------------------------------------------------------------------------
  it("ambiguous + classifyEndpoint done:true → respond", async () => {
    asr.setExpressionState("fluent");
    const classifyEndpoint = vi.fn(async () => ({ done: true, reason: "ok" }));
    const pipeline = connectCascadedPipeline(makeOpts({ assessCompleteness: () => "ambiguous", classifyEndpoint }));
    await pipeline.startListening();
    asr.pushDelta("这件事挺复杂", true);
    asr.pushSpeechStopped(1000);
    await vi.waitFor(() => expect(classifyEndpoint).toHaveBeenCalled());
    await Promise.resolve(); await Promise.resolve();
    expect(sendUserTurn.fn).toHaveBeenCalledOnce();
    pipeline.close();
  });

  // -------------------------------------------------------------------------
  // 11. ambiguous + classifyEndpoint done:false → wait
  // -------------------------------------------------------------------------
  it("ambiguous + classifyEndpoint done:false → wait", async () => {
    asr.setExpressionState("fluent");
    const classifyEndpoint = vi.fn(async () => ({ done: false, reason: "not done" }));
    const pipeline = connectCascadedPipeline(makeOpts({ assessCompleteness: () => "ambiguous", classifyEndpoint }));
    await pipeline.startListening();
    asr.pushDelta("这件事挺复杂", true);
    asr.pushSpeechStopped(1000);
    await vi.waitFor(() => expect(classifyEndpoint).toHaveBeenCalled());
    await Promise.resolve(); await Promise.resolve();
    expect(sendUserTurn.fn).not.toHaveBeenCalled();
    pipeline.close();
  });

  // -------------------------------------------------------------------------
  // 12. classifyEndpoint 抛错 → 兜底 respond
  // -------------------------------------------------------------------------
  it("classifyEndpoint 抛错 → 兜底 respond", async () => {
    asr.setExpressionState("fluent");
    const classifyEndpoint = vi.fn(async () => { throw new Error("net"); });
    const pipeline = connectCascadedPipeline(makeOpts({ assessCompleteness: () => "ambiguous", classifyEndpoint }));
    await pipeline.startListening();
    asr.pushDelta("这件事挺复杂", true);
    asr.pushSpeechStopped(1000);
    await vi.waitFor(() => expect(classifyEndpoint).toHaveBeenCalled());
    await Promise.resolve(); await Promise.resolve();
    expect(sendUserTurn.fn).toHaveBeenCalledOnce();
    pipeline.close();
  });

  // -------------------------------------------------------------------------
  // 13. onDecision 收到决策 trace
  // -------------------------------------------------------------------------
  it("onDecision 收到决策 trace", async () => {
    asr.setExpressionState("fluent");
    const traces: any[] = [];
    const pipeline = connectCascadedPipeline(makeOpts({ assessCompleteness: () => "complete", onDecision: (t) => traces.push(t) }));
    await pipeline.startListening();
    asr.pushDelta("我昨天去了公司");
    asr.pushSpeechStopped(1000);
    await Promise.resolve(); await Promise.resolve();
    expect(traces.length).toBeGreaterThan(0);
    expect(traces[0]).toHaveProperty("action");
    expect(traces[0]).toHaveProperty("reason");
    pipeline.close();
  });

  // -------------------------------------------------------------------------
  // 14. startListening(opening) 受控开场进 speaking
  // -------------------------------------------------------------------------
  it("startListening(opening) 受控开场进 speaking", async () => {
    asr.setExpressionState("fluent");
    const pipeline = connectCascadedPipeline(makeOpts());
    await pipeline.startListening("上次你说要追的那个问题，现在怎么样了？");
    expect(stateChanges).toContain("speaking");
    expect(tts.segments.flat().join("")).toContain("上次你说要追的那个问题");
    pipeline.close();
  });

  // -------------------------------------------------------------------------
  // 15. 卫生: empty reply gives audible + visible feedback (not silent drop)
  // -------------------------------------------------------------------------
  it("empty assistant reply speaks a filler line and surfaces it (no silent drop)", async () => {
    asr.setExpressionState("concluding");
    // sendUserTurn returns an empty reply (no terminal punctuation / whitespace).
    const emptyTurn = vi.fn(async (): Promise<{ assistantText: string }> => ({ assistantText: "   " }));
    const pipeline = connectCascadedPipeline(makeOpts({ sendUserTurn: emptyTurn }));
    await pipeline.startListening();
    asr.pushDelta("嗯", true);
    asr.pushSpeechStopped(1000);
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();

    // A filler line was spoken (audible feedback) ...
    expect(tts.segments.length).toBeGreaterThan(0);
    const spoken = tts.segments.flat().join("");
    expect(spoken.length).toBeGreaterThan(0);
    // ... and surfaced to the UI (visible feedback), not an empty string.
    expect(assistantTexts.some((t) => t.trim().length > 0)).toBe(true);
    // Returns to listening so the user can continue.
    expect(stateChanges.at(-1)).toBe("listening");
    pipeline.close();
  });

  // -------------------------------------------------------------------------
  // 16. P1-08: close() tears down the TTS sink (close(), not just stop())
  // -------------------------------------------------------------------------
  it("close() calls tts.close() to release the socket + AudioContext", async () => {
    const pipeline = connectCascadedPipeline(makeOpts());
    await pipeline.startListening();
    pipeline.close();
    expect((tts as any).closeCalls).toBe(1);
    // stop() is still called before close() (so in-flight speak() resolves).
    expect((tts as any).stopCalls).toBeGreaterThanOrEqual(1);
  });

  it("TTS 中断保留文字、回到 listening 且不关闭 ASR", async () => {
    const onTtsPlaybackInterrupted = vi.fn();
    const base = makeOpts();
    const interruptedTts: TtsSink = {
      ...tts,
      speak: vi.fn().mockRejectedValueOnce(new TtsPlaybackInterruptedError("播放中断", 1011)),
    };
    const asrStop = vi.spyOn(asr, "stop");
    const pipeline = connectCascadedPipeline({
      ...base,
      tts: interruptedTts,
      callbacks: { ...base.callbacks, onTtsPlaybackInterrupted } as never,
    });
    await pipeline.startListening();
    asr.pushDelta("完整用户表达", true);
    asr.pushSpeechStopped(900);

    await vi.waitFor(() => expect(interruptedTts.speak).toHaveBeenCalled());
    await vi.waitFor(() => expect(onTtsPlaybackInterrupted).toHaveBeenCalledOnce());
    expect(assistantTexts).toContain(FIXED_ASSISTANT_TEXT);
    expect(stateChanges.at(-1)).toBe("listening");
    expect(asrStop).not.toHaveBeenCalled();

    pipeline.close();
  });

  it("流式播放中断后不继续发送同一轮剩余 segments", async () => {
    const onTtsPlaybackInterrupted = vi.fn();
    const base = makeOpts();
    const interruptedTts: TtsSink = {
      ...tts,
      speak: vi.fn().mockRejectedValueOnce(new TtsPlaybackInterruptedError("播放中断", 1011)),
    };
    const stream = vi.fn(async (_text: string, _signal: AbortSignal, onDelta: (chunk: string) => void) => {
      onDelta("第一段。");
      onDelta("第二段。");
      return { assistantText: "第一段。第二段。" };
    });
    const pipeline = connectCascadedPipeline({
      ...base,
      tts: interruptedTts,
      sendUserTurnStream: stream,
      callbacks: { ...base.callbacks, onTtsPlaybackInterrupted } as never,
    });
    await pipeline.startListening();
    asr.pushDelta("完整用户表达", true);
    asr.pushSpeechStopped(900);

    await vi.waitFor(() => expect(onTtsPlaybackInterrupted).toHaveBeenCalledOnce());
    expect(interruptedTts.speak).toHaveBeenCalledTimes(1);

    pipeline.close();
  });
});
