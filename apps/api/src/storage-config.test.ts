import { describe, it, expect } from "vitest";
import { resolveCorpusAudioMaxBytes } from "./storage-config";

describe("storage-config", () => {
  it("resolves default max bytes", () => {
    expect(resolveCorpusAudioMaxBytes({})).toBe(50 * 1024 * 1024);
  });

  it("resolves custom max bytes from env", () => {
    expect(resolveCorpusAudioMaxBytes({ CORPUS_AUDIO_MAX_BYTES: "10485760" })).toBe(10485760);
  });
});
