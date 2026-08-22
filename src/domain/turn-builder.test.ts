import { describe, expect, it } from "vitest";
import {
  appendUserTurnOnly,
  applyTurnPatch,
  createInitialProductState,
  createSessionDraft,
  decideInterviewStrategy,
  overlayThinHostStrategy,
  receiveUserTurn,
  receiveUserTurnWithAssistant,
  updateInterviewControl,
} from "./engine";
import type { InterviewReference } from "./types";

function addExchange(
  session: ReturnType<typeof createSessionDraft>,
  userText: string,
  assistantQuestion: string,
) {
  return receiveUserTurnWithAssistant(session, userText, {
    content: assistantQuestion,
    intent: "追问",
  });
}

describe("interview control feedback", () => {
  it("skip names the complete current assistant question instead of truncating the user's answer", () => {
    let session = createSessionDraft(createInitialProductState(), "organization");
    session = addExchange(
      session,
      "前两个季度先约定把释放容量投入试点。",
      "当部门不愿让出预算或人员权时，你准备如何调整激励和决策权？",
    );

    const skipped = updateInterviewControl(session, "skip");
    const feedback = skipped.turns.at(-1)?.content ?? "";

    expect(feedback).toContain("当部门不愿让出预算或人员权时，你准备如何调整激励和决策权？");
    expect(feedback).not.toContain("前两个季度先约定把释放容");
  });

  it("summary cites distinct user statements across the conversation instead of one local fragment", () => {
    let session = createSessionDraft(createInitialProductState(), "organization");
    session = addExchange(
      session,
      "个人工具已经快很多，但端到端价值流没有缩短。",
      "哪一个环节仍然决定了交付周期？",
    );
    session = addExchange(
      session,
      "审批等待和跨部门激励才是当前瓶颈。",
      "这两个瓶颈之间是什么关系？",
    );

    const summarized = updateInterviewControl(session, "summary");
    const feedback = summarized.turns.at(-1)?.content ?? "";

    expect(feedback).toContain("个人工具已经快很多");
    expect(feedback).toContain("审批等待和跨部门激励");
    expect(feedback).toContain("请你确认");
  });
});

describe("structured interview references", () => {
  it("stores the exact structured reference selected by the strategy on both trace and assistant turn", () => {
    let session = createSessionDraft(createInitialProductState(), "organization");
    const reference: InterviewReference = {
      id: "memory:memory-1",
      type: "memory",
      text: "个人工具普及率不是组织提效的充分条件。",
      sourceEntityType: "memory_record",
      sourceEntityId: "memory-1",
      sourceLabel: "已确认长期记忆",
      evidenceTurn: { sessionId: "source-session", turnId: "source-turn" }
    };
    session.guide.relevantMemories = [reference.text];
    session.guide.availableReferences = [reference];

    const decision = decideInterviewStrategy(session, "组织提效为什么没有跟上？");
    session = receiveUserTurnWithAssistant(session, "组织提效为什么没有跟上？", {
      content: "这条历史判断在哪个环节最能被验证？",
      intent: "追问",
      referencedMemory: decision.referencedMemory,
      strategyDecision: decision
    });

    expect((decision as typeof decision & { references?: unknown[] }).references).toEqual([reference]);
    expect((session.strategyTrace?.at(-1) as typeof decision & { references?: unknown[] }).references).toEqual([reference]);
    expect((session.turns.at(-1) as (typeof session.turns)[number] & { references?: unknown[] }).references).toEqual([reference]);
  });

  it("插嘴或短接话在开口前就是让人把话说完", () => {
    const session = createSessionDraft(createInitialProductState(), "organization");
    const decision = decideInterviewStrategy(session, "等一下");
    expect(decision.strategy).toBe("space_holding");
    expect(decision.label).toBe("让人把那件事说完");
  });

  it("嘴里只客套接话时，策略不能再叫追问机制", () => {
    const session = createSessionDraft(createInitialProductState(), "organization");
    const raw = decideInterviewStrategy(session, "授权让我最难受的是那次救火");
    const overlaid = overlayThinHostStrategy(raw, "好，你说。");
    expect(overlaid.strategy).toBe("space_holding");
  });

  it("does not quote a card history string when no structured source is available", () => {
    const session = createSessionDraft(createInitialProductState(), "organization");
    session.card.historyReferences = ["无法核验来源的卡片历史"];
    session.guide.availableReferences = [];
    session.guide.relevantMemories = [];
    session.guide.recommendedPerspectives = ["系统论"];
    session.turns = [0, 1, 2].map((index) => ({
      id: `user-${index}`,
      sessionId: session.id,
      role: "user" as const,
      content: `已有表达 ${index}`,
      intent: "用户表达",
      timestamp: new Date().toISOString()
    }));

    const next = receiveUserTurn(session, "继续讨论组织效率。");

    expect(next.turns.at(-1)?.content).not.toContain("无法核验来源的卡片历史");
    expect(next.turns.at(-1)?.referencedMemory).toBeUndefined();
    expect(next.turns.at(-1)?.references).toBeUndefined();
  });
});

describe("appendUserTurnOnly / applyTurnPatch", () => {
  it("writes the guest sentence once and then the host follow-up", () => {
    let session = createSessionDraft(createInitialProductState(), "daily");
    session = appendUserTurnOnly(session, "授权让我最难受的是那次救火");
    expect(session.turns).toHaveLength(1);
    expect(session.turns[0]?.role).toBe("user");
    session = appendUserTurnOnly(session, "授权让我最难受的是那次救火");
    expect(session.turns).toHaveLength(1);
    session = applyTurnPatch(session, {
      assistant: { content: "那次救火具体卡在哪一步？", intent: "追问" }
    });
    expect(session.turns.map((turn) => turn.role)).toEqual(["user", "assistant"]);
    expect(session.turns.at(-1)?.content).toContain("救火");
  });
});
