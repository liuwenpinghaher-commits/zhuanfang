import { describe, expect, it } from "vitest";
import { interviewLaunchFromAsset, knowledgeFocusFromAsset } from "./assets";

describe("interviewLaunchFromAsset", () => {
  it("opens a point interview with the title and theme line", () => {
    expect(
      interviewLaunchFromAsset({
        kind: "points",
        id: "pt_1",
        title: "我不该继续亲自救火",
        summary: "亲自救火会让团队等拍板",
        relatedThemeIds: ["theme-control"]
      })
    ).toEqual({
      mode: "point",
      topicHint: "我不该继续亲自救火",
      relatedThemeIds: ["theme-control"]
    });
  });

  it("opens a learning interview for a debt using the next question", () => {
    expect(
      interviewLaunchFromAsset({
        kind: "debts",
        id: "d1",
        title: "组织惯性",
        summary: "机制奖励了等拍板",
        nextPrompt: "上次提到组织惯性，你后来能用自己的话解释它了吗？"
      })
    ).toEqual({
      mode: "learning",
      topicHint: "上次提到组织惯性，你后来能用自己的话解释它了吗？"
    });
  });

  it("opens daily with the question text, not a decision session", () => {
    expect(
      interviewLaunchFromAsset({
        kind: "questions",
        id: "q1",
        title: "如果我不亲自救火，最坏会发生什么？",
        summary: "授权边界"
      })
    ).toEqual({
      mode: "daily",
      topicHint: "如果我不亲自救火，最坏会发生什么？"
    });
  });
});

describe("knowledgeFocusFromAsset", () => {
  it("pins point/question/decision/debt", () => {
    expect(knowledgeFocusFromAsset("points", "pt_1")).toEqual({ sourceType: "point", sourceId: "pt_1" });
    expect(knowledgeFocusFromAsset("questions", "q1")).toEqual({ sourceType: "question", sourceId: "q1" });
    expect(knowledgeFocusFromAsset("decisions", "de_1")).toEqual({ sourceType: "decision", sourceId: "de_1" });
    expect(knowledgeFocusFromAsset("debts", "d1")).toEqual({ sourceType: "debt", sourceId: "d1" });
    expect(knowledgeFocusFromAsset("questions", "  ")).toBeNull();
  });
});
