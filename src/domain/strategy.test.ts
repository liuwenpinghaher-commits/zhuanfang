import { describe, expect, it } from "vitest";
import { createInitialProductState, createSessionDraft, decideInterviewStrategy } from "./engine";
import type { InterviewSession } from "./types";

// S3-B: ruleType must drive the concrete-moment / mechanism-reversal strategies,
// with keyword matching kept as a backward-compatible fallback for legacy patches
// that predate ruleType.

function sessionWithRules(
  rules: string[],
  ruleTypes?: string[]
): InterviewSession {
  const state = createInitialProductState();
  const session = createSessionDraft(state, "decision", "standard", {});
  session.turns = []; // first user turn
  session.strategyTrace = [];
  session.enginePolicy = {
    ...session.enginePolicy!,
    appliedPlaybookRules: rules,
    ...(ruleTypes ? { appliedPlaybookRuleTypes: ruleTypes } : {})
  };
  return session;
}

describe("decideInterviewStrategy — ruleType-driven concrete-moment", () => {
  it("triggers concrete_example_probe via ruleType even when rule text lacks the keyword", () => {
    // Rule text deliberately omits "具体时刻"; only ruleType marks it.
    const session = sessionWithRules(["先让被访者落到一个真实场景"], ["concrete-moment"]);
    const decision = decideInterviewStrategy(session, "团队总是不主动承担");
    expect(decision.strategy).toBe("concrete_example_probe");
  });

  it("falls back to keyword match when no ruleType is present (legacy patch)", () => {
    // No ruleTypes; rule text contains the legacy keyword "具体时刻".
    const session = sessionWithRules(["当用户使用抽象评价时，先追问一个具体时刻。"]);
    const decision = decideInterviewStrategy(session, "团队总是不主动承担");
    expect(decision.strategy).toBe("concrete_example_probe");
  });

  it("does NOT trigger concrete_example_probe when neither ruleType nor keyword matches", () => {
    const session = sessionWithRules(["保持单步节奏，不要堆建议"]);
    const decision = decideInterviewStrategy(session, "团队总是不主动承担");
    expect(decision.strategy).not.toBe("concrete_example_probe");
  });
});

describe("decideInterviewStrategy — ruleType-driven mechanism-reversal", () => {
  function mechanismSession(rules: string[], ruleTypes?: string[]): InterviewSession {
    const session = sessionWithRules(rules, ruleTypes);
    // Need: previousUserTurns >= 1, last trace = concrete_example_probe, concrete moment text.
    session.turns = [
      {
        id: "t1",
        role: "user",
        content: "上周那次会议他说要等拍板",
        intent: "用户表达",
        timestamp: new Date().toISOString()
      }
    ];
    session.strategyTrace = [
      {
        turnIndex: 1,
        strategy: "concrete_example_probe",
        label: "索要具体时刻",
        reason: "test",
        depth: "surface"
      }
    ];
    return session;
  }

  it("triggers mechanism_reversal_probe via ruleType when rule text lacks the keywords", () => {
    const session = mechanismSession(["把个体表现翻成系统问题"], ["mechanism-reversal"]);
    const decision = decideInterviewStrategy(session, "上周那次会议他说要等拍板");
    expect(decision.strategy).toBe("mechanism_reversal_probe");
  });

  it("falls back to keyword match (机制+奖励+代价) for legacy mechanism patches", () => {
    const session = mechanismSession(["拿到具体例子后，从机制、奖励和代价角度反问。"]);
    const decision = decideInterviewStrategy(session, "上周那次会议他说要等拍板");
    expect(decision.strategy).toBe("mechanism_reversal_probe");
  });
});

describe("decideInterviewStrategy — decision_review (Wave B)", () => {
  it("triggers decision_review on turn 2–4 when a due decision is present and no debt wins", () => {
    const session = sessionWithRules([]);
    session.turns = [
      { id: "u1", role: "user", content: "第一轮", intent: "用户表达", timestamp: new Date().toISOString() }
    ];
    session.strategyTrace = [];
    session.guide.debtToAddress = undefined;
    session.guide.openDebts = [];
    session.guide.decisionsToReview = [
      { title: "是否放权", choice: "关键节点把控", daysOpen: 40 }
    ];
    const decision = decideInterviewStrategy(session, "最近团队还是老样子");
    expect(decision.strategy).toBe("decision_review");
    expect(decision.reason).toContain("是否放权");
  });

  it("does not double-fire decision_review after it already appears in strategyTrace", () => {
    const session = sessionWithRules([]);
    session.turns = [
      { id: "u1", role: "user", content: "第一轮", intent: "用户表达", timestamp: new Date().toISOString() },
      { id: "a1", role: "assistant", content: "追问", intent: "追问", timestamp: new Date().toISOString() },
      { id: "u2", role: "user", content: "第二轮", intent: "用户表达", timestamp: new Date().toISOString() }
    ];
    session.strategyTrace = [
      { turnIndex: 2, strategy: "decision_review", label: "决策复盘", reason: "done", depth: "mechanism" }
    ];
    session.guide.decisionsToReview = [{ title: "是否放权", choice: "关键节点把控", daysOpen: 40 }];
    const decision = decideInterviewStrategy(session, "继续说");
    expect(decision.strategy).not.toBe("decision_review");
  });
});

describe("decideInterviewStrategy — playbook_followup_probe (SIC+ KD7)", () => {
  it("triggers playbook_followup_probe via follow-up ruleType + concrete moment", () => {
    const session = sessionWithRules(["顺着具体事实再往下挖一层"], ["follow-up"]);
    session.guide.decisionsToReview = [];
    session.guide.debtToAddress = undefined;
    session.guide.openDebts = [];
    const decision = decideInterviewStrategy(session, "上周那次会议他说要等拍板");
    expect(decision.strategy).toBe("playbook_followup_probe");
    expect(decision.label).toBe("技法追问");
  });

  it("does not fire playbook_followup_probe without a concrete moment signal", () => {
    const session = sessionWithRules(["顺着具体事实再往下挖一层"], ["follow-up"]);
    const decision = decideInterviewStrategy(session, "团队总是不主动承担");
    expect(decision.strategy).not.toBe("playbook_followup_probe");
  });

  it("does not double-fire playbook_followup_probe in the same session", () => {
    const session = sessionWithRules(["顺着具体事实再往下挖一层"], ["follow-up"]);
    session.turns = [
      { id: "u1", role: "user", content: "上周会议", intent: "用户表达", timestamp: new Date().toISOString() }
    ];
    session.strategyTrace = [
      {
        turnIndex: 1,
        strategy: "playbook_followup_probe",
        label: "技法追问",
        reason: "done",
        depth: "mechanism"
      }
    ];
    const decision = decideInterviewStrategy(session, "上周那次会议他还是那样");
    expect(decision.strategy).not.toBe("playbook_followup_probe");
  });

  it("priority: decision_review beats playbook_followup_probe", () => {
    const session = sessionWithRules(["顺着具体事实再往下挖一层"], ["follow-up"]);
    session.turns = [
      { id: "u1", role: "user", content: "第一轮", intent: "用户表达", timestamp: new Date().toISOString() }
    ];
    session.strategyTrace = [];
    session.guide.debtToAddress = undefined;
    session.guide.openDebts = [];
    session.guide.decisionsToReview = [
      { title: "是否放权", choice: "关键节点把控", daysOpen: 40 }
    ];
    const decision = decideInterviewStrategy(session, "上周那次会议他说要等拍板");
    expect(decision.strategy).toBe("decision_review");
  });

  it("priority: debt_followup beats playbook_followup_probe", () => {
    const session = sessionWithRules(["顺着具体事实再往下挖一层"], ["follow-up"]);
    session.turns = [
      { id: "u1", role: "user", content: "第一轮", intent: "用户表达", timestamp: new Date().toISOString() }
    ];
    session.strategyTrace = [];
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
    const decision = decideInterviewStrategy(session, "上周那次会议他还是那样");
    expect(decision.strategy).toBe("debt_followup");
  });

  it("priority: playbook_followup_probe beats ≥10min synthesis", () => {
    const session = sessionWithRules(["顺着具体事实再往下挖一层"], ["follow-up"]);
    session.startedAt = new Date(Date.now() - 11 * 60 * 1000).toISOString();
    session.turns = [
      { id: "u1", role: "user", content: "第一轮", intent: "用户表达", timestamp: new Date().toISOString() }
    ];
    session.strategyTrace = [];
    session.guide.decisionsToReview = [];
    session.guide.debtToAddress = undefined;
    session.guide.openDebts = [];
    const decision = decideInterviewStrategy(session, "上周那次会议他说要等拍板");
    expect(decision.strategy).toBe("playbook_followup_probe");
  });

  it("regression: ≥10min still yields synthesis when no follow-up rule", () => {
    const session = sessionWithRules([]);
    session.startedAt = new Date(Date.now() - 11 * 60 * 1000).toISOString();
    session.turns = [
      { id: "u1", role: "user", content: "第一轮", intent: "用户表达", timestamp: new Date().toISOString() }
    ];
    session.strategyTrace = [];
    session.guide.decisionsToReview = [];
    session.guide.debtToAddress = undefined;
    session.guide.openDebts = [];
    session.guide.recommendedPerspectives = [];
    session.guide.blindspotCandidates = [];
    const decision = decideInterviewStrategy(session, "上周那次会议他说要等拍板");
    expect(decision.strategy).toBe("synthesis");
  });
});

describe("decideInterviewStrategy — late-session anti-repeat", () => {
  it("does not repeat synthesis when the latest strategy already synthesized the discussion", () => {
    const session = sessionWithRules([]);
    session.startedAt = new Date().toISOString();
    session.turns = Array.from({ length: 10 }, (_, index) => ({
      id: `turn-${index}`,
      role: index % 2 === 0 ? "user" as const : "assistant" as const,
      content: `第 ${index + 1} 轮内容`,
      intent: index % 2 === 0 ? "用户表达" : "主持人发言",
      timestamp: new Date().toISOString()
    }));
    session.guide.recommendedPerspectives = [];
    session.guide.blindspotCandidates = [];
    session.strategyTrace = [
      {
        turnIndex: 4,
        strategy: "mechanism_probe",
        label: "追问机制",
        reason: "test",
        depth: "mechanism"
      },
      {
        turnIndex: 5,
        strategy: "synthesis",
        label: "阶段总结",
        reason: "test",
        depth: "synthesis"
      }
    ];

    const decision = decideInterviewStrategy(session, "组织提效没有随着个人工具普及而增长。");

    expect(decision.strategy).not.toBe("synthesis");
    expect(decision.strategy).not.toBe(session.strategyTrace.at(-1)?.strategy);
    expect(decision.reason).toContain("避免重复");
  });

  it("rotates away from a repeated default mechanism probe", () => {
    const session = sessionWithRules([]);
    session.startedAt = new Date().toISOString();
    session.guide.debtToAddress = "";
    session.guide.openDebts = [];
    session.turns = [
      { id: "u1", role: "user", content: "第一轮", intent: "用户表达", timestamp: new Date().toISOString() },
      { id: "a1", role: "assistant", content: "追问", intent: "追问", timestamp: new Date().toISOString() }
    ];
    session.strategyTrace = [
      { turnIndex: 1, strategy: "mechanism_probe", label: "追问机制", reason: "test", depth: "surface" }
    ];

    const decision = decideInterviewStrategy(session, "这种变化没有触及共同上下文。");

    expect(decision.strategy).not.toBe("mechanism_probe");
    expect(decision.reason).toContain("避免重复");
  });
});
