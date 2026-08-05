/**
 * Loop golden — end-to-end deterministic path: due decision → card/queue → draft → strategy.
 * No live LLM. Complements craft-golden (strategy-only) with launch/card wiring.
 */
import { buildInterviewCard, createSessionDraft } from "./context-pack";
import { createInitialProductState } from "./engine";
import { decideInterviewStrategy } from "./strategy";
import {
  buildCognitiveRevisitQueue,
  pickInterviewLaunchRecommendation
} from "./revisit-queue";
import type { DecisionAsset, ProductState } from "./types";

export type LoopGoldenScenarioId = "decision_revisit_loop" | "pending_memory_queue" | "suppress_decision_review";

export type LoopGoldenResult = {
  id: LoopGoldenScenarioId;
  pass: boolean;
  detail: string;
};

const NOW = "2026-08-05T12:00:00.000Z";

function stripActiveSessions(state: ProductState): ProductState {
  return {
    ...state,
    sessions: state.sessions.filter((s) => s.status !== "active"),
    themes: [],
    debts: [],
    memoryCandidates: []
  };
}

function addDueDecision(state: ProductState): ProductState {
  const decision: DecisionAsset = {
    id: "loop_d_auth",
    title: "是否放权",
    decisionKind: "用户决策",
    confirmationStatus: "用户确认",
    choice: "关键节点把控",
    tradeOff: "效率 vs 控制",
    riskHypothesis: "一线拍板会失控",
    reviewAt: "2026-07-01T00:00:00.000Z",
    status: "待复盘",
    updatedAt: "2026-07-01T00:00:00.000Z"
  };
  return { ...state, decisions: [...state.decisions, decision] };
}

/** 1 · due decision → queue → card title/whyNow → draft guide → decision_review on turn 2 */
export function runDecisionRevisitLoopScenario(): LoopGoldenResult {
  let state = stripActiveSessions(createInitialProductState());
  state = addDueDecision(state);

  const queue = buildCognitiveRevisitQueue(state, NOW);
  if (queue[0]?.kind !== "decision_due") {
    return { id: "decision_revisit_loop", pass: false, detail: `queue top=${queue[0]?.kind}` };
  }

  const rec = pickInterviewLaunchRecommendation(state, { now: NOW });
  if (rec.mode !== "decision" || rec.topicHint !== "是否放权") {
    return {
      id: "decision_revisit_loop",
      pass: false,
      detail: `rec mode=${rec.mode} topic=${rec.topicHint}`
    };
  }

  // Card without user topicHint must surface decision via queue-backed auto path
  const card = buildInterviewCard(state, undefined, undefined);
  const titleOk = card.title.includes("是否放权");
  const whyOk = card.whyNow.includes("是否放权");
  if (!titleOk || !whyOk) {
    return {
      id: "decision_revisit_loop",
      pass: false,
      detail: `card title="${card.title}" why="${card.whyNow}"`
    };
  }

  const session = createSessionDraft(state, rec.mode, "standard", {
    topicHint: rec.topicHint,
    relatedThemeIds: rec.relatedThemeIds
  });
  if (!session.guide.decisionsToReview?.some((d) => d.title === "是否放权")) {
    return {
      id: "decision_revisit_loop",
      pass: false,
      detail: `guide decisions=${JSON.stringify(session.guide.decisionsToReview)}`
    };
  }

  session.turns = [
    {
      id: "u1",
      role: "user",
      content: "第一轮表达",
      intent: "用户表达",
      timestamp: NOW
    }
  ];
  session.guide.debtToAddress = undefined;
  session.guide.openDebts = [];
  const decision = decideInterviewStrategy(session, "最近团队还是老样子");
  const pass = decision.strategy === "decision_review";
  return {
    id: "decision_revisit_loop",
    pass,
    detail: pass ? "queue→card→draft→decision_review" : `strategy=${decision.strategy}`
  };
}

/** 2 · pending memory tops queue; launch skips to next launchable after HITL item */
export function runPendingMemoryQueueScenario(): LoopGoldenResult {
  let state = stripActiveSessions(createInitialProductState());
  state = {
    ...state,
    memoryCandidates: [
      {
        id: "mc1",
        text: "我习惯在关键节点亲自拍板",
        status: "pending",
        sourceType: "interview_session",
        sourceId: "s",
        evidenceQuote: "亲自拍板",
        reason: "test",
        sensitivity: "normal",
        reviewScore: 0.9,
        reviewSignals: [],
        createdAt: NOW
      }
    ]
  };
  state = addDueDecision(state);
  const queue = buildCognitiveRevisitQueue(state, NOW);
  if (queue[0]?.kind !== "memory_hitl") {
    return { id: "pending_memory_queue", pass: false, detail: `top=${queue[0]?.kind}` };
  }
  const rec = pickInterviewLaunchRecommendation(state, { now: NOW });
  // Launch still targets decision (canLaunchInterview), not stuck on HITL
  const pass = rec.launchItem.kind === "decision_due" && rec.mode === "decision";
  return {
    id: "pending_memory_queue",
    pass,
    detail: pass ? "HITL first, launch decision" : `launch=${rec.launchItem.kind}`
  };
}

/** 3 · suppressed decision key blocks decision_review */
export function runSuppressDecisionReviewScenario(): LoopGoldenResult {
  let state = stripActiveSessions(createInitialProductState());
  state = addDueDecision(state);
  const session = createSessionDraft(state, "decision", "standard", { topicHint: "是否放权" });
  session.turns = [
    { id: "u1", role: "user", content: "第一轮", intent: "用户表达", timestamp: NOW }
  ];
  session.guide.debtToAddress = undefined;
  session.guide.openDebts = [];
  session.suppressedRevisitIds = ["decision:是否放权"];
  const decision = decideInterviewStrategy(session, "继续聊组织");
  const pass = decision.strategy !== "decision_review";
  return {
    id: "suppress_decision_review",
    pass,
    detail: pass ? `suppressed→${decision.strategy}` : `still ${decision.strategy}`
  };
}

export function runAllLoopGoldenScenarios(): LoopGoldenResult[] {
  return [
    runDecisionRevisitLoopScenario(),
    runPendingMemoryQueueScenario(),
    runSuppressDecisionReviewScenario()
  ];
}
