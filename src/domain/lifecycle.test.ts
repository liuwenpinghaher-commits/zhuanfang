import { describe, expect, it } from "vitest";
import {
  analyzeImportedInterview,
  approvePlaybookPatch,
  buildSearchBrief,
  createEmptyProductState,
  createInitialProductState,
  generatePodcastEpisode
} from "./engine";
import {
  deleteCorpusInsightBundle,
  deletePodcastEpisode,
  deleteSearchBrief,
  discardEmptyActiveInterviewSession,
  dedupeGeneratedArtifacts,
  forgetSessionNote
} from "./lifecycle";
import type {
  DecisionAsset,
  DualTrackNote,
  InterviewSession,
  KnowledgeDebt,
  MemoryCandidate,
  MemoryRecord,
  PodcastEpisode,
  PointAsset,
  ProductState,
  QuestionAsset
} from "./types";

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


describe("discardEmptyActiveInterviewSession", () => {
  it("removes active sessions with zero user turns", () => {
    const base = createInitialProductState();
    const card = {
      title: "t",
      whyNow: "w",
      suggestedOpening: "o",
      historyReferences: [] as string[],
      potentialTension: "p",
      suggestedPerspectives: [] as string[],
      likelyOutputs: [] as string[]
    };
    const guide = {
      topicHint: "x",
      dailyBrief: { suggestedTopic: "x", openingQuestion: "o", contextNote: "c" },
      perspectiveCoverage: {} as Record<string, number>,
      missingPerspectives: [] as string[],
      recommendedPerspectives: [] as string[],
      perspectiveRationale: [] as string[],
      relevantMemories: [] as string[],
      availableReferences: [] as never[],
      graphReferences: [] as never[],
      opinionEvolution: [] as never[],
      statedPositions: [] as string[],
      openDebts: [] as string[],
      decisionsToReview: [] as string[],
      blindspotCandidates: [] as string[],
      knowledgeFragments: [] as string[],
      suggestedOpening: "o",
      strategyChecklist: [] as string[]
    };
    const empty = {
      id: "session-empty-1",
      mode: "daily" as const,
      strength: "standard" as const,
      status: "active" as const,
      title: "空会话",
      card,
      guide,
      turns: [] as never[],
      startedAt: "2026-06-01T00:00:00.000Z"
    };
    const withSession = { ...base, sessions: [empty] };
    const next = discardEmptyActiveInterviewSession(withSession as never, "session-empty-1");
    expect(next).not.toBeNull();
    expect(next!.sessions).toHaveLength(0);
  });

  it("returns null when user already spoke", () => {
    const base = createInitialProductState();
    const card = {
      title: "t",
      whyNow: "w",
      suggestedOpening: "o",
      historyReferences: [] as string[],
      potentialTension: "p",
      suggestedPerspectives: [] as string[],
      likelyOutputs: [] as string[]
    };
    const guide = {
      topicHint: "x",
      dailyBrief: { suggestedTopic: "x", openingQuestion: "o", contextNote: "c" },
      perspectiveCoverage: {} as Record<string, number>,
      missingPerspectives: [] as string[],
      recommendedPerspectives: [] as string[],
      perspectiveRationale: [] as string[],
      relevantMemories: [] as string[],
      availableReferences: [] as never[],
      graphReferences: [] as never[],
      opinionEvolution: [] as never[],
      statedPositions: [] as string[],
      openDebts: [] as string[],
      decisionsToReview: [] as string[],
      blindspotCandidates: [] as string[],
      knowledgeFragments: [] as string[],
      suggestedOpening: "o",
      strategyChecklist: [] as string[]
    };
    const busy = {
      id: "session-busy-1",
      mode: "daily" as const,
      strength: "standard" as const,
      status: "active" as const,
      title: "进行中",
      card,
      guide,
      turns: [{ id: "t1", role: "user" as const, content: "hi", createdAt: "2026-06-01T00:00:01.000Z" }],
      startedAt: "2026-06-01T00:00:00.000Z"
    };
    const withSession = { ...base, sessions: [busy] };
    expect(discardEmptyActiveInterviewSession(withSession as never, "session-busy-1")).toBeNull();
  });
});

function forgetNote(id: string, sessionId: string): DualTrackNote {
  return {
    id,
    sessionId,
    title: `笔记-${id}`,
    summary: "摘要",
    keyQuote: "原话",
    saidTrack: ["我说了"],
    learnedTrack: ["我学到"],
    nextQuestions: [],
    createdAt: "2026-08-01T00:00:00.000Z"
  };
}

function forgetSession(id: string): InterviewSession {
  return {
    id,
    mode: "daily",
    strength: "standard",
    status: "completed",
    title: "已完成",
    card: {
      title: "t",
      whyNow: "w",
      suggestedOpening: "o",
      historyReferences: [],
      potentialTension: "p",
      suggestedPerspectives: [],
      likelyOutputs: []
    },
    guide: {
      topicHint: "x",
      dailyBrief: { suggestedTopic: "x", openingQuestion: "o", contextNote: "c" },
      perspectiveCoverage: {},
      missingPerspectives: [],
      recommendedPerspectives: [],
      perspectiveRationale: "",
      relevantMemories: [],
      availableReferences: [],
      graphReferences: [],
      opinionEvolution: [],
      statedPositions: [],
      openDebts: [],
      decisionsToReview: [],
      blindspotCandidates: [],
      knowledgeFragments: [],
      suggestedOpening: "o",
      strategyChecklist: []
    },
    turns: [],
    startedAt: "2026-08-01T00:00:00.000Z",
    completedAt: "2026-08-01T01:00:00.000Z"
  };
}

function forgetPoint(id: string, extra: Partial<PointAsset> = {}): PointAsset {
  return {
    id,
    title: `观点-${id}`,
    content: "内容",
    status: "稳定观点",
    confidence: "AI 推断",
    evidence: ["证"],
    important: false,
    updatedAt: "2026-08-01T00:00:00.000Z",
    sourceSessionId: extra.sourceSessionId ?? "s1",
    ...extra
  };
}

function forgetQuestion(id: string, extra: Partial<QuestionAsset> = {}): QuestionAsset {
  return {
    id,
    question: `问题-${id}`,
    whyImportant: "重要",
    status: "开放",
    appearances: 1,
    nextPrompt: "下句",
    important: false,
    updatedAt: "2026-08-01T00:00:00.000Z",
    sourceSessionId: extra.sourceSessionId ?? "s1",
    ...extra
  };
}

function forgetDecision(id: string, extra: Partial<DecisionAsset> = {}): DecisionAsset {
  return {
    id,
    title: `决策-${id}`,
    decisionKind: "候选决策",
    confirmationStatus: "待用户确认",
    choice: "选",
    tradeOff: "取舍",
    riskHypothesis: "风险",
    reviewAt: "2026-09-01",
    status: "待复盘",
    updatedAt: "2026-08-01T00:00:00.000Z",
    sourceSessionId: extra.sourceSessionId ?? "s1",
    ...extra
  };
}

function forgetDebt(id: string, extra: Partial<KnowledgeDebt> = {}): KnowledgeDebt {
  return {
    id,
    concept: `债-${id}`,
    context: "背景",
    whyImportant: "重要",
    status: "待了解",
    nextQuestion: "下一问",
    updatedAt: "2026-08-01T00:00:00.000Z",
    sourceSessionId: extra.sourceSessionId ?? "s1",
    ...extra
  };
}

function forgetCandidate(id: string, extra: Partial<MemoryCandidate> = {}): MemoryCandidate {
  return {
    id,
    text: `候选-${id}`,
    status: "pending",
    sourceType: "interview_session",
    sourceId: "s1",
    evidenceQuote: "原话",
    reason: "抽出",
    sensitivity: "normal",
    reviewScore: 70,
    reviewSignals: [],
    createdAt: "2026-08-01T00:00:00.000Z",
    ...extra
  };
}

function forgetRecord(id: string, extra: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    id,
    text: `记忆-${id}`,
    status: "confirmed",
    sourceType: "interview_session",
    sourceId: "s1",
    evidenceQuote: "原话",
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
    ...extra
  };
}

function forgetState(overrides: Partial<ProductState> = {}): ProductState {
  return {
    ...createEmptyProductState(),
    notes: [forgetNote("n1", "s1"), forgetNote("n2", "s2")],
    sessions: [forgetSession("s1"), forgetSession("s2")],
    themes: [
      {
        id: "th1",
        name: "主题线",
        summary: "跨场",
        maturity: "重复",
        representativeQuote: "原话",
        appearances: 2,
        nextQuestion: "下一问",
        updatedAt: "2026-08-01T00:00:00.000Z"
      }
    ],
    importSources: [
      {
        id: "imp1",
        title: "导入",
        sourceType: "text",
        content: "素材",
        status: "chunked",
        sensitivity: "normal",
        chunkIds: [],
        createdAt: "2026-08-01T00:00:00.000Z",
        updatedAt: "2026-08-01T00:00:00.000Z"
      }
    ],
    ...overrides
  };
}

describe("forgetSessionNote", () => {
  it("returns null when the note is missing", () => {
    expect(forgetSessionNote(createEmptyProductState(), "missing")).toBeNull();
  });

  it("default: removes this note and session, keeps exclusive and merged assets, strips this session from merged", () => {
    const state = forgetState({
      points: [
        forgetPoint("p-only", { sourceSessionId: "s1" }),
        forgetPoint("p-shared", {
          sourceSessionId: "s1",
          appearedInSessionIds: ["s1", "s2"],
          evidenceAnchors: [
            { sessionId: "s1", turnId: "t1" },
            { sessionId: "s2", turnId: "t2" }
          ]
        })
      ],
      debts: [forgetDebt("d-only", { sourceSessionId: "s1" })],
      questions: [forgetQuestion("q-s2", { sourceSessionId: "s2" })],
      memoryCandidates: [
        forgetCandidate("c-s1"),
        forgetCandidate("c-s2", { sourceId: "s2" })
      ],
      memoryRecords: [
        forgetRecord("m-s1", { evidenceAnchors: [{ sessionId: "s1", turnId: "t1" }] })
      ],
      podcastEpisodes: [
        {
          id: "ep-note",
          noteId: "n1",
          sourceType: "note",
          sourceId: "n1",
          title: "本场播客",
          format: "solo",
          voice: "calm-host",
          status: "draft",
          scriptReviewStatus: "待确认",
          durationSec: 10,
          script: "稿",
          chapters: [],
          audioUrl: "local-audio://ep-note.wav",
          shownotes: [],
          createdAt: "2026-08-01T00:00:00.000Z"
        },
        {
          id: "ep-other",
          noteId: "n2",
          sourceType: "note",
          sourceId: "n2",
          title: "别的场",
          format: "solo",
          voice: "calm-host",
          status: "draft",
          scriptReviewStatus: "待确认",
          durationSec: 10,
          script: "稿",
          chapters: [],
          audioUrl: "local-audio://ep-other.wav",
          shownotes: [],
          createdAt: "2026-08-01T00:00:00.000Z"
        }
      ],
      interviewAnnotations: [
        { id: "a1", sessionId: "s1", turnId: "t1", text: "旁注", createdAt: "2026-08-01T00:00:00.000Z" },
        { id: "a2", sessionId: "s2", turnId: "t1", text: "别场", createdAt: "2026-08-01T00:00:00.000Z" }
      ]
    });

    const result = forgetSessionNote(state, "n1");
    expect(result).not.toBeNull();
    const { nextState, receipt } = result!;

    expect(nextState.notes.map((n) => n.id)).toEqual(["n2"]);
    expect(nextState.sessions.map((s) => s.id)).toEqual(["s2"]);
    expect(nextState.points.map((p) => p.id).sort()).toEqual(["p-only", "p-shared"]);
    expect(nextState.debts.map((d) => d.id)).toEqual(["d-only"]);
    expect(nextState.questions.map((q) => q.id)).toEqual(["q-s2"]);
    expect(nextState.memoryCandidates.map((c) => c.id)).toEqual(["c-s2"]);
    expect(nextState.memoryRecords.map((m) => m.id)).toEqual(["m-s1"]);
    expect(nextState.podcastEpisodes.map((e) => e.id)).toEqual(["ep-other"]);
    expect(nextState.interviewAnnotations.map((a) => a.id)).toEqual(["a2"]);
    expect(nextState.themes).toHaveLength(1);
    expect(nextState.importSources).toHaveLength(1);

    const shared = nextState.points.find((p) => p.id === "p-shared")!;
    expect(shared.appearedInSessionIds).toEqual(["s2"]);
    expect(shared.evidenceAnchors).toEqual([{ sessionId: "s2", turnId: "t2" }]);
    expect(shared.sourceSessionId).toBe("s1");

    expect(receipt.removed.note).toBe(true);
    expect(receipt.removed.session).toBe(true);
    expect(receipt.removed.exclusivePoints).toBe(0);
    expect(receipt.removed.pendingMemories).toBe(1);
    expect(receipt.removed.podcasts).toBe(1);
    expect(receipt.keptShared.points).toBe(2);
    expect(state.notes).toHaveLength(2);
    expect(nextState.auditEvents[0]?.type).toBe("session_note_forgotten");
  });

  it("exclusiveAssets: deletes session-only debt/point, keeps merged point with this session stripped", () => {
    const state = forgetState({
      points: [
        forgetPoint("p-only", { sourceSessionId: "s1" }),
        forgetPoint("p-shared", {
          sourceSessionId: "s2",
          appearedInSessionIds: ["s2", "s1"]
        })
      ],
      debts: [forgetDebt("d-only", { sourceSessionId: "s1" })],
      decisions: [forgetDecision("de-shared", { sourceSessionId: "s2", appearedInSessionIds: ["s2", "s1"] })]
    });

    const result = forgetSessionNote(state, "n1", { exclusiveAssets: true });
    expect(result).not.toBeNull();
    const { nextState, receipt } = result!;

    expect(nextState.points.map((p) => p.id)).toEqual(["p-shared"]);
    expect(nextState.points[0].appearedInSessionIds).toEqual(["s2"]);
    expect(nextState.debts).toHaveLength(0);
    expect(nextState.decisions.map((d) => d.id)).toEqual(["de-shared"]);
    expect(nextState.decisions[0].appearedInSessionIds).toEqual(["s2"]);
    expect(receipt.removed.exclusivePoints).toBe(1);
    expect(receipt.removed.exclusiveDebts).toBe(1);
    expect(receipt.keptShared.points).toBe(1);
    expect(nextState.themes).toHaveLength(1);
  });

  it("confirmedMemory: deletes records whose evidence is only this session; keeps records that also cite another session", () => {
    const state = forgetState({
      memoryRecords: [
        forgetRecord("m-only", { evidenceAnchors: [{ sessionId: "s1", turnId: "t1" }] }),
        forgetRecord("m-shared", {
          sourceId: "s1",
          evidenceAnchors: [
            { sessionId: "s1", turnId: "t1" },
            { sessionId: "s2", turnId: "t9" }
          ]
        }),
        forgetRecord("m-other", { sourceId: "s2", evidenceAnchors: [{ sessionId: "s2", turnId: "t2" }] })
      ]
    });

    const kept = forgetSessionNote(state, "n1");
    expect(kept!.nextState.memoryRecords.map((m) => m.id).sort()).toEqual(["m-only", "m-other", "m-shared"]);

    const gone = forgetSessionNote(state, "n1", { confirmedMemory: true });
    expect(gone!.nextState.memoryRecords.map((m) => m.id).sort()).toEqual(["m-other", "m-shared"]);
    const shared = gone!.nextState.memoryRecords.find((m) => m.id === "m-shared")!;
    expect(shared.evidenceAnchors).toEqual([{ sessionId: "s2", turnId: "t9" }]);
    expect(gone!.receipt.removed.confirmedMemories).toBe(1);
  });

  it("does not delete a search-brief podcast that only shares noteId by collision", () => {
    const state = forgetState({
      podcastEpisodes: [
        {
          id: "ep-collision",
          noteId: "n1",
          sourceType: "search-brief",
          sourceId: "n1",
          title: "简报播客",
          format: "solo",
          voice: "calm-host",
          status: "draft",
          scriptReviewStatus: "待确认",
          durationSec: 10,
          script: "稿",
          chapters: [],
          audioUrl: "local-audio://x.wav",
          shownotes: [],
          createdAt: "2026-08-01T00:00:00.000Z"
        }
      ]
    });
    const result = forgetSessionNote(state, "n1");
    expect(result!.nextState.podcastEpisodes.map((e) => e.id)).toEqual(["ep-collision"]);
  });
});
