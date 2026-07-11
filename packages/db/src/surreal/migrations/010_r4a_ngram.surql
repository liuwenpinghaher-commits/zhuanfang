-- R4a · 中文全文分词升级:zh analyzer 从 ngram(2,2) → ngram(1,3)
-- (方案 2026-07-10 §4 R4;依据 R0-S5 spike + R4a 真实体量复核)。
--
-- 收益(R0-S5 + R4a 11k-chunk 复核实测):单字/短人名召回从 0 → ~99%——ngram 最小 2 时,
--   单字查询 `search::analyze` 切不出任何 token(候选恒 0);(1,3) 产 1-gram token 后
--   「卡」416/420、「赌」177/180 命中。多字查询覆盖不回退(强化学习 89/90、数据飞轮 59/60)。
-- 代价(R4a 真实体量复核,优于 toy 语料预估):索引膨胀 1.87x(27.2MB→50.8MB @ 11010 chunk,
--   toy 语料曾预估 2.6x——真实体量因固定开销摊薄,膨胀更低),索引构建耗时 1.1x(47s→50s)。
--   查询侧 1-gram 噪声由消费层「择优」规则治理(见 constants.ts MAX_BM25_QUERY_TOKENS),非 DDL 侧。
--
-- 3.0.2 实测(R4a probe):`DEFINE ANALYZER OVERWRITE` 支持(比 006 的 REMOVE+DEFINE 更干净、原子);
--   `REBUILD INDEX [IF EXISTS] <idx> ON <table>` 支持。⚠️ 改 analyzer 的 filter 后【必须】REBUILD 所有
--   用它的 BM25 索引:migration-correctness spike 实证——只 OVERWRITE 不 REBUILD,旧 posting list 仍是
--   2-gram、新单字 token 对不上(「卡」仍 0);REBUILD 后才真的用新 analyzer 重切词(「卡」→命中)。
-- 幂等:applySchema 账本保证本文件只跑一次;OVERWRITE 与 REBUILD 自身亦可重入(spike 复跑无副作用)。

DEFINE ANALYZER OVERWRITE zh TOKENIZERS class FILTERS ngram(1,3), lowercase;

-- 重建所有 zh BM25 索引(全集:003 的 memory_ft/rag_ft + 009 的 kc_ft)。
-- IF EXISTS 防御:003/009 按文件名序在 010 之前应用,三索引必在;IF EXISTS 仅为幂等/健壮。
REBUILD INDEX IF EXISTS memory_ft ON memory;
REBUILD INDEX IF EXISTS rag_ft    ON rag_chunk;
REBUILD INDEX IF EXISTS kc_ft     ON knowledge_chunk;
