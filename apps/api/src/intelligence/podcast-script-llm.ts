// LLM-backed podcast script generator.
// Grounds the script ONLY in the note's summary/keyQuote/saidTrack/learnedTrack/nextQuestions.
// Throws on empty output so the caller can fall back to the deterministic script.
import type { DualTrackNote, PodcastEpisode } from "../../../../src/domain/types";
import type { BailianChatClient } from "../providers/bailian";

const SYSTEM_PROMPT = [
  "你是一名资深播客制作人。你的任务是把一次专访笔记转化为可朗读的播客脚本。",
  "铁律：",
  "1. 只能使用给定笔记中的真实内容，不编造事实、不添加未提到的内容。",
  "2. keyQuote 必须逐字引用，不得改写。",
  "3. 脚本要自然流畅，适合朗读，时长约 3-5 分钟。",
  "4. 直接输出脚本正文（纯文本），不要 JSON、不要 Markdown 标题、不要解释。"
].join("\n");

export async function generatePodcastScript(
  input: { note: Pick<DualTrackNote, "title" | "summary" | "keyQuote" | "saidTrack" | "learnedTrack" | "nextQuestions">; format: PodcastEpisode["format"] },
  chatClient: BailianChatClient
): Promise<string> {
  const { note, format } = input;
  const formatLabel = format === "host-guest" ? "主持对谈（双人）" : "单人旁白";

  const userPrompt = [
    `播客形态：${formatLabel}`,
    "",
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
  ].filter(Boolean).join("\n");

  const raw = await chatClient.complete({
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: userPrompt }
    ],
    responseFormat: "text",
    temperature: 0.6
  });

  const script = raw.trim();
  if (!script) {
    throw new Error("LLM podcast script generation returned empty output.");
  }
  return script;
}
