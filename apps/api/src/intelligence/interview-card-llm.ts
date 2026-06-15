// LLM-backed interview card synthesizer.
// Uses the user's REAL long-term themes, open debts, recent notes and recalled
// memories to produce a richer opening card.  Throws on any LLM/parse failure
// so the route falls back to the deterministic buildInterviewCard.
import type { InterviewGuide, ProductState } from "../../../../src/domain/types";
import type { BailianChatClient } from "../providers/bailian";
import { asObject, asString, asStringArray, parseJsonObject } from "./llm-json";

export interface SynthesizedCard {
  whyNow: string;
  suggestedOpening: string;
  potentialTension: string;
  likelyOutputs: string[];
}

const SYSTEM_PROMPT = [
  "你是专访主持人的策划助手。基于用户的真实长期主题、未还知识债、最近笔记和召回记忆，为今天这场专访生成开场策划。",
  "铁律：只能基于给定的真实数据，不编造用户没有的主题/事件。只输出一个 JSON 对象。"
].join("\n");

export async function synthesizeInterviewCard(
  state: ProductState,
  guide: InterviewGuide,
  chatClient: BailianChatClient
): Promise<SynthesizedCard> {
  const themes = state.themes.slice(0, 6).map((t) => `${t.name}（${t.summary}）`);
  const debts = (guide.openDebts ?? []).map((d) => d.concept).slice(0, 6);
  const recentNotes = state.notes.slice(0, 5).map((n) => n.summary);
  const memories = (guide.relevantMemories ?? []).slice(0, 5);
  const raw = await chatClient.complete({
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      {
        role: "user",
        content: [
          `话题倾向：${guide.topicHint || "（未指定）"}`,
          `长期主题：${themes.join("、") || "（无）"}`,
          `未还知识债：${debts.join("、") || "（无）"}`,
          `近期笔记：${recentNotes.join(" / ") || "（无）"}`,
          `可引用记忆：${memories.join(" / ") || "（无）"}`,
          "",
          "请输出 JSON：",
          `{"whyNow":"为什么此刻值得聊这个，一句话","suggestedOpening":"一个自然的开场问题","potentialTension":"潜在的张力或矛盾，一句话","likelyOutputs":["这场专访可能沉淀出的 1-3 类资产"]}`
        ].join("\n")
      }
    ],
    responseFormat: "json",
    temperature: 0.5
  });
  const obj = asObject(parseJsonObject(raw));
  const whyNow = asString(obj.whyNow);
  if (!whyNow) throw new Error("card synthesis missing whyNow");
  return {
    whyNow,
    suggestedOpening: asString(obj.suggestedOpening) || guide.suggestedOpening,
    potentialTension: asString(obj.potentialTension),
    likelyOutputs: asStringArray(obj.likelyOutputs)
  };
}
