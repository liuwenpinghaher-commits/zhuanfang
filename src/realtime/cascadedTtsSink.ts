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

const DEFAULT_SAMPLE_RATE = 24000;

export function createBrowserTtsSink(ttsWsUrl: string, voice?: string): TtsSink {
  let ws: WebSocket | null = null;
  let audioCtx: AudioContext | null = null;
  let stopped = false;

  // Sample-accurate playback scheduling.
  let nextStartTime = 0; // in AudioContext time; next buffer starts here
  const scheduledSources = new Set<AudioBufferSourceNode>();

  // Decode state for the current utterance.
  let sampleRate = DEFAULT_SAMPLE_RATE;
  let leftoverByte: Uint8Array | null = null; // a half 16-bit sample split across chunks

  function getAudioContext(): AudioContext {
    if (!audioCtx || audioCtx.state === "closed") {
      audioCtx = new AudioContext();
    }
    if (audioCtx.state === "suspended") {
      audioCtx.resume().catch(() => { /* best-effort */ });
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
    // Start exactly when the previous buffer ends (sample-accurate, gapless). If we've
    // underrun (network stall), fall back to "now" — a small gap, not a crash.
    const startAt = Math.max(ctx.currentTime, nextStartTime);
    try {
      source.start(startAt);
    } catch {
      return;
    }
    nextStartTime = startAt + buffer.duration;
    scheduledSources.add(source);
    source.onended = () => { scheduledSources.delete(source); };
  }

  function stopPlayback() {
    stopped = true;
    for (const source of scheduledSources) {
      try { source.stop(); } catch { /* already stopped */ }
    }
    scheduledSources.clear();
    nextStartTime = 0;
    leftoverByte = null;
  }

  function openWs(): Promise<WebSocket> {
    return new Promise((resolve, reject) => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        resolve(ws);
        return;
      }
      const socket = new WebSocket(ttsWsUrl);
      socket.binaryType = "arraybuffer";
      socket.onopen = () => {
        ws = socket;
        resolve(socket);
      };
      socket.onerror = () => reject(new Error("TTS WebSocket failed to open"));
      socket.onclose = () => { if (ws === socket) ws = null; };
    });
  }

  return {
    async speak(segments: string[], speakVoice?: string): Promise<void> {
      // Fresh utterance: reset scheduling + decode state.
      stopped = false;
      nextStartTime = 0;
      leftoverByte = null;
      sampleRate = DEFAULT_SAMPLE_RATE;

      const socket = await openWs();
      const ctx = getAudioContext();

      return new Promise<void>((resolve, reject) => {
        let doneReceived = false;
        let drainPoll: ReturnType<typeof setInterval> | null = null;

        const cleanup = () => {
          socket.removeEventListener("message", onMessage);
          if (drainPoll !== null) { clearInterval(drainPoll); drainPoll = null; }
        };

        // Resolve once every scheduled buffer has finished playing.
        const resolveWhenDrained = () => {
          if (stopped || ctx.currentTime >= nextStartTime - 0.02) {
            cleanup();
            resolve();
            return true;
          }
          return false;
        };

        const onMessage = (event: MessageEvent) => {
          if (stopped) {
            cleanup();
            resolve();
            return;
          }

          if (event.data instanceof ArrayBuffer) {
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
            cleanup();
            reject(new Error(msg.message ?? "TTS error"));
          }
          void doneReceived;
        };

        socket.addEventListener("message", onMessage);

        socket.send(
          JSON.stringify({
            type: "speak",
            segments,
            ...(speakVoice ?? voice ? { voice: speakVoice ?? voice } : {})
          })
        );
      });
    },

    stop() {
      stopPlayback();
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "cancel" }));
      }
    }
  };
}
