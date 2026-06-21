// LLM extraction of candidate long-term memories from an imported document.
// Returns reviewable candidates (the user approves each before it's stored).
import type { ImportedMemoryCandidate } from "../../../../src/domain/import";
import { sanitizeExternalMaterialBlock } from "../../../../src/domain/engine";
import { withMemoryCandidateReview } from "../../../../src/domain/memoryReview";
import type { MemoryCandidate } from "../../../../src/domain/types";
import { makeId } from "../../../../src/domain/utils";
import type { BailianChatClient } from "../providers/bailian";
import { asArray, asObject, asString, parseJsonObjectLoose } from "./llm-json";

const SYSTEM_PROMPT = [
  "你从用户导入的资料里抽取值得长期记住的【候选记忆】：稳定的事实、明确的观点、决策、未解的问题/知识债。",
  "每条都要给出资料里的原文片段作为 evidence。判断敏感度：涉及隐私/健康/财务/人际冲突标 sensitive，否则 normal。",
  "铁律：只抽资料里真实出现的内容，不编造。资料很薄就少抽几条。只输出一个 JSON 对象。"
].join("\n");

export async function extractCandidateMemories(
  title: string,
  content: string,
  chatClient: BailianChatClient
): Promise<ImportedMemoryCandidate[]> {
  const raw = await chatClient.complete({
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      {
        role: "user",
        content: [
          `资料标题：${title}`,
          "",
          "=== 资料内容 ===",
          sanitizeExternalMaterialBlock(content, "（外部资料片段已清洗）").slice(0, 8000),
          "=== 内容结束 ===",
          "",
          "请输出 JSON：",
          `{"candidates":[{"text":"一条值得长期记住的记忆（陈述句）","evidenceQuote":"资料里的原文片段","sensitivity":"normal|sensitive"}]}`
        ].join("\n")
      }
    ],
    responseFormat: "json",
    temperature: 0.3,
    maxTokens: 3000
  });

  const parsed = parseJsonObjectLoose(raw);
  if (!parsed) {
    throw new Error("memory extraction LLM returned unparseable JSON");
  }
  return asArray(parsed.candidates)
    .map((item) => {
      const obj = asObject(item);
      const sensitivity = asString(obj.sensitivity) === "sensitive" ? "sensitive" : "normal";
      return {
        text: asString(obj.text),
        evidenceQuote: asString(obj.evidenceQuote),
        sensitivity: sensitivity as "normal" | "sensitive"
      };
    })
    .filter((candidate) => candidate.text.length > 0)
    .slice(0, 20);
}

// Turn LLM-extracted candidates into reviewable MemoryCandidates sourced from an
// interview session. Mirrors the import-source conversion (ingestImportSource),
// but stamps sourceType="interview_session"/sourceId so the candidate links back
// to the conversation it came from. withMemoryCandidateReview scores each one.
export function toSessionMemoryCandidates(
  candidates: ImportedMemoryCandidate[],
  sessionId: string,
  sessionTitle: string,
  createdAt: string
): MemoryCandidate[] {
  return candidates.map((candidate) =>
    withMemoryCandidateReview({
      id: makeId("memory-candidate"),
      text: candidate.text,
      status: "pending" as const,
      sourceType: "interview_session" as const,
      sourceId: sessionId,
      evidenceQuote: candidate.evidenceQuote,
      reason: `从专访《${sessionTitle}》的对话中抽取，需你确认后才进入长期记忆。`,
      sensitivity: candidate.sensitivity,
      createdAt
    })
  );
}
