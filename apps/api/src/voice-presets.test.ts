import { describe, expect, it } from "vitest";
import {
  COSYVOICE_PRESET_VOICES,
  normalizeCosyVoiceId,
  pairQwenAudioTtsVoice,
  resolveQwenAudioTtsVoice
} from "./voice-presets";

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

  it("maps qwen-audio TTS voices that 411 on token-plan to speaking voices", () => {
    expect(resolveQwenAudioTtsVoice("longanhuan")).toBe("longanlingxin");
    expect(resolveQwenAudioTtsVoice("longanyang")).toBe("longanqian");
    expect(resolveQwenAudioTtsVoice("longanlingxin")).toBe("longanlingxin");
    expect(resolveQwenAudioTtsVoice("longanqian")).toBe("longanqian");
  });
});

describe("pairQwenAudioTtsVoice", () => {
  it("pairs the host with the other speaking voice", () => {
    expect(pairQwenAudioTtsVoice("longanlingxin")).toBe("longanqian");
    expect(pairQwenAudioTtsVoice("longanqian")).toBe("longanlingxin");
    expect(pairQwenAudioTtsVoice("longanhuan")).toBe("longanqian");
  });
});
