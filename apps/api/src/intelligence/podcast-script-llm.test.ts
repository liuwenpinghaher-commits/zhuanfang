import { describe, expect, it } from "vitest";
import type { BailianChatClient } from "../providers/bailian";
import { generatePodcastScript } from "./podcast-script-llm";

const mockNote = {
  title: "关于产品决策的访谈",
  summary: "用户聊到了在资源紧张时如何取舍产品方向",
  keyQuote: "真正困难是团队不敢暴露坏消息",
  saidTrack: ["我们砍掉了三个功能", "选择聚焦核心留存"],
  learnedTrack: ["做减法需要更大的勇气", "数据不说谎，人会"],
  nextQuestions: ["下次如何让团队更早暴露问题？"]
};

const mockChat = (response: string): BailianChatClient => ({
  async complete() {
    return response;
  }
});

const throwingChat = (): BailianChatClient => ({
  async complete() {
    throw new Error("LLM 调用失败");
  }
});

describe("generatePodcastScript", () => {
  it("happy path: returns a non-empty script string", async () => {
    const script = "开场：今天我们回到一段关于产品决策的对话。\n真正困难是团队不敢暴露坏消息。";
    const result = await generatePodcastScript(
      { note: mockNote, format: "solo" },
      mockChat(script)
    );
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
    expect(result).toBe(script);
  });

  it("happy path: host-guest format passes format label to LLM", async () => {
    let capturedMessages: Array<{ role: string; content: string }> = [];
    const capturingChat: BailianChatClient = {
      async complete(input) {
        capturedMessages = input.messages as Array<{ role: string; content: string }>;
        return "主持人：欢迎来到今天的节目。\n来宾：谢谢邀请。";
      }
    };

    const result = await generatePodcastScript(
      { note: mockNote, format: "host-guest" },
      capturingChat
    );

    expect(result.length).toBeGreaterThan(0);
    const userContent = capturedMessages.find((m) => m.role === "user")?.content ?? "";
    expect(userContent).toContain("主持对谈（双人）");
  });

  it("throws when LLM client throws", async () => {
    await expect(
      generatePodcastScript({ note: mockNote, format: "solo" }, throwingChat())
    ).rejects.toThrow("LLM 调用失败");
  });

  it("throws when LLM returns empty string", async () => {
    await expect(
      generatePodcastScript({ note: mockNote, format: "solo" }, mockChat(""))
    ).rejects.toThrow("empty output");
  });

  it("throws when LLM returns only whitespace", async () => {
    await expect(
      generatePodcastScript({ note: mockNote, format: "solo" }, mockChat("   \n  "))
    ).rejects.toThrow("empty output");
  });

  it("grounds script in note content — passes note fields to LLM", async () => {
    let capturedUserContent = "";
    const capturingChat: BailianChatClient = {
      async complete(input) {
        const userMsg = input.messages.find((m) => m.role === "user");
        capturedUserContent = (userMsg?.content as string) ?? "";
        return "生成的脚本内容";
      }
    };

    await generatePodcastScript({ note: mockNote, format: "solo" }, capturingChat);

    expect(capturedUserContent).toContain(mockNote.title);
    expect(capturedUserContent).toContain(mockNote.keyQuote);
    expect(capturedUserContent).toContain(mockNote.summary);
    expect(capturedUserContent).toContain(mockNote.saidTrack[0]);
    expect(capturedUserContent).toContain(mockNote.learnedTrack[0]);
    expect(capturedUserContent).toContain(mockNote.nextQuestions[0]);
  });
});
