-- P0 · 向量(HNSW)+ 全文(BM25)索引(spec 01 §4)。
-- 维度 1024 = text-embedding-v3 默认(S0/S5 确认);必须与 constants.ts EMBEDDING_DIMENSION 一致(测试守卫)。
-- 仅 memory/rag_chunk 有 embedding(material 无 — 已据 types.ts 删除 spec 的 material_emb)。
-- S0 实测:嵌入式引擎为 SurrealDB 3.0.2;全文语法改用 FULLTEXT ANALYZER(非 2.x 的 SEARCH ANALYZER);
--         中文索引需 ngram(2,2) 滤波器才能产生子词 token。

DEFINE INDEX IF NOT EXISTS memory_emb ON memory    FIELDS embedding HNSW DIMENSION 1024 DIST COSINE;
DEFINE INDEX IF NOT EXISTS rag_emb    ON rag_chunk FIELDS embedding HNSW DIMENSION 1024 DIST COSINE;

DEFINE ANALYZER IF NOT EXISTS zh TOKENIZERS class FILTERS ngram(2,2), lowercase;
DEFINE INDEX IF NOT EXISTS memory_ft ON memory    FIELDS text FULLTEXT ANALYZER zh BM25;
DEFINE INDEX IF NOT EXISTS rag_ft    ON rag_chunk FIELDS text FULLTEXT ANALYZER zh BM25;
