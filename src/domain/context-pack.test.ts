import { describe, expect, it } from "vitest";
import { buildInterviewCard, buildInterviewContextPack, buildInterviewGuide, buildSemanticRagContext, scoreMemoryForRetrieval } from "./context-pack";
import { createInitialProductState } from "./engine";
import type { MemoryCorrection, MemoryRecord, RagChunk, ImportSource, SearchBrief } from "./types";

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

    // Without explicit searchBriefId, falls back to briefs[0] — still resolves
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
    // briefs[0] 未追踪，briefs[1] 追踪
    const untrackedFirst = makeTrackedBrief("brief-untracked-first", false);
    const trackedSecond = makeTrackedBrief("brief-tracked-second", true);
    state.searchBriefs = [untrackedFirst, trackedSecond];

    // 关键：不传 searchBriefId，断言选中 tracked 的 brief
    const contextPack = buildInterviewContextPack(state, {});

    expect(contextPack.searchBriefs.length).toBeGreaterThan(0);
    const found = contextPack.searchBriefs.find((b) => b.id === "brief-tracked-second");
    expect(found).toBeDefined();
    expect(found?.tracked).toBe(true);
    // [0] 的 untracked brief 不应被选中
    const wrongBrief = contextPack.searchBriefs.find((b) => b.id === "brief-untracked-first");
    expect(wrongBrief).toBeUndefined();
  });

  it("全无 tracked brief 时回退到 briefs[0]（原有行为保持）", () => {
    const state = createInitialProductState();
    state.systemConfig = {
      ...state.systemConfig,
      search: { ...state.systemConfig.search, allowWebInInterview: true }
    };
    const brief0 = makeTrackedBrief("brief-fallback-0", false);
    const brief1 = makeTrackedBrief("brief-fallback-1", false);
    state.searchBriefs = [brief0, brief1];

    const contextPack = buildInterviewContextPack(state, {});

    expect(contextPack.searchBriefs.length).toBeGreaterThan(0);
    expect(contextPack.searchBriefs[0].id).toBe("brief-fallback-0");
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
