/**
 * Craft golden factory (realization Must-set · D2).
 * Deterministic scenarios that drive shipped strategy / retrieval — no live LLM.
 */
import { createInitialProductState, createSessionDraft, decideInterviewStrategy } from "./engine";
import { buildInterviewGuide } from "./context-pack";
import { applyCognitiveRelations } from "./reasoning";
import { retrievePersonalKnowledge } from "./retrieval";
import type { InterviewSession, KnowledgeChunk, ProductState } from "./types";

export type CraftGoldenScenarioId =
  | "concrete_moment_probe"
  | "decision_review_once"
  | "debt_followup_no_duplicate"
  | "contradiction_review_mid_late_once"
  | "rag_grounding_refuse"
  | "playbook_followup_probe"
  | "decision_over_playbook_followup"
  | "playbook_followup_over_synthesis";

export type CraftGoldenResult = {
  id: CraftGoldenScenarioId;
  pass: boolean;
  detail: string;
};

function baseSession(
  state: ProductState,
  mode: "daily" | "decision" = "daily"
): InterviewSession {
  const session = createSessionDraft(state, mode, "standard", {});
  session.turns = [];
  session.strategyTrace = [];
  return session;
}

/** 1 · abstract first turn + concrete-moment playbook → concrete_example_probe */
export function runConcreteMomentScenario(): CraftGoldenResult {
  const state = createInitialProductState();
  const session = baseSession(state);
  session.enginePolicy = {
    ...session.enginePolicy!,
    appliedPlaybookRules: ["先让被访者落到一个真实场景"],
    appliedPlaybookRuleTypes: ["concrete-moment"]
  };
  const decision = decideInterviewStrategy(session, "团队总是不主动承担");
  const pass = decision.strategy === "concrete_example_probe";
  return {
    id: "concrete_moment_probe",
    pass,
    detail: pass ? "strategy=concrete_example_probe" : `got ${decision.strategy}`
  };
}

/** 2 · due decision on turn 2 → decision_review; second call after trace does not re-fire */
export function runDecisionReviewOnceScenario(): CraftGoldenResult {
  const state = createInitialProductState();
  const session = baseSession(state, "decision");
  session.turns = [
    { id: "u1", role: "user", content: "第一轮", intent: "用户表达", timestamp: new Date().toISOString() }
  ];
  session.guide.debtToAddress = undefined;
  session.guide.openDebts = [];
  session.guide.decisionsToReview = [{ title: "是否放权", choice: "关键节点把控", daysOpen: 40 }];
  const first = decideInterviewStrategy(session, "最近团队还是老样子");
  session.strategyTrace = [
    {
      turnIndex: 2,
      strategy: "decision_review",
      label: "决策复盘",
      reason: "done",
      depth: "mechanism"
    }
  ];
  session.turns = [
    ...session.turns,
    { id: "a1", role: "assistant", content: "追问", intent: "追问", timestamp: new Date().toISOString() },
    { id: "u2", role: "user", content: "第二轮", intent: "用户表达", timestamp: new Date().toISOString() }
  ];
  const second = decideInterviewStrategy(session, "继续说");
  const pass = first.strategy === "decision_review" && second.strategy !== "decision_review";
  return {
    id: "decision_review_once",
    pass,
    detail: pass
      ? "decision_review once then blocked"
      : `first=${first.strategy} second=${second.strategy}`
  };
}

/** 3 · open debt → debt_followup; same session does not double-fire */
export function runDebtFollowupNoDuplicateScenario(): CraftGoldenResult {
  const state = createInitialProductState();
  const session = baseSession(state);
  session.turns = [
    { id: "u1", role: "user", content: "第一轮", intent: "用户表达", timestamp: new Date().toISOString() }
  ];
  session.guide.decisionsToReview = [];
  session.guide.debtToAddress = "跨部门激励为何失效";
  session.guide.openDebts = [
    {
      concept: "跨部门激励为何失效",
      context: "组织",
      daysOpen: 20,
      nextQuestion: "谁的 KPI？"
    }
  ];
  const first = decideInterviewStrategy(session, "还是老问题");
  session.strategyTrace = [
    {
      turnIndex: 2,
      strategy: "debt_followup",
      label: "知识债追问",
      reason: "done",
      depth: "mechanism"
    }
  ];
  session.turns.push(
    { id: "a1", role: "assistant", content: "债", intent: "追问", timestamp: new Date().toISOString() },
    { id: "u2", role: "user", content: "再说", intent: "用户表达", timestamp: new Date().toISOString() }
  );
  const second = decideInterviewStrategy(session, "继续");
  const pass = first.strategy === "debt_followup" && second.strategy !== "debt_followup";
  return {
    id: "debt_followup_no_duplicate",
    pass,
    detail: pass
      ? "debt_followup once then blocked"
      : `first=${first.strategy} second=${second.strategy}`
  };
}

/**
 * 4 · opposing points with contradicts soft-links → guide checklist includes 对立看法
 * → mid-late turn fires contradiction_review at most once.
 */
export function runContradictionReviewScenario(): CraftGoldenResult {
  let state = createInitialProductState();
  const now = "2026-08-01T00:00:00.000Z";
  state = {
    ...state,
    themes: [
      {
        id: "th_auth",
        name: "授权",
        summary: "组织授权",
        maturity: "聚焦",
        representativeQuote: "放权",
        appearances: 3,
        nextQuestion: "谁拍板？",
        updatedAt: now
      }
    ],
    points: [
      {
        id: "pt_central",
        title: "集权拍板",
        content: "关键节点必须我亲自拍板",
        status: "稳定观点",
        confidence: "用户确认",
        evidence: ["原话"],
        relatedThemeIds: ["th_auth"],
        important: true,
        updatedAt: now
      },
      {
        id: "pt_delegate",
        title: "充分放权",
        content: "关键节点应该交给一线拍板",
        status: "稳定观点",
        confidence: "AI 推断",
        evidence: ["原话2"],
        relatedThemeIds: ["th_auth"],
        important: false,
        updatedAt: now
      }
    ]
  };
  state = applyCognitiveRelations(state, {
    contradicts: [["pt_central", "pt_delegate"]],
    supersedes: []
  });
  const guide = buildInterviewGuide(state, { topicHint: "授权与拍板" });
  const hasOpposingHint = guide.strategyChecklist.some((line) => line.includes("对立看法"));
  const session = createSessionDraft(state, "daily", "standard", { topicHint: "授权与拍板" });
  // Mid-late: previousUserTurns 4..8 → set 4 prior user turns
  session.turns = Array.from({ length: 8 }, (_, i) => ({
    id: `t${i}`,
    role: (i % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
    content: `轮次 ${i}`,
    intent: i % 2 === 0 ? "用户表达" : "追问",
    timestamp: now
  }));
  session.guide = guide;
  session.strategyTrace = [];
  const first = decideInterviewStrategy(session, "我还是想自己拍板");
  session.strategyTrace = [
    {
      turnIndex: 5,
      strategy: "contradiction_review",
      label: "对立观点复盘",
      reason: "done",
      depth: "meta"
    }
  ];
  session.turns.push(
    { id: "ux", role: "user", content: "又一轮", intent: "用户表达", timestamp: now }
  );
  const second = decideInterviewStrategy(session, "再说一次对立");
  const pass =
    hasOpposingHint &&
    first.strategy === "contradiction_review" &&
    second.strategy !== "contradiction_review";
  return {
    id: "contradiction_review_mid_late_once",
    pass,
    detail: pass
      ? "contradicts→checklist→contradiction_review once"
      : `hint=${hasOpposingHint} first=${first.strategy} second=${second.strategy}`
  };
}

/** 5 · empty / low-signal knowledge → retrieve refuses grounding (no invented memory) */
export function runRagGroundingRefuseScenario(): CraftGoldenResult {
  const chunks: KnowledgeChunk[] = [
    {
      id: "kc1",
      sourceId: "src_unrelated",
      sourceType: "material",
      title: "无关",
      text: "天气预报与交通路况汇总",
      keywords: ["天气", "路况"],
      createdAt: "2026-08-01T00:00:00.000Z"
    }
  ];
  const result = retrievePersonalKnowledge(chunks, "我确认过的关于组织放权的长期判断是什么？", {
    topK: 3,
    minScore: 0.35
  });
  const pass = result.rejected === true && result.chunks.length === 0;
  return {
    id: "rag_grounding_refuse",
    pass,
    detail: pass
      ? `refused topScore=${result.topScore}`
      : `rejected=${result.rejected} n=${result.chunks.length} score=${result.topScore}`
  };
}

/** 6 · follow-up ruleType + concrete moment → playbook_followup_probe */
export function runPlaybookFollowupProbeScenario(): CraftGoldenResult {
  const state = createInitialProductState();
  const session = baseSession(state);
  session.enginePolicy = {
    ...session.enginePolicy!,
    appliedPlaybookRules: ["顺着具体事实再往下挖一层"],
    appliedPlaybookRuleTypes: ["follow-up"]
  };
  session.guide.decisionsToReview = [];
  session.guide.debtToAddress = undefined;
  session.guide.openDebts = [];
  const decision = decideInterviewStrategy(session, "上周那次会议他说要等拍板");
  const pass = decision.strategy === "playbook_followup_probe";
  return {
    id: "playbook_followup_probe",
    pass,
    detail: pass ? "strategy=playbook_followup_probe" : `got ${decision.strategy}`
  };
}

/** 7 · due decision on turn 2 beats follow-up rule hard branch */
export function runDecisionOverPlaybookFollowupScenario(): CraftGoldenResult {
  const state = createInitialProductState();
  const session = baseSession(state, "decision");
  session.enginePolicy = {
    ...session.enginePolicy!,
    appliedPlaybookRules: ["顺着具体事实再往下挖一层"],
    appliedPlaybookRuleTypes: ["follow-up"]
  };
  session.turns = [
    { id: "u1", role: "user", content: "第一轮", intent: "用户表达", timestamp: new Date().toISOString() }
  ];
  session.guide.debtToAddress = undefined;
  session.guide.openDebts = [];
  session.guide.decisionsToReview = [{ title: "是否放权", choice: "关键节点把控", daysOpen: 40 }];
  const decision = decideInterviewStrategy(session, "上周那次会议他说要等拍板");
  const pass = decision.strategy === "decision_review";
  return {
    id: "decision_over_playbook_followup",
    pass,
    detail: pass ? "decision_review > playbook_followup_probe" : `got ${decision.strategy}`
  };
}

/** 8 · follow-up rule + ≥10min still picks playbook_followup (not synthesis) */
export function runPlaybookFollowupOverSynthesisScenario(): CraftGoldenResult {
  const state = createInitialProductState();
  const session = baseSession(state);
  session.startedAt = new Date(Date.now() - 11 * 60 * 1000).toISOString();
  session.enginePolicy = {
    ...session.enginePolicy!,
    appliedPlaybookRules: ["顺着具体事实再往下挖一层"],
    appliedPlaybookRuleTypes: ["follow-up"]
  };
  session.turns = [
    { id: "u1", role: "user", content: "第一轮", intent: "用户表达", timestamp: new Date().toISOString() }
  ];
  session.guide.decisionsToReview = [];
  session.guide.debtToAddress = undefined;
  session.guide.openDebts = [];
  const decision = decideInterviewStrategy(session, "上周那次会议他说要等拍板");
  const pass = decision.strategy === "playbook_followup_probe";
  return {
    id: "playbook_followup_over_synthesis",
    pass,
    detail: pass ? "playbook_followup_probe > synthesis" : `got ${decision.strategy}`
  };
}

export const CRAFT_GOLDEN_RUNNERS: Array<() => CraftGoldenResult> = [
  runConcreteMomentScenario,
  runDecisionReviewOnceScenario,
  runDebtFollowupNoDuplicateScenario,
  runContradictionReviewScenario,
  runRagGroundingRefuseScenario,
  runPlaybookFollowupProbeScenario,
  runDecisionOverPlaybookFollowupScenario,
  runPlaybookFollowupOverSynthesisScenario
];

export function runAllCraftGolden(): CraftGoldenResult[] {
  return CRAFT_GOLDEN_RUNNERS.map((run) => run());
}

export function assertAllCraftGoldenPass(results: CraftGoldenResult[] = runAllCraftGolden()): void {
  const failed = results.filter((r) => !r.pass);
  if (failed.length > 0) {
    throw new Error(
      `craft golden failed: ${failed.map((f) => `${f.id}(${f.detail})`).join("; ")}`
    );
  }
}
