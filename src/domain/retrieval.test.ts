import { describe, expect, it } from "vitest";
import {
  applyChannelQuotas,
  buildBootContextPack,
  decideRecallAcceptance,
  retrievePersonalKnowledge,
  DEFAULT_BOOT_CONTEXT_CHAR_BUDGET
} from "./retrieval";
import { createInitialProductState } from "./engine";
import type { KnowledgeChunk } from "./types";

function chunk(partial: Partial<KnowledgeChunk> & Pick<KnowledgeChunk, "id" | "sourceType" | "text">): KnowledgeChunk {
  return {
    sourceId: partial.sourceId ?? partial.id,
    title: partial.title ?? partial.id,
    keywords: partial.keywords ?? [],
    createdAt: partial.createdAt ?? "2026-07-28T00:00:00.000Z",
    ...partial
  };
}

describe("decideRecallAcceptance", () => {
  it("rejects empty", () => {
    const d = decideRecallAcceptance([], 0.12);
    expect(d.rejected).toBe(true);
    expect(d.reason).toBe("empty");
  });

  it("rejects below threshold", () => {
    const d = decideRecallAcceptance([{ score: 0.05 }, { score: 0.02 }], 0.12);
    expect(d.rejected).toBe(true);
    expect(d.reason).toBe("below_threshold");
    expect(d.topScore).toBe(0.05);
  });

  it("accepts when top >= threshold", () => {
    const d = decideRecallAcceptance([{ score: 0.2 }, { score: 0.01 }], 0.12);
    expect(d.rejected).toBe(false);
  });
});

describe("applyChannelQuotas", () => {
  it("caps material so memory is not crowded out", () => {
    const ranked = [
      ...Array.from({ length: 6 }, (_, i) => ({
        item: chunk({ id: `m${i}`, sourceType: "material" as const, text: `资料${i} 放权` }),
        score: 1 - i * 0.01
      })),
      { item: chunk({ id: "mem1", sourceType: "memory" as const, text: "我害怕放权失控" }), score: 0.5 }
    ];
    const capped = applyChannelQuotas(ranked, { memory: 5, material: 2, transcript: 2, asset: 3 });
    expect(capped.filter((c) => c.channel === "material")).toHaveLength(2);
    expect(capped.some((c) => c.item.id === "mem1")).toBe(true);
  });
});

describe("retrievePersonalKnowledge", () => {
  it("returns empty + rejected when only weak keyword noise", () => {
    const chunks = [
      chunk({ id: "a", sourceType: "point", text: "完全无关的天文学内容" }),
      chunk({ id: "b", sourceType: "material", text: "银河系旋臂" })
    ];
    const r = retrievePersonalKnowledge(chunks, "团队授权与控制感", { minScore: 0.2 });
    expect(r.rejected).toBe(true);
    expect(r.chunks).toHaveLength(0);
  });

  it("keeps strong memory hits", () => {
    const chunks = [
      chunk({ id: "m", sourceType: "memory", text: "团队授权时我最怕短期失控", keywords: ["授权", "失控"] }),
      chunk({ id: "x", sourceType: "material", text: "无关" })
    ];
    const r = retrievePersonalKnowledge(chunks, "授权失控", { minScore: 0.1, topK: 5 });
    expect(r.rejected).toBe(false);
    expect(r.chunks.some((c) => c.id === "m")).toBe(true);
  });
});

describe("buildBootContextPack", () => {
  it("stays within char budget and includes policy line", () => {
    const state = createInitialProductState();
    const pack = buildBootContextPack(state, { charBudget: 800 });
    expect(pack.charCount).toBeLessThanOrEqual(800);
    expect(pack.text).toContain("【用户画像】");
    expect(pack.memoryPolicyLine.length).toBeGreaterThan(0);
    expect(pack.charCount).toBeLessThanOrEqual(DEFAULT_BOOT_CONTEXT_CHAR_BUDGET);
  });
});
