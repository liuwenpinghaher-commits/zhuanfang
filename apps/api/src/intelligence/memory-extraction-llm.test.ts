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
import { extractCandidateMemories } from "./memory-extraction-llm";

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
    ).rejects.toThrow("Expected a JSON object");
  });
});
