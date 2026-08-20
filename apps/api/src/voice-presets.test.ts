import { describe, expect, it } from "vitest";
import { COSYVOICE_PRESET_VOICES, normalizeCosyVoiceId } from "./voice-presets";

describe("normalizeCosyVoiceId", () => {
  it("keeps verified presets", () => {
    for (const p of COSYVOICE_PRESET_VOICES) {
      expect(normalizeCosyVoiceId(p.voice)).toBe(p.voice);
    }
  });

  it("maps legacy longyuan_v3 to longanhuan", () => {
    expect(normalizeCosyVoiceId("longyuan_v3")).toBe("longanlingxin");
  });

  it("maps calm-host / warm-interviewer aliases", () => {
    expect(normalizeCosyVoiceId("calm-host")).toBe("longanqian");
    expect(normalizeCosyVoiceId("warm-interviewer")).toBe("longanlingxin");
  });

  it("falls back on empty/unknown", () => {
    expect(normalizeCosyVoiceId("")).toBe("longanlingxin");
    expect(normalizeCosyVoiceId("not-a-real-voice")).toBe("longanlingxin");
    expect(normalizeCosyVoiceId(undefined, "longanyang")).toBe("longanyang");
  });
});
