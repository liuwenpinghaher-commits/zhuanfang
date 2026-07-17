import { describe, expect, it } from "vitest";
import {
  createInitialProductState,
  createSessionDraft,
  receiveUserTurnWithAssistant,
  updateInterviewControl,
} from "./engine";

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
