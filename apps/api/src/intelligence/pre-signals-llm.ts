// Voice-path pre_signals generation. The text interview gets pre_signals for
// free (the character model appends a <pre_signals> block to its follow-up),
// but the realtime voice model doesn't — so this generates them on demand from
// the conversation so far, reusing the same <pre_signals> format + parser.
import type { InteractionPreSignals, InterviewSession } from "../../../../src/domain/types";
import { extractPreSignals, type BailianChatClient } from "../providers/bailian";

const SYSTEM_PROMPT = [
  "你是专访的交互预判器。基于到目前为止的对话，预测【下一轮】用户表达时，AI 该往哪个方向深挖、哪些词不该打断、哪些词应立即停止。",
  "只输出一个 <pre_signals>...</pre_signals> 块，不要任何其它文字。"
].join("\n");

const TEMPLATE = [
  "<pre_signals>",
  "depth_direction:",
  "  concept: [基于对话，判断下一轮最值得深挖的一个方向；没有就留空]",
  "  reason: [为什么值得深挖]",
  "  guidance: [一句邀请式引导话语]",
  "backchannel: [用户说这些时不打断，逗号分隔，如：嗯,对,是的,好]",
  "interrupt: [用户说这些时立即停止，逗号分隔，如：不对,等一下,我打断一下]",
  "sensitivity: [low/medium/high，盲区/知识债=low，闲聊=high]",
  "</pre_signals>"
].join("\n");

export async function generatePreSignals(
  session: InterviewSession,
  chatClient: BailianChatClient
): Promise<InteractionPreSignals> {
  const transcript = session.turns
    .slice(-12)
    .map((turn) => `${turn.role === "user" ? "用户" : "主持人"}：${turn.content}`)
    .join("\n");

  const raw = await chatClient.complete({
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      {
        role: "user",
        content: [
          `本次主题：${session.title}`,
          "",
          "=== 对话记录 ===",
          transcript || "（暂无对话，按主题给一个合理的初始预判）",
          "=== 记录结束 ===",
          "",
          "请按这个格式输出：",
          TEMPLATE
        ].join("\n")
      }
    ],
    temperature: 0.3
  });

  const { preSignals } = extractPreSignals(raw.trim());
  if (!preSignals) {
    throw new Error("Failed to parse pre_signals from LLM output.");
  }
  return preSignals;
}
