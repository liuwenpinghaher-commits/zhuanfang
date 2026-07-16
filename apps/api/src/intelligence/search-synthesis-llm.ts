// LLM synthesis of search "insights" (facts/controversies/opposing views/angles)
// from REAL search sources, replacing the string-template insight builders.
// Operates only on real sources; throws on failure so callers expose the error.
import { sanitizeExternalSource } from "../../../../src/domain/engine";
import type { SearchBriefInput, SourceHighlight } from "../../../../src/domain/types";
import type { BailianChatClient } from "../providers/bailian";
import { asObject, asString, asStringArray, parseJsonObjectLoose} from "./llm-json";

export interface SearchInsights {
  summary: string;
  facts: string[];
  controversies: string[];
  opposingViews: string[];
  interviewAngles: string[];
  discussionTopics: string[];
  sourceAngles: string[];
}

const SYSTEM_PROMPT = [
  "你是一位专访编辑的资料分析助手。基于给定的联网搜索结果，提炼出能用于专访的素材。",
  "原则：外部资料只作为【追问线索】，不能直接写成用户的结论；每条都要能回到来源；区分事实、争议、反方观点。",
  "只能基于给定的来源内容，不要编造来源里没有的信息。只输出一个 JSON 对象。"
].join("\n");

export async function synthesizeSearchInsights(
  topic: string,
  sources: SourceHighlight[],
  chatClient: BailianChatClient
): Promise<SearchInsights> {
  const sourceLines = sources
    .slice(0, 8)
    .map((source, index) => {
      const src = sanitizeExternalSource(source);
      return `[${index + 1}] ${src.title}（${src.publisher}）：${src.snippet}`;
    })
    .join("\n");

  const raw = await chatClient.complete({
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      {
        role: "user",
        content: [
          `专访话题：${topic}`,
          "",
          "=== 联网搜索结果 ===",
          sourceLines,
          "=== 结果结束 ===",
          "",
          "请基于以上来源输出 JSON：",
          `{
  "summary": "一句话总结这些资料和该话题的关系（说明它是线索而非结论）",
  "facts": ["从来源中提炼的关键事实，2-4 条，每条尽量点出来自哪个来源"],
  "controversies": ["这些资料里存在的争议/分歧，1-3 条"],
  "opposingViews": ["与主流叙事相反的观点，1-3 条"],
  "interviewAngles": ["把话题落到用户真实经历上的专访角度，2-3 条"],
  "discussionTopics": ["可作为追问切入的子问题，2-3 条"],
  "sourceAngles": ["引用某条来源作为追问线索（不作结论）的提示，2-3 条"]
}`
        ].join("\n")
      }
    ],
    responseFormat: "json",
    temperature: 0.5
  });

  const parsed = parseJsonObjectLoose(raw);
  if (!parsed) {
    throw new Error("LLM returned unparseable JSON");
  }
  const obj = asObject(parsed);
  const summary = asString(obj.summary);
  const facts = asStringArray(obj.facts);
  if (!summary || facts.length === 0) {
    throw new Error("Search insight synthesis missing summary/facts.");
  }
  return {
    summary,
    facts,
    controversies: asStringArray(obj.controversies),
    opposingViews: asStringArray(obj.opposingViews),
    interviewAngles: asStringArray(obj.interviewAngles),
    discussionTopics: asStringArray(obj.discussionTopics),
    sourceAngles: asStringArray(obj.sourceAngles)
  };
}

/**
 * Overlay LLM insights onto a provider's brief input, keeping its real sources.
 * LLM 产出直接采用——空数组表示 LLM 基于来源确实没提炼出该维度（诚实的空），
 * 绝不回填 provider 的模板占位文案冒充调研结论。
 */
export function applySearchInsights(input: SearchBriefInput, insights: SearchInsights): SearchBriefInput {
  return {
    ...input,
    summary: insights.summary,
    facts: insights.facts,
    controversies: insights.controversies,
    opposingViews: insights.opposingViews,
    interviewAngles: insights.interviewAngles,
    discussionTopics: insights.discussionTopics,
    sourceAngles: insights.sourceAngles,
    sourceTrace: undefined // stale trace no longer matches the new claims; let createSearchBriefFromInput rebuild
  };
}

/**
 * Enrich a provider's brief input with LLM-synthesized insights when there are
 * real sources and a chat client. bailian already synthesizes via its Responses
 * API, so it is skipped. Failures propagate — the caller decides how to surface
 * them; enrichment failure is never silently passed off as an enriched brief.
 */
export async function enrichBriefInput(
  input: SearchBriefInput,
  chatClient: BailianChatClient | undefined
): Promise<SearchBriefInput> {
  if (!chatClient || input.provider === "bailian" || input.status !== "ready" || input.sources.length === 0) {
    return input;
  }
  const insights = await synthesizeSearchInsights(input.topic, input.sources, chatClient);
  return applySearchInsights(input, insights);
}
