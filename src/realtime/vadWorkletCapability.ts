import { resolveVadWorkletUrl } from "./sileroVad";

export type VadWorkletCapability =
  | { supported: true }
  | { supported: false; reason: "fetch" | "mime" | "execution" | "unsupported" };

export type VoiceUiStatus =
  | "idle"
  | "connecting"
  | "listening"
  | "speaking"
  | "interrupted"
  | "reconnecting"
  | "degraded"
  | "exhausted";

interface VadWorkletProbeDeps {
  fetchImpl: typeof fetch;
  createAudioContext: () => AudioContext;
}

const browserDefaults: VadWorkletProbeDeps = {
  fetchImpl: (...args) => globalThis.fetch(...args),
  createAudioContext: () => new AudioContext(),
};

export async function probeVadWorkletCapability(
  deps: VadWorkletProbeDeps = browserDefaults,
): Promise<VadWorkletCapability> {
  let context: AudioContext;
  try {
    context = deps.createAudioContext();
  } catch {
    return { supported: false, reason: "unsupported" };
  }

  try {
    if (!context.audioWorklet) return { supported: false, reason: "unsupported" };

    const workletUrl = resolveVadWorkletUrl();
    let response: Response;
    try {
      response = await deps.fetchImpl(workletUrl, { cache: "no-store" });
    } catch {
      return { supported: false, reason: "fetch" };
    }
    if (!response.ok) return { supported: false, reason: "fetch" };

    const mime = response.headers.get("content-type")?.toLowerCase() ?? "";
    if (!mime.includes("javascript")) return { supported: false, reason: "mime" };

    try {
      await context.audioWorklet.addModule(workletUrl);
    } catch {
      return { supported: false, reason: "execution" };
    }
    return { supported: true };
  } finally {
    await context.close().catch(() => undefined);
  }
}
