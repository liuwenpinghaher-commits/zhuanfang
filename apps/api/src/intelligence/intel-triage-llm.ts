// LLM triage of raw search results into structured intel items: per-source
// summary, relevance score, extracted claims, and category. Maps results back
// to real source URLs by index (so the LLM never invents links).
import type { TriagedIntelItem } from "../../../../src/domain/intel";
import type { SourceHighlight } from "../../../../src/domain/types";
import type { BailianChatClient } from "../providers/bailian";
import { asArray, asObject, asString, asStringArray, parseJsonObject } from "./llm-json";

const SYSTEM_PROMPT = [
  "你是情报分析师。给定一个监控主题和一批联网搜索结果，对每条结果做分诊：写一句摘要、评估与主题的相关度(0-100)、抽取关键主张、归类。",
  "过滤明显无关的结果。只能基于给定来源，不要编造。只输出一个 JSON 对象。"
].join("\n");

export async function triageIntelResults(
  taskName: string,
  keywords: string[],
  sources: SourceHighlight[],
  chatClient: BailianChatClient
): Promise<TriagedIntelItem[]> {
  if (sources.length === 0) {
    return [];
  }
  const limited = sources.slice(0, 10);
  const list = limited
    .map((source, index) => `[${index + 1}] ${source.title}（${source.publisher}）：${source.snippet}`)
    .join("\n");

  const raw = await chatClient.complete({
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      {
        role: "user",
        content: [
          `监控任务：${taskName}`,
          `关键词：${keywords.join("、")}`,
          "",
          "=== 搜索结果 ===",
          list,
          "=== 结果结束 ===",
          "",
          "请输出 JSON（只保留相关度>=40 的，index 对应上面的编号）：",
          `{"items":[{"index":1,"summary":"一句话摘要","relevance":0到100,"claims":["关键主张"],"category":"如 趋势/观点/事件/数据"}]}`
        ].join("\n")
      }
    ],
    responseFormat: "json",
    temperature: 0.4,
    maxTokens: 1800
  });

  const parsed = parseJsonObject(raw);
  return asArray(parsed.items)
    .map((item) => {
      const obj = asObject(item);
      const index = Number(obj.index) - 1;
      const source = limited[index];
      if (!source) {
        return null;
      }
      return {
        title: source.title,
        url: source.url,
        publisher: source.publisher,
        summary: asString(obj.summary) || source.snippet,
        relevance: clampRelevance(obj.relevance),
        claims: asStringArray(obj.claims),
        category: asString(obj.category) || "未分类"
      } satisfies TriagedIntelItem;
    })
    .filter((item): item is TriagedIntelItem => item !== null);
}

function clampRelevance(value: unknown): number {
  const num = Number(value);
  if (!Number.isFinite(num)) {
    return 50;
  }
  return Math.max(0, Math.min(100, Math.round(num)));
}
