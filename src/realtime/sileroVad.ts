/**
 * Browser Silero VAD (neural) via @ricky0123/vad-web.
 * Loads ONNX + ort WASM from same-origin `/vad/` (copied by scripts/copy-vad-assets.mjs).
 * Optional: fails soft when WASM/model cannot load — cascade falls back to energy VAD.
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

/** Same-origin VAD root (Vite `public/vad` → `/vad/…` in dev and production). */
export function resolveVadAssetRoot(): string {
  const base =
    typeof import.meta !== "undefined" && import.meta.env?.BASE_URL
      ? String(import.meta.env.BASE_URL)
      : "/";
  const root = base.endsWith("/") ? base : `${base}/`;
  return `${root}vad/`;
}

export function resolveVadWorkletUrl(): string {
  return `${resolveVadAssetRoot()}vad.worklet.bundle.min.js`;
}

function vadAssetPaths(): { baseAssetPath: string; onnxWASMBasePath: string } {
  const baseAssetPath = resolveVadAssetRoot();
  return {
    baseAssetPath,
    onnxWASMBasePath: `${baseAssetPath}ort/`
  };
}

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
    const paths = vadAssetPaths();
    vad = await mod.MicVAD.new({
      model: "v5",
      baseAssetPath: paths.baseAssetPath,
      onnxWASMBasePath: paths.onnxWASMBasePath,
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
