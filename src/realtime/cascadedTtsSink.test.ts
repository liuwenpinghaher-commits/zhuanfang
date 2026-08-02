// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createBrowserTtsSink } from "./cascadedTtsSink";

interface MockTtsSocket {
  sent: string[];
  open(): void;
  message(data: string | ArrayBuffer): void;
  close(code?: number, reason?: string): void;
  error(): void;
}

let sockets: MockTtsSocket[] = [];
let restoreWebSocket: (() => void) | null = null;
let restoreAudioContext: (() => void) | null = null;

beforeEach(() => {
  sockets = [];
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
      this.readyState = TestWebSocket.CLOSED;
      this.onclose?.({ code, reason } as CloseEvent);
    }

    error() {
      this.onerror?.();
    }
  }

  const audioContext = {
    state: "running",
    currentTime: 0,
    destination: {},
    resume: async () => undefined,
    close: async () => undefined,
    createBuffer: () => ({ getChannelData: () => new Float32Array(), duration: 0 }),
    createBufferSource: () => ({ connect: () => undefined, start: () => undefined, stop: () => undefined }),
  };

  globalThis.WebSocket = TestWebSocket as unknown as typeof WebSocket;
  globalThis.AudioContext = class { constructor() { return audioContext; } } as unknown as typeof AudioContext;
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
    await Promise.resolve();
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

  it("close 幂等且不会重播 active segments", async () => {
    const sink = createBrowserTtsSink("ws://test/tts");
    const speaking = sink.speak(["只发送一次"]);
    sockets[0].open();
    await Promise.resolve();
    sink.close?.();
    sink.close?.();
    await expect(speaking).resolves.toBeUndefined();
    expect(sockets).toHaveLength(1);
    expect(sockets[0].sent.filter((value) => JSON.parse(value).type === "speak")).toHaveLength(1);
  });
});
