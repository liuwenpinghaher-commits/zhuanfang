/**
 * Parser robustness tests for search-synthesis-llm.
 *
 * synthesizeSearchInsights calls parseJsonObject + asObject/asString/asStringArray.
 * Robustness points:
 *  - missing summary or empty facts → throws "missing summary/facts"
 *  - optional arrays missing → empty arrays (asStringArray default)
 *  - malformed JSON → throws (parseJsonObject propagates)
 *  - Well-formed JSON → returns valid SearchInsights
 */
import { describe, expect, it } from "vitest";
import type { SourceHighlight } from "../../../../src/domain/types";
import type { BailianChatClient } from "../providers/bailian";
import { synthesizeSearchInsights } from "./search-synthesis-llm";

const mockChat = (json: string): BailianChatClient => ({
  async complete() {
    return json;
  }
});

const mockSources: SourceHighlight[] = [
  {
    id: "src-1",
    title: "AI 2025 年现状",
    url: "https://example.com/ai-2025",
    publisher: "科技评论",
    publishedAt: "2025-01-01",
    snippet: "2025 年 AI 模型能力快速提升，各行业应用深化",
    relevanceScore: 90,
    usage: "topic-suggestion"
  },
  {
    id: "src-2",
    title: "AI 编程工具对比",
    url: "https://example.com/coding-tools",
    publisher: "开发者社区",
    publishedAt: "2025-01-02",
    snippet: "Cursor 与 GitHub Copilot 各有优劣，多数开发者混合使用",
    relevanceScore: 85,
    usage: "topic-suggestion"
  }
];

const VALID_JSON = JSON.stringify({
  summary: "这些资料揭示了 AI 工具发展的两条路径，作为追问线索而非结论",
  facts: ["AI 编程工具已被超过 70% 的开发者采用", "多模型混合策略成为主流"],
  controversies: ["自动化是否导致工程师技能退化"],
  opposingViews: ["AI 工具实际提高了工程师门槛而非降低"],
  interviewAngles: ["你的团队用 AI 工具解决了什么以前解决不了的问题？"],
  discussionTopics: ["你如何判断 AI 生成的代码质量？"],
  sourceAngles: ["来源 [1] 提到用户接受度，可作为追问切入"]
});

describe("synthesizeSearchInsights", () => {
  it("happy path: well-formed JSON → returns valid SearchInsights", async () => {
    const result = await synthesizeSearchInsights("AI 编程工具", mockSources, mockChat(VALID_JSON));

    expect(typeof result.summary).toBe("string");
    expect(result.summary.length).toBeGreaterThan(0);
    expect(Array.isArray(result.facts)).toBe(true);
    expect(result.facts.length).toBeGreaterThan(0);
    expect(Array.isArray(result.controversies)).toBe(true);
    expect(Array.isArray(result.opposingViews)).toBe(true);
    expect(Array.isArray(result.interviewAngles)).toBe(true);
    expect(Array.isArray(result.discussionTopics)).toBe(true);
    expect(Array.isArray(result.sourceAngles)).toBe(true);
  });

  it("missing summary → throws 'missing summary/facts'", async () => {
    const json = JSON.stringify({
      facts: ["一个事实"],
      controversies: [],
      opposingViews: [],
      interviewAngles: [],
      discussionTopics: [],
      sourceAngles: []
    });
    await expect(
      synthesizeSearchInsights("主题", mockSources, mockChat(json))
    ).rejects.toThrow("missing summary/facts");
  });

  it("empty facts array → throws 'missing summary/facts'", async () => {
    const json = JSON.stringify({
      summary: "有摘要",
      facts: [], // empty → asStringArray returns [] → length === 0 → throws
      controversies: [],
      opposingViews: [],
      interviewAngles: [],
      discussionTopics: [],
      sourceAngles: []
    });
    await expect(
      synthesizeSearchInsights("主题", mockSources, mockChat(json))
    ).rejects.toThrow("missing summary/facts");
  });

  it("optional arrays missing → default to [] (no crash)", async () => {
    const json = JSON.stringify({
      summary: "有摘要",
      facts: ["有一个事实"]
      // controversies, opposingViews, interviewAngles, discussionTopics, sourceAngles missing
    });
    const result = await synthesizeSearchInsights("主题", mockSources, mockChat(json));
    expect(result.controversies).toEqual([]);
    expect(result.opposingViews).toEqual([]);
    expect(result.interviewAngles).toEqual([]);
    expect(result.discussionTopics).toEqual([]);
    expect(result.sourceAngles).toEqual([]);
  });

  it("malformed JSON → throws so caller falls back", async () => {
    await expect(
      synthesizeSearchInsights("主题", mockSources, mockChat("not json at all"))
    ).rejects.toThrow();
  });

  it("JSON array at top level → throws (parseJsonObject requires object)", async () => {
    await expect(
      synthesizeSearchInsights("主题", mockSources, mockChat("[1,2,3]"))
    ).rejects.toThrow("unparseable JSON");
  });

  it("facts is not an array → treated as empty → throws", async () => {
    const json = JSON.stringify({
      summary: "有摘要",
      facts: "这不是数组" // asStringArray("string") returns fallback []
    });
    await expect(
      synthesizeSearchInsights("主题", mockSources, mockChat(json))
    ).rejects.toThrow("missing summary/facts");
  });
});
