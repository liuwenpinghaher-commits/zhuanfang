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
