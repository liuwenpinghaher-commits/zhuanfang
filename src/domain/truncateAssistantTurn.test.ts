import { describe, expect, it } from "vitest";
import { truncateAssistantTurn } from "./engine";
import type { InterviewSession, InterviewTurn } from "./types";

function makeSession(turns: InterviewTurn[]): InterviewSession {
  return {
    id: "session-test",
    mode: "daily",
    strength: "standard",
    status: "active",
    title: "测试会话",
    card: {
      title: "测试卡",
      summary: "",
      historyReferences: [],
      suggestedPerspectives: [],
      proposedFocus: [],
      blockers: [],
      memoryReferences: [],
      knowledgeDebtRefs: [],
      noteRefs: [],
      questionRefs: [],
      pointRefs: [],
      themeRefs: [],
      preferredStrategies: []
    } as unknown as InterviewSession["card"],
    guide: {
      anchorQuestion: "",
      questions: []
    } as unknown as InterviewSession["guide"],
    turns,
    startedAt: new Date().toISOString()
  } as InterviewSession;
}

function makeAssistantTurn(overrides: Partial<InterviewTurn> = {}): InterviewTurn {
  return {
    id: overrides.id ?? "turn-assistant",
    role: "assistant",
    content: overrides.content ?? "你最近在思考的核心议题到底是什么？",
    intent: overrides.intent ?? "深问",
    timestamp: overrides.timestamp ?? new Date().toISOString(),
    providerTurnId: overrides.providerTurnId,
    truncated: overrides.truncated
  };
}

describe("truncateAssistantTurn", () => {
  it("truncates the targeted assistant turn by id", () => {
    const original = makeAssistantTurn({ id: "turn-1", content: "你最近在思考的核心议题到底是什么？" });
    const session = makeSession([original]);

    const result = truncateAssistantTurn(session, {
      turnId: "turn-1",
      spokenTextSoFar: "你最近在思考"
    });

    expect(result.changed).toBe(true);
    expect(result.truncatedTurn?.content).toBe("你最近在思考");
    expect(result.truncatedTurn?.truncated?.spokenChars).toBe(6);
    expect(result.truncatedTurn?.truncated?.originalChars).toBe(original.content.length);
    expect(result.truncatedTurn?.truncated?.reason).toBe("user_interrupt");
    expect(result.session.turns[0].id).toBe("turn-1");
  });

  it("falls back to provider turn id", () => {
    const turn = makeAssistantTurn({ id: "turn-2", providerTurnId: "resp-99", content: "AAAAAAA" });
    const session = makeSession([turn]);

    const result = truncateAssistantTurn(session, {
      providerTurnId: "resp-99",
      spokenTextSoFar: "AAA"
    });

    expect(result.changed).toBe(true);
    expect(result.truncatedTurn?.content).toBe("AAA");
  });

  it("targets the latest non-truncated assistant turn when no id given", () => {
    const older = makeAssistantTurn({ id: "older", content: "abc" });
    const latest = makeAssistantTurn({ id: "latest", content: "abcdef" });
    const session = makeSession([older, latest]);

    const result = truncateAssistantTurn(session, { spokenTextSoFar: "abc" });

    expect(result.changed).toBe(true);
    expect(result.truncatedTurn?.id).toBe("latest");
    expect(result.session.turns.find((turn) => turn.id === "latest")?.content).toBe("abc");
    expect(result.session.turns.find((turn) => turn.id === "older")?.content).toBe("abc");
  });

  it("returns unchanged when no assistant turn matches", () => {
    const session = makeSession([
      { ...makeAssistantTurn({ id: "x" }), role: "user" }
    ]);

    const result = truncateAssistantTurn(session, { spokenTextSoFar: "anything" });

    expect(result.changed).toBe(false);
    expect(result.truncatedTurn).toBeNull();
    expect(result.session).toBe(session);
  });

  it("does not retruncate an already truncated turn when no id provided", () => {
    const truncated = makeAssistantTurn({
      id: "old",
      content: "ab",
      truncated: { spokenChars: 2, originalChars: 5, reason: "user_interrupt", truncatedAt: "2026-01-01T00:00:00.000Z" }
    });
    const fresh = makeAssistantTurn({ id: "fresh", content: "hello" });
    const session = makeSession([truncated, fresh]);

    const result = truncateAssistantTurn(session, { spokenTextSoFar: "he" });

    expect(result.changed).toBe(true);
    expect(result.truncatedTurn?.id).toBe("fresh");
  });

  it("supports provider_error reason", () => {
    const session = makeSession([makeAssistantTurn({ id: "boom", content: "longgggg" })]);

    const result = truncateAssistantTurn(session, {
      turnId: "boom",
      spokenTextSoFar: "lon",
      reason: "provider_error"
    });

    expect(result.truncatedTurn?.truncated?.reason).toBe("provider_error");
  });

  it("clamps spokenTextSoFar longer than original to original length", () => {
    const session = makeSession([makeAssistantTurn({ id: "small", content: "ab" })]);

    const result = truncateAssistantTurn(session, {
      turnId: "small",
      spokenTextSoFar: "abcdef"
    });

    expect(result.changed).toBe(false);
    expect(result.truncatedTurn?.id).toBe("small");
    expect(result.truncatedTurn?.content).toBe("ab");
  });
});
