// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createBrowserTtsSink, TTS_AUTOPLAY_BLOCKED_MESSAGE } from "./cascadedTtsSink";

interface MockTtsSocket {
  sent: string[];
  closeCalls: Array<{ code?: number; reason?: string }>;
  open(): void;
  message(data: string | ArrayBuffer): void;
  close(code?: number, reason?: string): void;
  error(): void;
}

interface MockAudioContextControl {
  state: AudioContextState;
  blockResume: boolean;
  resumeRejects: boolean;
  resumeCalls: number;
  releaseBlockedResumes(): void;
}

interface MockAudioSourceControl {
  startCalls: number;
  stopCalls: number;
}

let sockets: MockTtsSocket[] = [];
let audioContexts: MockAudioContextControl[] = [];
let audioSources: MockAudioSourceControl[] = [];
let nextAudioContextSuspended = false;
let nextAudioContextResumeBlocked = false;
let nextAudioContextResumeRejects = false;
let restoreWebSocket: (() => void) | null = null;
let restoreAudioContext: (() => void) | null = null;

beforeEach(() => {
  sockets = [];
  audioContexts = [];
  audioSources = [];
  nextAudioContextSuspended = false;
  nextAudioContextResumeBlocked = false;
  nextAudioContextResumeRejects = false;
  const originalWebSocket = globalThis.WebSocket;
  const originalAudioContext = globalThis.AudioContext;

  class TestWebSocket {
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    static readonly CLOSING = 2;
    static readonly CLOSED = 3;
    readyState = TestWebSocket.CONNECTING;
    binaryType = "blob";
    onopen: (() => void) | null = null;
    onerror: (() => void) | null = null;
    onclose: ((event: CloseEvent) => void) | null = null;
    private readonly listeners = new Map<string, Set<(event: MessageEvent) => void>>();
    sent: string[] = [];
    closeCalls: Array<{ code?: number; reason?: string }> = [];

    constructor(_url: string) {
      sockets.push(this);
    }

    send(value: string) {
      this.sent.push(value);
    }

    addEventListener(type: string, listener: (event: MessageEvent) => void) {
      const listeners = this.listeners.get(type) ?? new Set();
      listeners.add(listener);
      this.listeners.set(type, listeners);
    }

    removeEventListener(type: string, listener: (event: MessageEvent) => void) {
      this.listeners.get(type)?.delete(listener);
    }

    open() {
      this.readyState = TestWebSocket.OPEN;
      this.onopen?.();
    }

    message(data: string | ArrayBuffer) {
      for (const listener of this.listeners.get("message") ?? []) {
        listener({ data } as MessageEvent);
      }
    }

    close(code = 1006, reason = "interrupted") {
      this.closeCalls.push({ code, reason });
      this.readyState = TestWebSocket.CLOSED;
      this.onclose?.({ code, reason } as CloseEvent);
    }

    error() {
      this.onerror?.();
    }
  }

  globalThis.WebSocket = TestWebSocket as unknown as typeof WebSocket;
  globalThis.AudioContext = class {
    constructor() {
      const blockedResumeResolvers: Array<() => void> = [];
      const control: MockAudioContextControl & {
        currentTime: number;
        destination: object;
        resume(): Promise<void>;
        close(): Promise<void>;
        createBuffer(): { getChannelData(): Float32Array; duration: number };
        createBufferSource(): { connect(): void; start(): void; stop(): void };
      } = {
        state: nextAudioContextSuspended ? "suspended" : "running",
        blockResume: nextAudioContextResumeBlocked,
        resumeRejects: nextAudioContextResumeRejects,
        resumeCalls: 0,
        currentTime: 0,
        destination: {},
        resume() {
          this.resumeCalls += 1;
          if (this.resumeRejects) {
            return Promise.reject(new Error("autoplay blocked"));
          }
          if (!this.blockResume) {
            this.state = "running";
            return Promise.resolve();
          }
          return new Promise<void>((resolve) => {
            blockedResumeResolvers.push(resolve);
          });
        },
        close() {
          this.state = "closed";
          return Promise.resolve();
        },
        releaseBlockedResumes() {
          if (this.state !== "closed") this.state = "running";
          for (const resolve of blockedResumeResolvers.splice(0)) resolve();
        },
        createBuffer: () => ({ getChannelData: () => new Float32Array(), duration: 0 }),
        createBufferSource: () => {
          const source: MockAudioSourceControl & {
            connect(): void;
            start(): void;
            stop(): void;
          } = {
            startCalls: 0,
            stopCalls: 0,
            connect: () => undefined,
            start() { this.startCalls += 1; },
            stop() { this.stopCalls += 1; },
          };
          audioSources.push(source);
          return source;
        },
      };
      audioContexts.push(control);
      nextAudioContextSuspended = false;
      nextAudioContextResumeBlocked = false;
      nextAudioContextResumeRejects = false;
      return control;
    }
  } as unknown as typeof AudioContext;
  restoreWebSocket = () => { globalThis.WebSocket = originalWebSocket; };
  restoreAudioContext = () => { globalThis.AudioContext = originalAudioContext; };
});

afterEach(() => {
  restoreWebSocket?.();
  restoreAudioContext?.();
  restoreWebSocket = null;
  restoreAudioContext = null;
});

describe("createBrowserTtsSink", () => {
  async function expectSettled(promise: Promise<void>) {
    let settled = false;
    void promise.then(() => { settled = true; }, () => { settled = true; });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(settled).toBe(true);
  }

  async function expectInterrupted(
    promise: Promise<void>,
    expected: { name: string; code?: number },
  ) {
    const outcome = await Promise.race([
      promise.then(
        () => ({ status: "resolved" as const }),
        (error: unknown) => ({ status: "rejected" as const, error }),
      ),
      new Promise<{ status: "pending" }>((resolve) => {
        setTimeout(() => resolve({ status: "pending" }), 0);
      }),
    ]);
    expect(outcome).toMatchObject({ status: "rejected", error: expected });
  }

  function sentSpeakSegments(socket: MockTtsSocket): string[][] {
    return socket.sent
      .map((value) => JSON.parse(value))
      .filter((value) => value.type === "speak")
      .map((value) => value.segments);
  }

  it("中途 close 拒绝当前 speak，下一轮创建新 socket且不重发旧 segments", async () => {
    const sink = createBrowserTtsSink("ws://test/tts", "voice");
    const first = sink.speak(["第一轮"]);
    sockets[0].open();
    await Promise.resolve();
    sockets[0].close(1011, "upstream interrupted");
    await expect(first).rejects.toMatchObject({ name: "TtsPlaybackInterruptedError", code: 1011 });

    const second = sink.speak(["第二轮"]);
    expect(sockets).toHaveLength(2);
    sockets[1].open();
    await vi.waitFor(() => expect(sentSpeakSegments(sockets[1])).toEqual([["第二轮"]]));
    let secondSettled = false;
    void second.then(() => { secondSettled = true; }, () => { secondSettled = true; });
    sockets[0].close(1006, "late old-socket close");
    await Promise.resolve();
    expect(secondSettled).toBe(false);
    sockets[1].message(JSON.stringify({ type: "tts.done" }));
    await second;
    expect(sockets[1].sent
      .map((value) => JSON.parse(value))
      .filter((value) => value.type === "speak")
      .map((value) => value.segments))
      .toEqual([["第二轮"]]);
  });

  it("tts.done 之后 socket close 视为播放成功，不报中断", async () => {
    const sink = createBrowserTtsSink("ws://test/tts");
    const speaking = sink.speak(["播完这一句"]);
    sockets[0].open();
    await vi.waitFor(() => expect(sentSpeakSegments(sockets[0])).toEqual([["播完这一句"]]));
    sockets[0].message(JSON.stringify({ type: "tts.done" }));
    sockets[0].close(1000, "normal close after done");
    await expect(speaking).resolves.toBeUndefined();
  });

  it("主动 stop 正常 resolve 当前 speak", async () => {
    const sink = createBrowserTtsSink("ws://test/tts");
    const speaking = sink.speak(["会被主动停止"]);
    sockets[0].open();
    await Promise.resolve();
    sink.stop();
    await expect(speaking).resolves.toBeUndefined();
  });

  it("中途 error 拒绝当前 speak", async () => {
    const sink = createBrowserTtsSink("ws://test/tts");
    const speaking = sink.speak(["会被异常中断"]);
    sockets[0].open();
    await Promise.resolve();
    sockets[0].error();
    await expect(speaking).rejects.toMatchObject({ name: "TtsPlaybackInterruptedError" });
  });

  it("异常 close 会停止已排队音频且下一轮仍可播放", async () => {
    const sink = createBrowserTtsSink("ws://test/tts");
    const first = sink.speak(["第一轮已有音频"]);
    sockets[0].open();
    await vi.waitFor(() => expect(sentSpeakSegments(sockets[0])).toEqual([["第一轮已有音频"]]));
    sockets[0].message(new Uint8Array([0, 0]).buffer);
    expect(audioSources).toHaveLength(1);
    expect(audioSources[0]).toMatchObject({ startCalls: 1, stopCalls: 0 });

    sockets[0].close(1011, "upstream interrupted");
    await expect(first).rejects.toMatchObject({ name: "TtsPlaybackInterruptedError", code: 1011 });
    expect(audioSources[0].stopCalls).toBe(1);

    const second = sink.speak(["第二轮正常播放"]);
    sockets[1].open();
    await vi.waitFor(() => expect(sentSpeakSegments(sockets[1])).toEqual([["第二轮正常播放"]]));
    sockets[1].message(new Uint8Array([0, 0]).buffer);
    expect(audioSources).toHaveLength(2);
    expect(audioSources[1]).toMatchObject({ startCalls: 1, stopCalls: 0 });
    sink.stop();
    await second;
  });

  it("close 幂等且不会重播 active segments", async () => {
    const sink = createBrowserTtsSink("ws://test/tts");
    const speaking = sink.speak(["只发送一次"]);
    sockets[0].open();
    await vi.waitFor(() => expect(sentSpeakSegments(sockets[0])).toEqual([["只发送一次"]]));
    sink.close?.();
    sink.close?.();
    await expect(speaking).resolves.toBeUndefined();
    expect(sockets).toHaveLength(1);
    expect(sockets[0].sent.filter((value) => JSON.parse(value).type === "speak")).toHaveLength(1);
  });

  it.each(["stop", "close"] as const)("socket CONNECTING 时 %s 立即取消，迟到 open 不发送旧 segments", async (action) => {
    const sink = createBrowserTtsSink("ws://test/tts");
    const first = sink.speak(["连接中的旧轮"]);
    const oldSocket = sockets[0];

    if (action === "stop") sink.stop();
    else sink.close?.();

    await expectSettled(first);
    expect(oldSocket.closeCalls.length).toBeGreaterThan(0);

    const second = sink.speak(["新的有效轮次"]);
    expect(sockets).toHaveLength(2);
    oldSocket.open();
    await Promise.resolve();
    expect(sentSpeakSegments(oldSocket)).toEqual([]);

    sockets[1].open();
    await vi.waitFor(() => expect(sentSpeakSegments(sockets[1])).toEqual([["新的有效轮次"]]));
    sockets[1].message(JSON.stringify({ type: "tts.done" }));
    await second;
    expect(sentSpeakSegments(sockets[1])).toEqual([["新的有效轮次"]]);
  });

  it.each(["stop", "close"] as const)("AudioContext resume 等待时 %s 立即取消，旧 continuation 不影响新轮", async (action) => {
    nextAudioContextSuspended = true;
    nextAudioContextResumeBlocked = true;
    const sink = createBrowserTtsSink("ws://test/tts");
    const first = sink.speak(["等待 resume 的旧轮"]);
    const oldSocket = sockets[0];
    oldSocket.open();
    await vi.waitFor(() => expect(audioContexts).toHaveLength(1));
    const oldContext = audioContexts[0];
    await vi.waitFor(() => expect(oldContext.resumeCalls).toBeGreaterThan(0));

    if (action === "stop") sink.stop();
    else sink.close?.();

    await expectSettled(first);
    expect(sentSpeakSegments(oldSocket)).toEqual([]);

    if (action === "stop") oldContext.blockResume = false;
    const second = sink.speak(["resume 后的新轮"]);
    const newSocket = action === "stop" ? oldSocket : sockets[1];
    if (action === "close") newSocket.open();
    await Promise.resolve();
    await Promise.resolve();

    oldContext.releaseBlockedResumes();
    await Promise.resolve();
    await Promise.resolve();
    expect(sentSpeakSegments(oldSocket)).not.toContainEqual(["等待 resume 的旧轮"]);
    expect(sentSpeakSegments(newSocket)).toEqual([["resume 后的新轮"]]);

    newSocket.message(JSON.stringify({ type: "tts.done" }));
    await second;
  });

  it.each([
    { event: "close" as const, expected: { name: "TtsPlaybackInterruptedError", code: 1011 } },
    { event: "error" as const, expected: { name: "TtsPlaybackInterruptedError" } },
  ])("warm socket $event 在下一轮 resume pending 时中断当前 speak", async ({ event, expected }) => {
    const sink = createBrowserTtsSink("ws://test/tts");
    const first = sink.speak(["建立 warm socket"]);
    const warmSocket = sockets[0];
    warmSocket.open();
    await vi.waitFor(() => expect(sentSpeakSegments(warmSocket)).toEqual([["建立 warm socket"]]));
    warmSocket.message(JSON.stringify({ type: "tts.done" }));
    await first;

    const context = audioContexts[0];
    context.state = "suspended";
    context.blockResume = true;
    const resumeCallsBefore = context.resumeCalls;
    const second = sink.speak(["resume pending 的第二轮"]);
    await vi.waitFor(() => expect(context.resumeCalls).toBeGreaterThan(resumeCallsBefore));

    if (event === "close") warmSocket.close(1011, "remote interrupted");
    else warmSocket.error();

    await expectInterrupted(second, expected);
    context.releaseBlockedResumes();
    await Promise.resolve();
    await Promise.resolve();
    expect(sentSpeakSegments(warmSocket)).toEqual([["建立 warm socket"]]);

    const third = sink.speak(["故障后的新轮"]);
    expect(sockets).toHaveLength(2);
    sockets[1].open();
    await vi.waitFor(() => expect(sentSpeakSegments(sockets[1])).toEqual([["故障后的新轮"]]));
    sockets[1].message(JSON.stringify({ type: "tts.done" }));
    await third;
  });

  it("复用传入的播放 AudioContext，不再 new", async () => {
    const playbackCtx = new AudioContext();
    expect(audioContexts).toHaveLength(1);
    const sink = createBrowserTtsSink("ws://test/tts", "voice", playbackCtx);
    const speaking = sink.speak(["复用上下文"]);
    sockets[0].open();
    await vi.waitFor(() => expect(sentSpeakSegments(sockets[0])).toEqual([["复用上下文"]]));
    expect(audioContexts).toHaveLength(1);
    sockets[0].message(JSON.stringify({ type: "tts.done" }));
    await speaking;
  });

  it("speak 时上下文仍非 running 则失败并提示再点一次", async () => {
    nextAudioContextSuspended = true;
    nextAudioContextResumeRejects = true;
    const sink = createBrowserTtsSink("ws://test/tts");
    const speaking = sink.speak(["听不到"]);
    sockets[0].open();
    await expect(speaking).rejects.toMatchObject({
      name: "TtsPlaybackInterruptedError",
      message: TTS_AUTOPLAY_BLOCKED_MESSAGE,
    });
    expect(sentSpeakSegments(sockets[0])).toEqual([]);
  });

  it("tts.done 但播放上下文仍挂起，不得当成播完", async () => {
    const sink = createBrowserTtsSink("ws://test/tts");
    const speaking = sink.speak(["挂起时钟"]);
    sockets[0].open();
    await vi.waitFor(() => expect(sentSpeakSegments(sockets[0])).toEqual([["挂起时钟"]]));
    audioContexts[0].state = "suspended";
    sockets[0].message(JSON.stringify({ type: "tts.done" }));
    await expect(speaking).rejects.toMatchObject({
      name: "TtsPlaybackInterruptedError",
      message: TTS_AUTOPLAY_BLOCKED_MESSAGE,
    });
  });
});
