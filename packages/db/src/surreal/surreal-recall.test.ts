import { describe, it, expect, afterEach } from "vitest";
import { createInitialProductState } from "../../../../src/domain/engine";
import { createSurrealProductStateRepository, type SurrealRepoHandle } from "./surreal-product-state-repository";
import { EMBEDDING_DIMENSION } from "./constants";

const open: SurrealRepoHandle[] = [];
afterEach(async () => { for (const r of open) await r.close(); open.length = 0; });
async function makeMem(): Promise<SurrealRepoHandle> {
  const r = await createSurrealProductStateRepository({ url: "mem://" }); open.push(r); return r;
}

function linkedState() {
  const base = createInitialProductState();
  return { ...base,
    themes: [{ id: "th_1", name: "放权", summary: "", maturity: "聚焦" as const, representativeQuote: "", appearances: 1, nextQuestion: "", updatedAt: "2026-06-27T00:00:00.000Z" }],
    sessions: [{ id: "se_1", mode: "daily", strength: "standard", status: "active", title: "会话", startedAt: "2026-06-27T00:00:00.000Z", turns: [{ id: "tu_1", role: "user", content: "原话", intent: "", timestamp: "2026-06-27T00:00:00.000Z" }] } as unknown as (typeof base.sessions)[number]],
    points: [{ id: "pt_1", title: "观点", content: "c", status: "稳定观点" as const, confidence: "用户确认" as const, evidence: [], relatedThemeIds: ["th_1"], important: false, updatedAt: "2026-06-27T00:00:00.000Z", evidenceAnchors: [{ sessionId: "se_1", turnId: "tu_1" }] }],
    decisions: [{ id: "de_1", title: "决策", decisionKind: "用户决策" as const, confirmationStatus: "用户确认" as const, choice: "c", tradeOff: "", riskHypothesis: "", reviewAt: "", status: "待复盘" as const, updatedAt: "2026-06-27T00:00:00.000Z", relatedThemeIds: ["th_1"] }],
    questions: [{ id: "qu_1", question: "q", whyImportant: "", status: "开放" as const, appearances: 1, relatedThemeIds: ["th_1"], nextPrompt: "", important: false, updatedAt: "2026-06-27T00:00:00.000Z" }],
    // M1: 记忆主题归属内嵌于 record.relatedThemeIds(退役 state.memoryEdges);about_theme 投影自此。
    memoryRecords: [{ id: "me_1", text: "记忆", status: "confirmed" as const, sourceType: "profile" as const, sourceId: "p", evidenceQuote: "", sensitivity: "normal" as const, createdAt: "2026-06-27T00:00:00.000Z", updatedAt: "2026-06-27T00:00:00.000Z", relatedThemeIds: ["th_1"] }]
  };
}

describe("surreal native recall: 图遍历", () => {
  it("recallThemeAssets:一次拿全 point+decision+question+memory(含曾漏 decisions)", async () => {
    const repo = await makeMem();
    repo.replaceState(linkedState());
    await repo.flush();
    const r = await repo.recallThemeAssets("th_1");
    expect(r.points).toContain("pt_1");
    expect(r.decisions).toContain("de_1");   // 曾漏 decisions:图模型下天然覆盖
    expect(r.questions).toContain("qu_1");
    expect(r.memories).toContain("me_1");     // about_theme
  });

  it("recallProvenanceTurns:沿 derived_from 取证据 turn", async () => {
    const repo = await makeMem();
    repo.replaceState(linkedState());
    await repo.flush();
    const turns = await repo.recallProvenanceTurns("point", "pt_1");
    expect(turns.map((t) => t.id)).toContain("tu_1");
    expect(turns[0]?.content).toBe("原话");
  });
});

function memWithEmbedding(id: string, text: string, vec: number[], opts: { sensitivity?: "normal" | "sensitive"; status?: "confirmed" | "deprecated" } = {}) {
  return { id, text, status: opts.status ?? "confirmed", sourceType: "profile" as const, sourceId: "p",
    evidenceQuote: "", sensitivity: opts.sensitivity ?? "normal", embedding: vec,
    createdAt: "2026-06-27T00:00:00.000Z", updatedAt: "2026-06-27T00:00:00.000Z" };
}
// 造 DIMENSION 维向量:第 0 位置不同以区分方向。
function vec(seed: number): number[] { const v = new Array(EMBEDDING_DIMENSION).fill(0); v[0] = seed; v[1] = 1; return v; }

describe("surreal native recall: 向量 HNSW + A4 门控", () => {
  it("recallMemoriesByVector:返回余弦最近的 confirmed/normal 记忆", async () => {
    const repo = await makeMem();
    const base = createInitialProductState();
    repo.replaceState({ ...base, memoryRecords: [
      memWithEmbedding("me_near", "近", vec(1)),
      memWithEmbedding("me_far", "远", vec(-1))
    ] });
    await repo.flush();
    const hits = await repo.recallMemoriesByVector(vec(1), 1);
    expect(hits.map((h) => h.id)).toEqual(["me_near"]);
  });

  it("A4 门控:默认不返回 sensitive / 非 confirmed;includeSensitive 才含 sensitive", async () => {
    const repo = await makeMem();
    const base = createInitialProductState();
    repo.replaceState({ ...base, memoryRecords: [
      memWithEmbedding("me_norm", "普通", vec(1)),
      memWithEmbedding("me_sens", "敏感", vec(1), { sensitivity: "sensitive" }),
      memWithEmbedding("me_dep", "弃用", vec(1), { status: "deprecated" })
    ] });
    await repo.flush();
    const def = await repo.recallMemoriesByVector(vec(1), 10);
    expect(def.map((h) => h.id).sort()).toEqual(["me_norm"]);           // 仅 confirmed+normal
    const withSens = await repo.recallMemoriesByVector(vec(1), 10, { includeSensitive: true });
    expect(withSens.map((h) => h.id).sort()).toEqual(["me_norm", "me_sens"]); // 含 sensitive,仍不含 deprecated
  });
});

describe("surreal native recall: 混合检索(HNSW + BM25 + search::rrf,③)", () => {
  it("混合检索:召回 BM25 精确词命中(向量远)+ 向量语义近,纯 HNSW(同 k)漏掉前者", async () => {
    const repo = await makeMem();
    const base = createInitialProductState();
    // me_near:向量 vec(1) 与 query 同向(向量最近)。
    // me_kw:文本含专名「区块链」,但向量 vec(-1) 与 query 相反 → 纯 HNSW 排在最末。
    // 另造 6 条「向量比 me_kw 更靠近 query、但文本不含专名」的噪声(vecAt:第0位 0.1..0.6,
    //   余弦比 vec(-1) 更接近 vec(1))。k=2 时纯 HNSW 只会取 me_near + 1 条噪声,必漏 me_kw;
    //   混合检索靠 BM25 把 me_kw 拉回。
    const noise = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6].map((s, i) => memWithEmbedding(`me_noise_${i}`, `无关内容${i}`, vec(s)));
    repo.replaceState({ ...base, memoryRecords: [
      memWithEmbedding("me_near", "关于授权放权的深度思考", vec(1)),
      memWithEmbedding("me_kw", "团队评估区块链技术选型", vec(-1)),
      ...noise
    ] });
    await repo.flush();
    const kSmall = 2;
    // 基线:纯 HNSW(无 queryText),k=2 → me_near + 最近噪声,绝不含向量最远的 me_kw。
    const hnswOnly = await repo.recallMemoriesByVector(vec(1), kSmall);
    expect(hnswOnly.map((h) => h.id)).not.toContain("me_kw");
    // 混合:queryText 命中专名「区块链」(多 ngram token)→ me_kw 被 BM25 拉回;向量项仍在。
    const hybrid = await repo.recallMemoriesByVector(vec(1), kSmall, { queryText: "区块链" });
    const ids = hybrid.map((h) => h.id);
    expect(ids).toContain("me_kw");    // BM25 把向量最远的专名命中拉进来(纯 HNSW 漏)
    expect(ids).toContain("me_near");  // 向量语义项仍在
  });

  it("A4 门控在混合检索下保持:非 confirmed / sensitive 不进结果", async () => {
    const repo = await makeMem();
    const base = createInitialProductState();
    // 三条文本都含「区块链」(BM25 都命中),但 sensitivity/status 不同 → A4 必须拦。
    repo.replaceState({ ...base, memoryRecords: [
      memWithEmbedding("me_norm", "区块链普通记忆", vec(-1)),
      memWithEmbedding("me_sens", "区块链敏感记忆", vec(-1), { sensitivity: "sensitive" }),
      memWithEmbedding("me_dep", "区块链弃用记忆", vec(-1), { status: "deprecated" })
    ] });
    await repo.flush();
    const def = await repo.recallMemoriesByVector(vec(1), 10, { queryText: "区块链" });
    expect(def.map((h) => h.id).sort()).toEqual(["me_norm"]);            // BM25 命中也只放 confirmed+normal
    const withSens = await repo.recallMemoriesByVector(vec(1), 10, { queryText: "区块链", includeSensitive: true });
    expect(withSens.map((h) => h.id).sort()).toEqual(["me_norm", "me_sens"]); // 含 sensitive,仍不含 deprecated
  });

  it("fail-safe:无 queryText → 退化为纯 HNSW,结果与现状一致", async () => {
    const repo = await makeMem();
    const base = createInitialProductState();
    const records = [
      memWithEmbedding("me_near", "近", vec(1)),
      memWithEmbedding("me_far", "远", vec(-1))
    ];
    repo.replaceState({ ...base, memoryRecords: records });
    await repo.flush();
    // 不传 queryText → 与既有纯 HNSW 调用同参、同结果。
    const baseline = await repo.recallMemoriesByVector(vec(1), 1);
    const noQueryText = await repo.recallMemoriesByVector(vec(1), 1, { queryText: undefined });
    const emptyQueryText = await repo.recallMemoriesByVector(vec(1), 1, { queryText: "   " });
    expect(baseline.map((h) => h.id)).toEqual(["me_near"]);
    expect(noQueryText.map((h) => h.id)).toEqual(["me_near"]);     // undefined queryText 等价纯 HNSW
    expect(emptyQueryText.map((h) => h.id)).toEqual(["me_near"]);  // 空白 queryText 也退化
  });

  it("fail-safe:queryText 有词但 BM25 零命中 → 退化为向量召回(不破坏)", async () => {
    const repo = await makeMem();
    const base = createInitialProductState();
    repo.replaceState({ ...base, memoryRecords: [
      memWithEmbedding("me_near", "授权放权", vec(1)),
      memWithEmbedding("me_far", "目标管理", vec(-1))
    ] });
    await repo.flush();
    // queryText「量子飞船」与任何记忆都无 ngram 交集 → BM25 路空,rrf 仅剩向量路。
    const hits = await repo.recallMemoriesByVector(vec(1), 2, { queryText: "量子飞船" });
    expect(hits.map((h) => h.id)).toContain("me_near"); // 向量召回照常,不因 BM25 空而崩
  });
});
