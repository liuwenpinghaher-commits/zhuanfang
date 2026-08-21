/**
 * Tests for judgeCognitiveRelations — the LLM semantic-judgment half of lightweight
 * reasoning (本体论欠账②). Rule pre-filter (collectCandidatePointPairs) feeds it
 * same-theme point pairs; the LLM classifies each as contradict / supersede / none.
 *
 * 真实性契约(2026-07 重构):chatClient 必选;预算耗尽/解析失败/LLM 抛错 → 向上抛,
 * 由 /end 统一 catch 原子中止并如实 5xx。"返回空关系"只保留给「确实没有候选对」。
 */
import { describe, expect, it, vi } from "vitest";
import type { BailianChatClient } from "../providers/bailian";
import type { LlmBudget } from "../llm-budget";
import type { PointAsset } from "../../../../src/domain/types";
import { COGNITIVE_RELATIONS_TIMEOUT_MS, judgeCognitiveRelations } from "./cognitive-relations-llm";

const point = (id: string, overrides: Partial<PointAsset> = {}): PointAsset => ({
  id,
  title: `观点 ${id}`,
  content: `内容 ${id}`,
  status: "临时想法",
  confidence: "AI 推断",
  evidence: [],
  relatedThemeIds: ["th_1"],
  important: false,
  updatedAt: "2026-06-27T00:00:00.000Z",
  ...overrides
});

const mockChat = (json: string): BailianChatClient => ({ async complete() { return json; } });
const alwaysBudget: LlmBudget = { tryConsume: () => true, reset: () => {} };
const neverBudget: LlmBudget = { tryConsume: () => false, reset: () => {} };

const pairOf = (a: string, b: string): [PointAsset, PointAsset] => [point(a), point(b)];

describe("judgeCognitiveRelations", () => {
  // 真实性重构:剔除「no chatClient → 空关系」用例——签名已改 chatClient 必选(调用方 /end 保证存在),
  // "没有 client 也悄悄返回空"的兜底路径已不存在。

  it("no pairs → empty relations, does NOT consume budget or call LLM", async () => {
    const budget: LlmBudget = { tryConsume: vi.fn(() => true), reset: () => {} };
    const complete = vi.fn(async () => "{}");
    const out = await judgeCognitiveRelations([], { complete }, budget, "s1");
    expect(out).toEqual({ contradicts: [], supersedes: [] });
    expect(budget.tryConsume).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
  });

  it("budget exhausted → throws (预算已用尽), no LLM call", async () => {
    const complete = vi.fn(async () => "{}");
    await expect(
      judgeCognitiveRelations([pairOf("pt_1", "pt_2")], { complete }, neverBudget, "s1")
    ).rejects.toThrow("预算已用尽");
    expect(complete).not.toHaveBeenCalled();
  });

  it("passes explicit contradiction timeout so /end is not killed by the 60s client default", async () => {
    const captured: Array<{ timeoutMs?: number }> = [];
    const chat: BailianChatClient = {
      async complete(input) {
        captured.push(input);
        return JSON.stringify({ relations: [{ a: "pt_1", b: "pt_2", verdict: "none" }] });
      }
    };
    await judgeCognitiveRelations([pairOf("pt_1", "pt_2")], chat, alwaysBudget, "s1");
    expect(captured[0]?.timeoutMs).toBe(COGNITIVE_RELATIONS_TIMEOUT_MS);
  });

  it("happy path: parses contradict + supersede verdicts", async () => {
    const json = JSON.stringify({
      relations: [
        { a: "pt_1", b: "pt_2", verdict: "contradict" },
        { a: "pt_3", b: "pt_4", verdict: "supersede", newer: "pt_4" }
      ]
    });
    const out = await judgeCognitiveRelations(
      [pairOf("pt_1", "pt_2"), pairOf("pt_3", "pt_4")],
      mockChat(json),
      alwaysBudget,
      "s1"
    );
    expect(out.contradicts).toContainEqual(["pt_1", "pt_2"]);
    expect(out.supersedes).toContainEqual({ oldId: "pt_3", newId: "pt_4" });
  });

  it("verdict 'none' → dropped", async () => {
    const json = JSON.stringify({ relations: [{ a: "pt_1", b: "pt_2", verdict: "none" }] });
    const out = await judgeCognitiveRelations([pairOf("pt_1", "pt_2")], mockChat(json), alwaysBudget, "s1");
    expect(out).toEqual({ contradicts: [], supersedes: [] });
  });

  it("supersede: 'newer' must be one of the pair — otherwise dropped (no hallucinated id)", async () => {
    const json = JSON.stringify({ relations: [{ a: "pt_1", b: "pt_2", verdict: "supersede", newer: "pt_99" }] });
    const out = await judgeCognitiveRelations([pairOf("pt_1", "pt_2")], mockChat(json), alwaysBudget, "s1");
    expect(out.supersedes).toEqual([]);
  });

  it("relations referencing pairs that were not sent → dropped (only judged real candidates)", async () => {
    const json = JSON.stringify({ relations: [{ a: "pt_1", b: "pt_999", verdict: "contradict" }] });
    const out = await judgeCognitiveRelations([pairOf("pt_1", "pt_2")], mockChat(json), alwaysBudget, "s1");
    expect(out.contradicts).toEqual([]);
  });

  it("supersede: newer=a → oldId is b", async () => {
    const json = JSON.stringify({ relations: [{ a: "pt_1", b: "pt_2", verdict: "supersede", newer: "pt_1" }] });
    const out = await judgeCognitiveRelations([pairOf("pt_1", "pt_2")], mockChat(json), alwaysBudget, "s1");
    expect(out.supersedes).toEqual([{ oldId: "pt_2", newId: "pt_1" }]);
  });

  it("malformed JSON → throws (解析失败不可伪装成'无矛盾')", async () => {
    await expect(
      judgeCognitiveRelations([pairOf("pt_1", "pt_2")], mockChat("not json"), alwaysBudget, "s1")
    ).rejects.toThrow("cognitive relations LLM returned unparseable JSON");
  });

  it("LLM throws → propagates (不吞错、不返回空关系)", async () => {
    const throwing: BailianChatClient = { async complete() { throw new Error("boom"); } };
    await expect(
      judgeCognitiveRelations([pairOf("pt_1", "pt_2")], throwing, alwaysBudget, "s1")
    ).rejects.toThrow("boom");
  });
});
