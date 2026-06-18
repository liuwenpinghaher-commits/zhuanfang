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

  it("LLM 返回坏 JSON → 默认 done:true（宁可接话）", async () => {
    const r = await classifyTurnComplete(fakeSession(), "嗯", fakeChat("不是JSON"));
    expect(r.done).toBe(true);
  });

  it("chatClient 抛错 → 默认 done:true", async () => {
    const chat: BailianChatClient = { complete: vi.fn(async () => { throw new Error("timeout"); }) };
    const r = await classifyTurnComplete(fakeSession(), "嗯", chat);
    expect(r.done).toBe(true);
  });
});
