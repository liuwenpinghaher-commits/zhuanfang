/**
 * Bailian CosyVoice streaming TTS client over WebSocket duplex protocol.
 *
 * Protocol (verified live via scripts/spike-cascaded.mjs):
 *   1. Connect wss://dashscope.aliyuncs.com/api-ws/v1/inference, Authorization: Bearer <key>
 *   2. Send run-task (with model/voice/format parameters)
 *   3. Wait for JSON event {header:{event:"task-started"}}
 *   4. Send continue-task per text segment
 *   5. Send finish-task
 *   6. Receive binary frames (audio chunks) + JSON result-generated events
 *   7. Receive {header:{event:"task-finished"}} → done
 */

import WebSocket from "ws";
import { randomUUID } from "node:crypto";
import { BAILIAN_PODCAST_TTS_MODEL, BAILIAN_PODCAST_TTS_VOICE } from "./bailian";

const BAILIAN_WS_TTS_URL = "wss://dashscope.aliyuncs.com/api-ws/v1/inference";

// ── Timeouts (P1-09) ──────────────────────────────────────────────────────────
// A half-dead DashScope WS (socket open but never emitting task-started / audio)
// would otherwise hang the turn forever. Two independent guards:
//   • connect/first-progress: must see task-started (or any audio) within this window
//   • overall: the whole synthesis must finish within this window regardless
export const STREAMING_TTS_CONNECT_TIMEOUT_MS = 10_000;
export const STREAMING_TTS_OVERALL_TIMEOUT_MS = 60_000;

/**
 * Sample rate (Hz) of the raw PCM the cascade TTS streams. The browser sink
 * (cascadedTtsSink) builds 16-bit PCM AudioBuffers at exactly this rate, so the
 * two MUST agree. The proxy announces it to the browser in the tts.start frame.
 */
export const STREAMING_TTS_SAMPLE_RATE = 24000;

// ── Public interface ──────────────────────────────────────────────────────────

export interface BailianStreamingTtsClient {
  /** Stream synthesis of one or more text segments; onAudio fires per binary chunk. */
  synthesizeStream(
    input: { segments: string[]; voice?: string },
    handlers: {
      onAudio: (chunk: ArrayBuffer | Buffer) => void;
      onComplete: () => void;
      onError?: (e: Error) => void;
    },
    signal?: AbortSignal
  ): Promise<void>;
}

export interface BailianStreamingTtsOptions {
  apiKey: string;
  model?: string;
  voice?: string;
  wsUrl?: string;
  /** Injectable WebSocket factory — used in tests to provide a mock WS. */
  wsFactory?: (url: string, opts: { headers: Record<string, string> }) => WsLike;
  /**
   * Connect / first-progress timeout (ms). If neither task-started nor any audio
   * chunk arrives within this window, the stream fails with "TTS timeout".
   * Defaults to STREAMING_TTS_CONNECT_TIMEOUT_MS. Injectable for tests.
   */
  connectTimeoutMs?: number;
  /**
   * Overall timeout (ms) for the whole synthesis. Defaults to
   * STREAMING_TTS_OVERALL_TIMEOUT_MS. Injectable for tests.
   */
  overallTimeoutMs?: number;
}

// ── Internal WS duck-type ─────────────────────────────────────────────────────

export interface WsLike {
  on(event: "open", handler: () => void): this;
  on(event: "message", handler: (data: Buffer | string, isBinary: boolean) => void): this;
  on(event: "error", handler: (err: Error) => void): this;
  on(event: "close", handler: (code: number, reason: string) => void): this;
  send(data: string): void;
  close(): void;
}

// ── Factory ───────────────────────────────────────────────────────────────────

export function createBailianStreamingTtsClient(
  options: BailianStreamingTtsOptions
): BailianStreamingTtsClient {
  const {
    apiKey,
    model = BAILIAN_PODCAST_TTS_MODEL,
    voice: defaultVoice = BAILIAN_PODCAST_TTS_VOICE,
    wsUrl = BAILIAN_WS_TTS_URL,
    wsFactory,
    connectTimeoutMs = STREAMING_TTS_CONNECT_TIMEOUT_MS,
    overallTimeoutMs = STREAMING_TTS_OVERALL_TIMEOUT_MS
  } = options;

  const createWs: (url: string, opts: { headers: Record<string, string> }) => WsLike =
    wsFactory ??
    ((url, opts) => new WebSocket(url, opts) as unknown as WsLike);

  return {
    synthesizeStream(input, handlers, signal) {
      return synthesizeStream({ input, handlers, signal, apiKey, model, defaultVoice, wsUrl, createWs, connectTimeoutMs, overallTimeoutMs });
    }
  };
}

// ── Core implementation ───────────────────────────────────────────────────────

interface SynthesizeStreamParams {
  input: { segments: string[]; voice?: string };
  handlers: {
    onAudio: (chunk: ArrayBuffer | Buffer) => void;
    onComplete: () => void;
    onError?: (e: Error) => void;
  };
  signal?: AbortSignal;
  apiKey: string;
  model: string;
  defaultVoice: string;
  wsUrl: string;
  createWs: (url: string, opts: { headers: Record<string, string> }) => WsLike;
  connectTimeoutMs: number;
  overallTimeoutMs: number;
}

function synthesizeStream(params: SynthesizeStreamParams): Promise<void> {
  const { input, handlers, signal, apiKey, model, defaultVoice, wsUrl, createWs, connectTimeoutMs, overallTimeoutMs } = params;
  const { segments, voice = defaultVoice } = input;
  const { onAudio, onComplete, onError } = handlers;

  return new Promise<void>((resolve, reject) => {
    let settled = false;
    let aborted = false;

    // P1-09: connect/first-progress + overall timers. Cleared in finish() so a
    // settled stream never fires a late timeout. The connect timer is also cleared
    // the moment we see real progress (task-started or first audio chunk).
    let connectTimer: ReturnType<typeof setTimeout> | undefined;
    let overallTimer: ReturnType<typeof setTimeout> | undefined;

    function clearConnectTimer() {
      if (connectTimer !== undefined) {
        clearTimeout(connectTimer);
        connectTimer = undefined;
      }
    }

    function clearTimers() {
      clearConnectTimer();
      if (overallTimer !== undefined) {
        clearTimeout(overallTimer);
        overallTimer = undefined;
      }
    }

    function finish(err?: Error) {
      if (settled) return;
      settled = true;
      clearTimers();
      if (err) {
        onError?.(err);
        reject(err);
      } else {
        onComplete();
        resolve();
      }
    }

    /** Fail with a timeout and close the socket (idempotent via finish()'s guard). */
    function failTimeout() {
      if (settled || aborted) return;
      // Settle with the timeout error FIRST so it wins the race: ws.close() may
      // synchronously fire onClose → finish("WebSocket closed unexpectedly"),
      // which must then be a no-op (settled already true).
      finish(new Error("TTS timeout"));
      try {
        ws.close();
      } catch {
        // ignore close errors during timeout teardown
      }
    }

    const taskId = randomUUID();

    const ws = createWs(wsUrl, {
      headers: { Authorization: `Bearer ${apiKey}` }
    });

    // Arm both timers up front. If the socket never opens / never streams, these
    // are the only things that can still settle the promise.
    connectTimer = setTimeout(failTimeout, connectTimeoutMs);
    overallTimer = setTimeout(failTimeout, overallTimeoutMs);

    function sendJson(obj: unknown) {
      if (!settled && !aborted) {
        ws.send(JSON.stringify(obj));
      }
    }

    function sendRunTask() {
      sendJson({
        header: {
          action: "run-task",
          task_id: taskId,
          streaming: "duplex"
        },
        payload: {
          task_group: "audio",
          task: "tts",
          function: "SpeechSynthesizer",
          model,
          parameters: {
            text_type: "PlainText",
            voice,
            // PCM (raw s16le) not MP3: the cascade browser sink plays chunks with
            // sample-accurate Web Audio scheduling. MP3 stream fragments don't fall on
            // frame boundaries, so per-chunk decodeAudioData drops many chunks → choppy
            // audio. Raw PCM concatenates seamlessly. (Spike: scripts/spike-tts-pcm.)
            format: "pcm",
            sample_rate: STREAMING_TTS_SAMPLE_RATE
          },
          input: {}
        }
      });
    }

    function sendContinueTasks() {
      for (const text of segments) {
        sendJson({
          header: {
            action: "continue-task",
            task_id: taskId,
            streaming: "duplex"
          },
          payload: { input: { text } }
        });
      }
    }

    function sendFinishTask() {
      ws.send(
        JSON.stringify({
          header: {
            action: "finish-task",
            task_id: taskId,
            streaming: "duplex"
          },
          payload: { input: {} }
        })
      );
    }

    function handleAbort() {
      if (settled || aborted) return;
      aborted = true;
      try {
        sendFinishTask();
        ws.close();
      } catch {
        // ignore send/close errors during abort
      }
      // Resolve (not reject) on clean abort — caller used the signal deliberately
      finish();
    }

    // Register abort handler before opening WS
    if (signal) {
      if (signal.aborted) {
        // Already aborted before we even started
        handleAbort();
        return;
      }
      signal.addEventListener("abort", handleAbort, { once: true });
    }

    ws.on("open", () => {
      if (aborted || settled) return;
      sendRunTask();
    });

    ws.on("message", (data: Buffer | string, isBinary: boolean) => {
      if (settled && !aborted) return;
      if (aborted) return; // Ignore messages after abort

      // Binary frame = audio chunk
      if (isBinary || (Buffer.isBuffer(data) && !isJsonBuffer(data))) {
        if (!settled) {
          // Real audio is progress — the connect/first-progress window is satisfied.
          clearConnectTimer();
          onAudio(data as Buffer);
        }
        return;
      }

      // JSON control frame
      let msg: { header?: { event?: string; error_message?: string } };
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }

      const event = msg?.header?.event;

      if (event === "task-started") {
        // task-started is progress — the connect/first-progress window is satisfied.
        // The overall timer still guards the rest of the synthesis.
        clearConnectTimer();
        // Send all segments then finish-task
        sendContinueTasks();
        if (!aborted) {
          sendFinishTask();
        }
        return;
      }

      if (event === "task-finished") {
        signal?.removeEventListener("abort", handleAbort);
        finish();
        return;
      }

      if (event === "task-failed") {
        signal?.removeEventListener("abort", handleAbort);
        const errMsg = msg?.header?.error_message ?? "TTS task-failed";
        finish(new Error(errMsg));
        return;
      }

      // result-generated and other events are informational — ignore
    });

    ws.on("error", (err: Error) => {
      signal?.removeEventListener("abort", handleAbort);
      finish(err);
    });

    ws.on("close", (_code: number, _reason: string) => {
      if (!settled && !aborted) {
        signal?.removeEventListener("abort", handleAbort);
        finish(new Error("WebSocket closed unexpectedly"));
      }
    });
  });
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Returns true if the buffer starts with a JSON delimiter character. */
function isJsonBuffer(buf: Buffer): boolean {
  if (buf.length === 0) return false;
  const first = buf[0];
  return first === 0x7b /* { */ || first === 0x5b /* [ */;
}
