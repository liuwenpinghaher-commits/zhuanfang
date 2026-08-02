/**
 * Browser-side TTS sink for the cascade pipeline.
 *
 * Connects to the server's TTS WebSocket proxy at:
 *   /api/realtime-voice/ws/tts/:sessionId
 *
 * Protocol (browser → proxy):
 *   { type: "speak", segments: string[], voice?: string }
 *   { type: "cancel" }
 *
 * Protocol (proxy → browser):
 *   { type: "tts.start", format: "pcm", sampleRate: number }  — announced before audio
 *   <binary frame>                                            — raw PCM (s16le, mono) chunk
 *   { type: "tts.done" }                                      — synthesis complete
 *   { type: "error", message: string }
 *
 * Why PCM + manual scheduling (not MP3 + decodeAudioData):
 *   CosyVoice streams audio in many small chunks. MP3 stream fragments don't fall on
 *   frame boundaries, so decoding each chunk independently fails for many of them
 *   (silently dropped) → choppy, words missing. Raw PCM chunks are just samples: they
 *   concatenate seamlessly. We build a 16-bit PCM AudioBuffer per chunk and schedule
 *   each at a sample-accurate start time (previous end), so there are no gaps/clicks
 *   between chunks the way onended-chaining produces.
 */
import type { TtsSink } from "./cascadedPipeline";
import type { SpeechProsody } from "../domain/speech-text";

const DEFAULT_SAMPLE_RATE = 24000;
// Pre-roll before the first chunk plays. Gives the audio thread headroom so the
// opening doesn't glitch/under-run at startup, and keeps the first scheduled time
// safely in the future (a just-resumed context can have currentTime ~0).
const STARTUP_LATENCY = 0.15;

export class TtsPlaybackInterruptedError extends Error {
  readonly code?: number;

  constructor(message: string, code?: number) {
    super(message);
    this.name = "TtsPlaybackInterruptedError";
    this.code = code;
  }
}

export function createBrowserTtsSink(ttsWsUrl: string, voice?: string): TtsSink {
  let ws: WebSocket | null = null;
  let audioCtx: AudioContext | null = null;
  let stopped = false;

  // Sample-accurate playback scheduling.
  let nextStartTime = 0; // in AudioContext time; next buffer starts here
  let firstChunkOfUtterance = true; // first chunk gets the STARTUP_LATENCY cushion
  const scheduledSources = new Set<AudioBufferSourceNode>();

  // Decode state for the current utterance.
  let sampleRate = DEFAULT_SAMPLE_RATE;
  let leftoverByte: Uint8Array | null = null; // a half 16-bit sample split across chunks

  // Side-channel recording of the host (interviewer) TTS audio. We accumulate a
  // verbatim copy of every PCM chunk as it arrives so the assembled stream can be
  // stored + replayed later. This is a pure tap: it never touches the playback
  // path (decode/schedule), so it cannot change what the user hears. The recorded
  // sample rate is the one the chunks were synthesized at (`sampleRate` below,
  // sourced from the tts.start announcement / default 24000).
  const recordedChunks: Uint8Array[] = [];
  let recordedSampleRate = DEFAULT_SAMPLE_RATE;

  // The in-flight speak is bound to the socket that started it. A closed socket
  // can still dispatch late lifecycle events after a replacement socket opens;
  // those events must never settle the replacement utterance.
  let activeSpeak: {
    generation: number;
    socket: WebSocket;
    resolve: () => void;
    reject: (error: TtsPlaybackInterruptedError) => void;
    cleanup: () => void;
  } | null = null;
  let nextSpeakGeneration = 0;
  let pendingSpeak: {
    generation: number;
    cancelled: boolean;
    socket: WebSocket | null;
    cancellation: Promise<void>;
    cancel: () => void;
    interruption: Promise<never>;
    interruptionError: TtsPlaybackInterruptedError | null;
    interrupt: (error: TtsPlaybackInterruptedError) => void;
  } | null = null;

  function isCurrentSpeak(generation: number) {
    return pendingSpeak?.generation === generation && !pendingSpeak.cancelled;
  }

  function clearPendingSpeak(generation: number) {
    if (pendingSpeak?.generation === generation) pendingSpeak = null;
  }

  function resolveActiveSpeak(socket?: WebSocket, generation?: number) {
    if (!activeSpeak
      || (socket && activeSpeak.socket !== socket)
      || (generation !== undefined && activeSpeak.generation !== generation)) return;
    const current = activeSpeak;
    activeSpeak = null;
    current.cleanup();
    clearPendingSpeak(current.generation);
    current.resolve();
  }

  function rejectActiveSpeak(socket: WebSocket, message: string, code?: number) {
    if (stopped || !activeSpeak || activeSpeak.socket !== socket) return;
    const current = activeSpeak;
    activeSpeak = null;
    clearScheduledPlayback(false);
    current.cleanup();
    clearPendingSpeak(current.generation);
    current.reject(new TtsPlaybackInterruptedError(message, code));
  }

  function interruptSpeakForSocket(socket: WebSocket, error: TtsPlaybackInterruptedError) {
    const current = pendingSpeak;
    if (current?.socket === socket && !current.cancelled) current.interrupt(error);
    rejectActiveSpeak(socket, error.message, error.code);
  }

  function cancelPendingSpeak() {
    const current = pendingSpeak;
    if (!current || current.cancelled) return;
    current.cancelled = true;
    current.cancel();
    resolveActiveSpeak(undefined, current.generation);
    if (current.socket?.readyState === WebSocket.CONNECTING) {
      try { current.socket.close(1000, "tts speak cancelled"); } catch { /* already closed */ }
    }
    clearPendingSpeak(current.generation);
  }

  function getAudioContext(): AudioContext {
    if (!audioCtx || audioCtx.state === "closed") {
      audioCtx = new AudioContext();
    }
    return audioCtx;
  }

  /** Decode one raw PCM (s16le, mono) chunk into an AudioBuffer, carrying any odd
   *  trailing byte over to the next chunk. Returns null if there's nothing playable yet. */
  function decodePcmChunk(data: ArrayBuffer): AudioBuffer | null {
    const ctx = getAudioContext();
    const incoming = new Uint8Array(data);
    let bytes: Uint8Array;
    if (leftoverByte) {
      bytes = new Uint8Array(leftoverByte.length + incoming.length);
      bytes.set(leftoverByte, 0);
      bytes.set(incoming, leftoverByte.length);
      leftoverByte = null;
    } else {
      bytes = incoming;
    }
    const usableLen = bytes.length - (bytes.length % 2);
    if (usableLen < bytes.length) {
      leftoverByte = bytes.slice(usableLen); // stash the 1 trailing byte
    }
    if (usableLen === 0) return null;

    const sampleCount = usableLen / 2;
    const view = new DataView(bytes.buffer, bytes.byteOffset, usableLen);
    const buffer = ctx.createBuffer(1, sampleCount, sampleRate);
    const channel = buffer.getChannelData(0);
    for (let i = 0; i < sampleCount; i++) {
      channel[i] = view.getInt16(i * 2, true) / 32768;
    }
    return buffer;
  }

  /** Schedule a decoded buffer to play immediately after whatever is already queued. */
  function scheduleBuffer(buffer: AudioBuffer) {
    if (stopped) return;
    const ctx = getAudioContext();
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(ctx.destination);
    // First chunk: start a touch in the future (cushion). Thereafter start exactly
    // when the previous buffer ends (sample-accurate, gapless). On under-run
    // (network stall) fall back to "now" — a small gap, not a crash/garble.
    const startAt = firstChunkOfUtterance
      ? ctx.currentTime + STARTUP_LATENCY
      : Math.max(ctx.currentTime, nextStartTime);
    firstChunkOfUtterance = false;
    try {
      source.start(startAt);
    } catch {
      return;
    }
    nextStartTime = startAt + buffer.duration;
    scheduledSources.add(source);
    source.onended = () => { scheduledSources.delete(source); };
  }

  function clearScheduledPlayback(terminal: boolean) {
    stopped = terminal;
    for (const source of scheduledSources) {
      try { source.stop(); } catch { /* already stopped */ }
    }
    scheduledSources.clear();
    nextStartTime = 0;
    firstChunkOfUtterance = true;
    leftoverByte = null;
  }

  function openWs(attempt: NonNullable<typeof pendingSpeak>): Promise<WebSocket> {
    return new Promise((resolve, reject) => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        attempt.socket = ws;
        resolve(ws);
        return;
      }
      const socket = new WebSocket(ttsWsUrl);
      attempt.socket = socket;
      socket.binaryType = "arraybuffer";
      socket.onopen = () => {
        if (!isCurrentSpeak(attempt.generation)) {
          try { socket.close(1000, "stale tts connection"); } catch { /* already closed */ }
          resolve(socket);
          return;
        }
        ws = socket;
        resolve(socket);
      };
      socket.onerror = () => {
        const error = new TtsPlaybackInterruptedError("TTS WebSocket interrupted");
        if (ws === socket) ws = null;
        interruptSpeakForSocket(socket, error);
        reject(error);
        try {
          if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
            socket.close(1011, "tts socket error");
          }
        } catch { /* already closing/closed */ }
      };
      socket.onclose = (event) => {
        if (ws === socket) ws = null;
        const error = new TtsPlaybackInterruptedError(event.reason || "TTS WebSocket interrupted", event.code);
        interruptSpeakForSocket(socket, error);
        reject(error);
      };
    });
  }

  return {
    async speak(segments: string[], speakVoice?: string, prosody?: SpeechProsody): Promise<void> {
      let cancel!: () => void;
      const cancellation = new Promise<void>((resolve) => { cancel = resolve; });
      let rejectInterruption!: (error: TtsPlaybackInterruptedError) => void;
      const interruption = new Promise<never>((_resolve, reject) => { rejectInterruption = reject; });
      const attempt = {
        generation: ++nextSpeakGeneration,
        cancelled: false,
        socket: null as WebSocket | null,
        cancellation,
        cancel,
        interruption,
        interruptionError: null as TtsPlaybackInterruptedError | null,
        interrupt(error: TtsPlaybackInterruptedError) {
          if (this.cancelled || this.interruptionError) return;
          this.interruptionError = error;
          rejectInterruption(error);
        },
      };
      pendingSpeak = attempt;
      // Fresh utterance: reset scheduling + decode state.
      stopped = false;
      nextStartTime = 0;
      firstChunkOfUtterance = true;
      leftoverByte = null;
      sampleRate = DEFAULT_SAMPLE_RATE;

      let socket: WebSocket;
      try {
        const opened = await Promise.race([
          openWs(attempt).then((value) => ({ value })),
          attempt.cancellation.then(() => null),
          attempt.interruption,
        ]);
        if (!opened || !isCurrentSpeak(attempt.generation)) return;
        if (attempt.interruptionError) throw attempt.interruptionError;
        socket = opened.value;
      } catch (error) {
        if (attempt.cancelled || !isCurrentSpeak(attempt.generation)) return;
        clearPendingSpeak(attempt.generation);
        if (error instanceof TtsPlaybackInterruptedError) throw error;
        throw new TtsPlaybackInterruptedError(error instanceof Error ? error.message : "TTS WebSocket interrupted");
      }
      if (!isCurrentSpeak(attempt.generation)) return;
      const ctx = getAudioContext();
      // Ensure the context is actually RUNNING before we schedule against
      // ctx.currentTime — a suspended context reports currentTime ~0, which would
      // schedule every chunk in the past and garble playback once it resumes.
      try {
        if (ctx.state !== "running") {
          await Promise.race([
            ctx.resume().catch(() => { /* best-effort */ }),
            attempt.cancellation,
            attempt.interruption,
          ]);
        }
      } catch (error) {
        if (attempt.cancelled || !isCurrentSpeak(attempt.generation)) return;
        clearPendingSpeak(attempt.generation);
        if (error instanceof TtsPlaybackInterruptedError) throw error;
        throw new TtsPlaybackInterruptedError(error instanceof Error ? error.message : "TTS playback interrupted");
      }
      if (!isCurrentSpeak(attempt.generation)) return;
      if (attempt.interruptionError) throw attempt.interruptionError;

      return new Promise<void>((resolve, reject) => {
        let doneReceived = false;
        let drainPoll: ReturnType<typeof setInterval> | null = null;

        const cleanup = () => {
          socket.removeEventListener("message", onMessage);
          if (drainPoll !== null) { clearInterval(drainPoll); drainPoll = null; }
        };

        activeSpeak = { generation: attempt.generation, socket, resolve, reject, cleanup };

        // Resolve once every scheduled buffer has finished playing.
        const resolveWhenDrained = () => {
          if (stopped || ctx.currentTime >= nextStartTime - 0.02) {
            resolveActiveSpeak(socket);
            return true;
          }
          return false;
        };

        const onMessage = (event: MessageEvent) => {
          if (stopped) {
            resolveActiveSpeak(socket);
            return;
          }

          if (event.data instanceof ArrayBuffer) {
            // Side-channel tap (does NOT touch playback): keep a verbatim copy of
            // the raw PCM bytes so the whole host stream can be stored + replayed.
            // Copy into a fresh Uint8Array — the underlying ArrayBuffer may be
            // reused/neutered after this handler returns.
            try {
              recordedChunks.push(new Uint8Array(event.data.slice(0)));
              recordedSampleRate = sampleRate;
            } catch {
              /* best-effort recording — never let it affect playback */
            }
            // Raw PCM chunk → decode + schedule (gapless).
            try {
              const buffer = decodePcmChunk(event.data);
              if (buffer && !stopped) scheduleBuffer(buffer);
            } catch {
              /* malformed chunk — skip */
            }
            return;
          }

          let msg: { type?: string; message?: string; sampleRate?: number };
          try {
            msg = JSON.parse(event.data as string);
          } catch {
            return;
          }

          if (msg.type === "tts.start") {
            if (typeof msg.sampleRate === "number" && msg.sampleRate > 0) {
              sampleRate = msg.sampleRate;
            }
          } else if (msg.type === "tts.done") {
            doneReceived = true;
            // All audio received; wait for the scheduled playback to drain.
            if (!resolveWhenDrained()) {
              drainPoll = setInterval(resolveWhenDrained, 50);
            }
          } else if (msg.type === "error") {
            rejectActiveSpeak(socket, msg.message ?? "TTS error");
          }
          void doneReceived;
        };

        socket.addEventListener("message", onMessage);

        socket.send(
          JSON.stringify({
            type: "speak",
            segments,
            ...(speakVoice ?? voice ? { voice: speakVoice ?? voice } : {}),
            ...(prosody ? { prosody } : {})
          })
        );
      });
    },

    stop() {
      clearScheduledPlayback(true);
      cancelPendingSpeak();
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "cancel" }));
      }
      // Resolve any in-flight speak() so the pipeline's await returns (releases mic).
      resolveActiveSpeak();
    },

    // P1-08: terminal teardown. stop() keeps the socket warm for the next turn;
    // close() releases the socket AND the AudioContext so they don't leak across
    // repeated voice-session open/close cycles (leaked AudioContexts eventually
    // exhaust the browser's context budget, after which new contexts fail to
    // start and TTS goes permanently silent). Idempotent: nulls each handle so a
    // second close() is a no-op, and a later getAudioContext()/openWs() can
    // recreate fresh resources if the sink is somehow reused.
    close() {
      clearScheduledPlayback(true);
      cancelPendingSpeak();
      // Resolve any in-flight speak() before we drop the socket it's listening on.
      resolveActiveSpeak();
      if (ws) {
        try {
          if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
            ws.close(1000, "tts sink closed");
          }
        } catch { /* already closing/closed */ }
        ws = null;
      }
      if (audioCtx && audioCtx.state !== "closed") {
        audioCtx.close().catch(() => { /* best-effort */ });
      }
      audioCtx = null;
    },

    // Returns the whole host (interviewer) TTS audio captured so far as a single
    // contiguous PCM buffer (s16le, mono) plus its sample rate, for storing as a
    // WAV. Returns null when nothing was ever recorded (text path / no audio
    // received) so the caller skips the upload. Pure read of the side-channel
    // tap — does not affect playback.
    getRecordedPcm(): { pcm: Uint8Array; sampleRate: number } | null {
      if (recordedChunks.length === 0) return null;
      let total = 0;
      for (const chunk of recordedChunks) total += chunk.length;
      if (total === 0) return null;
      const pcm = new Uint8Array(total);
      let offset = 0;
      for (const chunk of recordedChunks) {
        pcm.set(chunk, offset);
        offset += chunk.length;
      }
      return { pcm, sampleRate: recordedSampleRate };
    }
  };
}
