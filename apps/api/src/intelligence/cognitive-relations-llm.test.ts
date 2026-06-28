/**
 * Tests for judgeCognitiveRelations — the LLM semantic-judgment half of lightweight
 * reasoning (本体论欠账②). Rule pre-filter (collectCandidatePointPairs) feeds it
 * same-theme point pairs; the LLM classifies each as contradict / supersede / none.
 *
 * Fail-safe contract: no chatClient, budget exhausted, no pairs, parse failure, or any
 * thrown error → returns empty relations (never throws, never blocks finalize).
 */
import { describe, expect, it, vi } from "vitest";
import type { BailianChatClient } from "../providers/bailian";
import type { LlmBudget } from "../llm-budget";
import type { PointAsset } from "../../../../src/domain/types";
import { judgeCognitiveRelations } from "./cognitive-relations-llm";

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
  it("no chatClient → empty relations, no throw", async () => {
    const out = await judgeCognitiveRelations([pairOf("pt_1", "pt_2")], undefined, alwaysBudget, "s1");
    expect(out).toEqual({ contradicts: [], supersedes: [] });
  });

  it("no pairs → empty relations, does NOT consume budget or call LLM", async () => {
    const budget: LlmBudget = { tryConsume: vi.fn(() => true), reset: () => {} };
    const complete = vi.fn(async () => "{}");
    const out = await judgeCognitiveRelations([], { complete }, budget, "s1");
    expect(out).toEqual({ contradicts: [], supersedes: [] });
    expect(budget.tryConsume).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
  });

  it("budget exhausted → empty relations, no LLM call", async () => {
    const complete = vi.fn(async () => "{}");
    const out = await judgeCognitiveRelations([pairOf("pt_1", "pt_2")], { complete }, neverBudget, "s1");
    expect(out).toEqual({ contradicts: [], supersedes: [] });
    expect(complete).not.toHaveBeenCalled();
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

  it("malformed JSON → empty relations (fail-safe, no throw)", async () => {
    const out = await judgeCognitiveRelations([pairOf("pt_1", "pt_2")], mockChat("not json"), alwaysBudget, "s1");
    expect(out).toEqual({ contradicts: [], supersedes: [] });
  });

  it("LLM throws → empty relations (fail-safe, no throw)", async () => {
    const throwing: BailianChatClient = { async complete() { throw new Error("boom"); } };
    const out = await judgeCognitiveRelations([pairOf("pt_1", "pt_2")], throwing, alwaysBudget, "s1");
    expect(out).toEqual({ contradicts: [], supersedes: [] });
  });
});
