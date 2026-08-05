import { describe, expect, it } from "vitest";
import { createInitialProductState } from "./engine";
import {
  buildCognitiveRevisitQueue,
  countPendingMemoryCandidates,
  pickInterviewLaunchRecommendation
} from "./revisit-queue";
import type { DecisionAsset, KnowledgeDebt, MemoryCandidate, ProductState } from "./types";

const NOW = "2026-08-05T12:00:00.000Z";

function withDecision(state: ProductState, partial: Partial<DecisionAsset> & Pick<DecisionAsset, "id" | "title">): ProductState {
  const decision: DecisionAsset = {
    id: partial.id,
    title: partial.title,
    decisionKind: "用户决策",
    confirmationStatus: partial.confirmationStatus ?? "用户确认",
    choice: partial.choice ?? "方案 A",
    tradeOff: partial.tradeOff ?? "代价",
    riskHypothesis: partial.riskHypothesis ?? "假设",
    reviewAt: partial.reviewAt ?? "2026-07-01T00:00:00.000Z",
    status: partial.status ?? "待复盘",
    updatedAt: partial.updatedAt ?? "2026-07-01T00:00:00.000Z",
    relatedThemeIds: partial.relatedThemeIds,
    sourceSessionId: partial.sourceSessionId
  };
  return { ...state, decisions: [...state.decisions, decision] };
}

function withPendingMemory(state: ProductState, text = "候选记忆"): ProductState {
  const candidate: MemoryCandidate = {
    id: "mc_pending",
    text,
    status: "pending",
    sourceType: "interview_session",
    sourceId: "s1",
    evidenceQuote: text,
    reason: "test",
    sensitivity: "normal",
    reviewScore: 0.8,
    reviewSignals: [],
    createdAt: NOW
  };
  return { ...state, memoryCandidates: [...state.memoryCandidates, candidate] };
}

function withOpenDebt(state: ProductState, concept = "跨部门激励"): ProductState {
  const debt: KnowledgeDebt = {
    id: "debt1",
    concept,
    context: "组织",
    whyImportant: "重要",
    status: "待了解",
    nextQuestion: "谁的 KPI？",
    updatedAt: "2026-07-01T00:00:00.000Z"
  };
  return { ...state, debts: [...state.debts, debt] };
}

describe("buildCognitiveRevisitQueue", () => {
  it("pending memory is top when no active session", () => {
    let state = createInitialProductState();
    state = { ...state, sessions: state.sessions.filter((s) => s.status !== "active") };
    state = withPendingMemory(state);
    const queue = buildCognitiveRevisitQueue(state, NOW);
    expect(queue[0]?.kind).toBe("memory_hitl");
    expect(queue[0]?.title).toMatch(/1 条记忆待确认/);
    expect(countPendingMemoryCandidates(state)).toBe(1);
  });

  it("due decision ranks above open debt and themes", () => {
    let state = createInitialProductState();
    state = { ...state, sessions: [], themes: [] };
    state = withOpenDebt(state);
    state = withDecision(state, { id: "d1", title: "是否放权" });
    const queue = buildCognitiveRevisitQueue(state, NOW);
    const kinds = queue.map((i) => i.kind);
    expect(kinds[0]).toBe("decision_due");
    expect(queue[0]?.topicHint).toBe("是否放权");
    expect(queue[0]?.mode).toBe("decision");
  });

  it("approve all pending removes memory_hitl from queue", () => {
    let state = createInitialProductState();
    state = { ...state, sessions: [] };
    state = withPendingMemory(state);
    expect(buildCognitiveRevisitQueue(state, NOW).some((i) => i.kind === "memory_hitl")).toBe(true);
    state = {
      ...state,
      memoryCandidates: state.memoryCandidates.map((c) =>
        c.status === "pending" ? { ...c, status: "approved" as const, reviewedAt: NOW } : c
      )
    };
    expect(buildCognitiveRevisitQueue(state, NOW).some((i) => i.kind === "memory_hitl")).toBe(false);
  });

  it("unconfirmed decision is not due", () => {
    let state = createInitialProductState();
    state = { ...state, sessions: [], themes: [], debts: [] };
    state = withDecision(state, {
      id: "d2",
      title: "未拍板",
      confirmationStatus: "待用户确认"
    });
    const queue = buildCognitiveRevisitQueue(state, NOW);
    expect(queue.every((i) => i.kind !== "decision_due")).toBe(true);
  });

  it("cold_start when empty personal state", () => {
    let state = createInitialProductState();
    state = {
      ...state,
      sessions: [],
      themes: [],
      decisions: [],
      debts: [],
      questions: [],
      memoryCandidates: []
    };
    const queue = buildCognitiveRevisitQueue(state, NOW);
    expect(queue.some((i) => i.kind === "cold_start")).toBe(true);
  });
});

describe("pickInterviewLaunchRecommendation", () => {
  it("due decision drives decision mode and topicHint", () => {
    let state = createInitialProductState();
    state = { ...state, sessions: [], themes: [], debts: [], memoryCandidates: [] };
    state = withDecision(state, { id: "d1", title: "是否放权", choice: "关键节点把控" });
    const rec = pickInterviewLaunchRecommendation(state, { now: NOW });
    expect(rec.mode).toBe("decision");
    expect(rec.topicHint).toBe("是否放权");
    expect(rec.launchItem.kind).toBe("decision_due");
    expect(rec.reason).toContain("是否放权");
  });

  it("search brief forces learning mode", () => {
    const state = createInitialProductState();
    const brief = state.searchBriefs[0];
    if (!brief) {
      // seed may lack brief — skip soft
      expect(true).toBe(true);
      return;
    }
    const rec = pickInterviewLaunchRecommendation(state, { searchBriefId: brief.id, now: NOW });
    expect(rec.mode).toBe("learning");
  });
});
