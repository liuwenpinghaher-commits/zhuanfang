import { describe, it, expect } from "vitest";
import { prefetchRecall } from "./prefetch-recall";
import { createInitialProductState } from "../../../../src/domain/engine";
import type { ProductState } from "../../../../src/domain/types";
import type { NativeRecallPort } from "./native-recall-port";

function stateWithTheme(): ProductState {
  const base = createInitialProductState();
  return {
    ...base,
    themes: [{ id: "th_1", name: "放权", summary: "", maturity: "聚焦" as const, representativeQuote: "", appearances: 9, nextQuestion: "", updatedAt: "2026-06-27T00:00:00.000Z" }],
    points: [{ id: "pt_1", title: "p", content: "c", status: "稳定观点" as const, confidence: "用户确认" as const, evidence: [], relatedThemeIds: ["th_1"], important: false, updatedAt: "2026-06-27T00:00:00.000Z" }]
  };
}

const okPort = (): NativeRecallPort => ({
  recallThemeAssets: async () => ({ points: ["pt_1"], decisions: ["de_1"], questions: [], memories: ["me_1"] }),
  recallMemoriesByVector: async () => [{ id: "me_1", text: "记忆" }],
  recallProvenanceTurns: async (table, id) => [{ id: "tu_1", content: `原话:${table}:${id}`, sessionId: "se_1", role: "user" }]
});

describe("prefetchRecall", () => {
  it("组装 themeAssets + memoryHits + provenance", async () => {
    const r = await prefetchRecall(okPort(), stateWithTheme(), "放权", [0.1, 0.2], { includeSensitive: false, topN: 5 });
    expect(r.themeAssets?.points).toContain("pt_1");
    expect(r.memoryHits?.[0]?.id).toBe("me_1");
    expect(r.provenance?.some((p) => p.assetId === "pt_1")).toBe(true);
  });
  it("无 queryEmbedding:不召回向量,memoryHits undefined,其余仍在", async () => {
    const r = await prefetchRecall(okPort(), stateWithTheme(), "放权", undefined, { includeSensitive: false, topN: 5 });
    expect(r.memoryHits).toBeUndefined();
    expect(r.themeAssets?.points).toContain("pt_1");
  });
  it("fail-safe:某子召回抛错 → 该字段 undefined,整体不抛", async () => {
    const port: NativeRecallPort = { ...okPort(), recallMemoriesByVector: async () => { throw new Error("boom"); } };
    const r = await prefetchRecall(port, stateWithTheme(), "放权", [0.1], { includeSensitive: false, topN: 5 });
    expect(r.memoryHits).toBeUndefined();
    expect(r.themeAssets?.points).toContain("pt_1");
  });
});
