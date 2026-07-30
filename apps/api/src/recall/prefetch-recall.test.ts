import { describe, it, expect } from "vitest";
import { prefetchRecall, resolveThemeForPrefetch } from "./prefetch-recall";
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
  // C-P1-05 dual layer: empty HNSW hits must NOT be injected as memoryHits:[]
  // (empty array is truthy and would collapse the domain confirmed pool).
  it("C-P1-05: HNSW 返回空数组 → memoryHits 字段省略(不注入 [])", async () => {
    const port: NativeRecallPort = {
      ...okPort(),
      recallMemoriesByVector: async () => []
    };
    const r = await prefetchRecall(port, stateWithTheme(), "放权", [0.1, 0.2], { includeSensitive: false, topN: 5 });
    expect(r).not.toHaveProperty("memoryHits");
    expect(r.memoryHits).toBeUndefined();
    // other lanes still assemble
    expect(r.themeAssets?.points).toContain("pt_1");
  });
  // 真实性重构:safe() 吞错已删除——任一路召回抛错整体 reject,由调用方如实 5xx,
  // 不再"看起来成功但少了召回"。
  it("某子召回抛错 → 整体 reject(不再吞错返回 undefined)", async () => {
    const port: NativeRecallPort = { ...okPort(), recallMemoriesByVector: async () => { throw new Error("boom"); } };
    await expect(
      prefetchRecall(port, stateWithTheme(), "放权", [0.1], { includeSensitive: false, topN: 5 })
    ).rejects.toThrow("boom");
  });
  it("③ 混合检索:把 topicHint 作为 queryText + includeSensitive 透传给 recallMemoriesByVector", async () => {
    let seen: { includeSensitive?: boolean; queryText?: string } | undefined;
    const port: NativeRecallPort = { ...okPort(), recallMemoriesByVector: async (_e, _k, o) => { seen = o; return [{ id: "me_1", text: "记忆" }]; } };
    await prefetchRecall(port, stateWithTheme(), "放权", [0.1, 0.2], { includeSensitive: true, topN: 5 });
    expect(seen?.queryText).toBe("放权");
    expect(seen?.includeSensitive).toBe(true);
  });

  it("R-P1-01: opts.queryText drives BM25 while topicHint drives theme graph match", async () => {
    let memSeen: { queryText?: string } | undefined;
    let themeId: string | undefined;
    const port: NativeRecallPort = {
      ...okPort(),
      recallThemeAssets: async (id) => {
        themeId = id;
        return { points: ["pt_1"], decisions: [], questions: [], memories: [] };
      },
      recallMemoriesByVector: async (_e, _k, o) => {
        memSeen = o;
        return [{ id: "me_1", text: "记忆" }];
      }
    };
    await prefetchRecall(port, stateWithTheme(), "放权", [0.1, 0.2], {
      includeSensitive: false,
      topN: 5,
      queryText: "第二增长曲线让我焦虑"
    });
    expect(themeId).toBe("th_1"); // theme from topicHint name match
    expect(memSeen?.queryText).toBe("第二增长曲线让我焦虑"); // BM25 from queryText
  });

  it("R-P1-01: empty topicHint skips theme graph even when queryText is set", async () => {
    let themeCalled = false;
    let memSeen: { queryText?: string } | undefined;
    const port: NativeRecallPort = {
      ...okPort(),
      recallThemeAssets: async () => {
        themeCalled = true;
        return { points: [], decisions: [], questions: [], memories: [] };
      },
      recallMemoriesByVector: async (_e, _k, o) => {
        memSeen = o;
        return [{ id: "me_1", text: "记忆" }];
      }
    };
    const r = await prefetchRecall(port, stateWithTheme(), "", [0.1, 0.2], {
      includeSensitive: false,
      topN: 5,
      queryText: "今天聊第二增长曲线"
    });
    expect(themeCalled).toBe(false);
    expect(r.themeAssets).toBeUndefined();
    expect(memSeen?.queryText).toBe("今天聊第二增长曲线");
  });
});

describe("prefetchRecall: rag 混合召回注入(方案一)+ 溯源敏感透传(方案三)", () => {
  it("port 具备 recallRagChunks → ragHits 注入;k=topN*2、usage=interview-context、topicHint 作 queryText", async () => {
    let seen: { embedding?: number[]; queryText?: string; k: number; usage?: string } | undefined;
    const port: NativeRecallPort = { ...okPort(), recallRagChunks: async (o) => { seen = o; return [{ id: "rc_1", text: "块" }]; } };
    const r = await prefetchRecall(port, stateWithTheme(), "放权", [0.1, 0.2], { includeSensitive: false, topN: 5 });
    expect(r.ragHits?.map((h) => h.id)).toEqual(["rc_1"]);
    expect(seen?.k).toBe(10);
    expect(seen?.usage).toBe("interview-context");
    expect(seen?.queryText).toBe("放权");
    expect(seen?.embedding).toEqual([0.1, 0.2]);
  });
  it("port 无 recallRagChunks(sqlite/dual 档位)→ ragHits undefined,其余照常", async () => {
    const r = await prefetchRecall(okPort(), stateWithTheme(), "放权", [0.1], { includeSensitive: false, topN: 5 });
    expect(r.ragHits).toBeUndefined();
    expect(r.themeAssets?.points).toContain("pt_1");
  });
  // 真实性重构:rag 路同样不吞错——抛错整体 reject。
  it("recallRagChunks 抛错 → 整体 reject(不再吞错置 ragHits undefined)", async () => {
    const port: NativeRecallPort = { ...okPort(), recallRagChunks: async () => { throw new Error("boom"); } };
    await expect(
      prefetchRecall(port, stateWithTheme(), "放权", [0.1], { includeSensitive: false, topN: 5 })
    ).rejects.toThrow("boom");
  });
  it("无 queryEmbedding 有 topicHint → 仍调 recallRagChunks(BM25-only,不带 embedding);空命中不注入", async () => {
    let seen: { embedding?: number[]; queryText?: string } | undefined;
    const port: NativeRecallPort = { ...okPort(), recallRagChunks: async (o) => { seen = o; return []; } };
    const r = await prefetchRecall(port, stateWithTheme(), "放权", undefined, { includeSensitive: false, topN: 5 });
    expect(seen?.queryText).toBe("放权");
    expect(seen?.embedding).toBeUndefined();
    expect(r.ragHits).toBeUndefined();
  });
  it("方案三:includeSensitive 透传给 recallProvenanceTurns(敏感纵深门控)", async () => {
    let seen: { includeSensitive?: boolean } | undefined;
    const port: NativeRecallPort = {
      ...okPort(),
      recallProvenanceTurns: async (_t, _i, o) => { seen = o; return [{ id: "tu_1", content: "原话", sessionId: "se_1", role: "user" }]; }
    };
    await prefetchRecall(port, stateWithTheme(), "放权", [0.1], { includeSensitive: true, topN: 5 });
    expect(seen?.includeSensitive).toBe(true);
  });
});


describe("resolveThemeForPrefetch (R-P2-05 soft match)", () => {
  const baseState = {
    themes: [
      { id: "th_old", name: "放权", appearances: 99 },
      { id: "th_growth", name: "第二增长曲线", appearances: 2 },
      { id: "th_sleep", name: "睡眠焦虑", appearances: 5 }
    ]
  } as any;

  it("exact name wins", () => {
    const t = resolveThemeForPrefetch(baseState, "放权");
    expect(t?.id).toBe("th_old");
  });

  it("soft containment: utterance contains theme name", () => {
    const t = resolveThemeForPrefetch(baseState, "增长", "今天我想谈第二增长曲线的焦虑");
    expect(t?.id).toBe("th_growth");
  });

  it("does not fall back to highest-appearances unrelated theme", () => {
    const t = resolveThemeForPrefetch(baseState, "全新话题XYZ", "这是一个从未出现过的主题讨论");
    expect(t).toBeUndefined();
  });
});
