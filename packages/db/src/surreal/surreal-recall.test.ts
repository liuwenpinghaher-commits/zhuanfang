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

  it("D 溯源门控:已放弃的观点不再溯源(终态资产证据 turn 不喂进 LLM 引导)", async () => {
    const repo = await makeMem();
    const s = linkedState();
    repo.replaceState({ ...s, points: s.points.map((p) => ({ ...p, status: "已放弃" as const })) });
    await repo.flush();
    const turns = await repo.recallProvenanceTurns("point", "pt_1");
    expect(turns).toHaveLength(0); // status NOT IN ['已放弃',...] 拦住终态来源,即便 derived_from 边仍在
  });
});

describe("surreal native recall: 权威库落库健康度(E)", () => {
  it("getPersistHealth:初始为 0,persist 成功后连续失败计数仍为 0", async () => {
    const repo = await makeMem();
    expect(repo.getPersistHealth().consecutiveFailures).toBe(0); // 初始
    repo.replaceState(linkedState());
    await repo.flush();
    expect(repo.getPersistHealth().consecutiveFailures).toBe(0); // 成功落库后清零
    expect(repo.getPersistHealth().lastError).toBeUndefined();
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

  it("R4a 单字召回:单字 queryText 拉回关键词块(ngram(2,2) 对单字切 0 token、此路恒空,(1,3) 才可达)", async () => {
    const repo = await makeMem();
    const base = createInitialProductState();
    // me_kw 含单字「赌」但向量最远(vec(-1));另造噪声让纯 HNSW 在小 k 下必漏 me_kw。
    // 旧 ngram(2,2):search::analyze('zh','赌') 切不出任何 token → BM25 路空 → me_kw 永不被拉回。
    // 新 ngram(1,3):单字产 1-gram「赌」→ BM25 命中 me_kw。这是 R0-S5 的核心收益,真库实证。
    const noise = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6].map((s, i) => memWithEmbedding(`me_noise_${i}`, `无关内容${i}`, vec(s)));
    repo.replaceState({ ...base, memoryRecords: [
      memWithEmbedding("me_near", "关于授权放权的深度思考", vec(1)),
      memWithEmbedding("me_kw", "他喜欢赌一把大的", vec(-1)),
      ...noise
    ] });
    await repo.flush();
    const kSmall = 2;
    const hnswOnly = await repo.recallMemoriesByVector(vec(1), kSmall);
    expect(hnswOnly.map((h) => h.id)).not.toContain("me_kw");          // 基线:向量最远,纯 HNSW k=2 漏
    const hybrid = await repo.recallMemoriesByVector(vec(1), kSmall, { queryText: "赌" });
    expect(hybrid.map((h) => h.id)).toContain("me_kw");                // 单字 BM25 拉回(升级前不可能)
  });

  it("R4a 1-gram 噪声治理:多字 queryText 不因单字 gram 误召无关块(择优丢单字)", async () => {
    const repo = await makeMem();
    const base = createInitialProductState();
    // me_kw 含专名「区块链」;me_dist 只与「区块链」共享单字「链」(产业链),不含专名,且【无 embedding】
    // → HNSW 不可达,只能由 BM25 路召回。旧「全 gram」下单字「链」会把 me_dist 误拉进候选;
    // R4a 择优(含多字 gram 则丢单字)后「链」被丢,me_dist 不再被误召——1-gram 噪声治理的确定性断言。
    const meDist = { id: "me_dist", text: "关注上下游产业链整合", status: "confirmed" as const,
      sourceType: "profile" as const, sourceId: "p", evidenceQuote: "", sensitivity: "normal" as const,
      createdAt: "2026-06-27T00:00:00.000Z", updatedAt: "2026-06-27T00:00:00.000Z" };  // 刻意无 embedding
    repo.replaceState({ ...base, memoryRecords: [
      memWithEmbedding("me_kw", "团队评估区块链技术选型", vec(-1)),
      meDist as unknown as (typeof base.memoryRecords)[number]
    ] });
    await repo.flush();
    const hybrid = await repo.recallMemoriesByVector(vec(1), 10, { queryText: "区块链" });
    const ids = hybrid.map((h) => h.id);
    expect(ids).toContain("me_kw");        // 专名多字 gram(区块/区块链/块链)命中
    expect(ids).not.toContain("me_dist");  // 仅共享单字「链」+无 embedding → 择优丢单字后两路皆不达
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

// ── 方案一:rag_chunk 原生混合召回 ──
function ragChunk(id: string, text: string, opts: { vec?: number[]; usage?: "interview-context" | "memory-candidate" } = {}) {
  return {
    id, sourceId: "is_1", title: id, text, keywords: [], tokenEstimate: 10,
    usage: opts.usage ?? "interview-context",
    ...(opts.vec ? { embedding: opts.vec } : {}),
    createdAt: "2026-06-27T00:00:00.000Z"
  };
}
function ragState(chunks: Array<ReturnType<typeof ragChunk>>) {
  const base = createInitialProductState();
  return {
    ...base,
    importSources: [{
      id: "is_1", title: "资料", sourceType: "text", content: "正文", status: "chunked",
      sensitivity: "normal", chunkIds: chunks.map((c) => c.id),
      createdAt: "2026-06-27T00:00:00.000Z", updatedAt: "2026-06-27T00:00:00.000Z"
    }] as unknown as typeof base.importSources,
    ragChunks: chunks as unknown as typeof base.ragChunks
  };
}

describe("surreal native recall: rag_chunk 混合召回(方案一)", () => {
  it("HNSW:返回向量最近的块;usage 门控拦下 memory-candidate", async () => {
    const repo = await makeMem();
    repo.replaceState(ragState([
      ragChunk("rc_near", "授权放权的资料", { vec: vec(1) }),
      ragChunk("rc_far", "无关资料", { vec: vec(-1) }),
      ragChunk("rc_mc", "候选块", { vec: vec(1), usage: "memory-candidate" })
    ]));
    await repo.flush();
    const near = await repo.recallRagChunks({ embedding: vec(1), k: 1, usage: "interview-context" });
    expect(near.map((h) => h.id)).toEqual(["rc_near"]);
    const all = await repo.recallRagChunks({ embedding: vec(1), k: 10, usage: "interview-context" });
    expect(all.map((h) => h.id)).not.toContain("rc_mc");   // usage 门控
    expect(all.map((h) => h.id)).toEqual(expect.arrayContaining(["rc_near", "rc_far"]));
  });

  it("混合:BM25 拉回【无 embedding】的关键词块(纯 HNSW 物理不可达的降级摄入块)", async () => {
    const repo = await makeMem();
    repo.replaceState(ragState([
      ragChunk("rc_vec", "授权放权的深度思考", { vec: vec(1) }),
      ragChunk("rc_kw", "团队评估区块链技术选型")   // 无 embedding → 不在 HNSW 索引
    ]));
    await repo.flush();
    const hnsw = await repo.recallRagChunks({ embedding: vec(1), k: 5, usage: "interview-context" });
    expect(hnsw.map((h) => h.id)).not.toContain("rc_kw");  // 基线:无嵌入块 HNSW 恒不可达
    const hybrid = await repo.recallRagChunks({ embedding: vec(1), queryText: "区块链", k: 5, usage: "interview-context" });
    expect(hybrid.map((h) => h.id)).toEqual(expect.arrayContaining(["rc_kw", "rc_vec"]));
  });

  it("BM25-only:无 embedding 仍可关键词召回;embedding/queryText 皆缺 → []", async () => {
    const repo = await makeMem();
    repo.replaceState(ragState([
      ragChunk("rc_kw", "团队评估区块链技术选型"),
      ragChunk("rc_other", "完全无关的内容", { vec: vec(1) })
    ]));
    await repo.flush();
    const bm = await repo.recallRagChunks({ queryText: "区块链", k: 5, usage: "interview-context" });
    expect(bm.map((h) => h.id)).toEqual(["rc_kw"]);
    expect(await repo.recallRagChunks({ k: 5, usage: "interview-context" })).toEqual([]);
    expect(await repo.recallRagChunks({ queryText: "   ", k: 5 })).toEqual([]);
  });

  it("混合路径 usage 门控在最终 SELECT:BM25 命中但 usage 不符 → 不进结果", async () => {
    const repo = await makeMem();
    repo.replaceState(ragState([
      ragChunk("rc_ic", "区块链正式资料", { vec: vec(1) }),
      ragChunk("rc_mc", "区块链候选块", { vec: vec(1), usage: "memory-candidate" })
    ]));
    await repo.flush();
    const hits = await repo.recallRagChunks({ embedding: vec(1), queryText: "区块链", k: 10, usage: "interview-context" });
    expect(hits.map((h) => h.id)).toEqual(["rc_ic"]);
  });
});

// ── 方案三:溯源敏感纵深门控 ──
describe("surreal native recall: 溯源敏感纵深门控(方案三)", () => {
  function sensitiveMemoryState() {
    const s = linkedState();
    return {
      ...s,
      memoryRecords: s.memoryRecords.map((m) => ({
        ...m, sensitivity: "sensitive" as const,
        evidenceAnchors: [{ sessionId: "se_1", turnId: "tu_1" }]
      }))
    };
  }
  it("敏感来源资产默认不溯源(证据原话不经侧路泄出);includeSensitive 显式放行", async () => {
    const repo = await makeMem();
    repo.replaceState(sensitiveMemoryState());
    await repo.flush();
    expect(await repo.recallProvenanceTurns("memory", "me_1")).toHaveLength(0);
    const opened = await repo.recallProvenanceTurns("memory", "me_1", { includeSensitive: true });
    expect(opened.map((t) => t.id)).toContain("tu_1");
  });
  it("无 sensitivity 列的资产(point)不受影响(NONE 放行,现状行为不变)", async () => {
    const repo = await makeMem();
    repo.replaceState(linkedState());
    await repo.flush();
    const turns = await repo.recallProvenanceTurns("point", "pt_1");
    expect(turns.map((t) => t.id)).toContain("tu_1");
  });
});

// ── P4 真实业务 E2E 实测修复:persist 瞬态冲突有界重试 ──
describe("persist 瞬态冲突重试(原生召回读×写并发)", () => {
  it("isTransientPersistError:只认嵌入式引擎事务冲突报文,schema 数据错误不重试", async () => {
    const { isTransientPersistError } = await import("./surreal-product-state-repository");
    expect(isTransientPersistError(new Error("QueryError: The query was not executed due to a failed transaction"))).toBe(true);
    expect(isTransientPersistError("The query was not executed due to a failed transaction")).toBe(true);
    // P8 修复(R0-S3 实测 2026-07-10):真实写写冲突是 InternalError,报文如下——旧匹配
    // /failed transaction/i 对它失效,重试阶梯从未对真冲突生效。钉住新口径。
    expect(isTransientPersistError(new Error(
      "Query not executed: Transaction conflict: Transaction write conflict. This transaction can be retried"
    ))).toBe(true);
    // 三段式判别的第三支独立生效:报文只含"can be retried"片段(无 conflict 字样)也应命中——
    // 引擎自述可重试即可重试,防未来报文措辞微调再次让重试失效。
    expect(isTransientPersistError(new Error("This transaction can be retried"))).toBe(true);
    expect(isTransientPersistError(new Error("Found '不存在枚举' for field `status`, with record `point:x`"))).toBe(false);
    expect(isTransientPersistError(new Error("Expected a object but found NONE"))).toBe(false);
  });

  it("并发原生召回读 × 连续快写:persist 最终收敛,health 无残留失败,图审计一致", async () => {
    const repo = await makeMem();
    repo.replaceState(ragState([
      ragChunk("rc_a", "授权放权的资料", { vec: vec(1) }),
      ragChunk("rc_b", "团队评估区块链技术选型", { vec: vec(-1) })
    ]));
    await repo.flush();
    // 读写混跑:10 轮快写(每轮改 memoryRecords)与并行原生召回(HNSW/BM25/rrf + 图遍历)交错,
    // 模拟真实业务下 create-session 预召回撞上异步 persist 的窗口。
    const ts = "2026-06-28T00:00:00.000Z";
    const readers: Array<Promise<unknown>> = [];
    for (let i = 0; i < 10; i++) {
      const s = repo.getState();
      repo.replaceState({ ...s, memoryRecords: [
        { id: `me_${i}`, text: `记忆${i}`, status: "confirmed", sourceType: "profile", sourceId: "p",
          evidenceQuote: "", sensitivity: "normal", embedding: vec(i + 1), createdAt: ts, updatedAt: ts } as never
      ]});
      readers.push(repo.recallRagChunks({ embedding: vec(1), queryText: "区块链", k: 3, usage: "interview-context" }));
      readers.push(repo.recallMemoriesByVector(vec(1), 3));
    }
    await Promise.all(readers);   // 读全程不抛
    await repo.flush();           // 写队列(含重试)排空
    expect(repo.getPersistHealth().consecutiveFailures).toBe(0); // 无残留失败(冲突要么没发生要么被重试吸收)
    const audit = await repo.auditGraphConsistency();
    expect(audit.ok, `读写混跑后图审计应一致: ${JSON.stringify(audit)}`).toBe(true);
  }, 30000);
});

// ── 方案二:图↔软链双表示一致性审计 ──
describe("surreal graph consistency audit(方案二)", () => {
  it("一致状态:ok=true,期望/实际边数相等,part_of 被 append-only 豁免不参审", async () => {
    const repo = await makeMem();
    repo.replaceState(linkedState());
    await repo.flush();
    const r = await repo.auditGraphConsistency();
    expect(r.ok).toBe(true);
    expect(r.missingCount).toBe(0);
    expect(r.unexpectedCount).toBe(0);
    expect(r.expectedCount).toBeGreaterThan(0);
    expect(r.expectedCount).toBe(r.actualCount);
    expect(r.auditedEdgeTables).not.toContain("part_of");
  });
  it("漂移检出:带外删边 → missing(投影漏写类);带外加边 → unexpected(漏删/带外写入类)", async () => {
    const repo = await makeMem();
    repo.replaceState(linkedState());
    await repo.flush();
    await repo.query("DELETE belongs_to_theme WHERE in = point:pt_1;");
    await repo.query("RELATE question:qu_1->about_theme->theme:th_1;");
    const r = await repo.auditGraphConsistency();
    expect(r.ok).toBe(false);
    expect(r.missingCount).toBe(1);
    expect(r.missingInDb[0]).toBe("belongs_to_theme|point:pt_1->theme:th_1");
    expect(r.unexpectedCount).toBe(1);
    expect(r.unexpectedInDb[0]).toBe("about_theme|question:qu_1->theme:th_1");
  });
});

// ── P0 家族根修回归(全系统审查实测三形态) ──
describe("P0 persist 确定性失败家族根修", () => {
  it("P0-1a(note×级联收缩): 移除 session 保留 note → note 在 hot 与 DB 双侧存活,审计一致", async () => {
    const repo = await makeMem();
    repo.replaceState(linkedState());
    await repo.flush();
    // 造 note 挂在 se_1 上
    const s = repo.getState();
    repo.replaceState({ ...s, notes: [{ id: "no_1", sessionId: "se_1", title: "笔记", summary: "s", keyQuote: "", saidTrack: [], learnedTrack: [], createdAt: "2026-06-27T00:00:00.000Z" } as never] });
    await repo.flush();
    // 移除 session、保留 note(006 级联收缩后:DB 不再静默删 note)
    const s2 = repo.getState();
    repo.replaceState({ ...s2, sessions: [] });
    await repo.flush();
    expect(repo.getPersistHealth().consecutiveFailures).toBe(0);
    expect(repo.getState().notes.map((n) => n.id)).toContain("no_1");   // hot 保留
    const [rows] = await repo.query<[Array<{ id: unknown }>]>("SELECT id FROM note;");
    expect((rows ?? []).length).toBe(1);                                 // DB 同样保留(不再发散)
    const audit = await repo.auditGraphConsistency();
    // session 已删 → turn 级联清 → note/point 的 derived_from 悬空:ok 必须 false(P0 假绿闭合)。
    expect(audit.ok, JSON.stringify(audit)).toBe(false);
    expect(audit.danglingProvenanceCount).toBeGreaterThan(0);
    // 隐私核心不回退:session 的 turn 仍被级联清掉
    const [turns] = await repo.query<[Array<{ id: unknown }>]>("SELECT id FROM turn;");
    expect((turns ?? []).length).toBe(0);
  });

  it("P0-1b(chunk 修剪): 悬空 rag_chunk(来源不存在)被 normalize 修剪,hot/DB 一致", async () => {
    const repo = await makeMem();
    const base = createInitialProductState();
    repo.replaceState({
      ...base,
      importSources: [],
      ragChunks: [{ id: "rc_orphan", sourceId: "is_gone", title: "孤儿", text: "t", keywords: [], tokenEstimate: 1, usage: "interview-context", createdAt: "2026-06-27T00:00:00.000Z" }] as never
    });
    await repo.flush();
    expect(repo.getState().ragChunks.map((c) => c.id)).not.toContain("rc_orphan"); // 域层修剪
    expect(repo.getPersistHealth().consecutiveFailures).toBe(0);
    const audit = await repo.auditGraphConsistency();
    expect(audit.ok, JSON.stringify(audit)).toBe(true);
  });

  it("P0-2(同事务级联感知): 移除 session + 新增 point(anchor→该 session 的 turn)→ persist 成功,悬空边被判死", async () => {
    const repo = await makeMem();
    repo.replaceState(linkedState());
    await repo.flush();
    const s = repo.getState();
    const newPoint = { ...s.points[0], id: "pt_new", title: "全新观点", evidenceAnchors: [{ sessionId: "se_1", turnId: "tu_1" }] };
    repo.replaceState({ ...s, sessions: [], points: [...s.points, newPoint] });
    await repo.flush();
    expect(repo.getPersistHealth().consecutiveFailures).toBe(0);       // 修复前:确定性失败 wedge
    const [pts] = await repo.query<[Array<{ id: unknown }>]>("SELECT id FROM point;");
    expect((pts ?? []).length).toBe(2);                                 // 资产真实落库
    const audit = await repo.auditGraphConsistency();
    // 悬空 derived_from 被丢弃 → dangling>0 → ok 必须 false
    expect(audit.ok, JSON.stringify(audit)).toBe(false);
    expect(audit.danglingProvenanceCount).toBeGreaterThan(0);
  });

  it("P0-3b(必填 string 兜底): 缺 content 的 point 被 normalize 补空串,persist 不被 coerce 拒", async () => {
    const repo = await makeMem();
    const s = linkedState();
    // 手工/坏 import 缺必填 string content 的 point(真实业务 E2E 实测触发)。
    const badPoint = { id: "pt_nocontent", title: "无正文", status: "稳定观点", confidence: "用户确认", evidence: [], relatedThemeIds: [], important: false, updatedAt: "2026-06-27T00:00:00.000Z" };
    repo.replaceState({ ...s, points: [...s.points, badPoint as never] });
    await repo.flush();
    expect(repo.getPersistHealth().consecutiveFailures).toBe(0);   // 修复前:coerce 失败 wedge
    const [pts] = await repo.query<[Array<{ id: unknown }>]>("SELECT id FROM point;");
    expect((pts ?? []).length).toBe(2);
    expect(repo.getState().points.find((p) => p.id === "pt_nocontent")?.content).toBe("");  // fail-closed 兜空串
  });

  it("P0-3(枚举钳制): 非法 point.status 被 normalize 钳制为合法值,persist 不再被 ASSERT 拒", async () => {
    const repo = await makeMem();
    const s = linkedState();
    repo.replaceState({ ...s, points: s.points.map((p) => ({ ...p, status: "已废弃" as never })) });
    await repo.flush();
    expect(repo.getPersistHealth().consecutiveFailures).toBe(0);
    expect(repo.getState().points[0].status).toBe("临时想法");          // fail-closed 钳制
    const [pts] = await repo.query<[Array<{ id: unknown }>]>("SELECT id FROM point;");
    expect((pts ?? []).length).toBe(1);
  });
});

// ── ④ 根修:H1×A5 碰撞(reset/purge 级联删 turn 后,重引入带 anchor 的资产) ──
describe("④根修:悬空溯源不再拒整事务(reset→重引入形状,E2E 复现根因)", () => {
  it("完整会话落库→reset(A5 级联删 turn)→同 id 资产重引入(turns 已降冷)→persist 零失败,资产真实落库,悬空溯源按 DB 真相丢弃,审计一致", async () => {
    const repo = await makeMem();
    repo.replaceState(linkedState());       // session+turn tu_1 + point(anchor→tu_1) 全落库
    await repo.flush();
    repo.resetState();                       // 删 session → A5 EVENT 级联删其 turn 行
    await repo.flush();
    const [turnsAfterReset] = await repo.query<[Array<{ id: unknown }>]>("SELECT id FROM turn;");
    expect((turnsAfterReset ?? []).length).toBe(0);  // 前提确认:turn 已被级联删除

    // 重引入同一批资产,但会话 turns 已降冷(为空)——anchor 悬空指向已删除的 tu_1。
    // 修复前:derived_from RELATE ENFORCED 拒 → 整事务确定性失败(consecutiveFailures>0,
    // 资产永不落库=E2E 实测的 12 次 persist_failed 形状);修复后:悬空边被过滤,其余全部落库。
    const seed = linkedState();
    repo.replaceState({ ...seed, sessions: seed.sessions.map((s) => ({ ...s, turns: [] })) });
    await repo.flush();

    expect(repo.getPersistHealth().consecutiveFailures).toBe(0);
    const [points] = await repo.query<[Array<{ id: unknown }>]>("SELECT id FROM point;");
    expect((points ?? []).length).toBe(1);           // 资产真实落库(修复前整事务被拒为 0)
    const [df] = await repo.query<[Array<Record<string, unknown>>]>("SELECT * FROM derived_from;");
    expect((df ?? []).length).toBe(0);               // 悬空溯源不投影(turn 真的不存在)
    const audit = await repo.auditGraphConsistency();
    // P0:dangling 仍单列可观测,但顶层 ok 必须 fail-closed(备份恢复假绿的根因)。
    expect(audit.ok, `有悬空溯源时 ok 必须为 false: ${JSON.stringify(audit)}`).toBe(false);
    expect(audit.danglingProvenanceCount).toBe(1);   // 单列可观测
    expect(audit.missingCount).toBe(0);              // 不进 missing(与漂移区分)
  });

  it("P0 import:空库治理恢复冷层 turns + 降冷热态 → recallProvenanceTurns 非空且审计 ok", async () => {
    // createSurrealStores exposes governance; standalone repo may not.
    const { createSurrealStores } = await import("./surreal-cold-repositories");
    const stores = await createSurrealStores({ url: "mem://" });
    open.push(stores.productState);
    const repo = stores.productState;
    const seed = linkedState();
    // Source shape after offload: hot turns empty, cold raw keeps original turns, assets keep anchors.
    const offloadedHot = {
      ...seed,
      sessions: seed.sessions.map((s) => ({ ...s, turns: [], status: "completed" as const })),
    };
    const coldRaw = [{
      sessionId: "se_1",
      turns: [{ id: "tu_1", role: "user" as const, content: "原话", intent: "", timestamp: "2026-06-27T00:00:00.000Z" }],
      strategyTrace: [],
      createdAt: "2026-06-27T00:00:00.000Z",
    }];
    // Empty-store import: replace hot + cold raw in one governance transaction.
    await repo.runGovernanceTransaction!(
      { kind: "replace", next: offloadedHot as typeof seed },
      { rawMaterial: { action: "replace", materials: coldRaw } },
    );
    const turns = await repo.recallProvenanceTurns("point", "pt_1");
    expect(turns.map((t) => t.id)).toContain("tu_1");
    expect(turns.find((t) => t.id === "tu_1")?.content).toBe("原话");
    const audit = await repo.auditGraphConsistency();
    expect(audit.danglingProvenanceCount, JSON.stringify(audit)).toBe(0);
    expect(audit.ok, JSON.stringify(audit)).toBe(true);
  });

  it("H1 降冷不受影响:会话未删除、turns 剥离 → 溯源边保留(端点仍在 DB)", async () => {
    const repo = await makeMem();
    repo.replaceState(linkedState());
    await repo.flush();
    // 降冷形状:同一会话保留、turns 清空(offloadCompletedSession 语义),不经过 reset。
    const s = repo.getState();
    repo.replaceState({ ...s, sessions: s.sessions.map((x) => ({ ...x, turns: [] })) });
    await repo.flush();
    expect(repo.getPersistHealth().consecutiveFailures).toBe(0);
    const turns = await repo.recallProvenanceTurns("point", "pt_1");
    expect(turns.map((t: { id: string }) => t.id)).toContain("tu_1");  // 溯源照常(P2c H1 契约不回归)
  });
});

// perf/审计(#2):turn 存在核对由 `SELECT VALUE id FROM turn WHERE id IN $ids`(扫最大 turn 表)
// 改为 record-direct `SELECT VALUE id FROM $ids`。FROM $ids 对不存在记录返回 null → 必须 null 过滤,
// 使「存在的 turn id 集合」与旧版逐一相同。下测构造【实存降冷 turn】+【从不存在 ghost turn】混合于
// 同一批新增溯源,断言实存边保留、ghost 边丢弃、persist 零失败——若 FROM $ids 对不存在返回 id 本身
// (而非 null)则 ghost 边会被误留 → RELATE ENFORCED 拒 → consecutiveFailures>0,本测即红。
describe("perf/审计:#2 turn 存在核对记录直取(SELECT VALUE id FROM $ids + null 过滤)", () => {
  it("同批新增溯源含【实存降冷 turn】+【ghost turn】混合:实存边保留、ghost 边丢弃、persist 零失败", async () => {
    const repo = await makeMem();
    // 步骤1:先落库 session se_1(含 turn tu_1),point 此刻不锚定 tu_1(无 derived_from)。
    const s1 = linkedState();
    repo.replaceState({ ...s1, points: s1.points.map((p) => ({ ...p, evidenceAnchors: [] })) });
    await repo.flush();
    const [t0] = await repo.query<[Array<{ id: unknown }>]>("SELECT id FROM turn;");
    expect((t0 ?? []).length).toBe(1); // 前提:tu_1 实存于 DB

    // 步骤2:同一笔 persist 新增两条 derived_from——
    //   pt_1→tu_1:turns 已降冷清空 → tu_1 不在 nextTurnIds → 走 DB 存在核对(实存);
    //   pt_2→tu_ghost:其 session se_ghost 从未落库 → DB 不存在(FROM $ids 返回 null)。
    const s2 = linkedState();
    repo.replaceState({
      ...s2,
      sessions: s2.sessions.map((x) => ({ ...x, turns: [] })),  // 降冷:tu_1 移出 nextTurnIds,逼出 DB 核对
      points: [
        { ...s2.points[0], id: "pt_1", evidenceAnchors: [{ sessionId: "se_1", turnId: "tu_1" }] },
        { ...s2.points[0], id: "pt_2", relatedThemeIds: [], evidenceAnchors: [{ sessionId: "se_ghost", turnId: "tu_ghost" }] },
      ],
    });
    await repo.flush();

    expect(repo.getPersistHealth().consecutiveFailures).toBe(0); // ghost 边丢弃 → 不触 RELATE ENFORCED 失败
    const [df] = await repo.query<[Array<{ it: string; ii: string; ot: string; oi: string }>]>(
      "SELECT meta::tb(in) AS it, meta::id(in) AS ii, meta::tb(out) AS ot, meta::id(out) AS oi FROM derived_from;"
    );
    const edges = (df ?? []).map((r) => `${r.it}:${r.ii}->${r.ot}:${r.oi}`);
    expect(edges).toEqual(["point:pt_1->turn:tu_1"]);            // 实存边保留、ghost 边不投影
    const [pts] = await repo.query<[Array<{ id: unknown }>]>("SELECT VALUE meta::id(id) FROM point;");
    expect((pts ?? []).map(String).sort()).toEqual(["pt_1", "pt_2"]); // pt_2 节点照常落库(仅其悬空溯源被丢)
  });
});

// perf/审计(#5):search::rrf 官方签名 ($lists, limit, k)——第2=返回上限、第3=RRF 衰减常量(默认60)。
// 此前把 60 放进 limit 槽、把 recall_k 放进 k 槽属语义倒置。下测在真库坐实第2槽=limit(与召回集membership无关)。
describe("perf/审计:#5 search::rrf 参数位(第2=limit、第3=衰减 k)", () => {
  it("坐实第2参=limit:候选池>limit 时恰被截断;旧倒置版 limit 恒=60 不随 recall_k 收窄", async () => {
    const repo = await makeMem();
    const base = createInitialProductState();
    // 8 条记忆全部含关键词「区块链」→ BM25 路返回全部 8 条(候选池=8)。
    const recs = Array.from({ length: 8 }, (_, i) => memWithEmbedding(`me_${i}`, `区块链记忆${i}`, vec(1)));
    repo.replaceState({ ...base, memoryRecords: recs });
    await repo.flush();
    const q = vec(1);
    const fusedLen = async (arg2: number, arg3: number): Promise<number> => {
      const r = await repo.query<Array<unknown>>(
        `LET $vec = (SELECT id FROM memory WHERE embedding <|3,40|> $q);
         LET $bm  = (SELECT id FROM memory WHERE text @@ $tok);
         LET $fused = search::rrf([$vec, $bm], ${arg2}, ${arg3});
         RETURN $fused;`, { q, tok: "区块链" });
      return ((r[r.length - 1] ?? []) as unknown[]).length;
    };
    // 修正版 (limit=Math.max(k,60)=60, k=60):候选池 8 < 60 → 返回全部 8(不误截)。
    expect(await fusedLen(60, 60)).toBe(8);
    // 第2参=limit 坐实:传 limit=3 → 恰返 3(证明第2槽是返回上限,而非衰减常量)。
    expect(await fusedLen(3, 60)).toBe(3);
    // 旧倒置版 (limit=60, k=3):limit 恒 60、与 recall_k=3 无关 → 仍返 8(暴露旧版把 60 误当 limit)。
    expect(await fusedLen(60, 3)).toBe(8);
  });
});
