// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  COSYVOICE_PRESET_VOICES,
  normalizeCosyVoiceId,
  mapQwenAudio411Voice,
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

  it("falls back on empty, keeps clone ids", () => {
    expect(normalizeCosyVoiceId("")).toBe("longanlingxin");
    expect(normalizeCosyVoiceId(undefined, "longanyang")).toBe("longanyang");
    expect(normalizeCosyVoiceId("qwen-audio-3.0-tts-plus-zhangxj-abc")).toBe(
      "qwen-audio-3.0-tts-plus-zhangxj-abc"
    );
    expect(resolveQwenAudioTtsVoice("qwen-audio-3.0-tts-plus-zhangxj-abc")).toBe(
      "qwen-audio-3.0-tts-plus-zhangxj-abc"
    );
  });

  it("maps qwen-audio TTS voices that 411 on token-plan to speaking voices", () => {
    expect(resolveQwenAudioTtsVoice("longanhuan")).toBe("longanlingxin");
    expect(resolveQwenAudioTtsVoice("longanyang")).toBe("longanqian");
    expect(resolveQwenAudioTtsVoice("longanlingxin")).toBe("longanlingxin");
    expect(resolveQwenAudioTtsVoice("longanqian")).toBe("longanqian");
  });

  it("mapQwenAudio411Voice 只改 411 预设，自定义克隆 id 原样过", () => {
    expect(mapQwenAudio411Voice("longanhuan")).toBe("longanlingxin");
    expect(mapQwenAudio411Voice("longanyang")).toBe("longanqian");
    expect(mapQwenAudio411Voice("custom-voice-abc123")).toBe("custom-voice-abc123");
    expect(mapQwenAudio411Voice("cosyvoice-clone-xxx")).toBe("cosyvoice-clone-xxx");
  });
});

describe("pairQwenAudioTtsVoice", () => {
  it("pairs the host with the other speaking voice", () => {
    expect(pairQwenAudioTtsVoice("longanlingxin")).toBe("longanqian");
    expect(pairQwenAudioTtsVoice("longanqian")).toBe("longanlingxin");
    expect(pairQwenAudioTtsVoice("longanhuan")).toBe("longanqian");
    expect(pairQwenAudioTtsVoice("longanyang")).toBe("longanlingxin");
  });
});
