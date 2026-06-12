import type { RuntimeEnv } from "./env";

export const DEFAULT_CORPUS_AUDIO_MAX_BYTES = 50 * 1024 * 1024;

export function resolveCorpusAudioMaxBytes(env: RuntimeEnv | undefined) {
  const parsedValue = Number(env?.CORPUS_AUDIO_MAX_BYTES);
  if (!Number.isFinite(parsedValue)) {
    return DEFAULT_CORPUS_AUDIO_MAX_BYTES;
  }
  return Math.max(1, Math.min(2 * 1024 * 1024 * 1024, Math.floor(parsedValue)));
}
