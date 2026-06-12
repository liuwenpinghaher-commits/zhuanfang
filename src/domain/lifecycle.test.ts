import { describe, expect, it } from "vitest";
import {
  analyzeImportedInterview,
  approvePlaybookPatch,
  buildSearchBrief,
  createInitialProductState,
  generatePodcastEpisode
} from "./engine";
import {
  deleteCorpusInsightBundle,
  deletePodcastEpisode,
  deleteSearchBrief,
  dedupeGeneratedArtifacts
} from "./lifecycle";

describe("generated artifact lifecycle", () => {
  it("deletes a search brief without mutating the previous state", () => {
    const state = createInitialProductState();
    const { brief, nextState } = buildSearchBrief(state, "AI 产品商业化热点", "anysearch");

    const updated = deleteSearchBrief(nextState, brief.id);

    expect(nextState.searchBriefs).toHaveLength(1);
    expect(updated.searchBriefs).toHaveLength(0);
  });

  it("deletes a podcast episode without affecting source notes", () => {
    const state = createInitialProductState();
    const { episode, nextState } = generatePodcastEpisode(state, state.notes[0].id, {
      format: "solo",
      voice: "calm-host"
    });

    const updated = deletePodcastEpisode(nextState, episode.id);

    expect(updated.podcastEpisodes).toHaveLength(0);
    expect(updated.notes).toHaveLength(state.notes.length);
  });

  it("deletes a corpus insight bundle and preserves applied patch history", () => {
    const state = createInitialProductState();
    const { insight, nextState } = analyzeImportedInterview(state, {
      title: "优秀创始人专访样本",
      mediaType: "text",
      content:
        "主持人：你刚才说增长很难，能不能讲一个具体时刻？\n被访者：真正困难是团队不敢暴露坏消息。\n主持人：如果反过来看，是不是机制奖励了报喜不报忧？"
    });
    const approved = approvePlaybookPatch(nextState, insight.recommendedPatches[0].id);

    const updated = deleteCorpusInsightBundle(approved, insight.id);

    expect(updated.corpusInsights).toHaveLength(0);
    expect(updated.corpusImports).toHaveLength(0);
    expect(updated.playbookPatches).toHaveLength(1);
    expect(updated.playbookPatches[0].status).toBe("applied");
  });

  it("deduplicates generated artifacts by stable business keys", () => {
    const base = createInitialProductState();
    const firstSearch = buildSearchBrief(base, "AI 产品商业化热点", "anysearch").nextState;
    const secondSearch = buildSearchBrief(firstSearch, "AI 产品商业化热点", "anysearch").nextState;
    const firstPodcast = generatePodcastEpisode(secondSearch, secondSearch.notes[0].id, {
      format: "solo",
      voice: "calm-host"
    }).nextState;
    const secondPodcast = generatePodcastEpisode(firstPodcast, firstPodcast.notes[0].id, {
      format: "solo",
      voice: "calm-host"
    }).nextState;
    const firstCorpus = analyzeImportedInterview(secondPodcast, {
      title: "优秀专访样本",
      mediaType: "text",
      content: "主持人：能不能讲一个具体时刻？\n被访者：团队不敢暴露坏消息。"
    }).nextState;
    const secondCorpus = analyzeImportedInterview(firstCorpus, {
      title: "优秀专访样本",
      mediaType: "text",
      content: "主持人：能不能讲一个具体时刻？\n被访者：团队不敢暴露坏消息。"
    }).nextState;

    const result = dedupeGeneratedArtifacts(secondCorpus);

    expect(result.removed).toEqual({
      searchBriefs: 1,
      podcastEpisodes: 1,
      corpusInsights: 1
    });
    expect(result.nextState.searchBriefs).toHaveLength(1);
    expect(result.nextState.podcastEpisodes).toHaveLength(1);
    expect(result.nextState.corpusInsights).toHaveLength(1);
    expect(result.nextState.corpusImports).toHaveLength(1);
  });
});
