-- R2a · 冷层并库:三个 SQLite 冷层(raw-material / audio / knowledge-index)真表化
-- (方案 2026-07-10 §4 R2)。R0 门已过:S2 实测 20MB bytes 写 84ms/读 11ms/膨胀 1.0x → 音频入库 bytes 定案。
--
-- 与热态 12+16 实体共用同一嵌入式连接/库(嵌入式 surrealkv 同进程独占锁,双连接会挂;
-- 且 R2b 治理事务要跨冷热单事务)。历史数据不迁移(用户决策 2026-07-10):demo 可清空,
-- 三冷层从空起点重建;loadState 侧不涉及这三表(它们由独立冷层仓库读写,不进 ProductState)。
--
-- ⚠️ 刻意不加 CHANGEFEED:R0 S1 实测 @surrealdb/node 3.0.3(SurrealDB 3.0.2)定义 CHANGEFEED 的表
-- 每笔写向 stderr 打十几行 dbg! 噪声——R5 启用增量同步前先评估/升级 SDK。COUNT 索引后置到 R4。
--
-- 本任务只建表建索引;knowledge_chunk 的原生混合召回(HNSW+BM25+rrf)接线是 R2c,此处不做。

-- ═══ raw_material(InterviewRawMaterial)— types.ts:120 ═══════════════════════════
-- 逐字稿冷层:record id 沿用 sqlite 的 session_id 主键语义(raw_material:<sessionId>)。
-- turns / strategyTrace 是「只读整段读写」——一次性写入、一次性读回,不做字段级查询,故用
-- FLEXIBLE object 数组整段存(blob 合理:与热态把非核心字段塞 rest 同理,避免过度拆列)。
-- 3.x 语法(spike 实测):SCHEMAFULL 表存「任意嵌套对象数组」须用通配子字段——
-- `TYPE array` 声明数组本身,`turns[*] TYPE object FLEXIBLE` 让每个元素为不校验子字段的 FLEXIBLE
-- 对象(整段无损存 InterviewTurn/InterviewStrategyDecision 的全部字段,含嵌套)。
-- (`TYPE array FLEXIBLE` 报 "FLEXIBLE can only be used with types containing object";
-- `TYPE array<object> FLEXIBLE` 仍逐一校验元素子字段;`FLEXIBLE` 须在 `TYPE` 之后。)
DEFINE TABLE IF NOT EXISTS raw_material SCHEMAFULL;
DEFINE FIELD IF NOT EXISTS turns            ON raw_material TYPE array DEFAULT [];
DEFINE FIELD IF NOT EXISTS turns[*]         ON raw_material TYPE object FLEXIBLE;
DEFINE FIELD IF NOT EXISTS strategyTrace    ON raw_material TYPE array DEFAULT [];
DEFINE FIELD IF NOT EXISTS strategyTrace[*] ON raw_material TYPE object FLEXIBLE;
DEFINE FIELD IF NOT EXISTS createdAt        ON raw_material TYPE datetime DEFAULT time::now();

-- ═══ audio(InterviewAudio)— types.ts:130 ═════════════════════════════════════════
-- 录音冷层:record id 用复合数组 `audio:[<sessionId>, <role>]`,沿用 sqlite 复合 PK (session_id, role)
-- 语义(R0 后继实测:RecordId 传数组可直接作 UPSERT/SELECT/DELETE 目标;按 sessionId 列过滤删除
-- 整会话两路)。data 入库 bytes——R0-S2 背书(20MB 写 84ms/读 11ms/sha256 逐位一致/膨胀 1.0x),
-- 单库单事务边界最干净(R2b 治理事务可含音频)。读回类型是 Uint8Array 系,消费侧转 Buffer。
DEFINE TABLE IF NOT EXISTS audio SCHEMAFULL;
DEFINE FIELD IF NOT EXISTS sessionId          ON audio TYPE string;
DEFINE FIELD IF NOT EXISTS role               ON audio TYPE string ASSERT $value IN ['interviewee','interviewer'];
DEFINE FIELD IF NOT EXISTS mime               ON audio TYPE string;
DEFINE FIELD IF NOT EXISTS byteSize           ON audio TYPE int;
DEFINE FIELD IF NOT EXISTS durationMs         ON audio TYPE option<int>;
DEFINE FIELD IF NOT EXISTS recordingStartedAt ON audio TYPE option<datetime>;
DEFINE FIELD IF NOT EXISTS createdAt          ON audio TYPE datetime DEFAULT time::now();
DEFINE FIELD IF NOT EXISTS data               ON audio TYPE bytes;

-- ═══ knowledge_chunk(KnowledgeChunk,八源知识索引)— types.ts:146 ═════════════════
-- 替代 knowledge_chunks SQLite(embedding 此前以 JSON 文本存、无向量索引)。列对齐现有实现:
-- sourceType/sourceId/text/keywords/createdAt + embedding option<array<float>>(+ title/embeddingProvider)。
-- ⚠️ 派生「可重建」域:与 rag_chunk(RAG 块)是不同域(八源知识索引 vs RAG 检索块),刻意不合并。
-- HNSW(DIMENSION 1024 DIST COSINE,== EMBEDDING_DIMENSION,apply-schema 守卫防漂移)+ BM25 全文
-- (ANALYZER zh,与 003 既有 memory_ft/rag_ft 同款 ngram(2,2))——本迁移只建表建索引,原生召回接线 R2c。
DEFINE TABLE IF NOT EXISTS knowledge_chunk SCHEMAFULL;
DEFINE FIELD IF NOT EXISTS sourceType        ON knowledge_chunk TYPE string;
DEFINE FIELD IF NOT EXISTS sourceId          ON knowledge_chunk TYPE string;
DEFINE FIELD IF NOT EXISTS title             ON knowledge_chunk TYPE string DEFAULT '';
DEFINE FIELD IF NOT EXISTS text              ON knowledge_chunk TYPE string;
DEFINE FIELD IF NOT EXISTS keywords          ON knowledge_chunk TYPE array<string> DEFAULT [];
DEFINE FIELD IF NOT EXISTS embedding         ON knowledge_chunk TYPE option<array<float>>;
DEFINE FIELD IF NOT EXISTS embeddingProvider ON knowledge_chunk TYPE option<string>;
DEFINE FIELD IF NOT EXISTS createdAt         ON knowledge_chunk TYPE datetime DEFAULT time::now();

-- 按来源过滤索引(deleteBySource/replaceSource 用),对齐 sqlite idx_kc_source。
DEFINE INDEX IF NOT EXISTS kc_source ON knowledge_chunk FIELDS sourceType, sourceId;
-- 向量(HNSW)+ 全文(BM25):维度/分析器与 003 同款(zh analyzer 已在 003 定义,复用)。
DEFINE INDEX IF NOT EXISTS kc_emb ON knowledge_chunk FIELDS embedding HNSW DIMENSION 1024 DIST COSINE;
DEFINE INDEX IF NOT EXISTS kc_ft  ON knowledge_chunk FIELDS text FULLTEXT ANALYZER zh BM25;

-- 注:三冷层是独立冷层仓库读写,不入 entity_kind 分类表,也不进图审计的节点核对
-- (它们不在 NODE_MAPPINGS,与 turn/流水表同理豁免)。
