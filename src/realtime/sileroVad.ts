/**
 * Browser Silero VAD (neural) via @ricky0123/vad-web.
 * Uses CDN assets by default so Vite does not need onnx/wasm copy plugins.
 * Optional: fails soft when WASM/model cannot load.
 */
import type { MicVAD } from "@ricky0123/vad-web";

export interface SileroVadHandlers {
  onSpeechStart?: () => void;
  onSpeechEnd?: (audio: Float32Array) => void;
  onFrame?: (probs: { isSpeech: number; notSpeech: number }) => void;
}

export interface SileroVadController {
  start(): Promise<void>;
  pause(): void;
  destroy(): void;
  /** Latest speech probability 0..1 from onFrameProcessed. */
  getSpeechProb(): number;
  readonly ready: boolean;
}

const VAD_WEB_CDN = "https://cdn.jsdelivr.net/npm/@ricky0123/vad-web@0.0.27/dist/";
const ORT_CDN = "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.14.0/dist/";

function unavailableController(): SileroVadController {
  return {
    ready: false,
    getSpeechProb: () => 0,
    async start() {},
    pause() {},
    destroy() {}
  };
}

export async function createSileroVadController(
  stream: MediaStream,
  handlers: SileroVadHandlers = {}
): Promise<SileroVadController> {
  let speechProb = 0;
  let vad: MicVAD | null = null;
  let ready = false;

  // Node/jsdom unit tests and non-browser runtimes: skip without noisy warn.
  if (typeof window === "undefined" || typeof MediaStreamAudioSourceNode === "undefined") {
    return unavailableController();
  }

  try {
    const mod = await import("@ricky0123/vad-web");
    vad = await mod.MicVAD.new({
      model: "v5",
      baseAssetPath: VAD_WEB_CDN,
      onnxWASMBasePath: ORT_CDN,
      // Reuse the cascade mic stream (do not open a second getUserMedia).
      getStream: async () => stream,
      pauseStream: async () => {
        /* keep tracks alive for ASR */
      },
      resumeStream: async () => stream,
      positiveSpeechThreshold: 0.4,
      negativeSpeechThreshold: 0.25,
      redemptionMs: 400,
      minSpeechMs: 200,
      preSpeechPadMs: 200,
      onSpeechStart: () => handlers.onSpeechStart?.(),
      onSpeechEnd: (audio) => handlers.onSpeechEnd?.(audio),
      onFrameProcessed: (probs) => {
        speechProb = probs.isSpeech;
        handlers.onFrame?.(probs);
      }
    });
    ready = true;
  } catch (err) {
    console.warn(
      JSON.stringify({
        event: "silero_vad_init_failed",
        error: err instanceof Error ? err.message : String(err)
      })
    );
    return unavailableController();
  }

  return {
    get ready() {
      return ready && vad != null;
    },
    getSpeechProb: () => speechProb,
    async start() {
      vad?.start();
    },
    pause() {
      vad?.pause();
    },
    destroy() {
      try {
        vad?.pause();
      } catch {
        /* ignore */
      }
      vad = null;
      ready = false;
    }
  };
}
