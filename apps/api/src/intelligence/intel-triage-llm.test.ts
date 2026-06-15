/**
 * Parser robustness tests for intel-triage-llm.
 *
 * triageIntelResults calls parseJsonObject + clampRelevance (private).
 * Robustness points:
 *  - non-numeric relevance → clamped to 50 (isFinite fallback)
 *  - out-of-range relevance (>100 / <0) → clamped to [0, 100]
 *  - missing claims → empty array (asStringArray default)
 *  - item with invalid index (out of bounds) → filtered out (null → filtered)
 *  - empty sources → returns []
 */
import { describe, expect, it } from "vitest";
import type { SourceHighlight } from "../../../../src/domain/types";
import type { BailianChatClient } from "../providers/bailian";
import { triageIntelResults } from "./intel-triage-llm";

const mockChat = (json: string): BailianChatClient => ({
  async complete() {
    return json;
  }
});

const mockSources: SourceHighlight[] = [
  {
    id: "src-1",
    title: "AI 新闻",
    url: "https://example.com/1",
    publisher: "科技媒体",
    publishedAt: "2025-01-01",
    snippet: "AI 发展迅速",
    relevanceScore: 80,
    usage: "topic-suggestion"
  },
  {
    id: "src-2",
    title: "编程工具",
    url: "https://example.com/2",
    publisher: "开发者日报",
    publishedAt: "2025-01-02",
    snippet: "coding agent 落地",
    relevanceScore: 70,
    usage: "topic-suggestion"
  }
];

describe("triageIntelResults", () => {
  it("happy path: well-formed JSON → returns typed TriagedIntelItem array", async () => {
    const json = JSON.stringify({
      items: [
        {
          index: 1,
          summary: "AI 发展很快",
          relevance: 85,
          claims: ["大型模型主导市场", "开源追赶速度加快"],
          category: "趋势"
        }
      ]
    });
    const result = await triageIntelResults("AI 趋势", ["AI", "LLM"], mockSources, mockChat(json));

    expect(result.length).toBe(1);
    expect(result[0].title).toBe("AI 新闻");
    expect(result[0].url).toBe("https://example.com/1");
    expect(result[0].relevance).toBe(85);
    expect(result[0].claims).toEqual(["大型模型主导市场", "开源追赶速度加快"]);
    expect(result[0].category).toBe("趋势");
    expect(result[0].summary).toBe("AI 发展很快");
  });

  it("non-numeric relevance → clamped to 50 (default)", async () => {
    const json = JSON.stringify({
      items: [{ index: 1, summary: "摘要", relevance: "high", claims: [], category: "趋势" }]
    });
    const result = await triageIntelResults("主题", ["关键词"], mockSources, mockChat(json));
    expect(result[0].relevance).toBe(50);
  });

  it("null relevance → Number(null)=0, clamped to 0", async () => {
    // Number(null) = 0, which IS finite, so clampRelevance returns Math.max(0, Math.min(100, 0)) = 0
    const json = JSON.stringify({
      items: [{ index: 1, summary: "摘要", relevance: null, claims: [], category: "观点" }]
    });
    const result = await triageIntelResults("主题", ["关键词"], mockSources, mockChat(json));
    expect(result[0].relevance).toBe(0);
  });

  it("undefined relevance → Number(undefined)=NaN → default 50", async () => {
    // When relevance key is missing from JSON, obj.relevance is undefined
    // Number(undefined) = NaN → !isFinite → returns 50
    const json = JSON.stringify({
      items: [{ index: 1, summary: "摘要", claims: [], category: "观点" }] // relevance missing
    });
    const result = await triageIntelResults("主题", ["关键词"], mockSources, mockChat(json));
    expect(result[0].relevance).toBe(50);
  });

  it("relevance > 100 → clamped to 100", async () => {
    const json = JSON.stringify({
      items: [{ index: 1, summary: "摘要", relevance: 999, claims: [], category: "事件" }]
    });
    const result = await triageIntelResults("主题", ["关键词"], mockSources, mockChat(json));
    expect(result[0].relevance).toBe(100);
  });

  it("relevance < 0 → clamped to 0", async () => {
    const json = JSON.stringify({
      items: [{ index: 1, summary: "摘要", relevance: -50, claims: [], category: "数据" }]
    });
    const result = await triageIntelResults("主题", ["关键词"], mockSources, mockChat(json));
    expect(result[0].relevance).toBe(0);
  });

  it("missing claims field → empty array", async () => {
    const json = JSON.stringify({
      items: [{ index: 1, summary: "摘要", relevance: 70, category: "趋势" }] // no claims
    });
    const result = await triageIntelResults("主题", ["关键词"], mockSources, mockChat(json));
    expect(result[0].claims).toEqual([]);
  });

  it("item with out-of-range index → filtered out", async () => {
    const json = JSON.stringify({
      items: [
        { index: 99, summary: "越界索引", relevance: 80, claims: [], category: "趋势" }
      ]
    });
    const result = await triageIntelResults("主题", ["关键词"], mockSources, mockChat(json));
    expect(result).toEqual([]);
  });

  it("empty sources array → returns [] without calling LLM", async () => {
    // triageIntelResults returns [] when sources.length === 0
    const result = await triageIntelResults("主题", ["关键词"], [], mockChat("{}"));
    expect(result).toEqual([]);
  });

  it("malformed JSON → throws so caller falls back", async () => {
    await expect(
      triageIntelResults("主题", ["关键词"], mockSources, mockChat("not json"))
    ).rejects.toThrow();
  });

  it("items is not an array → returns empty (asArray fallback)", async () => {
    const json = JSON.stringify({ items: "not an array" });
    const result = await triageIntelResults("主题", ["关键词"], mockSources, mockChat(json));
    expect(result).toEqual([]);
  });

  it("missing summary → falls back to source snippet", async () => {
    const json = JSON.stringify({
      items: [{ index: 1, relevance: 60, claims: [], category: "趋势" }] // no summary
    });
    const result = await triageIntelResults("主题", ["关键词"], mockSources, mockChat(json));
    // asString(undefined) = "" → fallback to source.snippet
    expect(result[0].summary).toBe("AI 发展迅速");
  });
});
