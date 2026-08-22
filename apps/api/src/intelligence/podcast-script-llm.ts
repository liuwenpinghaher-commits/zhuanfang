// LLM-backed podcast script generator.
// Grounds the script ONLY in provided structured facts. Throws on empty output.
import type {
  DualTrackNote,
  KnowledgeDebt,
  LongTermTheme,
  PodcastEpisode,
  SearchBrief
} from "../../../../src/domain/types";
import type { BailianChatClient } from "../providers/bailian";

const SYSTEM_PROMPT = [
  "你是一名资深播客制作人。你的任务是把给定的结构化素材转化为可朗读的播客脚本。",
  "铁律：",
  "1. 只能使用给定素材中的真实内容，不编造事实、不添加未提到的内容。",
  "2. 若提供关键原话/代表原话，必须逐字引用，不得改写。",
  "3. 脚本要自然流畅，适合朗读，时长约 3-5 分钟。",
  "4. 若形态为主持对谈，用「主持人：」「来宾：」交替行；单人旁白用连贯口播。",
  "5. 直接输出脚本正文（纯文本），不要 JSON、不要 Markdown 标题、不要解释。"
].join("\n");

export type PodcastScriptSource =
  | {
      kind: "note";
      note: Pick<DualTrackNote, "title" | "summary" | "keyQuote" | "saidTrack" | "learnedTrack" | "nextQuestions">;
      format: PodcastEpisode["format"];
    }
  | {
      kind: "search-brief";
      brief: Pick<
        SearchBrief,
        "topic" | "summary" | "facts" | "controversies" | "opposingViews" | "interviewAngles" | "discussionTopics" | "sources"
      >;
      format: PodcastEpisode["format"];
    }
  | {
      kind: "theme";
      theme: Pick<
        LongTermTheme,
        "name" | "summary" | "representativeQuote" | "maturity" | "appearances" | "nextQuestion"
      >;
      format: PodcastEpisode["format"];
    }
  | {
      kind: "knowledge-debt";
      debt: Pick<KnowledgeDebt, "concept" | "context" | "whyImportant" | "status" | "nextQuestion">;
      format: PodcastEpisode["format"];
    };

/** Host-guest 3–5 min scripts routinely exceed the chat client 60s default. */
export const PODCAST_SCRIPT_TIMEOUT_MS = 180_000;

function formatLabel(format: PodcastEpisode["format"]) {
  return format === "host-guest" ? "主持对谈（双人）" : "单人旁白";
}

function buildUserPrompt(input: PodcastScriptSource): string {
  const head = [`播客形态：${formatLabel(input.format)}`, ""];
  if (input.kind === "note") {
    const { note } = input;
    return [
      ...head,
      "【笔记内容（唯一事实来源）】",
      `标题：${note.title}`,
      `摘要：${note.summary}`,
      `关键原话（必须逐字引用）："${note.keyQuote}"`,
      "",
      "我说了什么：",
      ...note.saidTrack.slice(0, 5).map((line, i) => `${i + 1}. ${line}`),
      "",
      "我学到了什么：",
      ...note.learnedTrack.slice(0, 5).map((line, i) => `${i + 1}. ${line}`),
      "",
      "下次值得追问：",
      ...note.nextQuestions.slice(0, 3).map((q, i) => `${i + 1}. ${q}`),
      "",
      "请基于以上内容，生成一段自然流畅、适合朗读的播客脚本。直接输出脚本，不要任何额外说明。"
    ].join("\n");
  }
  if (input.kind === "search-brief") {
    const { brief } = input;
    return [
      ...head,
      "【搜索简报（唯一事实来源）】",
      `主题：${brief.topic}`,
      `摘要：${brief.summary}`,
      "",
      "事实：",
      ...brief.facts.slice(0, 5).map((x, i) => `${i + 1}. ${x}`),
      "",
      "争议：",
      ...brief.controversies.slice(0, 4).map((x, i) => `${i + 1}. ${x}`),
      "",
      "反方：",
      ...brief.opposingViews.slice(0, 4).map((x, i) => `${i + 1}. ${x}`),
      "",
      "专访角度：",
      ...brief.interviewAngles.slice(0, 4).map((x, i) => `${i + 1}. ${x}`),
      "",
      "可讨论主题：",
      ...brief.discussionTopics.slice(0, 4).map((x, i) => `${i + 1}. ${x}`),
      "",
      "来源：",
      ...brief.sources.slice(0, 4).map((s, i) => `${i + 1}. ${s.publisher}｜${s.title}`),
      "",
      "请基于以上内容，生成一段自然流畅、适合朗读的热点专题播客脚本。直接输出脚本，不要任何额外说明。"
    ].join("\n");
  }
  if (input.kind === "theme") {
    const { theme } = input;
    return [
      ...head,
      "【长期主题（唯一事实来源）】",
      `主题名：${theme.name}`,
      `摘要：${theme.summary}`,
      `代表原话（必须逐字引用）："${theme.representativeQuote}"`,
      `成熟度：${theme.maturity}`,
      `历史出现：${theme.appearances} 次`,
      `下一问：${theme.nextQuestion}`,
      "",
      "请基于以上内容，生成一段自然流畅、适合朗读的主题回访播客脚本。直接输出脚本，不要任何额外说明。"
    ].join("\n");
  }
  const { debt } = input;
  return [
    ...head,
    "【知识债（唯一事实来源）】",
    `概念：${debt.concept}`,
    `背景：${debt.context}`,
    `为什么重要：${debt.whyImportant}`,
    `状态：${debt.status}`,
    `下一问：${debt.nextQuestion}`,
    "",
    "请基于以上内容，生成一段自然流畅、适合朗读的学习向播客脚本。直接输出脚本，不要任何额外说明。"
  ].join("\n");
}

/** @deprecated Prefer generatePodcastScriptFromSource — kept for call-site compatibility. */
export async function generatePodcastScript(
  input: { note: Pick<DualTrackNote, "title" | "summary" | "keyQuote" | "saidTrack" | "learnedTrack" | "nextQuestions">; format: PodcastEpisode["format"] },
  chatClient: BailianChatClient
): Promise<string> {
  return generatePodcastScriptFromSource({ kind: "note", note: input.note, format: input.format }, chatClient);
}

export async function generatePodcastScriptFromSource(
  input: PodcastScriptSource,
  chatClient: BailianChatClient
): Promise<string> {
  const userPrompt = buildUserPrompt(input);
  const raw = await chatClient.complete({
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: userPrompt }
    ],
    responseFormat: "text",
    temperature: 0.6,
    maxTokens: 4096,
    timeoutMs: PODCAST_SCRIPT_TIMEOUT_MS
  });
  const script = raw.trim();
  if (!script) {
    throw new Error("LLM podcast script generation returned empty output.");
  }
  return script;
}
