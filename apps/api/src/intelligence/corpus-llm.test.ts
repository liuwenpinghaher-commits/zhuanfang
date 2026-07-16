/**
 * Parser robustness tests for corpus-llm.
 *
 * analyzeCorpusWithLlm wraps parseCorpusAnalysis (private).
 * 真实性契约(2026-07 重构):
 *  - No usable dimensions → throws "Corpus analysis produced no usable dimensions."
 *  - dimensions with missing name/finding are filtered out
 *  - impact not in {low, medium, high} → throws(不再静默改写成 medium)
 *  - score 解析后非 1-5 有限数 → throws(不再默认 3 分)
 *  - Well-formed JSON → structurally valid CorpusInsight returned
 */
import { describe, expect, it } from "vitest";
import { createInitialProductState } from "../../../../src/domain/engine";
import type { BailianChatClient } from "../providers/bailian";
import { analyzeCorpusWithLlm, buildCorpusUserMessage } from "./corpus-llm";

const baseState = createInitialProductState();
const baseInput = {
  title: "测试样本",
  mediaType: "text" as const,
  content: "主持人：你能具体说说吗？\n被访者：当然可以。"
};

const mockChat = (json: string): BailianChatClient => ({
  async complete() {
    return json;
  }
});

// Minimal valid JSON that parseCorpusAnalysis accepts
const VALID_JSON = JSON.stringify({
  dimensions: [
    {
      name: "追问动作",
      score: 4,
      finding: "善于索要具体细节",
      example: "你能具体说说吗",
      recommendedAction: "保持追问节奏"
    }
  ],
  improvementPlan: [
    {
      title: "增加追问频率",
      rationale: "样本节奏更密集",
      action: "在沉默时主动追问",
      expectedEngineChange: "追问频率提升",
      evidence: "你能具体说说吗"
    }
  ],
  patch: {
    title: "追问规则",
    description: "提高追问密度",
    rules: ["每两轮至少一次追问", "具体化提问"],
    impact: "high"
  }
});

describe("analyzeCorpusWithLlm", () => {
  it("happy path: well-formed JSON → returns valid insight + nextState", async () => {
    const { insight, nextState } = await analyzeCorpusWithLlm(baseState, baseInput, mockChat(VALID_JSON));

    expect(insight).toBeDefined();
    expect(Array.isArray(insight.dimensions)).toBe(true);
    expect(insight.dimensions.length).toBeGreaterThan(0);
    expect(insight.dimensions[0].name).toBe("追问动作");
    expect(insight.dimensions[0].score).toBe(4);
    expect(Array.isArray(insight.improvementPlan)).toBe(true);
    expect(insight.recommendedPatches.length).toBeGreaterThan(0);
    expect(nextState).toBeDefined();
  });

  it("no usable dimensions (all filtered out) → throws", async () => {
    const json = JSON.stringify({
      dimensions: [
        // name missing → filtered out by .filter((d) => d.name && d.finding)
        { score: 3, finding: "有 finding 但没有名字", example: "例子", recommendedAction: "建议" }
      ],
      improvementPlan: [],
      patch: { title: "补丁", description: "描述", rules: [], impact: "low" }
    });
    await expect(
      analyzeCorpusWithLlm(baseState, baseInput, mockChat(json))
    ).rejects.toThrow("no usable dimensions");
  });

  it("empty dimensions array → throws", async () => {
    const json = JSON.stringify({
      dimensions: [],
      improvementPlan: [],
      patch: { title: "补丁", description: "描述", rules: [], impact: "low" }
    });
    await expect(
      analyzeCorpusWithLlm(baseState, baseInput, mockChat(json))
    ).rejects.toThrow("no usable dimensions");
  });

  it("invalid impact value → throws (不再静默改写成 medium)", async () => {
    const json = JSON.stringify({
      ...JSON.parse(VALID_JSON),
      patch: {
        title: "补丁",
        description: "描述",
        rules: ["规则"],
        impact: "INVALID" // not in {low, medium, high}
      }
    });
    await expect(
      analyzeCorpusWithLlm(baseState, baseInput, mockChat(json))
    ).rejects.toThrow("invalid impact");
  });

  it("score as string → parsed numerically (or fallback to 3)", async () => {
    const json = JSON.stringify({
      ...JSON.parse(VALID_JSON),
      dimensions: [
        { name: "某维度", score: "5", finding: "很好", example: "原话", recommendedAction: "继续" }
      ]
    });
    const { insight } = await analyzeCorpusWithLlm(baseState, baseInput, mockChat(json));
    // Number("5") = 5 —— 数字字符串仍可解析为合法评分
    expect(insight.dimensions[0].score).toBe(5);
  });

  it("non-numeric score string → throws (非法评分不能用默认 3 分冒充)", async () => {
    const json = JSON.stringify({
      ...JSON.parse(VALID_JSON),
      dimensions: [
        { name: "某维度", score: "excellent", finding: "很好", example: "原话", recommendedAction: "继续" }
      ]
    });
    await expect(
      analyzeCorpusWithLlm(baseState, baseInput, mockChat(json))
    ).rejects.toThrow("invalid score");
  });

  it("malformed JSON → throws (分析只有 LLM 一条路,路由如实暴露错误)", async () => {
    await expect(
      analyzeCorpusWithLlm(baseState, baseInput, mockChat("not json"))
    ).rejects.toThrow();
  });

  it("dimensions is not an array → throws (no usable dimensions)", async () => {
    const json = JSON.stringify({
      dimensions: "not an array",
      improvementPlan: [],
      patch: { title: "补丁", description: "描述", rules: [], impact: "low" }
    });
    await expect(
      analyzeCorpusWithLlm(baseState, baseInput, mockChat(json))
    ).rejects.toThrow("no usable dimensions");
  });

  it("passes the user-supplied focus into the LLM user message", async () => {
    let captured = "";
    const capturingChat: BailianChatClient = {
      async complete(request) {
        const userMessage = request.messages.find((message) => message.role === "user");
        captured = userMessage?.content ?? "";
        return VALID_JSON;
      }
    };
    await analyzeCorpusWithLlm(baseState, baseInput, capturingChat, "重点学习如何追问失败经历");
    expect(captured).toContain("重点学习如何追问失败经历");
  });

  it("omits the focus block when no focus is supplied", async () => {
    let captured = "";
    const capturingChat: BailianChatClient = {
      async complete(request) {
        const userMessage = request.messages.find((message) => message.role === "user");
        captured = userMessage?.content ?? "";
        return VALID_JSON;
      }
    };
    await analyzeCorpusWithLlm(baseState, baseInput, capturingChat);
    expect(captured).not.toContain("用户特别希望你重点关注");
  });
});

describe("buildCorpusUserMessage", () => {
  it("embeds the sample title and content", () => {
    const message = buildCorpusUserMessage("某优秀样本", "主持人：你能具体说说吗？");
    expect(message).toContain("某优秀样本");
    expect(message).toContain("你能具体说说吗");
  });

  it("includes the focus instruction when focus is provided", () => {
    const message = buildCorpusUserMessage("样本", "内容", "如何做机制反转");
    expect(message).toContain("用户特别希望你重点关注");
    expect(message).toContain("如何做机制反转");
  });

  it("does not include the focus instruction when focus is omitted", () => {
    const message = buildCorpusUserMessage("样本", "内容");
    expect(message).not.toContain("用户特别希望你重点关注");
  });

  it("ignores a whitespace-only focus", () => {
    const message = buildCorpusUserMessage("样本", "内容", "   ");
    expect(message).not.toContain("用户特别希望你重点关注");
  });
});
