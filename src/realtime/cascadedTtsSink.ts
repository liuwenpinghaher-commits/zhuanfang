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
 *   <binary frame>         — raw MP3 audio chunk
 *   { type: "tts.done" }  — synthesis complete
 *   { type: "error", message: string }
 */
import type { TtsSink } from "./cascadedPipeline";

export function createBrowserTtsSink(ttsWsUrl: string, voice?: string): TtsSink {
  let ws: WebSocket | null = null;
  let audioCtx: AudioContext | null = null;
  // Queue of decoded AudioBuffers waiting to be played
  let playQueue: AudioBuffer[] = [];
  let currentSource: AudioBufferSourceNode | null = null;
  let playing = false;
  let stopped = false;

  // Lazy-init AudioContext (must be triggered by user gesture; cascade start qualifies)
  function getAudioContext(): AudioContext {
    if (!audioCtx || audioCtx.state === "closed") {
      audioCtx = new AudioContext();
    }
    if (audioCtx.state === "suspended") {
      audioCtx.resume().catch(() => { /* best-effort */ });
    }
    return audioCtx;
  }

  function playNext() {
    if (stopped || playing || playQueue.length === 0) return;
    const ctx = getAudioContext();
    const buffer = playQueue.shift()!;
    playing = true;
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(ctx.destination);
    currentSource = source;
    source.onended = () => {
      currentSource = null;
      playing = false;
      playNext();
    };
    source.start();
  }

  function stopPlayback() {
    stopped = true;
    playQueue = [];
    if (currentSource) {
      try { currentSource.stop(); } catch { /* already stopped */ }
      currentSource = null;
    }
    playing = false;
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
      stopped = false;
      playQueue = [];

      const socket = await openWs();
      const ctx = getAudioContext();

      return new Promise<void>((resolve, reject) => {
        const onMessage = async (event: MessageEvent) => {
          if (stopped) {
            socket.removeEventListener("message", onMessage);
            resolve();
            return;
          }

          if (event.data instanceof ArrayBuffer) {
            // Binary frame: MP3 audio chunk — decode and enqueue
            try {
              const decoded = await ctx.decodeAudioData(event.data.slice(0));
              if (!stopped) {
                playQueue.push(decoded);
                playNext();
              }
            } catch {
              // malformed audio chunk — skip
            }
            return;
          }

          // Text frame: JSON control message
          let msg: { type?: string; message?: string };
          try {
            msg = JSON.parse(event.data as string);
          } catch {
            return;
          }

          if (msg.type === "tts.done") {
            socket.removeEventListener("message", onMessage);
            // Wait for the play queue to drain before resolving
            if (playQueue.length === 0 && !playing) {
              resolve();
            } else {
              // Poll until playback finishes
              const poll = setInterval(() => {
                if (playQueue.length === 0 && !playing) {
                  clearInterval(poll);
                  resolve();
                }
              }, 50);
            }
          } else if (msg.type === "error") {
            socket.removeEventListener("message", onMessage);
            reject(new Error(msg.message ?? "TTS error"));
          }
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
