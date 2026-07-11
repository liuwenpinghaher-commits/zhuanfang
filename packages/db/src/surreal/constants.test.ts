import { describe, it, expect } from "vitest";
import { selectBm25QueryTokens, MAX_BM25_QUERY_TOKENS } from "./constants";

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
