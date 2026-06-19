import { describe, it, expect } from "vitest";

describe("domain types", () => {
  it("InterviewSession includes new zhuanfang fields", () => {
    const session: import("./types").InterviewSession = {
      id: "s1",
      mode: "daily",
      strength: "standard",
      status: "active",
      title: "test",
      card: { title: "card", whyNow: "now", suggestedOpening: "open", historyReferences: [], potentialTension: "", suggestedPerspectives: [], likelyOutputs: [] },
      guide: {
        topicHint: "hint",
        dailyBrief: { suggestedTopic: "topic", openingQuestion: "q", contextNote: "note" },
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
        suggestedOpening: "open",
        strategyChecklist: [],
      },
      turns: [],
      startedAt: new Date().toISOString(),
    };
    expect(session.guide.topicHint).toBe("hint");
  });

  it("ProductState includes memoryRecords and memoryCandidates", () => {
    const state: import("./types").ProductState = {
      profile: { name: "", role: "", industry: "", currentFocus: "", longTermGoal: "", preferredStrength: "standard", explicitBoundaries: [], confirmedMemories: [], inferredMemories: [] },
      sessions: [], notes: [], points: [], questions: [], decisions: [], debts: [], themes: [],
      memoryCorrections: [], searchBriefs: [], podcastEpisodes: [], corpusImports: [], corpusInsights: [], playbookPatches: [],
      memoryRecords: [], memoryCandidates: [], memoryEdges: [],
      importSources: [], ragChunks: [], configVersions: [],
      auditEvents: [], aiRunEvents: [], workflowRuns: [], operationalChecks: [],
      revision: 0,
      systemConfig: {
        version: "v1",
        providers: [],
        search: { activeProvider: "bailian", recencyDays: 30, maxSources: 10, allowWebInInterview: false },
        voice: { ttsProvider: "bailian", defaultVoice: "default", podcastVoice: "default", podcastFormat: "solo", realtimeMode: "bailian" },
        models: { planningModel: "qwen", interviewModel: "qwen", synthesisModel: "qwen" },
        interview: { playbookVersion: "v1", launchMode: "immersive", silenceHoldMs: 2000, maxFollowUpDepth: 5, guidanceEnabled: true, guidanceFrequency: "medium", maxGuidancePerTurn: 2, minGuidanceIntervalMs: 5000, challengeBudgetPerSession: 3 },
        memory: { includeSensitiveMemoriesInContext: false, includePendingCandidatesInContext: false, externalMaterialMemoryPolicy: "review-only" },
      },
    };
    expect(state.memoryRecords).toEqual([]);
    expect(state.memoryCandidates).toEqual([]);
    expect(state.configVersions).toEqual([]);
  });

  it("MemoryRecord has all required fields", () => {
    const record: import("./types").MemoryRecord = {
      id: "mr1",
      text: "test memory",
      status: "confirmed",
      sourceType: "interview_session",
      sourceId: "s1",
      evidenceQuote: "quote",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    expect(record.status).toBe("confirmed");
  });

  it("MemoryCandidate has review fields", () => {
    const candidate: import("./types").MemoryCandidate = {
      id: "mc1",
      text: "candidate",
      status: "pending",
      sourceType: "interview_session",
      sourceId: "s1",
      evidenceQuote: "quote",
      reason: "important",
      sensitivity: "normal",
      reviewScore: 0.8,
      reviewSignals: [],
      createdAt: new Date().toISOString(),
    };
    expect(candidate.reviewScore).toBe(0.8);
  });

  it("InterviewGuide has strategy fields", () => {
    const guide: import("./types").InterviewGuide = {
      topicHint: "hint",
      dailyBrief: { suggestedTopic: "topic", openingQuestion: "q", contextNote: "note" },
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
      suggestedOpening: "open",
      strategyChecklist: [],
    };
    expect(guide.topicHint).toBe("hint");
  });
});
