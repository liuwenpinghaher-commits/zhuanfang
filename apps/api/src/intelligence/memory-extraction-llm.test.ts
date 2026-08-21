/**
 * Parser robustness tests for memory-extraction-llm.
 *
 * extractCandidateMemories coerces candidate fields via asArray/asObject/asString.
 * Robustness points:
 *  - Missing/empty text → candidate filtered out (.filter(c => c.text.length > 0))
 *  - Invalid sensitivity → coerced to "normal"
 *  - candidates is not an array → asArray returns [] → empty result
 *  - More than 20 candidates → sliced to max 20
 *  - Well-formed JSON → returns typed ImportedMemoryCandidate[]
 */
import { describe, expect, it } from "vitest";
import type { ImportedMemoryCandidate } from "../../../../src/domain/import";
import type { BailianChatClient } from "../providers/bailian";
import {
  extractCandidateMemories,
  MEMORY_EXTRACT_TIMEOUT_MS,
  splitTranscriptForMemoryExtract
} from "./memory-extraction-llm";
import type { BailianChatCompleteRequest } from "../providers/bailian";

const mockChat = (json: string): BailianChatClient => ({
  async complete() {
    return json;
  }
});

describe("extractCandidateMemories", () => {
  it("happy path: well-formed JSON → returns typed ImportedMemoryCandidate array", async () => {
    const json = JSON.stringify({
      candidates: [
        { text: "用户偏好直接反馈", evidenceQuote: "直接告诉我就好", sensitivity: "normal" },
        { text: "用户有隐私顾虑", evidenceQuote: "这些数据不要共享", sensitivity: "sensitive" }
      ]
    });
    const result = await extractCandidateMemories("测试资料", "内容", mockChat(json));

    expect(result.length).toBe(2);
    expect(result[0].text).toBe("用户偏好直接反馈");
    expect(result[0].evidenceQuote).toBe("直接告诉我就好");
    expect(result[0].sensitivity).toBe("normal");
    expect(result[1].sensitivity).toBe("sensitive");
    // Type check: all required fields present
    const candidate: ImportedMemoryCandidate = result[0];
    expect(typeof candidate.text).toBe("string");
  });

  it("missing text → candidate filtered out", async () => {
    const json = JSON.stringify({
      candidates: [
        { evidenceQuote: "有原文但没有文本", sensitivity: "normal" }, // no text
        { text: "", evidenceQuote: "空字符串", sensitivity: "normal" } // empty string
      ]
    });
    const result = await extractCandidateMemories("测试", "内容", mockChat(json));
    expect(result).toEqual([]);
  });

  it("invalid sensitivity → coerced to 'normal'", async () => {
    const json = JSON.stringify({
      candidates: [
        { text: "记忆条目", evidenceQuote: "原文", sensitivity: "INVALID" }
      ]
    });
    const result = await extractCandidateMemories("测试", "内容", mockChat(json));
    expect(result[0].sensitivity).toBe("normal");
  });

  it("candidates is not an array → returns empty result", async () => {
    const json = JSON.stringify({ candidates: "not an array" });
    const result = await extractCandidateMemories("测试", "内容", mockChat(json));
    expect(result).toEqual([]);
  });

  it("candidates missing entirely → returns empty result", async () => {
    const json = JSON.stringify({});
    const result = await extractCandidateMemories("测试", "内容", mockChat(json));
    expect(result).toEqual([]);
  });

  it("more than 20 candidates → sliced to max 20", async () => {
    const candidates = Array.from({ length: 25 }, (_, i) => ({
      text: `记忆条目 ${i + 1}`,
      evidenceQuote: `原文 ${i + 1}`,
      sensitivity: "normal"
    }));
    const json = JSON.stringify({ candidates });
    const result = await extractCandidateMemories("测试", "内容", mockChat(json));
    expect(result.length).toBe(20);
  });

  it("mixed valid and invalid items → only valid ones returned", async () => {
    const json = JSON.stringify({
      candidates: [
        { text: "有效条目", evidenceQuote: "原文", sensitivity: "normal" },
        { evidenceQuote: "无文本", sensitivity: "normal" }, // no text
        { text: 42, evidenceQuote: "数字文本", sensitivity: "normal" }, // non-string text → asString returns ""
        { text: "第二条有效", evidenceQuote: "另一段原文", sensitivity: "sensitive" }
      ]
    });
    const result = await extractCandidateMemories("测试", "内容", mockChat(json));
    expect(result.length).toBe(2);
    expect(result[0].text).toBe("有效条目");
    expect(result[1].text).toBe("第二条有效");
  });

  it("malformed JSON → throws (parseJsonObject throws on non-JSON)", async () => {
    await expect(
      extractCandidateMemories("测试", "内容", mockChat("not json"))
    ).rejects.toThrow();
  });

  it("array top-level (not an object) → throws (parseJsonObject requires object)", async () => {
    await expect(
      extractCandidateMemories("测试", "内容", mockChat("[1,2,3]"))
    ).rejects.toThrow("unparseable JSON");
  });

  it("injects explicit corrections and rejects a candidate that revives the corrected prerequisite claim", async () => {
    let capturedPrompt = "";
    const chat: BailianChatClient = {
      async complete(input) {
        capturedPrompt = input.messages.map((message) => message.content).join("\n");
        return JSON.stringify({
          candidates: [
            {
              text: "五项构成 AI Native 转型的结构性前提，缺一不可。",
              evidenceQuote: "转型前要把五项条件全部准备好",
              sensitivity: "normal"
            },
            {
              text: "个人工具普及率不是组织提效的充分条件。",
              evidenceQuote: "个人工具快了，但价值流没有缩短",
              sensitivity: "normal"
            }
          ]
        });
      }
    };
    const correction = "我明确纠正：结构条件不是转型开始前必须全部满足的准入门槛，而应当在试点中一起改变。";

    const result = await extractCandidateMemories("AI Native 转型", "访谈逐字稿", chat, {
      corrections: [correction]
    });

    expect(capturedPrompt).toContain(correction);
    expect(result.map((candidate) => candidate.text)).toEqual([
      "个人工具普及率不是组织提效的充分条件。"
    ]);
  });

  it("short body: one complete() call with explicit extract timeout", async () => {
    const captured: BailianChatCompleteRequest[] = [];
    const chat: BailianChatClient = {
      async complete(input) {
        captured.push(input);
        return JSON.stringify({
          candidates: [{ text: "一条记忆", evidenceQuote: "原文", sensitivity: "normal" }]
        });
      }
    };
    await extractCandidateMemories("短资料", "很短的一段话", chat);
    expect(captured).toHaveLength(1);
    expect(captured[0].timeoutMs).toBe(MEMORY_EXTRACT_TIMEOUT_MS);
  });

  it("long body is chunked; each call gets a slice of the 60s budget; duplicate texts merge", async () => {
    const longBody = "甲".repeat(4500) + "乙".repeat(4500);
    expect(splitTranscriptForMemoryExtract(longBody).length).toBeGreaterThan(1);
    const captured: BailianChatCompleteRequest[] = [];
    const chat: BailianChatClient = {
      async complete(input) {
        captured.push(input);
        return JSON.stringify({
          candidates: [{ text: "同一条", evidenceQuote: "原文", sensitivity: "normal" }]
        });
      }
    };
    const result = await extractCandidateMemories("长资料", longBody, chat);
    expect(captured.length).toBeGreaterThan(1);
    for (const call of captured) {
      expect(call.timeoutMs).toBe(MEMORY_EXTRACT_TIMEOUT_MS);
    }
    expect(captured[0].messages.some((m) => String(m.content).includes("第 1/"))).toBe(true);
    expect(result).toHaveLength(1);
    expect(result[0].text).toBe("同一条");
  });
});
