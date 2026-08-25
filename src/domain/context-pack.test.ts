import { describe, expect, it } from "vitest";
import { buildInterviewCard, buildInterviewContextPack, buildInterviewGuide, buildInterviewResumeCards, buildOpinionEvolution, buildPointContradictions, buildSemanticRagContext, createSessionDraft, scoreMemoryForRetrieval } from "./context-pack";
import { createEmptyProductState, createInitialProductState } from "./engine";
import type { MemoryCorrection, MemoryRecord, PointAsset, RagChunk, ImportSource, SearchBrief } from "./types";

// ─── helpers ─────────────────────────────────────────────────────────────────

function makeImportSource(id: string): ImportSource {
  return {
    id,
    title: `Source ${id}`,
    sourceType: "text",
    content: "test content",
    status: "chunked",
    sensitivity: "normal",
    chunkIds: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z"
  };
}

function makeRagChunk(id: string, sourceId: string, text: string, embedding?: number[]): RagChunk {
  return {
    id,
    sourceId,
    title: `Chunk ${id}`,
    text,
    keywords: [],
    tokenEstimate: Math.ceil(text.length / 2),
    usage: "interview-context",
    createdAt: "2026-01-01T00:00:00.000Z",
    ...(embedding !== undefined ? { embedding } : {})
  };
}

// ─── cosine retrieval tests ───────────────────────────────────────────────────

describe("buildSemanticRagContext — cosine retrieval", () => {
  it("ranks chunks by cosine similarity when query embedding provided", () => {
    const state = createInitialProductState();
    const source = makeImportSource("src-1");
    state.importSources = [source];

    // Three chunks with different embeddings; queryVec = [1,0,0]
    // chunkA: [1,0,0] → cosine=1 (most similar)
    // chunkB: [0,1,0] → cosine=0
    // chunkC: [0.7,0.7,0] → cosine≈0.707
    const chunkA = makeRagChunk("c-a", "src-1", "团队授权和直接下场", [1, 0, 0]);
    const chunkB = makeRagChunk("c-b", "src-1", "情感与沟通", [0, 1, 0]);
    const chunkC = makeRagChunk("c-c", "src-1", "管理风格与判断", [0.7, 0.7, 0]);
    state.ragChunks = [chunkA, chunkB, chunkC];

    const queryEmbedding = [1, 0, 0];
    const result = buildSemanticRagContext(state, "授权", 5, queryEmbedding);

    expect(result.chunks.length).toBeGreaterThan(0);
    // chunkA should rank first (cosine=1), chunkC second (cosine≈0.707)
    expect(result.chunks[0].id).toBe("c-a");
    if (result.chunks.length > 1) {
      expect(result.chunks[1].id).toBe("c-c");
    }
  });

  it("falls back to keyword scoring when no queryEmbedding provided", () => {
    const state = createInitialProductState();
    const source = makeImportSource("src-2");
    state.importSources = [source];

    // chunkX has the keyword "授权" (matches the topicHint), chunkY does not
    const chunkX = makeRagChunk("c-x", "src-2", "团队授权下场机制分析授权边界授权决策", [0, 0, 1]);
    const chunkY = makeRagChunk("c-y", "src-2", "完全不相关的段落 abc xyz", [1, 0, 0]);
    state.ragChunks = [chunkX, chunkY];

    // No queryEmbedding → should use keyword path
    const result = buildSemanticRagContext(state, "授权", 5);

    // chunkX should be returned via keyword match; chunkY should not score high enough
    expect(result.chunks.some((c) => c.id === "c-x")).toBe(true);
  });

  it("falls back to keyword scoring when chunks have no embeddings even if queryEmbedding is given", () => {
    const state = createInitialProductState();
    const source = makeImportSource("src-3");
    state.importSources = [source];

    // Chunks WITHOUT embedding fields
    const chunkA = makeRagChunk("c-a3", "src-3", "授权团队决策", undefined);
    const chunkB = makeRagChunk("c-b3", "src-3", "授权机制边界", undefined);
    state.ragChunks = [chunkA, chunkB];

    // queryEmbedding provided but chunks lack embeddings → keyword fallback
    const result = buildSemanticRagContext(state, "授权", 5, [1, 0, 0]);
    // Should still return results via keyword path
    expect(result.chunks.length).toBeGreaterThan(0);
  });

  it("returns empty when state has no ragChunks", () => {
    const state = createInitialProductState();
    state.ragChunks = [];
    const result = buildSemanticRagContext(state, "授权", 5, [1, 0, 0]);
    expect(result.chunks).toHaveLength(0);
  });
});

// ─── M3b: scoreMemoryForRetrieval — relevance + recency + importance ───────────

describe("scoreMemoryForRetrieval (M3b)", () => {
  it("ranks by relevance+recency+importance; substring fallback without embedding", () => {
    const now = "2026-06-20T00:00:00Z";
    const recent = {
      id: "a",
      text: "放权 信任",
      importance: 9,
      createdAt: "2026-06-19T00:00:00Z",
      lastAccessedAt: "2026-06-19T00:00:00Z"
    } as unknown as MemoryRecord;
    const old = {
      id: "b",
      text: "放权 信任",
      importance: 2,
      createdAt: "2026-01-01T00:00:00Z",
      lastAccessedAt: "2026-01-01T00:00:00Z"
    } as unknown as MemoryRecord;
    expect(scoreMemoryForRetrieval(recent, { topicTokens: ["放权"], now })).toBeGreaterThan(
      scoreMemoryForRetrieval(old, { topicTokens: ["放权"], now })
    );
  });

  it("uses cosine when both query and record embeddings present", () => {
    const now = "2026-06-20T00:00:00Z";
    const near = {
      id: "a",
      text: "x",
      embedding: [0.1, 0.2, 0.3],
      importance: 5,
      createdAt: now,
      lastAccessedAt: now
    } as unknown as MemoryRecord;
    const far = {
      id: "b",
      text: "x",
      embedding: [0.9, -0.2, 0.0],
      importance: 5,
      createdAt: now,
      lastAccessedAt: now
    } as unknown as MemoryRecord;
    const q = [0.1, 0.2, 0.31];
    expect(scoreMemoryForRetrieval(near, { topicTokens: [], queryEmbedding: q, now })).toBeGreaterThan(
      scoreMemoryForRetrieval(far, { topicTokens: [], queryEmbedding: q, now })
    );
  });

  it("recency uses lastAccessedAt, falls back to createdAt, and tolerates missing/invalid timestamps", () => {
    const now = "2026-06-20T00:00:00Z";
    // no lastAccessedAt → falls back to createdAt (recent)
    const fallbackToCreated = {
      id: "a",
      text: "放权",
      importance: 5,
      createdAt: "2026-06-19T00:00:00Z"
    } as unknown as MemoryRecord;
    // unparseable timestamps → recency floored to 0, but relevance+importance still scored
    const badTimestamps = {
      id: "b",
      text: "放权",
      importance: 5,
      createdAt: "not-a-date",
      lastAccessedAt: "also-bad"
    } as unknown as MemoryRecord;
    const goodScore = scoreMemoryForRetrieval(fallbackToCreated, { topicTokens: ["放权"], now });
    const badScore = scoreMemoryForRetrieval(badTimestamps, { topicTokens: ["放权"], now });
    expect(Number.isFinite(goodScore)).toBe(true);
    expect(Number.isFinite(badScore)).toBe(true);
    // recent createdAt beats unparseable (recency floored to 0)
    expect(goodScore).toBeGreaterThan(badScore);
  });
});

// ─── M3b: collectRelevantMemories surfaces importance via buildInterviewGuide ──

describe("collectRelevantMemories — confirmed memories ranked by score (M3b)", () => {
  it("a high-importance recent confirmed memory matching the topic appears in guide.relevantMemories", () => {
    const state = createInitialProductState();
    state.notes = []; state.points = []; state.questions = []; state.debts = [];
    // Theme drives the topicHint
    state.themes = [{
      id: "t1", name: "授权", summary: "团队授权",
      maturity: "聚焦", representativeQuote: "我要学会放手",
      appearances: 5, nextQuestion: "你最近放权了吗？", updatedAt: "2026-06-19T00:00:00.000Z"
    }];
    const salient: MemoryRecord = {
      id: "m-salient",
      text: "用户反复强调：授权团队后自己更焦虑",
      status: "confirmed",
      sourceType: "interview_session",
      sourceId: "s1",
      evidenceQuote: "授权团队后自己更焦虑",
      sensitivity: "normal",
      createdAt: "2026-06-19T00:00:00.000Z",
      updatedAt: "2026-06-19T00:00:00.000Z",
      importance: 9,
      lastAccessedAt: "2026-06-19T00:00:00.000Z"
    };
    state.memoryRecords = [salient];

    const guide = buildInterviewGuide(state);
    expect(guide.relevantMemories.length).toBeGreaterThan(0);
    expect(guide.relevantMemories.some((m) => m.includes("授权团队后自己更焦虑"))).toBe(true);
  });
});

// ─── original context-pack tests (must remain passing) ────────────────────────

describe("context-pack (de-hardcoded)", () => {
  it("显式专访主题贯穿标题、开场和首条主题参照", () => {
    const state = createInitialProductState();
    const topic = "企业如何进行 AI Native 转型";

    const card = buildInterviewCard(state, undefined, topic);

    expect(card.title).toContain(topic);
    expect(card.suggestedOpening).toContain(topic);
    expect(card.historyReferences[0]).toContain(topic);
  });

  it("does not parrot the 救火/控制感 demo when the user's themes are unrelated", () => {
    const state = createInitialProductState();
    state.themes = [{
      id: "t1", name: "搬家焦虑", summary: "关于搬到新城市的不安",
      maturity: "聚焦", representativeQuote: "我怕在新城市没有朋友",
      appearances: 3, nextQuestion: "你最担心失去什么？", updatedAt: new Date().toISOString()
    }];
    state.points = []; state.questions = []; state.debts = []; state.notes = [];
    const card = buildInterviewCard(state);
    expect(card.title).not.toContain("救火");
    expect(card.potentialTension).not.toContain("授权");
    expect(`${card.title} ${card.whyNow} ${card.suggestedOpening} ${card.potentialTension}`).toMatch(/搬家|新城市|朋友|焦虑/);
  });

  it("produces neutral card fields when the user has no themes (clean-start)", () => {
    const state = createInitialProductState();
    state.themes = []; state.points = []; state.questions = []; state.debts = []; state.notes = [];
    const card = buildInterviewCard(state);
    expect(card.title).toBe("今天想聊点什么？");
    expect(card.whyNow.length).toBeGreaterThan(0);
    expect(card.suggestedOpening.length).toBeGreaterThan(0);
    expect(card.potentialTension.length).toBeGreaterThan(0);
    expect(`${card.title}${card.whyNow}${card.potentialTension}`).not.toMatch(/救火|授权/);
  });

  it("empty product state opening does not claim a selected asset or seed focus", () => {
    const state = createEmptyProductState();
    const card = buildInterviewCard(state);
    const session = createSessionDraft(state, "daily");
    const opening = `${card.title} ${card.whyNow} ${card.suggestedOpening} ${session.card.suggestedOpening} ${session.guide.suggestedOpening}`;
    expect(opening).not.toContain("从你选中的资产继续");
    expect(opening).not.toContain("资产库中选中");
    expect(opening).not.toContain("把语音专访式日记从 demo 梳理成真正能长期使用的认知产品");
    expect(session.guide.topicHint).not.toBe("把语音专访式日记从 demo 梳理成真正能长期使用的认知产品");
  });

  it("blindspot candidates never leak the 救火/授权 demo persona", () => {
    for (const themes of [[], [{ id: "t1", name: "搬家焦虑", summary: "搬到新城市的不安", maturity: "聚焦" as const, representativeQuote: "怕没朋友", appearances: 2, nextQuestion: "最担心失去什么？", updatedAt: new Date().toISOString() }]]) {
      const state = createInitialProductState();
      state.themes = themes; state.points = []; state.questions = []; state.debts = []; state.notes = []; state.memoryRecords = []; state.memoryCandidates = [];
      const guide = buildInterviewGuide(state);
      for (const b of guide.blindspotCandidates) {
        expect(`${b.concept} ${b.reason}`).not.toMatch(/救火|授权/);
      }
    }
  });
});

describe("buildInterviewResumeCards", () => {
  it("返回全部 active 会话并按最近更新排序，不隐藏较早的未完成专访", () => {
    const state = createInitialProductState();
    const older = createSessionDraft(state, "daily", "standard", { topicHint: "较早主题" });
    const newer = createSessionDraft(state, "organization", "standard", { topicHint: "较新主题" });
    older.startedAt = "2026-07-17T08:00:00.000Z";
    newer.startedAt = "2026-07-17T09:00:00.000Z";
    state.sessions = [older, newer];

    const cards = buildInterviewResumeCards(state);

    expect(cards.map((card) => card.sessionId)).toEqual([newer.id, older.id]);
    expect(cards.map((card) => card.currentTopic)).toEqual(["较新主题", "较早主题"]);
  });
});

// ─── tracked brief → 喂专访断言 (R3) ─────────────────────────────────────────

describe("tracked SearchBrief → buildInterviewContextPack", () => {
  it("tracked:true brief appears in contextPack.searchBriefs (验证追踪产出真喂专访)", () => {
    const state = createInitialProductState();
    // allowWebInInterview defaults to true in seed; ensure it is set
    state.systemConfig = {
      ...state.systemConfig,
      search: { ...state.systemConfig.search, allowWebInInterview: true }
    };

    const trackedBrief = {
      id: "brief-tracked-001",
      topic: "AI 产品持续追踪主题",
      provider: "local-demo" as const,
      status: "ready" as const,
      summary: "持续追踪的外部调研摘要",
      facts: ["持续追踪事实"],
      controversies: ["持续追踪争议"],
      opposingViews: ["持续追踪反方"],
      interviewAngles: ["专访角度"],
      discussionTopics: ["讨论主题"],
      sourceAngles: ["素材角度"],
      sources: [],
      sourceTrace: [],
      appliedToSessionIds: [],
      createdAt: new Date().toISOString(),
      tracked: true
    };

    state.searchBriefs = [trackedBrief];

    const contextPack = buildInterviewContextPack(state, { searchBriefId: trackedBrief.id });

    // The tracked brief must be present in the context pack's searchBriefs array
    expect(contextPack.searchBriefs.length).toBeGreaterThan(0);
    const found = contextPack.searchBriefs.find((b) => b.id === trackedBrief.id);
    expect(found).toBeDefined();
    expect(found?.tracked).toBe(true);
  });

  it("tracked:false brief (no explicit searchBriefId) still appears as first brief via default resolution", () => {
    const state = createInitialProductState();
    state.systemConfig = {
      ...state.systemConfig,
      search: { ...state.systemConfig.search, allowWebInInterview: true }
    };

    const untrackedBrief = {
      id: "brief-untracked-001",
      topic: "未追踪主题",
      provider: "local-demo" as const,
      status: "ready" as const,
      summary: "未追踪摘要",
      facts: [],
      controversies: [],
      opposingViews: [],
      interviewAngles: [],
      discussionTopics: [],
      sourceAngles: [],
      sources: [],
      sourceTrace: [],
      appliedToSessionIds: [],
      createdAt: new Date().toISOString(),
      tracked: false
    };

    state.searchBriefs = [untrackedBrief];
    // C-P2-02: auto-inject requires topic overlap with profile/theme signal
    state.profile = { ...state.profile, currentFocus: untrackedBrief.topic };

    const contextPack = buildInterviewContextPack(state, {});
    expect(contextPack.searchBriefs.length).toBeGreaterThan(0);
    expect(contextPack.searchBriefs[0].id).toBe(untrackedBrief.id);
  });
});

describe("R4: corrections 有界化", () => {
  it("超过 20 条 memoryCorrections 时 context pack 中最多保留 20 条", () => {
    const state = createInitialProductState();
    // 构造 25 条 corrections，createdAt 各不相同
    const corrections: MemoryCorrection[] = Array.from({ length: 25 }, (_, i) => ({
      id: `corr-${i + 1}`,
      text: `correction ${i + 1}`,
      createdAt: new Date(Date.UTC(2026, 0, i + 1)).toISOString()
    }));
    state.memoryCorrections = corrections;

    const contextPack = buildInterviewContextPack(state, {});

    expect(contextPack.corrections.length).toBeLessThanOrEqual(20);
  });

  it("保留的是最近的 20 条（createdAt 最大的）", () => {
    const state = createInitialProductState();
    const corrections: MemoryCorrection[] = Array.from({ length: 25 }, (_, i) => ({
      id: `corr-${i + 1}`,
      text: `correction ${i + 1}`,
      createdAt: new Date(Date.UTC(2026, 0, i + 1)).toISOString() // day 1..25
    }));
    state.memoryCorrections = corrections;

    const contextPack = buildInterviewContextPack(state, {});

    // 最近的 20 条应为 day 6..25（id corr-6 到 corr-25）
    const ids = contextPack.corrections.map((c) => c.id);
    expect(ids).toContain("corr-25");
    expect(ids).toContain("corr-6");
    expect(ids).not.toContain("corr-5");
    expect(ids).not.toContain("corr-1");
  });

  it("corrections 不足 20 条时全部保留", () => {
    const state = createInitialProductState();
    const corrections: MemoryCorrection[] = Array.from({ length: 10 }, (_, i) => ({
      id: `corr-${i + 1}`,
      text: `correction ${i + 1}`,
      createdAt: new Date(Date.UTC(2026, 0, i + 1)).toISOString()
    }));
    state.memoryCorrections = corrections;

    const contextPack = buildInterviewContextPack(state, {});

    expect(contextPack.corrections.length).toBe(10);
  });
});

// ─── tracked brief 自动喂专访（真验证，不绕过 searchBriefId）─────────────────

function makeTrackedBrief(id: string, tracked: boolean): SearchBrief {
  return {
    id,
    topic: `topic-${id}`,
    provider: "local-demo" as const,
    status: "ready" as const,
    summary: `摘要-${id}`,
    facts: [`事实-${id}`],
    controversies: [`争议-${id}`],
    opposingViews: [`反方-${id}`],
    interviewAngles: [`角度-${id}`],
    discussionTopics: [`讨论-${id}`],
    sourceAngles: [`来源-${id}`],
    sources: [],
    sourceTrace: [],
    appliedToSessionIds: [],
    createdAt: new Date().toISOString(),
    tracked
  };
}

describe("tracked brief 自动选择（无显式 searchBriefId）", () => {
  it("多个 brief 中非首位的 tracked:true，不传 searchBriefId 时选中 tracked brief 而非 [0]", () => {
    const state = createInitialProductState();
    state.systemConfig = {
      ...state.systemConfig,
      search: { ...state.systemConfig.search, allowWebInInterview: true }
    };
    // briefs[0] 未追踪，briefs[1] 追踪；topicSignal 对齐 tracked 主题
    const untrackedFirst = makeTrackedBrief("brief-untracked-first", false);
    const trackedSecond = makeTrackedBrief("brief-tracked-second", true);
    state.searchBriefs = [untrackedFirst, trackedSecond];
    state.profile = { ...state.profile, currentFocus: trackedSecond.topic };

    // 关键：不传 searchBriefId，断言选中 tracked 的 brief（且与 currentFocus 有主题重叠）
    const contextPack = buildInterviewContextPack(state, {});

    expect(contextPack.searchBriefs.length).toBeGreaterThan(0);
    const found = contextPack.searchBriefs.find((b) => b.id === "brief-tracked-second");
    expect(found).toBeDefined();
    expect(found?.tracked).toBe(true);
    // [0] 的 untracked brief 不应被选中
    const wrongBrief = contextPack.searchBriefs.find((b) => b.id === "brief-untracked-first");
    expect(wrongBrief).toBeUndefined();
  });

  it("全无 tracked brief 时：与 currentFocus 重叠的 [0] 仍可自动注入", () => {
    const state = createInitialProductState();
    state.systemConfig = {
      ...state.systemConfig,
      search: { ...state.systemConfig.search, allowWebInInterview: true }
    };
    const brief0 = makeTrackedBrief("brief-fallback-0", false);
    const brief1 = makeTrackedBrief("brief-fallback-1", false);
    state.searchBriefs = [brief0, brief1];
    state.profile = { ...state.profile, currentFocus: brief0.topic };

    const contextPack = buildInterviewContextPack(state, {});

    expect(contextPack.searchBriefs.length).toBeGreaterThan(0);
    expect(contextPack.searchBriefs[0].id).toBe("brief-fallback-0");
  });

  it("C-P2-02: tracked brief without topic overlap is not auto-injected", () => {
    const state = createInitialProductState();
    state.systemConfig = {
      ...state.systemConfig,
      search: { ...state.systemConfig.search, allowWebInInterview: true }
    };
    const tracked = makeTrackedBrief("brief-no-overlap", true);
    state.searchBriefs = [tracked];
    state.themes = [];
    state.profile = { ...state.profile, currentFocus: "完全无关的个人焦点词" };

    const contextPack = buildInterviewContextPack(state, {});
    expect(contextPack.searchBriefs.find((b) => b.id === "brief-no-overlap")).toBeUndefined();
  });

  it("显式传 searchBriefId 时按 id 找，不被 tracked 逻辑干扰", () => {
    const state = createInitialProductState();
    state.systemConfig = {
      ...state.systemConfig,
      search: { ...state.systemConfig.search, allowWebInInterview: true }
    };
    const trackedFirst = makeTrackedBrief("brief-tracked-first", true);
    const explicitTarget = makeTrackedBrief("brief-explicit-target", false);
    state.searchBriefs = [trackedFirst, explicitTarget];

    // 显式指定第二个 brief（非 tracked）
    const contextPack = buildInterviewContextPack(state, { searchBriefId: "brief-explicit-target" });

    expect(contextPack.searchBriefs.length).toBeGreaterThan(0);
    expect(contextPack.searchBriefs.find((b) => b.id === "brief-explicit-target")).toBeDefined();
  });
});

// ─── M4: single source of truth = memoryRecords (drop profile parallel store) ──

describe("M4: context memory source = memoryRecords only", () => {
  it("memoryRecords 为空时 contextPack 的记忆来源也为空（不被其它来源混入）", () => {
    const state = createInitialProductState();
    state.memoryRecords = [];
    state.memoryCandidates = [];

    const contextPack = buildInterviewContextPack(state, {});

    expect(contextPack.memoryRecords).toHaveLength(0);
    expect(contextPack.confirmedMemories).toHaveLength(0);
  });

  it("memoryRecords 有 confirmed 记录时正确进入 contextPack.memoryRecords", () => {
    const state = createInitialProductState();
    const record: MemoryRecord = {
      id: "m-test-1",
      text: "来自 memoryRecords 的真实记忆",
      status: "confirmed",
      sourceType: "interview_session",
      sourceId: "s1",
      evidenceQuote: "真实记忆",
      sensitivity: "normal",
      createdAt: "2026-06-20T00:00:00.000Z",
      updatedAt: "2026-06-20T00:00:00.000Z"
    };
    state.memoryRecords = [record];

    const contextPack = buildInterviewContextPack(state, {});

    expect(contextPack.memoryRecords.some((r) => r.text === "来自 memoryRecords 的真实记忆")).toBe(true);
  });
});

// ─── 轻量推理(欠账②):buildOpinionEvolution 做实 ──────────────────────────────
describe("buildOpinionEvolution（做实:从 supersededByPointId 链产真实演化）", () => {
  const point = (id: string, overrides: Partial<PointAsset> = {}): PointAsset => ({
    id,
    title: `观点 ${id}`,
    content: `内容 ${id}`,
    status: "临时想法",
    confidence: "AI 推断",
    evidence: [],
    relatedThemeIds: [],
    important: false,
    updatedAt: "2026-06-27T00:00:00.000Z",
    ...overrides
  });

  it("有 supersededBy → 真实 oldView/newView/date/topic(共同主题名)", () => {
    const state = createInitialProductState();
    state.themes = [{ id: "th_1", name: "放权与拍板", summary: "", maturity: "聚焦", representativeQuote: "", appearances: 3, nextQuestion: "", updatedAt: "2026-06-27T00:00:00.000Z" }];
    state.points = [
      point("pt_old", { content: "凡事都该自己拍板", relatedThemeIds: ["th_1"], supersededByPointId: "pt_new", status: "已修正", updatedAt: "2026-06-01T00:00:00.000Z" }),
      point("pt_new", { content: "关键决策拍板,执行充分放权", relatedThemeIds: ["th_1"], updatedAt: "2026-06-20T00:00:00.000Z" })
    ];
    const evo = buildOpinionEvolution(state);
    expect(evo).toHaveLength(1);
    expect(evo[0]).toEqual({
      topic: "放权与拍板",
      oldView: "凡事都该自己拍板",
      newView: "关键决策拍板,执行充分放权",
      date: "2026-06-20T00:00:00.000Z"
    });
  });

  it("无任何 supersededBy 关系 → 空数组(诚实空,不再假拼 notes[0]+points[0])", () => {
    const state = createInitialProductState();
    state.notes = [{ id: "n1", sessionId: "s1", title: "t", summary: "s", keyQuote: "q", saidTrack: ["说过的话"], learnedTrack: [], nextQuestions: [], createdAt: "2026-06-27T00:00:00.000Z" }];
    state.points = [point("pt_1", { content: "孤立观点" })];
    expect(buildOpinionEvolution(state)).toEqual([]);
  });

  it("取代方 point 不存在(悬挂)→ 跳过该条,不产空壳", () => {
    const state = createInitialProductState();
    state.points = [point("pt_old", { supersededByPointId: "pt_ghost" })];
    expect(buildOpinionEvolution(state)).toEqual([]);
  });

  it("无共同主题 → topic 回退到任一方主题名;都没有 → 通用文案", () => {
    const state = createInitialProductState();
    state.themes = [{ id: "th_x", name: "只挂在新观点上的主题", summary: "", maturity: "萌芽", representativeQuote: "", appearances: 1, nextQuestion: "", updatedAt: "2026-06-27T00:00:00.000Z" }];
    state.points = [
      point("pt_old", { supersededByPointId: "pt_new", relatedThemeIds: [] }),
      point("pt_new", { relatedThemeIds: ["th_x"] })
    ];
    expect(buildOpinionEvolution(state)[0].topic).toBe("只挂在新观点上的主题");

    const state2 = createInitialProductState();
    state2.points = [point("a", { supersededByPointId: "b" }), point("b")];
    expect(buildOpinionEvolution(state2)[0].topic).toBe("长期主题");
  });

  it("多条 supersededBy → 多条演化", () => {
    const state = createInitialProductState();
    state.points = [
      point("o1", { supersededByPointId: "n1" }),
      point("n1"),
      point("o2", { supersededByPointId: "n2" }),
      point("n2")
    ];
    expect(buildOpinionEvolution(state)).toHaveLength(2);
  });

  it("buildPointContradictions(A):从 contradictsPointIds 派生对立对(symmetric 去重、字典序 title)", () => {
    const state = createInitialProductState();
    state.points = [
      point("pt_a", { title: "凡事自己拍板", contradictsPointIds: ["pt_b"] }),
      point("pt_b", { title: "充分放权", contradictsPointIds: ["pt_a"] }) // 双向软链
    ];
    const contras = buildPointContradictions(state);
    expect(contras).toHaveLength(1); // symmetric 去重:一对只出现一次
    expect(contras[0]).toEqual({ a: "凡事自己拍板", b: "充分放权" }); // 字典序 pt_a<pt_b
  });

  it("buildPointContradictions(A):指向不存在 point 的软链跳过(不产悬挂对)", () => {
    const state = createInitialProductState();
    state.points = [point("pt_a", { contradictsPointIds: ["pt_ghost"] })];
    expect(buildPointContradictions(state)).toEqual([]);
  });

  it("buildInterviewCard(A):card 带 opinionEvolution + contradictions(让 ② 前端可触达)", () => {
    const state = createInitialProductState();
    state.points = [
      point("pt_a", { title: "凡事自己拍板", contradictsPointIds: ["pt_b"] }),
      point("pt_b", { title: "充分放权", contradictsPointIds: ["pt_a"] })
    ];
    const card = buildInterviewCard(state);
    expect(card.contradictions).toHaveLength(1);
    expect(card.opinionEvolution).toBeDefined(); // 字段透出到 card(空数组也算可访问)
  });

  it("guide 消费:有 contradicts 软链 → strategyChecklist 出现对立观点复盘提示", () => {
    const state = createInitialProductState();
    state.points = [
      point("pt_a", { title: "应当集中拍板", relatedThemeIds: ["th_1"], contradictsPointIds: ["pt_b"] }),
      point("pt_b", { title: "应当充分放权", relatedThemeIds: ["th_1"], contradictsPointIds: ["pt_a"] })
    ];
    const guide = buildInterviewGuide(state);
    const hint = guide.strategyChecklist.find((line) => line.includes("对立看法"));
    expect(hint).toBeTruthy();
    expect(hint).toContain("应当集中拍板");
    expect(hint).toContain("应当充分放权");
  });

  it("guide 消费:无 contradicts → 不加复盘提示(checklist 无该行)", () => {
    const state = createInitialProductState();
    state.points = [point("pt_a", { relatedThemeIds: ["th_1"] })];
    const guide = buildInterviewGuide(state);
    expect(guide.strategyChecklist.some((line) => line.includes("对立看法"))).toBe(false);
  });
});

describe("审计修复(P2-10):statedPositions 排除终态观点", () => {
  it("guide.statedPositions 不含「已放弃」「已修正」,含「稳定观点」", () => {
    const state = createInitialProductState();
    const mkPoint = (id: string, title: string, status: PointAsset["status"]): PointAsset => ({
      id, title, content: `${title}的内容`, status, confidence: "用户确认",
      evidence: [], relatedThemeIds: [], important: false, updatedAt: "2026-06-27T00:00:00.000Z"
    });
    state.points = [
      mkPoint("p_live", "在世观点", "稳定观点"),
      mkPoint("p_abandoned", "已放弃观点", "已放弃"),
      mkPoint("p_revised", "已修正观点", "已修正")
    ];
    const guide = buildInterviewGuide(state, {});
    const joined = guide.statedPositions.join(" | ");
    expect(joined).toContain("在世观点");
    expect(joined).not.toContain("已放弃观点");
    expect(joined).not.toContain("已修正观点");
  });
});

describe("审计修复(P2·复盘闭环):decision.status「待复盘」驱动引导", () => {
  it("guide.decisionsToReview 收集【已确认+到复盘日】的待复盘决策(按距做出天数降序),已复盘不含", () => {
    const state = createInitialProductState();
    const past = new Date(Date.now() - 86400000).toISOString();   // reviewAt 已到期
    const mkDecision = (id: string, title: string, status: "待复盘" | "已复盘", updatedAt: string) => ({
      id, title, decisionKind: "候选决策" as const, confirmationStatus: "用户确认" as const,
      choice: `${title}的选择`, tradeOff: "", riskHypothesis: "", reviewAt: past, status,
      relatedThemeIds: [], nextPrompt: "", important: false, updatedAt
    });
    state.decisions = [
      mkDecision("d_old", "早决策", "待复盘", "2026-06-01T00:00:00.000Z"),
      mkDecision("d_new", "近决策", "待复盘", "2026-06-27T00:00:00.000Z"),
      mkDecision("d_done", "已复盘决策", "已复盘", "2026-06-10T00:00:00.000Z")
    ];
    const guide = buildInterviewGuide(state, {});
    const titles = guide.decisionsToReview.map((d) => d.title);
    expect(titles).toEqual(["早决策", "近决策"]);   // 待复盘且按 daysOpen 降序(早决策更久)
    expect(titles).not.toContain("已复盘决策");
    expect(guide.strategyChecklist.some((item) => item.includes("回顾决策") && item.includes("早决策"))).toBe(true);
  });

  it("R5-2:未确认(AI候选)/未到复盘日的待复盘决策不催复盘", () => {
    const state = createInitialProductState();
    const future = new Date(Date.now() + 30 * 86400000).toISOString();
    const base = { decisionKind: "候选决策" as const, choice: "选择", tradeOff: "", riskHypothesis: "", relatedThemeIds: [], nextPrompt: "", important: false, updatedAt: "2026-06-01T00:00:00.000Z", status: "待复盘" as const };
    state.decisions = [
      { ...base, id: "d_unconf", title: "未确认候选", confirmationStatus: "待用户确认", reviewAt: "" },        // 未确认→不催
      { ...base, id: "d_future", title: "未到复盘日", confirmationStatus: "用户确认", reviewAt: future }        // reviewAt 未到→不催
    ];
    const guide = buildInterviewGuide(state, {});
    expect(guide.decisionsToReview.map((d) => d.title)).toEqual([]);   // 两条都被门控挡住
    expect(guide.strategyChecklist.some((item) => item.includes("回顾决策"))).toBe(false);
  });

  it("无待复盘决策时 decisionsToReview 为空,checklist 不含复盘提示", () => {
    const state = createInitialProductState();
    state.decisions = [];   // 清掉 demo 种子的待复盘决策
    const guide = buildInterviewGuide(state, {});
    expect(guide.decisionsToReview).toEqual([]);
    expect(guide.strategyChecklist.some((item) => item.includes("回顾决策"))).toBe(false);
  });
});
