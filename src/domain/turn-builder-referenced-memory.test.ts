import { describe, expect, it } from "vitest";
import { receiveUserTurnWithAssistant } from "./turn-builder";
import type { InterviewSession, InterviewStrategyDecision } from "./types";

function makeSession(overrides?: Partial<InterviewSession>): InterviewSession {
  return {
    id: "se_ref",
    mode: "daily",
    strength: "standard",
    status: "active",
    title: "引用诚实单测",
    card: {
      title: "卡",
      whyNow: "",
      suggestedOpening: "开场",
      historyReferences: ["【冻结开场历史】不该在 strategy 未选中时出现"],
      potentialTension: "",
      suggestedPerspectives: [],
      likelyOutputs: []
    },
    guide: {
      topicHint: "放权",
      dailyBrief: { suggestedTopic: "", openingQuestion: "", contextNote: "" },
      perspectiveCoverage: {},
      missingPerspectives: [],
      recommendedPerspectives: [],
      perspectiveRationale: "",
      relevantMemories: ["【本轮相关记忆】审批权小范围验证"],
      graphReferences: [],
      opinionEvolution: [],
      statedPositions: [],
      openDebts: [],
      decisionsToReview: [],
      blindspotCandidates: [],
      knowledgeFragments: [],
      suggestedOpening: "",
      strategyChecklist: []
    },
    turns: [],
    startedAt: "2026-07-23T00:00:00.000Z",
    ...overrides
  };
}

describe("C-P1-03 receiveUserTurnWithAssistant referencedMemory honesty", () => {
  it("strategyDecision present without referencedMemory → turn has no invented card history ref", () => {
    const strategy: InterviewStrategyDecision = {
      strategy: "mechanism_probe",
      depth: "surface",
      label: "追问锚点",
      reason: "unit-test",
      turnIndex: 0
      // deliberately no referencedMemory
    };
    const next = receiveUserTurnWithAssistant(makeSession(), "我想放权但不敢", {
      content: "能讲一个具体时刻吗？",
      intent: "追问锚点",
      strategyDecision: strategy
    });
    const assistant = next.turns.find((t) => t.role === "assistant");
    expect(assistant).toBeDefined();
    expect(assistant!.referencedMemory).toBeUndefined();
  });

  it("explicit referencedMemory wins over strategy and card", () => {
    const strategy: InterviewStrategyDecision = {
      strategy: "perspective_shift",
      depth: "mechanism",
      label: "换视角",
      reason: "unit-test",
      turnIndex: 1,
      referencedMemory: "策略选中的记忆"
    };
    const next = receiveUserTurnWithAssistant(makeSession(), "放权", {
      content: "引用一下",
      intent: "换视角",
      referencedMemory: "显式传入的记忆",
      strategyDecision: strategy
    });
    const assistant = next.turns.find((t) => t.role === "assistant");
    expect(assistant!.referencedMemory).toBe("显式传入的记忆");
  });

  it("strategyDecision.referencedMemory is used when assistant omits explicit field", () => {
    const strategy: InterviewStrategyDecision = {
      strategy: "perspective_shift",
      depth: "mechanism",
      label: "换视角",
      reason: "unit-test",
      turnIndex: 2,
      referencedMemory: "策略真实选中"
    };
    const next = receiveUserTurnWithAssistant(makeSession(), "放权", {
      content: "引用一下",
      intent: "换视角",
      strategyDecision: strategy
    });
    const assistant = next.turns.find((t) => t.role === "assistant");
    expect(assistant!.referencedMemory).toBe("策略真实选中");
  });

  it("offline path (no strategyDecision) may still surface first card history ref", () => {
    const next = receiveUserTurnWithAssistant(makeSession(), "放权", {
      content: "继续",
      intent: "追问"
      // no strategyDecision — offline best-effort label
    });
    const assistant = next.turns.find((t) => t.role === "assistant");
    expect(assistant!.referencedMemory).toContain("冻结开场历史");
  });
});
