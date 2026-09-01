import { describe, expect, it } from "vitest";
import { resolveEpisodeVoices } from "./podcast";
import {
  clampPodcastGuestVoice,
  pairPodcastGuestVoice,
  podcastSpeakingIdentity,
  podcastVoiceSelectOptions
} from "./podcast-voices";
import type { PodcastEpisode } from "./types";

describe("podcast speaking identity and pairing", () => {
  it("treats 洋 as 谦 so the guest pair is 聆心", () => {
    expect(podcastSpeakingIdentity("longanyang")).toBe("longanqian");
    expect(pairPodcastGuestVoice("longanyang")).toBe("longanlingxin");
    expect(pairPodcastGuestVoice("longanqian")).toBe("longanlingxin");
    expect(pairPodcastGuestVoice("longanlingxin")).toBe("longanqian");
    expect(pairPodcastGuestVoice("longanhuan")).toBe("longanqian");
  });

  it("omits empty or placeholder guest ids instead of rewriting them to 欢", () => {
    expect(clampPodcastGuestVoice("")).toBeUndefined();
    expect(clampPodcastGuestVoice("   ")).toBeUndefined();
    expect(clampPodcastGuestVoice("calm-host")).toBeUndefined();
    expect(clampPodcastGuestVoice("warm-interviewer")).toBeUndefined();
    expect(clampPodcastGuestVoice("local-demo")).toBeUndefined();
    expect(clampPodcastGuestVoice("longanqian")).toBe("longanqian");
  });

  it("keeps a legacy current value selectable without disabling it", () => {
    const options = podcastVoiceSelectOptions("longanyang");
    expect(options[0]?.voice).toBe("longanyang");
    expect(options.some((item) => item.voice === "longanlingxin")).toBe(true);
    expect(options.some((item) => item.voice === "longanqian")).toBe(true);
  });

  it("labels a 张小珺 clone id as 张小珺", () => {
    const options = podcastVoiceSelectOptions("qwen-audio-3.0-tts-plus-zhangxj-abc");
    expect(options[0]).toEqual({ voice: "qwen-audio-3.0-tts-plus-zhangxj-abc", name: "张小珺" });
  });
});

describe("resolveEpisodeVoices", () => {
  function episode(extra: Partial<PodcastEpisode>): PodcastEpisode {
    return {
      id: "podcast-test",
      noteId: "note-1",
      title: "播客：测试",
      format: "host-guest",
      voice: "longanlingxin",
      status: "draft",
      scriptReviewStatus: "待确认",
      durationSec: 60,
      script: "主持人：开场。\n来宾：回应。",
      chapters: [],
      audioUrl: "local-audio://x.wav",
      shownotes: [],
      createdAt: "2026-08-22T00:00:00.000Z",
      ...extra
    };
  }

  it("uses stored guest when present", () => {
    expect(resolveEpisodeVoices(episode({ guestVoice: "longanqian" }))).toEqual({
      host: "longanlingxin",
      guest: "longanqian",
      guestFromFallback: false
    });
  });

  it("pairs 洋 host to 聆心 guest without rewriting host", () => {
    expect(resolveEpisodeVoices(episode({ voice: "longanyang" }))).toEqual({
      host: "longanyang",
      guest: "longanlingxin",
      guestFromFallback: true
    });
  });
});
