import { describe, it, expect } from "vitest";
import {
  selectBm25QueryTokens,
  MAX_BM25_QUERY_TOKENS,
  buildBm25Clause,
  reorderByRrfRank,
  RRF_RANK_CONSTANT,
} from "./constants";

// R4a · BM25 查询 token 择优/钳制口径(三处混合召回共享)。确定性单测,不碰 DB。
// 依据见 constants.ts 注释;规则:去重 →(含 ≥2 字 gram 则丢单字 1-gram、纯单字查询保留)→ 上限钳制。
describe("selectBm25QueryTokens(R4a 择优+钳制口径)", () => {
  it("纯单字查询:保留 1-gram(否则丢掉 R4a 升级的全部收益——单字召回)", () => {
    // ngram(1,3) 对单字「卡」只切出一个 1-gram token;必须保留,否则 BM25 路空。
    expect(selectBm25QueryTokens(["卡"])).toEqual(["卡"]);
    // 纯单字串(全是 1-gram)也保留:没有多字 gram 可用,单字是唯一信号。
    expect(selectBm25QueryTokens(["卡", "赌"])).toEqual(["卡", "赌"]);
  });

  it("含多字 gram:丢弃纯单字 1-gram(治 1-gram 噪声),只留 ≥2 字 gram", () => {
    // 模拟 search::analyze('zh','强化学习') 位置交错序:强,强化,强化学,化,化学,化学习,学,学习,习
    const analyzed = ["强", "强化", "强化学", "化", "化学", "化学习", "学", "学习", "习"];
    const chosen = selectBm25QueryTokens(analyzed);
    // 所有单字被丢弃(强化学习 候选广度回落到 ≈ngram(2,2) 水平),多字 gram 全保留。
    expect(chosen).toEqual(["强化", "强化学", "化学", "化学习", "学习"]);
    expect(chosen.every((t) => [...t].length >= 2)).toBe(true);
  });

  it("去重:重复 token 冗余(OR 语义不变),去掉", () => {
    expect(selectBm25QueryTokens(["数据", "数据", "配比", "数据"])).toEqual(["数据", "配比"]);
    // 去重发生在择优之前:重复单字在有多字时同样先去重再被丢
    expect(selectBm25QueryTokens(["组", "组织", "组织", "织"])).toEqual(["组织"]);
  });

  it("钳制:择优后仍超上限 → 截到 MAX_BM25_QUERY_TOKENS(防超长自由文本撑爆 OR 语句)", () => {
    // 造 100 个互异的多字 gram
    const many = Array.from({ length: 100 }, (_, i) => `词${i}`);
    const chosen = selectBm25QueryTokens(many);
    expect(chosen.length).toBe(MAX_BM25_QUERY_TOKENS);
    expect(chosen[0]).toBe("词0");                       // 保序:取前缀
    expect(chosen[MAX_BM25_QUERY_TOKENS - 1]).toBe(`词${MAX_BM25_QUERY_TOKENS - 1}`);
  });

  it("空 / 空串 token → 空数组(消费侧据此退化纯 HNSW)", () => {
    expect(selectBm25QueryTokens([])).toEqual([]);
    expect(selectBm25QueryTokens([""])).toEqual([]);       // filter(Boolean) 滤掉空串(analyzer 不产纯空白 token)
  });
});

// R2c · 三处混合召回机械件提炼后的纯函数锁定测试。断言【逐字节等价】:生成的 SQL 谓词串与参数、
// rrf 重排序,均与提炼前三处 inline 手抄产出完全一致——召回正确性依赖 SQL 语句形态精确不变。
describe("buildBm25Clause(BM25 OR 谓词串构造,三处混合召回共享)", () => {
  it("多 token:逐 token `text @@ $tN` 用 ` OR ` 串联,参数按 t0/t1/... 绑定", () => {
    const { clause, vars } = buildBm25Clause(["强化", "学习", "配比"]);
    // 与旧 inline `.map((tok,i)=>{tokenVars[`t${i}`]=tok; return `text @@ $t${i}`}).join(" OR ")` 逐字节相同。
    expect(clause).toBe("text @@ $t0 OR text @@ $t1 OR text @@ $t2");
    expect(vars).toEqual({ t0: "强化", t1: "学习", t2: "配比" });
  });

  it("单 token:无 OR,单谓词 + 单参数", () => {
    const { clause, vars } = buildBm25Clause(["卡"]);
    expect(clause).toBe("text @@ $t0");
    expect(vars).toEqual({ t0: "卡" });
  });

  it("空 token 列表:空串 clause + 空 vars(调用方在此之前已 length===0 退化,不会走到)", () => {
    const { clause, vars } = buildBm25Clause([]);
    expect(clause).toBe("");
    expect(vars).toEqual({});
  });

  it("参数键序与 token 序一致(索引即键名,无碰撞)", () => {
    const { vars } = buildBm25Clause(["a", "b", "c", "d"]);
    expect(Object.keys(vars)).toEqual(["t0", "t1", "t2", "t3"]);
  });
});

describe("reorderByRrfRank(rrf 融合名次 JS 重排,rag/knowledge 共享)", () => {
  it("按 order 内下标升序重排 rows(order 即 rrf 融合名次序)", () => {
    // DB `WHERE id IN $fused.map(...)` 取回不保序;order 是 $fused 的名次序。
    const rows = [{ id: "c" }, { id: "a" }, { id: "b" }];
    const order = ["a", "b", "c"];
    expect(reorderByRrfRank(rows, order).map((r) => r.id)).toEqual(["a", "b", "c"]);
  });

  it("未命中名次者沉到末尾(order.length),彼此保持原相对序(sort 稳定)", () => {
    const rows = [{ id: "x" }, { id: "a" }, { id: "y" }];
    const order = ["a"]; // 只有 a 在融合序里;x、y 无名次 → 均记 order.length=1,相对序不变
    expect(reorderByRrfRank(rows, order).map((r) => r.id)).toEqual(["a", "x", "y"]);
  });

  it("就地排序返回同一数组引用(与旧 inline `rows.sort(...)` 行为一致)", () => {
    const rows = [{ id: "b" }, { id: "a" }];
    const out = reorderByRrfRank(rows, ["a", "b"]);
    expect(out).toBe(rows); // 同引用
    expect(out.map((r) => r.id)).toEqual(["a", "b"]);
  });

  it("保留行对象的额外字段(泛型 T 透传,不只 id)", () => {
    const rows = [{ id: "b", text: "T2" }, { id: "a", text: "T1" }];
    expect(reorderByRrfRank(rows, ["a", "b"])).toEqual([{ id: "a", text: "T1" }, { id: "b", text: "T2" }]);
  });
});

describe("RRF_RANK_CONSTANT", () => {
  it("== 60(三处 search::rrf 第二参字面量提取,插值后 SQL 逐字节仍为 60)", () => {
    expect(RRF_RANK_CONSTANT).toBe(60);
    // 插值锁定:`search::rrf([$vec, $bm], ${RRF_RANK_CONSTANT}, ${k})` 渲染回原字面量形态。
    expect(`search::rrf([$vec, $bm], ${RRF_RANK_CONSTANT}, ${5})`).toBe("search::rrf([$vec, $bm], 60, 5)");
  });
});
