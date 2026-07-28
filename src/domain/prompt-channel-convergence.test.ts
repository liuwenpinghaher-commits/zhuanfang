import { describe, expect, it } from "vitest";
import { applyMidSessionCardRefresh } from "./context-pack";
import { buildRealtimeVoiceInstructions } from "./voice-instructions";
import type { InterviewCard, InterviewContextPack, InterviewSession } from "./types";

function makeSession(overrides?: Partial<InterviewSession>): InterviewSession {
  return {
    id: "se_ch",
    mode: "daily",
    strength: "standard",
    status: "active",
    title: "双通道",
    card: {
      title: "卡",
      whyNow: "现在",
      suggestedOpening: "开场",
      historyReferences: ["【card冻结】开场历史"],
      potentialTension: "",
      suggestedPerspectives: [],
      likelyOutputs: [],
      sourceHighlights: [{ id: "sh1", title: "开场素材", url: "u", publisher: "p", publishedAt: "", snippet: "旧素材片段", relevanceScore: 0.9, usage: "interview-context" }]
    },
    guide: {
      topicHint: "放权",
      dailyBrief: { suggestedTopic: "", openingQuestion: "", contextNote: "" },
      perspectiveCoverage: {},
      missingPerspectives: [],
      recommendedPerspectives: [],
      perspectiveRationale: "",
      relevantMemories: ["【guide live】本轮可引用记忆"],
      graphReferences: [],
      opinionEvolution: [],
      statedPositions: [],
      openDebts: [],
      decisionsToReview: [],
      blindspotCandidates: [],
      knowledgeFragments: ["【guide live】调研要点片段"],
      suggestedOpening: "",
      strategyChecklist: []
    },
    turns: [],
    startedAt: "2026-07-23T00:00:00.000Z",
    ...overrides
  };
}

describe("R-P1-02 voice prompt channel convergence", () => {
  it("does not dual-inject card history when guide.relevantMemories is non-empty", () => {
    const session = makeSession();
    const text = buildRealtimeVoiceInstructions(session, session.card, [], []);
    expect(text).toContain("【guide live】本轮可引用记忆");
    expect(text).not.toContain("【card冻结】开场历史");
  });

  it("prefers guide knowledgeFragments over card sourceHighlights", () => {
    const session = makeSession();
    const text = buildRealtimeVoiceInstructions(session, session.card, [], []);
    expect(text).toContain("【guide live】调研要点片段");
    expect(text).not.toContain("旧素材片段");
  });

  it("falls back to card history only when guide memories are empty", () => {
    const session = makeSession({
      guide: {
        ...makeSession().guide,
        relevantMemories: [],
        knowledgeFragments: []
      }
    });
    const text = buildRealtimeVoiceInstructions(session, session.card as InterviewCard, [], []);
    expect(text).toContain("【card冻结】开场历史");
    expect(text).toContain("旧素材片段");
  });

  it("mid-session empty livePack clears open-time sourceHighlights so freeze is not injected", () => {
    // After a mid-session pack rebuild with zero materials, card must not keep open-time freeze
    // (criterion 2) — otherwise voice/bailian fall back to 旧素材 when knowledgeFragments is empty.
    const session = makeSession({
      guide: {
        ...makeSession().guide,
        relevantMemories: ["【guide live】本轮可引用记忆"],
        knowledgeFragments: [] // no guide knowledge after refresh
      }
    });
    const emptyLivePack = {
      topicHint: "第二增长曲线",
      confirmedMemories: [],
      memoryRecords: [],
      pendingCandidates: [],
      corrections: [],
      graphReferences: [],
      searchBriefs: [],
      sourceHighlights: [], // empty pack materials
      ragChunks: [],
      securityInterceptions: [],
      sources: []
    } as InterviewContextPack;

    const refreshedCard = applyMidSessionCardRefresh(session.card, session.guide, emptyLivePack);
    expect(refreshedCard.sourceHighlights).toEqual([]);
    expect(refreshedCard.sourceHighlights).not.toEqual(session.card.sourceHighlights);

    const text = buildRealtimeVoiceInstructions(
      { ...session, card: refreshedCard },
      refreshedCard,
      [],
      []
    );
    expect(text).toContain("【guide live】本轮可引用记忆");
    expect(text).not.toContain("旧素材片段");
    expect(text).not.toContain("开场素材");
  });

  it("applyMidSessionCardRefresh writes non-empty pack highlights and live history", () => {
    const session = makeSession();
    const livePack = {
      topicHint: "放权",
      confirmedMemories: [],
      memoryRecords: [],
      pendingCandidates: [],
      corrections: [],
      graphReferences: [],
      searchBriefs: [],
      sourceHighlights: [
        {
          id: "live-sh",
          title: "本轮素材",
          url: "u2",
          publisher: "p",
          publishedAt: "",
          snippet: "中段刷新素材",
          relevanceScore: 0.9,
          usage: "interview-context" as const
        }
      ],
      ragChunks: [],
      securityInterceptions: [],
      sources: []
    } as InterviewContextPack;
    const card = applyMidSessionCardRefresh(session.card, session.guide, livePack);
    expect(card.historyReferences).toEqual(["【guide live】本轮可引用记忆"]);
    expect(card.sourceHighlights?.[0]?.snippet).toBe("中段刷新素材");
  });
});
