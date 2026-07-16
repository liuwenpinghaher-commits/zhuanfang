import { describe, it, expect, vi } from "vitest";
import { classifyTurnComplete } from "./turn-endpoint-llm";
import type { BailianChatClient } from "../providers/bailian";
import type { InterviewSession } from "../../../../src/domain/types";

function fakeSession(): InterviewSession {
  return { turns: [{ role: "user", content: "上次说到团队授权" } as any] } as InterviewSession;
}
function fakeChat(content: string): BailianChatClient {
  return { complete: vi.fn(async () => content) };
}

describe("classifyTurnComplete", () => {
  it("LLM 判 done:true → {done:true}", async () => {
    const r = await classifyTurnComplete(fakeSession(), "你说的是什么意思", fakeChat('{"done":true,"reason":"完整问句"}'));
    expect(r.done).toBe(true);
  });

  it("LLM 判 done:false → {done:false}", async () => {
    const r = await classifyTurnComplete(fakeSession(), "我觉得吧", fakeChat('{"done":false,"reason":"话没说完"}'));
    expect(r.done).toBe(false);
  });

  // 真实性重构:剔除「失败 → 默认 done:true」兜底——服务端不伪造分类结果,
  // 失败向上抛由路由如实 5xx;"拿不到判定就默认应答"的实时策略属于 cascade 调用方。
  it("LLM 返回坏 JSON → 向上抛(不再默认 done:true)", async () => {
    await expect(classifyTurnComplete(fakeSession(), "嗯", fakeChat("不是JSON"))).rejects.toThrow();
  });

  it("chatClient 抛错 → 向上抛(不再默认 done:true)", async () => {
    const chat: BailianChatClient = { complete: vi.fn(async () => { throw new Error("timeout"); }) };
    await expect(classifyTurnComplete(fakeSession(), "嗯", chat)).rejects.toThrow("timeout");
  });
});
