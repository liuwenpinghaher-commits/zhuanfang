import { describe, it, expect } from "vitest";
import { buildSessionArchive } from "./session-archive";
import type { ProductState, InterviewSession, DualTrackNote, PointAsset, QuestionAsset, DecisionAsset, KnowledgeDebt } from "./types";

function makeMinimalState(overrides: Partial<ProductState> = {}): ProductState {
  return {
    profile: {
      name: "Test",
      role: "PM",
      industry: "tech",
      currentFocus: "focus",
      longTermGoal: "goal",
      preferredStrength: "standard",
      explicitBoundaries: []
    },
    profileSuggestions: [],
    interviewAnnotations: [],
    chatSessions: [],
    sessions: [],
    notes: [],
    points: [],
    questions: [],
    decisions: [],
    debts: [],
    themes: [],
    memoryCorrections: [],
    memoryRecords: [],
    memoryCandidates: [],
    memoryEdges: [],
    searchBriefs: [],
    importSources: [],
    ragChunks: [],
    podcastEpisodes: [],
    corpusImports: [],
    corpusInsights: [],
    playbookPatches: [],
    configVersions: [],
    auditEvents: [],
    aiRunEvents: [],
    workflowRuns: [],
    operationalChecks: [],
    systemConfig: {
      version: "1",
      providers: [],
      search: { activeProvider: "local-demo", recencyDays: 7, maxSources: 5, allowWebInInterview: false },
      voice: { ttsProvider: "local-demo", defaultVoice: "default", podcastVoice: "default", podcastFormat: "solo", realtimeMode: "cascade" },
      models: { planningModel: "m", interviewModel: "m", synthesisModel: "m" },
      interview: { playbookVersion: "1", launchMode: "immersive", silenceHoldMs: 1000, maxFollowUpDepth: 3, guidanceEnabled: false, guidanceFrequency: "low", maxGuidancePerTurn: 2, minGuidanceIntervalMs: 5000, challengeBudgetPerSession: 2 },
      memory: { includeSensitiveMemoriesInContext: false, includePendingCandidatesInContext: false, externalMaterialMemoryPolicy: "review-only" }
    },
    revision: 1,
    ...overrides
  };
}

function makeSession(id: string, title = "会话"): InterviewSession {
  return {
    id,
    mode: "daily",
    strength: "standard",
    status: "completed",
    title,
    card: { title, whyNow: "", suggestedOpening: "", historyReferences: [], potentialTension: "", suggestedPerspectives: [], likelyOutputs: [] },
    guide: {
      topicHint: "",
      dailyBrief: { suggestedTopic: "", openingQuestion: "", contextNote: "" },
      perspectiveCoverage: {},
      missingPerspectives: [],
      recommendedPerspectives: [],
      perspectiveRationale: "",
      relevantMemories: [],
      graphReferences: [],
      opinionEvolution: [],
      statedPositions: [],
      openDebts: [],
      blindspotCandidates: [],
      knowledgeFragments: [],
      suggestedOpening: "",
      strategyChecklist: []
    },
    turns: [],
    startedAt: "2024-01-01T10:00:00.000Z"
  };
}

function makeNote(id: string, sessionId: string, createdAt: string): DualTrackNote {
  return {
    id,
    sessionId,
    title: `笔记-${id}`,
    summary: "summary",
    keyQuote: "quote",
    saidTrack: [],
    learnedTrack: [],
    nextQuestions: [],
    createdAt
  };
}

function makePoint(id: string, sourceSessionId?: string): PointAsset {
  return {
    id,
    title: `观点-${id}`,
    content: "content",
    status: "稳定观点",
    confidence: "AI 推断",
    evidence: [],
    relatedThemeIds: [],
    important: false,
    updatedAt: "2024-01-01T10:00:00.000Z",
    sourceSessionId
  };
}

function makeQuestion(id: string, sourceSessionId?: string): QuestionAsset {
  return {
    id,
    question: `问题-${id}`,
    whyImportant: "important",
    status: "开放",
    appearances: 1,
    relatedThemeIds: [],
    nextPrompt: "prompt",
    important: false,
    updatedAt: "2024-01-01T10:00:00.000Z",
    sourceSessionId
  };
}

function makeDecision(id: string, sourceSessionId?: string): DecisionAsset {
  return {
    id,
    title: `决策-${id}`,
    decisionKind: "候选决策",
    confirmationStatus: "待用户确认",
    choice: "choice",
    tradeOff: "tradeoff",
    riskHypothesis: "risk",
    reviewAt: "2025-01-01",
    status: "待复盘",
    updatedAt: "2024-01-01T10:00:00.000Z",
    sourceSessionId
  };
}

function makeDebt(id: string, sourceSessionId?: string): KnowledgeDebt {
  return {
    id,
    concept: `概念-${id}`,
    context: "context",
    whyImportant: "important",
    status: "待了解",
    nextQuestion: "next",
    updatedAt: "2024-01-01T10:00:00.000Z",
    sourceSessionId
  };
}

describe("buildSessionArchive", () => {
  it("空 state 返回空数组", () => {
    const state = makeMinimalState();
    expect(buildSessionArchive(state)).toEqual([]);
  });

  it("单 note 无资产时返回空资产列表", () => {
    const session = makeSession("s1");
    const note = makeNote("n1", "s1", "2024-01-01T10:00:00.000Z");
    const state = makeMinimalState({ sessions: [session], notes: [note] });

    const archive = buildSessionArchive(state);
    expect(archive).toHaveLength(1);
    expect(archive[0].note.id).toBe("n1");
    expect(archive[0].session?.id).toBe("s1");
    expect(archive[0].points).toEqual([]);
    expect(archive[0].questions).toEqual([]);
    expect(archive[0].decisions).toEqual([]);
    expect(archive[0].debts).toEqual([]);
  });

  it("note 聚合同 session 资产、不混入其他 session 的资产", () => {
    const s1 = makeSession("s1");
    const s2 = makeSession("s2");
    const note1 = makeNote("n1", "s1", "2024-01-02T10:00:00.000Z");
    const note2 = makeNote("n2", "s2", "2024-01-01T10:00:00.000Z");

    // s1 的资产
    const p1 = makePoint("p1", "s1");
    const q1 = makeQuestion("q1", "s1");
    const d1 = makeDecision("d1", "s1");
    const db1 = makeDebt("db1", "s1");

    // s2 的资产
    const p2 = makePoint("p2", "s2");
    const q2 = makeQuestion("q2", "s2");

    // 无 sourceSessionId 的资产（intel 路径等）
    const dbOrphan = makeDebt("db-orphan");

    const state = makeMinimalState({
      sessions: [s1, s2],
      notes: [note1, note2],
      points: [p1, p2],
      questions: [q1, q2],
      decisions: [d1],
      debts: [db1, dbOrphan]
    });

    const archive = buildSessionArchive(state);

    // 按 createdAt 倒序：n1(2024-01-02) 在前，n2(2024-01-01) 在后
    expect(archive).toHaveLength(2);
    const [entry1, entry2] = archive;

    // entry1 → note n1 / session s1
    expect(entry1.note.id).toBe("n1");
    expect(entry1.session?.id).toBe("s1");
    expect(entry1.points.map(p => p.id)).toEqual(["p1"]);
    expect(entry1.questions.map(q => q.id)).toEqual(["q1"]);
    expect(entry1.decisions.map(d => d.id)).toEqual(["d1"]);
    expect(entry1.debts.map(d => d.id)).toEqual(["db1"]);

    // entry2 → note n2 / session s2
    expect(entry2.note.id).toBe("n2");
    expect(entry2.session?.id).toBe("s2");
    expect(entry2.points.map(p => p.id)).toEqual(["p2"]);
    expect(entry2.questions.map(q => q.id)).toEqual(["q2"]);
    expect(entry2.decisions).toEqual([]);
    expect(entry2.debts).toEqual([]);
  });

  it("note 对应 session 不存在时 session 字段为 undefined", () => {
    const note = makeNote("n1", "nonexistent-session", "2024-01-01T10:00:00.000Z");
    const state = makeMinimalState({ notes: [note] });

    const archive = buildSessionArchive(state);
    expect(archive).toHaveLength(1);
    expect(archive[0].session).toBeUndefined();
    expect(archive[0].note.id).toBe("n1");
  });

  it("多 note 按 createdAt 倒序排列", () => {
    const s1 = makeSession("s1");
    const s2 = makeSession("s2");
    const s3 = makeSession("s3");
    const note1 = makeNote("n1", "s1", "2024-01-01T10:00:00.000Z");
    const note2 = makeNote("n2", "s2", "2024-03-15T10:00:00.000Z");
    const note3 = makeNote("n3", "s3", "2024-02-10T10:00:00.000Z");

    const state = makeMinimalState({
      sessions: [s1, s2, s3],
      notes: [note1, note2, note3]
    });

    const archive = buildSessionArchive(state);
    expect(archive.map(e => e.note.id)).toEqual(["n2", "n3", "n1"]);
  });
});
