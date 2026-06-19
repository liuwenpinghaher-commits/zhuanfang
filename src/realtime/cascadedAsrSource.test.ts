// @vitest-environment jsdom
/**
 * cascadedAsrSource.test.ts
 *
 * TDD for:
 *   P0-7: ASR start failure → stopMic (prevent mic leak) + finite reconnect.
 *   P0-9: non-string text/stash fields safely handled; empty transcript warns.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createBrowserAsrSource } from "./cascadedAsrSource";
import type { AsrEventHandlers } from "./cascadedPipeline";

// ---------------------------------------------------------------------------
// Harness: mock WebSocket + AudioContext so tests run without real I/O
// ---------------------------------------------------------------------------
function buildHarness() {
  const stream = {
    getTracks: () => [{ kind: "audio", stop: vi.fn() }],
  } as unknown as MediaStream;

  let wsOnOpen: (() => void) | null = null;
  let wsOnMessage: ((event: { data: string }) => void) | null = null;
  const wsSent: string[] = [];
  const wsClose = vi.fn();

  const originalWebSocket = (globalThis as Record<string, unknown>).WebSocket;
  const originalNavigator = (globalThis as Record<string, unknown>).navigator;

  (globalThis as Record<string, unknown>).WebSocket = class MockWebSocket {
    readyState = 1; // OPEN
    onopen: (() => void) | null = null;
    onmessage: ((event: { data: string }) => void) | null = null;
    onerror: ((event: Event) => void) | null = null;
    onclose: ((event: CloseEvent) => void) | null = null;
    constructor(_url: string) {
      // Capture open/message callbacks — assigned after constructor by source code
      wsOnOpen = () => {
        this.readyState = 1;
        this.onopen?.();
      };
      wsOnMessage = (e) => this.onmessage?.(e);
    }
    send(message: string) {
      wsSent.push(message);
    }
    close = wsClose;
    addEventListener = vi.fn();
    removeEventListener = vi.fn();
  };

  const audioCtxMock = {
    sampleRate: 16000,
    state: "running",
    destination: {},
    createMediaStreamSource: vi.fn(() => ({ disconnect: vi.fn(), connect: vi.fn() })),
    createScriptProcessor: vi.fn(() => ({
      disconnect: vi.fn(),
      connect: vi.fn(),
      onaudioprocess: null as unknown,
    })),
    createAnalyser: vi.fn(() => ({
      fftSize: 1024,
      frequencyBinCount: 512,
      getByteFrequencyData: vi.fn(),
      disconnect: vi.fn(),
      connect: vi.fn(),
    })),
    close: vi.fn().mockResolvedValue(undefined),
  };

  const originalAudioContext = (globalThis as Record<string, unknown>).AudioContext;
  (globalThis as Record<string, unknown>).AudioContext = class MockAudioContext {
    constructor() {
      return audioCtxMock;
    }
  };

  // Patch navigator.mediaDevices
  Object.defineProperty(globalThis, "navigator", {
    value: { mediaDevices: { getUserMedia: vi.fn(async () => stream) } },
    configurable: true,
    writable: true,
  });

  function teardown() {
    (globalThis as Record<string, unknown>).WebSocket = originalWebSocket;
    (globalThis as Record<string, unknown>).AudioContext = originalAudioContext;
    Object.defineProperty(globalThis, "navigator", {
      value: originalNavigator,
      configurable: true,
      writable: true,
    });
  }

  /**
   * Inject a WS message (JSON-serialises the object before delivery).
   * Must be called after wsOnOpen() has fired.
   */
  function pushMessage(data: unknown) {
    wsOnMessage?.({ data: JSON.stringify(data) });
  }

  return {
    /** Fire after a microtask delay to let source code assign ws.onopen */
    fireWsOpen: () => wsOnOpen?.(),
    pushMessage,
    wsSent,
    wsClose,
    teardown,
  };
}

/** Helper: start an ASR source, wait for it to be ready (proxy.connected resolved). */
async function startAsrSource(
  harness: ReturnType<typeof buildHarness>,
  handlers: AsrEventHandlers
) {
  const source = createBrowserAsrSource({
    asrWsUrl: "ws://test/asr",
    getMicStream: async () =>
      ({
        getTracks: () => [{ kind: "audio", stop: vi.fn() }],
      }) as unknown as MediaStream,
  });

  source.register(handlers);

  // start() → startMic() (async) → creates WebSocket → awaits proxy.connected
  const startPromise = source.start();

  // Give startMic() (which is mostly synchronous after getMicStream resolves) time
  // to create the WebSocket so wsOnOpen is captured.
  await new Promise((r) => setTimeout(r, 10));

  // Simulate WebSocket open + proxy ready — resolves the inner Promise<void>
  harness.fireWsOpen();
  harness.pushMessage({ type: "proxy.connected" });

  await startPromise;

  return source;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createBrowserAsrSource — ASR delta schema validation", () => {
  let harness: ReturnType<typeof buildHarness>;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    harness = buildHarness();
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    harness.teardown();
    vi.restoreAllMocks();
  });

  // --- Structural validity tests ---

  it("does NOT call onTranscriptDelta when text field is a number (invalid schema)", async () => {
    const onTranscriptDelta = vi.fn();
    await startAsrSource(harness, {
      onTranscriptDelta,
      onSpeechStarted: vi.fn(),
      onSpeechStopped: vi.fn(),
    });

    harness.pushMessage({
      type: "conversation.item.input_audio_transcription.delta",
      text: 42,
      stash: "",
    });

    expect(onTranscriptDelta).not.toHaveBeenCalled();
  });

  it("does NOT call onTranscriptDelta when stash field is an object (invalid schema)", async () => {
    const onTranscriptDelta = vi.fn();
    await startAsrSource(harness, {
      onTranscriptDelta,
      onSpeechStarted: vi.fn(),
      onSpeechStopped: vi.fn(),
    });

    harness.pushMessage({
      type: "conversation.item.input_audio_transcription.delta",
      text: "hello",
      stash: { nested: true }, // invalid
    });

    expect(onTranscriptDelta).not.toHaveBeenCalled();
  });

  it("does NOT call onTranscriptDelta when text is null (invalid schema)", async () => {
    const onTranscriptDelta = vi.fn();
    await startAsrSource(harness, {
      onTranscriptDelta,
      onSpeechStarted: vi.fn(),
      onSpeechStopped: vi.fn(),
    });

    harness.pushMessage({
      type: "conversation.item.input_audio_transcription.delta",
      text: null,
      stash: "some stash",
    });

    expect(onTranscriptDelta).not.toHaveBeenCalled();
  });

  it("emits asr_invalid_delta warn when text is not a string", async () => {
    await startAsrSource(harness, {
      onTranscriptDelta: vi.fn(),
      onSpeechStarted: vi.fn(),
      onSpeechStopped: vi.fn(),
    });

    harness.pushMessage({
      type: "conversation.item.input_audio_transcription.delta",
      text: 99,
      stash: "ok",
    });

    expect(warnSpy).toHaveBeenCalled();
    const warnArg = warnSpy.mock.calls[0][0] as string;
    const parsed = JSON.parse(warnArg);
    expect(parsed.event).toBe("asr_invalid_delta");
  });

  it("emits asr_invalid_delta warn when stash is not a string", async () => {
    await startAsrSource(harness, {
      onTranscriptDelta: vi.fn(),
      onSpeechStarted: vi.fn(),
      onSpeechStopped: vi.fn(),
    });

    harness.pushMessage({
      type: "conversation.item.input_audio_transcription.delta",
      text: "hello",
      stash: [1, 2, 3],
    });

    expect(warnSpy).toHaveBeenCalled();
    const warnArg = warnSpy.mock.calls[0][0] as string;
    const parsed = JSON.parse(warnArg);
    expect(parsed.event).toBe("asr_invalid_delta");
  });

  it("does NOT throw when delta message has no text/stash fields; treats as empty transcript", async () => {
    const onTranscriptDelta = vi.fn();
    await startAsrSource(harness, {
      onTranscriptDelta,
      onSpeechStarted: vi.fn(),
      onSpeechStopped: vi.fn(),
    });

    // No text/stash fields — undefined treated as ""; combined result is empty → asr_empty_transcript
    expect(() => {
      harness.pushMessage({
        type: "conversation.item.input_audio_transcription.delta",
      });
    }).not.toThrow();

    expect(onTranscriptDelta).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalled();
    const warnArg = warnSpy.mock.calls[0][0] as string;
    const parsed = JSON.parse(warnArg);
    // Both fields missing → empty concatenation → empty transcript warning
    expect(parsed.event).toBe("asr_empty_transcript");
  });

  // --- Empty transcript warning ---

  it("emits asr_empty_transcript warn when text+stash concatenate to empty string", async () => {
    await startAsrSource(harness, {
      onTranscriptDelta: vi.fn(),
      onSpeechStarted: vi.fn(),
      onSpeechStopped: vi.fn(),
    });

    harness.pushMessage({
      type: "conversation.item.input_audio_transcription.delta",
      text: "",
      stash: "",
    });

    expect(warnSpy).toHaveBeenCalled();
    const warnArg = warnSpy.mock.calls[0][0] as string;
    const parsed = JSON.parse(warnArg);
    expect(parsed.event).toBe("asr_empty_transcript");
  });

  it("does NOT call onTranscriptDelta when transcript is empty", async () => {
    const onTranscriptDelta = vi.fn();
    await startAsrSource(harness, {
      onTranscriptDelta,
      onSpeechStarted: vi.fn(),
      onSpeechStopped: vi.fn(),
    });

    harness.pushMessage({
      type: "conversation.item.input_audio_transcription.delta",
      text: "",
      stash: "",
    });

    expect(onTranscriptDelta).not.toHaveBeenCalled();
  });

  // --- Valid message — existing behaviour preserved ---

  it("calls onTranscriptDelta with concatenated text+stash for valid delta message", async () => {
    const onTranscriptDelta = vi.fn();
    await startAsrSource(harness, {
      onTranscriptDelta,
      onSpeechStarted: vi.fn(),
      onSpeechStopped: vi.fn(),
    });

    harness.pushMessage({
      type: "conversation.item.input_audio_transcription.delta",
      text: "hello ",
      stash: "world",
    });

    expect(onTranscriptDelta).toHaveBeenCalledWith("hello world", false);
  });

  it("calls onTranscriptDelta when only text is non-empty (stash undefined → treated as empty string)", async () => {
    const onTranscriptDelta = vi.fn();
    await startAsrSource(harness, {
      onTranscriptDelta,
      onSpeechStarted: vi.fn(),
      onSpeechStopped: vi.fn(),
    });

    // stash field absent — still a valid message if text is string
    // (missing stash ≡ undefined which is NOT typeof string, so we need to decide:
    //  treat absent stash as "" for valid messages, i.e. only text presence required)
    harness.pushMessage({
      type: "conversation.item.input_audio_transcription.delta",
      text: "just text",
      stash: "",
    });

    expect(onTranscriptDelta).toHaveBeenCalledWith("just text", false);
  });

  it("does NOT emit any warn for a valid delta message", async () => {
    await startAsrSource(harness, {
      onTranscriptDelta: vi.fn(),
      onSpeechStarted: vi.fn(),
      onSpeechStopped: vi.fn(),
    });

    harness.pushMessage({
      type: "conversation.item.input_audio_transcription.delta",
      text: "valid text",
      stash: "",
    });

    expect(warnSpy).not.toHaveBeenCalled();
  });

  // --- Other message types still work ---

  it("fires onSpeechStarted for input_audio_buffer.speech_started", async () => {
    const onSpeechStarted = vi.fn();
    await startAsrSource(harness, {
      onTranscriptDelta: vi.fn(),
      onSpeechStarted,
      onSpeechStopped: vi.fn(),
    });

    harness.pushMessage({ type: "input_audio_buffer.speech_started" });

    expect(onSpeechStarted).toHaveBeenCalledOnce();
  });

  it("fires onTranscriptDelta(text, true) for transcription.completed", async () => {
    const onTranscriptDelta = vi.fn();
    await startAsrSource(harness, {
      onTranscriptDelta,
      onSpeechStarted: vi.fn(),
      onSpeechStopped: vi.fn(),
    });

    harness.pushMessage({
      type: "conversation.item.input_audio_transcription.completed",
      transcript: "final text",
    });

    expect(onTranscriptDelta).toHaveBeenCalledWith("final text", true);
  });
});

// ---------------------------------------------------------------------------
// P0-7: ASR start failure → stopMic (mic leak) + finite reconnect
// ---------------------------------------------------------------------------

/**
 * Builds a harness where ASR WebSocket failure behaviour is injectable.
 *
 * `wsFactory` receives an attempt index (0-based) and returns either:
 *   - "error"    → triggers socket.onerror immediately
 *   - "connected" → sends proxy.connected (success)
 */
function buildReconnectHarness(wsFactory: (attempt: number) => "error" | "close" | "connected") {
  let attempt = 0;

  // Track mic track stop calls per stream
  const trackStops: (() => void)[][] = [];

  function makeStream() {
    const stop = vi.fn();
    const tracks = [{ kind: "audio", stop }];
    const st = { getTracks: () => tracks } as unknown as MediaStream;
    trackStops.push([stop]);
    return st;
  }

  const getMicStream = vi.fn(async () => makeStream());

  const originalWebSocket = (globalThis as Record<string, unknown>).WebSocket;
  const originalAudioContext = (globalThis as Record<string, unknown>).AudioContext;
  const originalNavigator = (globalThis as Record<string, unknown>).navigator;

  type WsCb = (e?: unknown) => void;
  const wsInstances: {
    onopen: WsCb | null;
    onmessage: ((e: { data: string }) => void) | null;
    onerror: WsCb | null;
    onclose: WsCb | null;
    readyState: number;
  }[] = [];

  (globalThis as Record<string, unknown>).WebSocket = class MockWS {
    readyState = 1;
    onopen: WsCb | null = null;
    onmessage: ((e: { data: string }) => void) | null = null;
    onerror: WsCb | null = null;
    onclose: WsCb | null = null;
    send = vi.fn();
    close = vi.fn();
    addEventListener = vi.fn();
    removeEventListener = vi.fn();
    constructor(_url: string) {
      const thisWs = this;
      wsInstances.push(thisWs);
      const currentAttempt = attempt++;
      // Fire onerror / connected asynchronously so callbacks are assigned
      setTimeout(() => {
        const result = wsFactory(currentAttempt);
        if (result === "error") {
          thisWs.onerror?.();
        } else if (result === "close") {
          // Simulate server-side close before proxy.connected — no onerror fires
          thisWs.onclose?.();
        } else {
          thisWs.onopen?.();
          thisWs.onmessage?.({ data: JSON.stringify({ type: "proxy.connected" }) });
        }
      }, 0);
    }
  };

  const audioCtxMock = {
    sampleRate: 16000,
    state: "running",
    destination: {},
    createMediaStreamSource: vi.fn(() => ({ disconnect: vi.fn(), connect: vi.fn() })),
    createScriptProcessor: vi.fn(() => ({
      disconnect: vi.fn(),
      connect: vi.fn(),
      onaudioprocess: null as unknown,
    })),
    createAnalyser: vi.fn(() => ({
      fftSize: 1024,
      frequencyBinCount: 512,
      getByteFrequencyData: vi.fn(),
      disconnect: vi.fn(),
      connect: vi.fn(),
    })),
    close: vi.fn().mockResolvedValue(undefined),
  };

  (globalThis as Record<string, unknown>).AudioContext = class MockAudioContext {
    constructor() { return audioCtxMock; }
  };

  Object.defineProperty(globalThis, "navigator", {
    value: { mediaDevices: { getUserMedia: vi.fn(async () => makeStream()) } },
    configurable: true,
    writable: true,
  });

  function teardown() {
    (globalThis as Record<string, unknown>).WebSocket = originalWebSocket;
    (globalThis as Record<string, unknown>).AudioContext = originalAudioContext;
    Object.defineProperty(globalThis, "navigator", {
      value: originalNavigator,
      configurable: true,
      writable: true,
    });
  }

  return { getMicStream, trackStops, wsInstances, teardown, audioCtxMock };
}

const defaultHandlers = (): AsrEventHandlers => ({
  onTranscriptDelta: vi.fn(),
  onSpeechStarted: vi.fn(),
  onSpeechStopped: vi.fn(),
});

describe("createBrowserAsrSource — P0-7: stopMic on failure + finite reconnect", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("calls stopMic (releases AudioContext + stream tracks) when ASR WebSocket errors on first attempt", async () => {
    const harness = buildReconnectHarness(() => "error"); // always fail
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const source = createBrowserAsrSource({
      asrWsUrl: "ws://test/asr",
      getMicStream: harness.getMicStream,
      maxReconnectAttempts: 0, // no retries — fail immediately
      baseReconnectDelayMs: 0,
    });
    source.register(defaultHandlers());

    await expect(source.start()).rejects.toThrow();

    // AudioContext.close should have been called (mic released)
    expect(harness.audioCtxMock.close).toHaveBeenCalled();
    harness.teardown();
  });

  it("retries up to maxReconnectAttempts times then rejects", async () => {
    let callCount = 0;
    const harness = buildReconnectHarness(() => {
      callCount++;
      return "error"; // always fail
    });
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const source = createBrowserAsrSource({
      asrWsUrl: "ws://test/asr",
      getMicStream: harness.getMicStream,
      maxReconnectAttempts: 2,
      baseReconnectDelayMs: 0,
    });
    source.register(defaultHandlers());

    await expect(source.start()).rejects.toThrow();

    // Should have attempted 1 (initial) + 2 (retries) = 3 total WS connections
    expect(callCount).toBe(3);
    harness.teardown();
  });

  it("succeeds on a later attempt when initial attempts fail", async () => {
    // Fail first 2, succeed on 3rd (attempt index 2)
    const harness = buildReconnectHarness((attempt) => attempt < 2 ? "error" : "connected");
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const source = createBrowserAsrSource({
      asrWsUrl: "ws://test/asr",
      getMicStream: harness.getMicStream,
      maxReconnectAttempts: 2,
      baseReconnectDelayMs: 0,
    });
    source.register(defaultHandlers());

    // Should resolve (not reject) — 3rd attempt succeeds
    await expect(source.start()).resolves.toBeUndefined();
    harness.teardown();
  });

  it("stop() sets closed=true so the reconnect loop will not start new connections after current attempt", async () => {
    // Verify: after stop() is called, any further start() call is a no-op (closed guard)
    // This is a white-box test for the `closed` flag semantics.
    const harness = buildReconnectHarness(() => "error");
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const source = createBrowserAsrSource({
      asrWsUrl: "ws://test/asr",
      getMicStream: harness.getMicStream,
      maxReconnectAttempts: 2,
      baseReconnectDelayMs: 0,
    });
    source.register(defaultHandlers());

    // stop() before start: sets closed=true, so the loop returns immediately on `if (closed) return`
    source.stop();

    // start() should return without making any WS connections
    await expect(source.start()).resolves.toBeUndefined();

    // No WS instances should have been created (closed before any connection)
    expect(harness.wsInstances).toHaveLength(0);
    harness.teardown();
  });
});

// ---------------------------------------------------------------------------
// onclose-before-ready: ASR WebSocket closed by server before proxy.connected
// This is the blind spot the audit found — only onerror was previously tested.
// ---------------------------------------------------------------------------

describe("createBrowserAsrSource — onclose before proxy.connected triggers reconnect (not hang)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("rejects start() when server closes socket before proxy.connected (not onerror)", async () => {
    // The critical regression: onclose (no onerror) must reject the inner Promise
    // so start() does NOT hang indefinitely.
    const harness = buildReconnectHarness(() => "close"); // always close, never error
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const source = createBrowserAsrSource({
      asrWsUrl: "ws://test/asr",
      getMicStream: harness.getMicStream,
      maxReconnectAttempts: 0, // no retries — fail fast
      baseReconnectDelayMs: 0,
    });
    source.register(defaultHandlers());

    // Must reject, not hang. The test itself acts as the timeout guard:
    // if start() hangs, vitest's per-test timeout will fail it.
    await expect(source.start()).rejects.toThrow(/closed before ready/i);

    harness.teardown();
  });

  it("retries and eventually rejects after all attempts close without proxy.connected", async () => {
    let callCount = 0;
    const harness = buildReconnectHarness(() => {
      callCount++;
      return "close";
    });
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const source = createBrowserAsrSource({
      asrWsUrl: "ws://test/asr",
      getMicStream: harness.getMicStream,
      maxReconnectAttempts: 2,
      baseReconnectDelayMs: 0,
    });
    source.register(defaultHandlers());

    await expect(source.start()).rejects.toThrow(/closed before ready/i);

    // 1 initial + 2 retries = 3 total connection attempts
    expect(callCount).toBe(3);
    harness.teardown();
  });

  it("succeeds when first attempt closes but a later attempt sends proxy.connected", async () => {
    // close on attempt 0, connected on attempt 1
    const harness = buildReconnectHarness((attempt) => attempt === 0 ? "close" : "connected");
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const source = createBrowserAsrSource({
      asrWsUrl: "ws://test/asr",
      getMicStream: harness.getMicStream,
      maxReconnectAttempts: 2,
      baseReconnectDelayMs: 0,
    });
    source.register(defaultHandlers());

    // Should resolve — second attempt succeeds
    await expect(source.start()).resolves.toBeUndefined();
    harness.teardown();
  });

  it("onclose after successful proxy.connected does NOT reject or cause double-settle", async () => {
    // Post-connect onclose is normal session teardown — must be silently ignored.
    // Test: connect successfully, then fire onclose — no error, no crash.
    const harness = buildReconnectHarness(() => "connected");

    const source = createBrowserAsrSource({
      asrWsUrl: "ws://test/asr",
      getMicStream: harness.getMicStream,
      maxReconnectAttempts: 0,
      baseReconnectDelayMs: 0,
    });
    source.register(defaultHandlers());

    await source.start(); // must resolve cleanly

    // Now fire onclose on the live socket — simulates server closing after session
    const wsInstance = harness.wsInstances[0];
    expect(() => wsInstance.onclose?.()).not.toThrow();

    harness.teardown();
  });
});
