import { describe, expect, it } from "vitest";
import type { BailianChatClient } from "../providers/bailian";
import {
  generatePodcastScript,
  generatePodcastScriptFromSource,
  PODCAST_SCRIPT_TIMEOUT_MS
} from "./podcast-script-llm";

const mockNote = {
  title: "关于产品决策的访谈",
  summary: "用户聊到了在资源紧张时如何取舍产品方向",
  keyQuote: "真正困难是团队不敢暴露坏消息",
  saidTrack: ["我们砍掉了三个功能", "选择聚焦核心留存"],
  learnedTrack: ["做减法需要更大的勇气", "数据不说谎，人会"],
  nextQuestions: ["下次如何让团队更早暴露问题？"]
};

const mockBrief = {
  topic: "AI 产品定价",
  summary: "市场对订阅制与用量计费仍有分歧。",
  facts: ["多家厂商并行提供席位与 token 计费"],
  controversies: ["免费额度是否扭曲真实需求"],
  opposingViews: ["应完全按结果收费"],
  interviewAngles: ["你上次为何改定价？"],
  discussionTopics: ["定价对销售话术的影响"],
  sources: [{ publisher: "示例刊", title: "定价观察" }]
};

const mockTheme = {
  name: "控制感",
  summary: "授权与亲自下场之间的摆动。",
  representativeQuote: "我不是不想管，是不想每次都替他们兜底。",
  maturity: "聚焦" as const,
  appearances: 5,
  nextQuestion: "如果允许短期失控，最坏会发生什么？"
};

const mockDebt = {
  concept: "组织惯性",
  context: "团队习惯等用户拍板。",
  whyImportant: "把人不主动转译成系统奖励了什么。",
  status: "待了解" as const,
  nextQuestion: "你后来能用自己的话解释它了吗？"
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

  it("asks the chat client for a long enough timeout and token budget", async () => {
    let captured: { timeoutMs?: number; maxTokens?: number } = {};
    const capturingChat: BailianChatClient = {
      async complete(input) {
        captured = { timeoutMs: input.timeoutMs, maxTokens: input.maxTokens };
        return "主持人：开场。\n来宾：回应。";
      }
    };
    await generatePodcastScript({ note: mockNote, format: "host-guest" }, capturingChat);
    expect(captured.timeoutMs).toBe(PODCAST_SCRIPT_TIMEOUT_MS);
    expect(captured.maxTokens).toBe(4096);
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

describe("generatePodcastScriptFromSource", () => {
  it("grounds search-brief facts and topic", async () => {
    let captured = "";
    const chat: BailianChatClient = {
      async complete(input) {
        captured = String(input.messages.find((m) => m.role === "user")?.content ?? "");
        return "简报播客脚本";
      }
    };
    const result = await generatePodcastScriptFromSource(
      { kind: "search-brief", brief: mockBrief as never, format: "solo" },
      chat
    );
    expect(result).toBe("简报播客脚本");
    expect(captured).toContain(mockBrief.topic);
    expect(captured).toContain(mockBrief.facts[0]);
    expect(captured).toContain(mockBrief.sources[0].title);
  });

  it("grounds theme quote and next question", async () => {
    let captured = "";
    const chat: BailianChatClient = {
      async complete(input) {
        captured = String(input.messages.find((m) => m.role === "user")?.content ?? "");
        return "主题播客脚本";
      }
    };
    await generatePodcastScriptFromSource({ kind: "theme", theme: mockTheme, format: "host-guest" }, chat);
    expect(captured).toContain(mockTheme.name);
    expect(captured).toContain(mockTheme.representativeQuote);
    expect(captured).toContain("主持对谈（双人）");
  });

  it("grounds knowledge-debt concept and context", async () => {
    let captured = "";
    const chat: BailianChatClient = {
      async complete(input) {
        captured = String(input.messages.find((m) => m.role === "user")?.content ?? "");
        return "知识债播客脚本";
      }
    };
    await generatePodcastScriptFromSource({ kind: "knowledge-debt", debt: mockDebt, format: "solo" }, chat);
    expect(captured).toContain(mockDebt.concept);
    expect(captured).toContain(mockDebt.context);
    expect(captured).toContain(mockDebt.whyImportant);
  });

  it("throws on empty output for non-note sources", async () => {
    await expect(
      generatePodcastScriptFromSource({ kind: "theme", theme: mockTheme, format: "solo" }, mockChat("  "))
    ).rejects.toThrow("empty output");
  });
});
