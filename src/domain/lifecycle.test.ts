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
import type { PodcastEpisode } from "./types";

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

describe("podcastEpisodeKey dedup — sourceType+sourceId priority (P2-20)", () => {
  function makeEpisode(overrides: Partial<PodcastEpisode> & Pick<PodcastEpisode, "id">): PodcastEpisode {
    return {
      noteId: "shared-entity-id",
      sourceType: "note",
      sourceId: "shared-entity-id",
      title: "播客：测试专访",
      format: "solo",
      voice: "calm-host",
      status: "draft",
      scriptReviewStatus: "待确认",
      durationSec: 180,
      script: "测试脚本内容",
      chapters: [],
      audioUrl: "local-audio://test.mp3",
      shownotes: [],
      createdAt: "2026-01-01T00:00:00.000Z",
      ...overrides
    };
  }

  it("keeps both episodes when noteId is the same but sourceType+sourceId differ (non-note id collision)", () => {
    // 模拟场景:一个 note 来源 episode 和一个 search-brief 来源 episode
    // 恰好拥有相同的实体 id(id 巧合碰撞),title/format/voice 也相同
    // 旧 key 用 noteId 首段 → 两者 key 相同 → 误判重复 → 去重掉一个(BUG)
    // 新 key 用 sourceType:sourceId → 不同 → 两者都保留(CORRECT)
    const noteEpisode = makeEpisode({
      id: "ep-1",
      noteId: "shared-entity-id",
      sourceType: "note",
      sourceId: "shared-entity-id"
    });
    const searchBriefEpisode = makeEpisode({
      id: "ep-2",
      noteId: "shared-entity-id",   // 与 note episode 的 noteId 相同(碰撞场景)
      sourceType: "search-brief",
      sourceId: "shared-entity-id"  // sourceId 与 noteId 相同,但 sourceType 不同
    });

    const base = createInitialProductState();
    const stateWithBoth: typeof base = {
      ...base,
      podcastEpisodes: [noteEpisode, searchBriefEpisode]
    };

    const result = dedupeGeneratedArtifacts(stateWithBoth);

    // 两个 episode 来源不同,不应被去重 — 改前此断言 FAIL
    expect(result.removed.podcastEpisodes).toBe(0);
    expect(result.nextState.podcastEpisodes).toHaveLength(2);
  });

  it("deduplicates two identical-source episodes when sourceType+sourceId+format+voice+title all match", () => {
    // 同 sourceType+sourceId 的真重复仍应被去重
    const ep1 = makeEpisode({ id: "ep-3", sourceType: "note", sourceId: "note-abc", noteId: "note-abc" });
    const ep2 = makeEpisode({ id: "ep-4", sourceType: "note", sourceId: "note-abc", noteId: "note-abc" });

    const base = createInitialProductState();
    const stateWithDups: typeof base = {
      ...base,
      podcastEpisodes: [ep1, ep2]
    };

    const result = dedupeGeneratedArtifacts(stateWithDups);

    expect(result.removed.podcastEpisodes).toBe(1);
    expect(result.nextState.podcastEpisodes).toHaveLength(1);
  });

  it("note-source episode key is stable — noteId still usable as fallback when sourceType/sourceId absent", () => {
    // 兼容性:当 sourceType/sourceId 缺失时,回退到 noteId 逻辑
    const epWithoutSource = makeEpisode({
      id: "ep-5",
      noteId: "legacy-note-id",
      sourceType: undefined,
      sourceId: undefined
    });
    const epWithoutSourceDup = makeEpisode({
      id: "ep-6",
      noteId: "legacy-note-id",
      sourceType: undefined,
      sourceId: undefined
    });

    const base = createInitialProductState();
    const stateWithLegacy: typeof base = {
      ...base,
      podcastEpisodes: [epWithoutSource, epWithoutSourceDup]
    };

    const result = dedupeGeneratedArtifacts(stateWithLegacy);

    // 无 sourceType/sourceId 的旧格式,noteId 相同时仍去重
    expect(result.removed.podcastEpisodes).toBe(1);
    expect(result.nextState.podcastEpisodes).toHaveLength(1);
  });
});
