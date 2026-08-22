import { describe, expect, it } from "vitest";
import { createInitialProductState, generatePodcastEpisode } from "./engine";
import { confirmPodcastScript, prependPodcastEpisode, replacePodcastEpisode } from "./podcast";

describe("confirmPodcastScript", () => {
  it("returns null when the episode is missing", () => {
    const state = createInitialProductState();
    const revision = state.revision;
    expect(confirmPodcastScript(state, "missing-episode")).toBeNull();
    expect(state.revision).toBe(revision);
  });

  it("returns null when the adopted script is empty", () => {
    const state = createInitialProductState();
    const { episode, nextState } = generatePodcastEpisode(state, state.notes[0].id, {
      format: "solo",
      voice: "calm-host"
    });
    expect(confirmPodcastScript(nextState, episode.id, "   ")).toBeNull();
  });

  it("confirms without rewriting audio when the script is unchanged", () => {
    const state = createInitialProductState();
    const { episode, nextState } = generatePodcastEpisode(state, state.notes[0].id, {
      format: "solo",
      voice: "calm-host"
    });
    const withAudio = replacePodcastEpisode(nextState, {
      ...episode,
      audioRenderStatus: "rendered",
      audioUrl: "https://cdn.example.com/keep.mp3",
      durationSec: 321
    });
    const confirmed = confirmPodcastScript(withAudio, episode.id);
    expect(confirmed).not.toBeNull();
    const stored = confirmed!.podcastEpisodes.find((item) => item.id === episode.id);
    expect(stored?.scriptReviewStatus).toBe("用户确认");
    expect(stored?.audioRenderStatus).toBe("rendered");
    expect(stored?.audioUrl).toBe("https://cdn.example.com/keep.mp3");
    expect(stored?.durationSec).toBe(321);
    expect(stored?.script).toBe(episode.script);
  });

  it("clears both rendered and failed audio when the script changes", () => {
    const state = createInitialProductState();
    const { episode, nextState } = generatePodcastEpisode(state, state.notes[0].id, {
      format: "solo",
      voice: "calm-host"
    });
    const failed = replacePodcastEpisode(nextState, {
      ...episode,
      audioRenderStatus: "failed",
      audioRenderMessage: "上次失败",
      audioUrl: "https://cdn.example.com/old.mp3"
    });
    const confirmed = confirmPodcastScript(failed, episode.id, `${episode.script}\n改过的一句`);
    expect(confirmed).not.toBeNull();
    const stored = confirmed!.podcastEpisodes.find((item) => item.id === episode.id);
    expect(stored?.scriptReviewStatus).toBe("用户确认");
    expect(stored?.audioRenderStatus).toBe("pending");
    expect(stored?.audioUrl).toBe(`local-audio://${episode.id}-stale.mp3`);
    expect(stored?.script).toContain("改过的一句");
  });

  it("does not mutate decisions or memory candidates", () => {
    const state = createInitialProductState();
    const { episode, nextState } = generatePodcastEpisode(state, state.notes[0].id, {
      format: "solo",
      voice: "calm-host"
    });
    const confirmed = confirmPodcastScript(nextState, episode.id);
    expect(confirmed!.decisions).toEqual(nextState.decisions);
    expect(confirmed!.memoryCandidates).toEqual(nextState.memoryCandidates);
    expect(confirmed!.notes).toEqual(nextState.notes);
  });

  it("replacePodcastEpisode keeps library order; prependPodcastEpisode inserts at front", () => {
    const state = createInitialProductState();
    const first = generatePodcastEpisode(state, state.notes[0].id, { format: "solo", voice: "a" });
    const second = generatePodcastEpisode(first.nextState, state.notes[0].id, { format: "solo", voice: "b" });
    const replaced = replacePodcastEpisode(second.nextState, {
      ...second.episode,
      title: "原地改标题"
    });
    expect(replaced.podcastEpisodes.map((item) => item.id)).toEqual(
      second.nextState.podcastEpisodes.map((item) => item.id)
    );
    expect(replaced.podcastEpisodes.find((item) => item.id === second.episode.id)?.title).toBe("原地改标题");

    const extra = { ...first.episode, id: "podcast-new-front", title: "新节目" };
    const prepended = prependPodcastEpisode(replaced, extra);
    expect(prepended.podcastEpisodes[0]?.id).toBe("podcast-new-front");
  });
});
