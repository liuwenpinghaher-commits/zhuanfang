import type { BailianChatClient } from "../providers/bailian";
import type { InterviewSession } from "../../../../src/domain/types";

/**
 * Layer 2 of the cascade turn gate: ask the LLM whether the user has finished
 * their turn, using the last few turns as context (LiveKit's text-first EOU idea).
 * Only called when the cheap heuristic returns "ambiguous". 失败向上抛——
 * 由路由如实 5xx；"拿不到判定就默认应答"的实时策略属于 cascade 调用方，
 * 服务端不伪造 done:true 的分类结果。
 */
export async function classifyTurnComplete(
  session: InterviewSession,
  transcript: string,
  chatClient: BailianChatClient
): Promise<{ done: boolean; reason: string }> {
  const recent = session.turns
    .slice(-4)
    .map((t) => `${t.role === "user" ? "用户" : "主持人"}：${t.content}`)
    .join("\n");

  const prompt =
    `你在判断访谈中"用户是否已经说完这一轮"。只判断用户最后这句是不是一个可以回应的完整表达，` +
    `还是话只说到一半（在思考、列举、卡顿、被打断）。\n\n` +
    `最近对话：\n${recent || "（无）"}\n\n` +
    `用户最新（可能未说完）：${transcript}\n\n` +
    `只输出 JSON：{"done": true 或 false, "reason": "简短中文理由"}`;

  const raw = await chatClient.complete({
    messages: [
      { role: "system", content: "你是轮转判定器，只输出 JSON，不要解释。" },
      { role: "user", content: prompt },
    ],
    responseFormat: "json",
    maxTokens: 60,
    temperature: 0,
  });
  const parsed = JSON.parse(raw) as { done?: unknown; reason?: unknown };
  return {
    done: parsed.done === true,
    reason: typeof parsed.reason === "string" ? parsed.reason : "",
  };
}
