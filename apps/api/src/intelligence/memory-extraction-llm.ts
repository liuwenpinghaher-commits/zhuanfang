// LLM extraction of candidate long-term memories from an imported document.
// Returns reviewable candidates (the user approves each before it's stored).
import type { ImportedMemoryCandidate } from "../../../../src/domain/import";
import { sanitizeExternalMaterialBlock , sanitizeExternalMaterialText } from "../../../../src/domain/engine";
import { conflictsWithExplicitCorrection, withMemoryCandidateReview } from "../../../../src/domain/memoryReview";
import type { MemoryCandidate } from "../../../../src/domain/types";
import { makeId } from "../../../../src/domain/utils";
import type { BailianChatClient } from "../providers/bailian";
import { asArray, asObject, asString, parseJsonObjectLoose } from "./llm-json";

const SYSTEM_PROMPT = [
  "你从下面的内容里抽取值得【长期记住】的候选记忆：跨时间仍成立的稳定观点/事实、明确的决策(含取舍)、未解的知识债/盲区。",
  "硬门槛——每条必须能落地为下面至少一种，否则不要抽：",
  "  (1) 一个可测量信号或量化判断；",
  "  (2) 一个可触发的条件/机制（形如「当X时会Y」「因为A所以B」「不是A而是B」）；",
  "  (3) 一个可证伪的假设（你能想象它在什么情况下不成立）。",
  "明确排除（这些不要抽）：纯修辞金句/比喻/诗意表达、情绪性一次性感慨、含「总是/永远/所有/完全/必须」的空泛绝对化、与已抽条目语义重复的。",
  "优先抽「可复用的知识债与机制」，而不是「读起来很妙的话」。宁可少而精，不要多而水；内容很薄就少抽几条甚至不抽。",
  "每条都要给出原文片段作为 evidence。判断敏感度：涉及隐私/健康/财务/人际冲突标 sensitive，否则 normal。",
  "铁律：只抽真实出现的内容，不编造。只输出一个 JSON 对象。"
].join("\n");

/** Per-stage /end budget for memory extract. Matches write-gate END_WRITE_PHASE_BUDGET_MS extract slice. */
export const MEMORY_EXTRACT_TIMEOUT_MS = 60_000;
export const MEMORY_EXTRACT_CHUNK_CHARS = 5_000;
export const MEMORY_EXTRACT_CHUNK_OVERLAP = 200;

export function splitTranscriptForMemoryExtract(
  content: string,
  chunkChars = MEMORY_EXTRACT_CHUNK_CHARS,
  overlap = MEMORY_EXTRACT_CHUNK_OVERLAP
): string[] {
  if (content.length <= chunkChars) return [content];
  const chunks: string[] = [];
  let start = 0;
  while (start < content.length) {
    const end = Math.min(start + chunkChars, content.length);
    chunks.push(content.slice(start, end));
    if (end >= content.length) break;
    start = end - overlap;
  }
  return chunks;
}

function parseExtractedCandidates(raw: string): ImportedMemoryCandidate[] {
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
    .filter((candidate) => candidate.text.length > 0);
}

async function extractOneChunk(
  title: string,
  chunk: string,
  chatClient: BailianChatClient,
  corrections: string[],
  timeoutMs: number,
  chunkIndex: number,
  chunkCount: number
): Promise<ImportedMemoryCandidate[]> {
  const raw = await chatClient.complete({
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      {
        role: "user",
        content: [
          `资料标题：${sanitizeExternalMaterialText(title, "（标题已清洗）")}`,
          ...(chunkCount > 1
            ? [`这是长资料的第 ${chunkIndex + 1}/${chunkCount} 段，只抽本段真实出现的内容。`]
            : []),
          "",
          "=== 资料内容 ===",
          chunk,
          "=== 内容结束 ===",
          ...(corrections.length > 0
            ? [
                "",
                "=== 用户明确修正（最高优先级）===",
                ...corrections.map((correction) => `- ${sanitizeExternalMaterialText(correction, "（修正已清洗）")}`),
                "不得抽取与这些修正冲突的旧观点；如需抽取，只能保留修正后的完整表述。",
                "=== 修正结束 ==="
              ]
            : []),
          "",
          "请输出 JSON：",
          `{"candidates":[{"text":"一条值得长期记住的记忆（陈述句）","evidenceQuote":"资料里的原文片段","sensitivity":"normal|sensitive"}]}`
        ].join("\n")
      }
    ],
    responseFormat: "json",
    temperature: 0.3,
    maxTokens: 3000,
    timeoutMs
  });
  return parseExtractedCandidates(raw);
}

export async function extractCandidateMemories(
  title: string,
  content: string,
  chatClient: BailianChatClient,
  options: { corrections?: string[] } = {}
): Promise<ImportedMemoryCandidate[]> {
  const corrections = (options.corrections ?? []).map((item) => item.trim()).filter(Boolean).slice(-20);
  // Cover a full long interview (~20K chars). At 8000 the back ~60% of a 20K-char
  // session was never mined for memories, so durable knowledge from the second half
  // (often the deepest part) was silently dropped. A single 24k prompt still blows
  // the 60s extract budget, so long bodies are chunked and each call gets a slice
  // of that budget.
  const body = sanitizeExternalMaterialBlock(content, "（外部资料片段已清洗）").slice(0, 24000);
  const chunks = splitTranscriptForMemoryExtract(body);
  // Each slice keeps the full 60s extract budget. Dividing 60s by chunk count
  // (20s×3) is what killed the 15-turn /end retry — the model never finished
  // the first slice. Parallel slices keep wall-clock near 60s.
  const parts = await Promise.all(
    chunks.map((chunk, i) =>
      extractOneChunk(title, chunk, chatClient, corrections, MEMORY_EXTRACT_TIMEOUT_MS, i, chunks.length)
    )
  );
  const merged: ImportedMemoryCandidate[] = [];
  const seen = new Set<string>();
  for (const part of parts) {
    for (const candidate of part) {
      const key = candidate.text.trim();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      merged.push(candidate);
    }
  }
  return merged
    .filter((candidate) => !conflictsWithExplicitCorrection(candidate, corrections))
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
