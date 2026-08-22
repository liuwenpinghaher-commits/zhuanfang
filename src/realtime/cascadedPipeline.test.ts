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
  setRecentEnergy(value: number): void;
  setEchoCancellationEnabled(value: boolean): void;
} {
  let handlers: AsrEventHandlers = {
    onTranscriptDelta: () => {},
    onSpeechStarted: () => {},
    onSpeechStopped: () => {},
  };
  let currentState: ExpressionState = fixedState;
  let userEnergyEvidence = true;
  let recentEnergy = 0;
  let echoCancellationEnabled = false;
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
    getRecentEnergy() {
      return recentEnergy;
    },
    getEchoCancellationEnabled() {
      return echoCancellationEnabled;
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
    setRecentEnergy(value: number) {
      recentEnergy = value;
    },
    setEchoCancellationEnabled(value: boolean) {
      echoCancellationEnabled = value;
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
  // 2c. VAD 误切同一句 — covered by echo-guard golden below (Phase 1 lock).
  //     Historical context: server_vad cut mid-thought → speech_started wiped
  //     committedTranscript → /end 422. Keep the narrative here; single golden
  //     owns the assertion surface to avoid dual-red drift.
  // -------------------------------------------------------------------------
  it.skip("VAD 误切同一句:listening 态 speech_started 累积前段(不丢),最终合并提交 — covered by echo-guard golden", async () => {
    /* see: echo-guard golden: listening 态 speech_started 保留已累积转写 */
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
    const pipeline = connectCascadedPipeline(makeOpts({
      sendUserTurn: lateSend,
      decisionOpts: { minBargeInMs: 0 },
    }));
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
    const latencySamples: Array<{ falseTriggerKind?: string }> = [];
    const opts = makeOpts({
      decisionOpts: { finalStabilityMs: 0, echoWindowMs: 1_500, echoSimilarityThreshold: 0.8 }
    });
    opts.callbacks.onTranscriptQuarantined = (item) => quarantined.push(item);
    opts.callbacks.onLatency = (sample) => latencySamples.push(sample);
    const pipeline = connectCascadedPipeline(opts);

    await pipeline.startListening("你能讲一个具体例子吗？");
    vi.advanceTimersByTime(601);
    asr.pushDelta("你能讲一个具体例子吗？", true);
    asr.pushSpeechStopped(1_000);
    await Promise.resolve();

    expect(quarantined).toHaveLength(1);
    expect(sendUserTurn.fn).not.toHaveBeenCalled();
    // Phase-0: echo quarantine emits countable false-trigger event
    expect(latencySamples.some((s) => s.falseTriggerKind === "quarantine_echo_suspect")).toBe(true);

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

  it("recovery 待确认期间冻结新连接转写，确认后按旧尾段再新内容的顺序提交", async () => {
    const pipeline = connectCascadedPipeline(makeOpts());
    await pipeline.startListening();

    asr.pushDelta("旧连接前半段，", true);
    pipeline.reviewRecoveryTranscript({ text: "未确认旧尾段", reason: "连接中断", code: 1006 });

    asr.pushSpeechStarted();
    asr.pushDelta("新连接继续内容。", true);
    asr.pushSpeechStopped(1_000);
    await Promise.resolve();

    expect(userTranscripts.at(-1)?.text).toBe("旧连接前半段，");
    expect(sendUserTurn.fn).not.toHaveBeenCalled();

    pipeline.confirmQuarantinedTranscript("确认旧尾段，");
    await vi.waitFor(() => expect(sendUserTurn.fn).toHaveBeenCalledOnce());
    expect(sendUserTurn.fn.mock.calls[0][0]).toBe("旧连接前半段，确认旧尾段，新连接继续内容。");
    pipeline.close();
  });

  it("recovery 待确认期间再次断线会逐项确认，不会把后续 partial 静默当 final", async () => {
    const onTranscriptQuarantined = vi.fn();
    const base = makeOpts();
    const pipeline = connectCascadedPipeline({
      ...base,
      callbacks: { ...base.callbacks, onTranscriptQuarantined },
    });
    await pipeline.startListening();

    asr.pushDelta("旧连接前半段，", true);
    pipeline.reviewRecoveryTranscript({ text: "首个待确认尾段，", reason: "首次断线", code: 1006 });

    asr.pushSpeechStarted();
    asr.pushDelta("新连接已确认段，", true);
    asr.pushDelta("第二连接未完成");
    pipeline.reviewRecoveryTranscript({ text: "第二连接未完成尾段。", reason: "再次断线", code: 1006 });

    asr.pushSpeechStarted();
    asr.pushDelta("第三连接继续。", true);
    asr.pushSpeechStopped(1_000);

    expect(onTranscriptQuarantined).toHaveBeenCalledTimes(1);
    expect(onTranscriptQuarantined).toHaveBeenLastCalledWith({
      text: "首个待确认尾段，",
      reason: "首次断线",
      source: "recovery",
    });
    expect(sendUserTurn.fn).not.toHaveBeenCalled();

    pipeline.confirmQuarantinedTranscript("确认首个尾段，");
    expect(onTranscriptQuarantined).toHaveBeenCalledTimes(2);
    expect(onTranscriptQuarantined).toHaveBeenLastCalledWith({
      text: "第二连接未完成尾段。",
      reason: "再次断线",
      source: "recovery",
    });
    expect(sendUserTurn.fn).not.toHaveBeenCalled();

    pipeline.confirmQuarantinedTranscript("确认第二尾段。");
    await vi.waitFor(() => expect(sendUserTurn.fn).toHaveBeenCalledOnce());
    expect(sendUserTurn.fn.mock.calls[0][0]).toBe(
      "旧连接前半段，确认首个尾段，新连接已确认段，确认第二尾段。第三连接继续。"
    );
    pipeline.close();
  });

  it("连续断线 partial 逐项丢弃时仍保留其间和之后的 provider final", async () => {
    const onTranscriptQuarantined = vi.fn();
    const base = makeOpts();
    const pipeline = connectCascadedPipeline({
      ...base,
      callbacks: { ...base.callbacks, onTranscriptQuarantined },
    });
    await pipeline.startListening();

    asr.pushDelta("原始 final，", true);
    pipeline.reviewRecoveryTranscript({ text: "丢弃第一尾段，", reason: "首次断线", code: 1006 });
    asr.pushDelta("中间 final，", true);
    asr.pushDelta("第二 partial");
    pipeline.reviewRecoveryTranscript({ text: "丢弃第二尾段。", reason: "再次断线", code: 1006 });
    asr.pushDelta("之后 final。", true);
    asr.pushSpeechStopped(1_000);

    pipeline.discardQuarantinedTranscript();
    expect(onTranscriptQuarantined).toHaveBeenCalledTimes(2);
    expect(onTranscriptQuarantined).toHaveBeenLastCalledWith({
      text: "丢弃第二尾段。",
      reason: "再次断线",
      source: "recovery",
    });
    expect(sendUserTurn.fn).not.toHaveBeenCalled();

    pipeline.discardQuarantinedTranscript();
    await vi.waitFor(() => expect(sendUserTurn.fn).toHaveBeenCalledOnce());
    expect(sendUserTurn.fn.mock.calls[0][0]).toBe("原始 final，中间 final，之后 final。");
    pipeline.close();
  });

  it("三次连续断线按发生顺序逐项确认且不丢失 final", async () => {
    const quarantined: string[] = [];
    const base = makeOpts();
    const pipeline = connectCascadedPipeline({
      ...base,
      callbacks: {
        ...base.callbacks,
        onTranscriptQuarantined: (item) => quarantined.push(item.text),
      },
    });
    await pipeline.startListening();

    asr.pushDelta("开头 final，", true);
    pipeline.reviewRecoveryTranscript({ text: "尾段一，", reason: "断线一", code: 1006 });
    asr.pushDelta("区间一 final，", true);
    asr.pushDelta("partial 二");
    pipeline.reviewRecoveryTranscript({ text: "尾段二，", reason: "断线二", code: 1006 });
    asr.pushDelta("区间二 final，", true);
    asr.pushDelta("partial 三");
    pipeline.reviewRecoveryTranscript({ text: "尾段三，", reason: "断线三", code: 1006 });
    asr.pushDelta("末尾 final。", true);
    asr.pushSpeechStopped(1_000);

    expect(quarantined).toEqual(["尾段一，"]);
    pipeline.confirmQuarantinedTranscript("确认一，");
    expect(quarantined).toEqual(["尾段一，", "尾段二，"]);
    pipeline.confirmQuarantinedTranscript("确认二，");
    expect(quarantined).toEqual(["尾段一，", "尾段二，", "尾段三，"]);
    expect(sendUserTurn.fn).not.toHaveBeenCalled();
    pipeline.confirmQuarantinedTranscript("确认三，");

    await vi.waitFor(() => expect(sendUserTurn.fn).toHaveBeenCalledOnce());
    expect(sendUserTurn.fn.mock.calls[0][0]).toBe(
      "开头 final，确认一，区间一 final，确认二，区间二 final，确认三，末尾 final。"
    );
    pipeline.close();
  });

  it("recovery 暂存期间再次开口会取消旧 speech_stopped，不能在仍说话时误提交", async () => {
    const pipeline = connectCascadedPipeline(makeOpts());
    await pipeline.startListening();
    asr.pushDelta("旧连接内容，", true);
    pipeline.reviewRecoveryTranscript({ text: "未确认尾段", reason: "连接中断", code: 1006 });

    asr.pushSpeechStarted();
    asr.pushDelta("新连接第一段，", true);
    asr.pushSpeechStopped(1_000);
    asr.pushSpeechStarted();
    asr.pushDelta("我还没有说完");

    pipeline.confirmQuarantinedTranscript("确认尾段，");
    await Promise.resolve();
    await Promise.resolve();

    expect(sendUserTurn.fn).not.toHaveBeenCalled();
    expect(userTranscripts.at(-1)?.text).toBe("旧连接内容，确认尾段，新连接第一段，我还没有说完");
    pipeline.close();
  });

  it("recovery 暂存中 speech_stopped 后再次开口，即使还没有新 delta 也不误提交", async () => {
    const pipeline = connectCascadedPipeline(makeOpts());
    await pipeline.startListening();
    asr.pushDelta("旧连接内容，", true);
    pipeline.reviewRecoveryTranscript({ text: "未确认尾段", reason: "连接中断", code: 1006 });
    asr.pushSpeechStarted();
    asr.pushDelta("新连接第一段。", true);
    asr.pushSpeechStopped(1_000);
    asr.pushSpeechStarted();

    pipeline.confirmQuarantinedTranscript("确认尾段，");
    await Promise.resolve();
    await Promise.resolve();

    expect(sendUserTurn.fn).not.toHaveBeenCalled();
    expect(userTranscripts.at(-1)?.text).toBe("旧连接内容，确认尾段，新连接第一段。");
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
    const latencySamples: Array<{ interrupted?: boolean; bargeInSuccess?: boolean }> = [];

    const pipeline = connectCascadedPipeline(
      makeOpts({
        sendUserTurn: slowSend,
        decisionOpts: { minBargeInMs: 0 },
        callbacks: {
          onStateChange: (s) => stateChanges.push(s),
          onUserTranscript: (text, isFinal) => userTranscripts.push({ text, isFinal }),
          onAssistantText: (text) => assistantTexts.push(text),
          onError: (e) => errors.push(e),
          onLatency: (sample) => latencySamples.push(sample)
        }
      })
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
    // Phase-0: natural barge-in reports success metrics
    expect(
      latencySamples.some((s) => s.interrupted === true && s.bargeInSuccess === true)
    ).toBe(true);

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

  it("max_wait_suppressed: timer firing during thinking emits falseTriggerKind", async () => {
    vi.useFakeTimers();
    const latencySamples: Array<{ falseTriggerKind?: string }> = [];
    const hangSend = vi.fn(
      (_text: string, _signal: AbortSignal) =>
        new Promise<{ assistantText: string }>(() => {
          /* stay in thinking until test ends */
        })
    );

    const pipeline = connectCascadedPipeline(
      makeOpts({
        sendUserTurn: hangSend,
        decisionOpts: {
          maxWaitMs: 400,
          minPauseMs: 100,
          finalStabilityMs: 0,
          echoWindowMs: 1_500,
          echoSimilarityThreshold: 0.8
        },
        callbacks: {
          onStateChange: (s) => stateChanges.push(s),
          onUserTranscript: (text, isFinal) => userTranscripts.push({ text, isFinal }),
          onAssistantText: (text) => assistantTexts.push(text),
          onError: (e) => errors.push(e),
          onLatency: (sample) => latencySamples.push(sample)
        }
      })
    );

    // Opening note enables later echo quarantine; drain echo-guard timer.
    await pipeline.startListening("你能讲一个具体例子吗？");
    await vi.advanceTimersByTimeAsync(601);

    // Arm maxWait via organizing wait (timer must outlive the confirm path).
    asr.setExpressionState("organizing");
    asr.setUserEnergyEvidence(true);
    asr.pushDelta("嗯那个", true);
    asr.pushSpeechStopped(150);
    await Promise.resolve();

    // Echo quarantine does not clear maxWait; confirm → doRespond → thinking.
    asr.setUserEnergyEvidence(false);
    asr.pushDelta("你能讲一个具体例子吗？", true);
    await Promise.resolve();
    pipeline.confirmQuarantinedTranscript("我确认要说的话。");
    await Promise.resolve();
    await Promise.resolve();
    expect(hangSend).toHaveBeenCalled();
    expect(stateChanges).toContain("thinking");

    // Fire armed maxWait while still thinking → suppressed countable event.
    await vi.advanceTimersByTimeAsync(400);
    await Promise.resolve();
    expect(latencySamples.some((s) => s.falseTriggerKind === "max_wait_suppressed")).toBe(true);

    pipeline.close();
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

  // =========================================================================
  // Echo-guard golden + fixed-P1 regression locks (CFC+ Phase 1)
  // Locks already-fixed behaviors so they cannot regress silently:
  //   - listening-state speech_started preserves cumulative transcript (VAD 误切)
  //   - TTS / post-TTS echo window: no barge-in, quarantine high-sim low-energy
  //   - maxWait timer must not fire while mic suppressed (P2-14 / half-duplex)
  //   - P1-08: close() → tts.close() (covered above)
  // Do NOT re-implement omni reconnect (P1-06) here — locked in bailianWebsocket.test.
  // =========================================================================

  it("echo-guard golden: listening 态 speech_started 保留已累积转写（VAD 误切不丢前段）", async () => {
    // Single lock for handleSpeechStarted: only barge-in resets transcript.
    // silenceMs=300 < default minPauseMs=600 → wait (prefix retained).
    const pipeline = connectCascadedPipeline(makeOpts());
    await pipeline.startListening();

    asr.setExpressionState("organizing");
    asr.pushDelta("如果只看效率指标，", true);
    asr.pushSpeechStopped(300);
    await Promise.resolve();
    expect(sendUserTurn.fn).not.toHaveBeenCalled();
    expect(userTranscripts.at(-1)?.text).toContain("如果只看效率指标");

    // Same utterance resumes after a short VAD cut — must NOT wipe committed prefix.
    asr.pushSpeechStarted();
    expect(userTranscripts.at(-1)?.text).toContain("如果只看效率指标");

    asr.setExpressionState("concluding");
    asr.pushDelta("会忽略协作成本。", true);
    asr.pushSpeechStopped(1000);
    await Promise.resolve();
    await Promise.resolve();

    expect(sendUserTurn.fn).toHaveBeenCalledOnce();
    expect(sendUserTurn.fn.mock.calls[0][0]).toBe("如果只看效率指标，会忽略协作成本。");
    pipeline.close();
  });

  it("echo-guard golden: 开场 TTS 期间回声忽略，不得 barge-in / sendUserTurn", async () => {
    // Half-duplex lock for opening speak() only — does NOT claim to arm maxWait
    // (mic suppress drops ASR before armMaxWait). P2-14 maxWait×suppress is
    // locked by the following "留白 maxWait 武装后进入 TTS" golden.
    vi.useFakeTimers();
    asr.setExpressionState("organizing");
    let resolveSpeak!: () => void;
    const heldSpeak = vi.fn(
      (_segs: string[]) => new Promise<void>((res) => { resolveSpeak = res; })
    );
    const heldStop = vi.fn();
    const heldTts = {
      speak: heldSpeak,
      stop: heldStop,
      close: vi.fn(),
    } as unknown as TtsSink;
    const pipeline = connectCascadedPipeline(
      makeOpts({
        tts: heldTts,
        decisionOpts: { maxWaitMs: 400, minPauseMs: 100 },
      })
    );

    // Opening holds speaking + suppressMic for the entire held speak().
    const started = pipeline.startListening("你好，今天我们聊聊你的工作。");
    await Promise.resolve();
    expect(heldSpeak).toHaveBeenCalledTimes(1);

    // Echo of the opening line must be ignored while suppressed.
    asr.pushSpeechStarted();
    asr.pushDelta("你好今天我们聊聊你的工作", true);
    asr.pushSpeechStopped(500);
    vi.advanceTimersByTime(3_000);
    await Promise.resolve();
    await Promise.resolve();

    expect(sendUserTurn.fn).not.toHaveBeenCalled();
    expect(heldStop).not.toHaveBeenCalled();

    resolveSpeak();
    await started;
    pipeline.close();
  });

  it("echo-guard golden: 留白 maxWait 武装后进入 TTS，speaking/echo 窗内不得 maxWait 误 respond", async () => {
    // P2-14 real lock: incomplete transcript must arm maxWait FIRST, then
    // respond/held TTS (suppressMic + clearMaxWait / !micSuppressed gate).
    // Text must NOT end on FINAL_PARTICLES (吗/呢/吧/啊/呀/嘛…) or it would
    // short-circuit to respond and never arm the timer (false-green).
    // Single-sentence assistant reply so one resolveSpeak() drains TTS and
    // actually enters releaseMicAfterGuard (ECHO_GUARD_MS) — default FIXED
    // reply is two sentences → two speak() calls → one resolve stays mid-TTS.
    vi.useFakeTimers();
    asr.setExpressionState("organizing");
    let resolveSpeak!: () => void;
    const heldSpeak = vi.fn(
      (_segs: string[]) => new Promise<void>((res) => { resolveSpeak = res; })
    );
    const heldTts = {
      speak: heldSpeak,
      stop: vi.fn(),
      close: vi.fn(),
    } as unknown as TtsSink;
    const decisions: Array<{ action: string; reason: string }> = [];
    const maxWaitMs = 800;
    const minPauseMs = 200;
    const singleSentenceSend = vi.fn(
      async (_text: string, _signal: AbortSignal): Promise<{ assistantText: string }> => ({
        assistantText: "我理解。",
      })
    );
    const pipeline = connectCascadedPipeline(
      makeOpts({
        tts: heldTts,
        sendUserTurn: singleSentenceSend,
        decisionOpts: { maxWaitMs, minPauseMs, finalStabilityMs: 0 },
        onDecision: (d) => decisions.push({ action: d.action, reason: d.reason }),
      })
    );
    await pipeline.startListening();

    // Incomplete filler ("嗯" is TRAILING_FILLERS) + silence >= minPause → wait + armMaxWait.
    asr.pushDelta("嗯", true);
    asr.pushSpeechStopped(300);
    await Promise.resolve();
    expect(singleSentenceSend).not.toHaveBeenCalled();
    expect(decisions.some((d) => d.action === "wait")).toBe(true);
    // Prove the safety-net is armed: almost maxWaitMs later, still no respond.
    vi.advanceTimersByTime(maxWaitMs - 50);
    await Promise.resolve();
    expect(singleSentenceSend).not.toHaveBeenCalled();
    expect(decisions.filter((d) => d.reason === "max-wait timer fired")).toHaveLength(0);

    // User finishes → concluding forces complete → respond → held TTS → mic suppressed.
    asr.setExpressionState("concluding");
    asr.pushSpeechStopped(1_000);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(singleSentenceSend).toHaveBeenCalledTimes(1);
    expect(heldSpeak).toHaveBeenCalledTimes(1);

    const callsAfterRespond = singleSentenceSend.mock.calls.length;
    const maxWaitFiresBeforeTts = decisions.filter((d) => d.reason === "max-wait timer fired").length;

    // While TTS is still held (mic suppressed), advancing well past maxWait must not
    // create another turn or emit a NEW "max-wait timer fired".
    vi.advanceTimersByTime(5_000);
    await Promise.resolve();
    await Promise.resolve();
    expect(singleSentenceSend.mock.calls.length).toBe(callsAfterRespond);
    expect(decisions.filter((d) => d.reason === "max-wait timer fired")).toHaveLength(maxWaitFiresBeforeTts);

    // Echo of AI voice during TTS: no barge-in, no new turn.
    asr.pushSpeechStarted();
    asr.pushDelta("我理解。", true);
    asr.pushSpeechStopped(1_000);
    await Promise.resolve();
    expect(singleSentenceSend.mock.calls.length).toBe(callsAfterRespond);
    expect(heldTts.stop).not.toHaveBeenCalled();

    // Drain the only speak() → doRespond finishes → releaseMicAfterGuard (600ms).
    resolveSpeak();
    await Promise.resolve();
    await Promise.resolve();
    expect(heldSpeak).toHaveBeenCalledTimes(1); // single-sentence: no second speak

    // True post-TTS echo guard window (mic still suppressed for ECHO_GUARD_MS):
    // high-sim low-energy echo must not create a turn / max-wait respond.
    vi.advanceTimersByTime(300);
    asr.setUserEnergyEvidence(false);
    asr.pushDelta("我理解。", true);
    asr.pushSpeechStopped(1_000);
    await Promise.resolve();
    expect(singleSentenceSend.mock.calls.length).toBe(callsAfterRespond);
    expect(decisions.filter((d) => d.reason === "max-wait timer fired")).toHaveLength(maxWaitFiresBeforeTts);

    pipeline.close();
  });

  it("echo-guard golden: TTS 回声窗内高相似低能量 → quarantine，确认前绝不 sendUserTurn", async () => {
    vi.useFakeTimers();
    asr.setExpressionState("concluding");
    asr.setUserEnergyEvidence(false);
    const quarantined: Array<{ text: string; source: string }> = [];
    const opts = makeOpts({
      decisionOpts: { finalStabilityMs: 0, echoWindowMs: 1_500, echoSimilarityThreshold: 0.8 },
    });
    opts.callbacks.onTranscriptQuarantined = (item) =>
      quarantined.push({ text: item.text, source: item.source });
    const pipeline = connectCascadedPipeline(opts);

    // Opening seeds recent TTS text for the echo similarity window.
    await pipeline.startListening("你能讲一个具体的协作例子吗？");
    // Past pipeline ECHO_GUARD_MS (600) so ASR is accepted, but still inside
    // turnAssembler echoWindowMs (1500) after noteTtsPlayback.
    vi.advanceTimersByTime(700);

    asr.pushDelta("你能讲一个具体的协作例子吗？", true);
    asr.pushSpeechStopped(1_000);
    await Promise.resolve();
    await Promise.resolve();

    expect(quarantined).toHaveLength(1);
    expect(quarantined[0].source).toBe("echo");
    expect(sendUserTurn.fn).not.toHaveBeenCalled();

    // Human confirms a real user rewrite — only then may the turn proceed.
    pipeline.confirmQuarantinedTranscript("我上周和产品一起改了优先级。");
    await Promise.resolve();
    await Promise.resolve();
    expect(sendUserTurn.fn).toHaveBeenCalledOnce();
    expect(sendUserTurn.fn.mock.calls[0][0]).toBe("我上周和产品一起改了优先级。");
    pipeline.close();
  });

  it("Layer-1: 能量已落的无标点口语直接交卷，不 arm 8s", async () => {
    asr.setExpressionState("fluent");
    asr.setRecentEnergy(0.01);
    const decisions: Array<{ action: string; reason: string }> = [];
    const pipeline = connectCascadedPipeline(makeOpts({
      onDecision: (d) => decisions.push({ action: d.action, reason: d.reason }),
      decisionOpts: { finalStabilityMs: 0, minPauseMs: 200, maxWaitMs: 8000 },
    }));
    await pipeline.startListening();
    asr.pushDelta("授权让我最难受的是那次救火", true);
    asr.pushSpeechStopped(900);
    await vi.waitFor(() => expect(sendUserTurn.fn).toHaveBeenCalledOnce());
    expect(sendUserTurn.fn.mock.calls[0][0]).toBe("授权让我最难受的是那次救火");
    expect(decisions.some((d) => d.reason === "max-wait timer fired")).toBe(false);
    pipeline.close();
  });

  it("Layer-1: 能量仍高时不交卷，下一段拼进同一轮", async () => {
    asr.setExpressionState("fluent");
    asr.setRecentEnergy(0.4);
    const pipeline = connectCascadedPipeline(makeOpts({
      decisionOpts: { finalStabilityMs: 0, minPauseMs: 200 },
    }));
    await pipeline.startListening();
    asr.pushDelta("授权让我最难受的是那次救火", true);
    asr.pushSpeechStopped(900);
    await Promise.resolve();
    expect(sendUserTurn.fn).not.toHaveBeenCalled();

    asr.setRecentEnergy(0.01);
    asr.pushSpeechStarted();
    asr.pushDelta("所以我把检索砍了", true);
    asr.pushSpeechStopped(900);
    await vi.waitFor(() => expect(sendUserTurn.fn).toHaveBeenCalledOnce());
    expect(sendUserTurn.fn.mock.calls[0][0]).toBe("授权让我最难受的是那次救火所以我把检索砍了");
    pipeline.close();
  });

  it("AEC 开着时，不相似高能量可以打断正在出声的主持人", async () => {
    vi.useFakeTimers();
    asr.setExpressionState("concluding");
    asr.setEchoCancellationEnabled(true);
    asr.setUserEnergyEvidence(true);
    asr.setRecentEnergy(0.5);
    let resolveSpeak!: () => void;
    const heldSpeak = vi.fn(
      (_segs: string[]) => new Promise<void>((res) => { resolveSpeak = res; })
    );
    const heldStop = vi.fn();
    const heldTts = { speak: heldSpeak, stop: heldStop, close: vi.fn() } as unknown as TtsSink;
    const pipeline = connectCascadedPipeline(makeOpts({
      tts: heldTts,
      echoCancellationEnabled: true,
      decisionOpts: { minBargeInMs: 280, finalStabilityMs: 0 },
    }));
    await pipeline.startListening();
    asr.pushDelta("我把那次救火说完了。", true);
    asr.pushSpeechStopped(1000);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(heldSpeak).toHaveBeenCalled();

    asr.pushSpeechStarted();
    vi.advanceTimersByTime(280);
    await Promise.resolve();
    expect(heldStop).toHaveBeenCalled();
    expect(stateChanges).toContain("interrupted");
    resolveSpeak();
    pipeline.close();
  });
});
