import { describe, it, expect } from "vitest";
import {
  addTurn,
  buildInterviewAgentContext,
  createInterviewSession,
} from "./engine";
import type { InterviewSession } from "./types";

function sessionWithTurnCount(count: number): InterviewSession {
  let session = createInterviewSession({ id: "ctx-1", title: "上下文测试" });
  for (let index = 0; index < count; index += 1) {
    session = addTurn(session, {
      role: index % 2 === 0 ? "user" : "assistant",
      content: `第${index + 1}轮`,
    });
  }
  return session;
}

describe("buildInterviewAgentContext", () => {
  it("returns instructions, sessionTitle, turnCount, latestUserTurn for an empty session", () => {
    const session = createInterviewSession({ id: "s-empty", title: "空会话" });

    const ctx = buildInterviewAgentContext(session);

    expect(ctx.sessionTitle).toBe("空会话");
    expect(ctx.turnCount).toBe(0);
    expect(ctx.latestUserTurn).toBeNull();
    expect(ctx.history).toEqual([]);
    expect(ctx.activeStrategies).toEqual([]);
    expect(ctx.instructions).toContain("你是一个真正的私人专访主持人");
  });

  it("includes user and assistant turns in history in order", () => {
    let session = createInterviewSession({ id: "s-h", title: "历史" });
    session = addTurn(session, { role: "user", content: "你好" });
    session = addTurn(session, { role: "assistant", content: "你好，欢迎" });
    session = addTurn(session, { role: "user", content: "我想聊产品" });

    const ctx = buildInterviewAgentContext(session);

    expect(ctx.turnCount).toBe(3);
    expect(ctx.history).toEqual([
      { role: "user", text: "你好" },
      { role: "assistant", text: "你好，欢迎" },
      { role: "user", text: "我想聊产品" },
    ]);
    expect(ctx.latestUserTurn).toBe("我想聊产品");
  });

  it("returns null latestUserTurn when only assistant turns exist", () => {
    let session = createInterviewSession({ id: "s-a", title: "仅助手" });
    session = addTurn(session, { role: "assistant", content: "开场白" });

    const ctx = buildInterviewAgentContext(session);

    expect(ctx.latestUserTurn).toBeNull();
    expect(ctx.history).toEqual([{ role: "assistant", text: "开场白" }]);
  });

  it("caps history at the most recent 20 turns", () => {
    const session = sessionWithTurnCount(30);

    const ctx = buildInterviewAgentContext(session);

    expect(ctx.turnCount).toBe(30);
    expect(ctx.history).toHaveLength(20);
    expect(ctx.history[0].text).toBe("第11轮");
    expect(ctx.history[19].text).toBe("第30轮");
  });

  it("defaults activeStrategies to [] when enginePolicy is missing", () => {
    const session = createInterviewSession({ id: "s-np", title: "无策略" });

    const ctx = buildInterviewAgentContext(session);

    expect(ctx.activeStrategies).toEqual([]);
  });

  it("returns the first 5 appliedPlaybookRules when enginePolicy is set", () => {
    const session: InterviewSession = {
      ...createInterviewSession({ id: "s-p", title: "有策略" }),
      enginePolicy: {
        appliedPlaybookRules: ["r1", "r2", "r3", "r4", "r5", "r6", "r7"],
        qualityGuardrails: [],
        playbookHints: [],
        modeStrategy: "",
        rationale: "",
      } as unknown as InterviewSession["enginePolicy"],
    };

    const ctx = buildInterviewAgentContext(session);

    expect(ctx.activeStrategies).toEqual(["r1", "r2", "r3", "r4", "r5"]);
  });
});

describe("addTurn", () => {
  it("appends a user turn with the given content and default intent", () => {
    let session = createInterviewSession({ id: "s-u", title: "用户" });
    session = addTurn(session, { role: "user", content: "测试用户消息" });

    expect(session.turns).toHaveLength(1);
    expect(session.turns[0].role).toBe("user");
    expect(session.turns[0].content).toBe("测试用户消息");
    expect(session.turns[0].intent).toBe("用户表达");
    expect(session.turns[0].timestamp).toBeTruthy();
  });

  it("appends an assistant turn with default intent", () => {
    let session = createInterviewSession({ id: "s-a", title: "助手" });
    session = addTurn(session, { role: "assistant", content: "助手回复" });

    expect(session.turns[0].role).toBe("assistant");
    expect(session.turns[0].intent).toBe("主持人发言");
  });

  it("accepts a valid InterviewStrategyId on assistant turns", () => {
    let session = createInterviewSession({ id: "s-s", title: "策略" });
    session = addTurn(session, {
      role: "assistant",
      content: "深问",
      strategy: "mechanism_probe",
    });

    expect(session.turns[0].strategy).toBe("mechanism_probe");
  });

  it("drops unknown strategy ids instead of laundering them through a cast", () => {
    let session = createInterviewSession({ id: "s-bs", title: "未知策略" });
    session = addTurn(session, {
      role: "assistant",
      content: "x",
      strategy: "greeting",
    });

    expect(session.turns[0].strategy).toBeUndefined();
  });
});

describe("createInterviewSession", () => {
  it("produces an empty card/guide that buildRealtimeVoiceInstructions can consume safely", () => {
    const session = createInterviewSession({ id: "s-vi", title: "标题" });

    // Indirect assertion: buildInterviewAgentContext calls
    // buildRealtimeVoiceInstructions, which dereferences card.* and guide.*
    // — no throw means the empty defaults are well-formed.
    expect(() => buildInterviewAgentContext(session)).not.toThrow();
  });

  it("uses the provided createdAt as startedAt", () => {
    const ts = "2026-01-15T08:30:00.000Z";
    const session = createInterviewSession({ id: "s-t", title: "t", createdAt: ts });

    expect(session.startedAt).toBe(ts);
  });

  it("defaults mode to daily and strength to standard", () => {
    const session = createInterviewSession({ id: "s-d", title: "默认值" });

    expect(session.mode).toBe("daily");
    expect(session.strength).toBe("standard");
    expect(session.status).toBe("active");
  });
});
