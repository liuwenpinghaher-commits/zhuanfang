import { describe, it, expect } from "vitest";
import { cosineSimilarity, topKByCosine } from "./vector";

describe("cosineSimilarity", () => {
  it("identical vectors => 1", () => {
    expect(cosineSimilarity([1, 0], [1, 0])).toBe(1);
  });

  it("orthogonal vectors => 0", () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBe(0);
  });

  it("opposite vectors => -1", () => {
    expect(cosineSimilarity([1, 0], [-1, 0])).toBe(-1);
  });

  it("zero vector => 0 (not NaN)", () => {
    const result = cosineSimilarity([0, 0], [1, 0]);
    expect(result).toBe(0);
    expect(Number.isNaN(result)).toBe(false);
  });

  it("dimension mismatch => 0", () => {
    expect(cosineSimilarity([1], [1, 0])).toBe(0);
  });
});

describe("topKByCosine", () => {
  it("returns top-k items sorted by cosine similarity descending", () => {
    const query = [1, 0];
    const items = [
      { id: "a", embedding: [1, 0] },
      { id: "b", embedding: [0, 1] },
      { id: "c", embedding: [0.9, 0.1] },
    ];
    const result = topKByCosine(query, items, 2);
    expect(result.map((x) => x.id)).toEqual(["a", "c"]);
  });

  it("ignores items without embedding", () => {
    const query = [1, 0];
    const items = [
      { id: "a", embedding: [1, 0] },
      { id: "d" } as { id: string; embedding?: number[] },
    ];
    const result = topKByCosine(query, items, 5);
    expect(result.map((x) => x.id)).not.toContain("d");
    expect(result.map((x) => x.id)).toContain("a");
  });

  it("空数组 embedding [] 不出现在结果中（静默污染修复）", () => {
    const query = [1, 0];
    const items: Array<{ id: string; embedding?: number[] }> = [
      { id: "good", embedding: [1, 0] },
      { id: "empty", embedding: [] },       // 空数组 — 应被过滤掉
      { id: "noEmbed" },                    // 无 embedding — 也被过滤掉
    ];
    const result = topKByCosine(query, items, 10);
    expect(result.map((x) => x.id)).toEqual(["good"]);
    expect(result.map((x) => x.id)).not.toContain("empty");
  });
});
