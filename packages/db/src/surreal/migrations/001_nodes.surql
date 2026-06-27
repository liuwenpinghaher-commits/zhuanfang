-- P0 · 节点表(= EntityNode,spec 01 §2)。SCHEMAFULL,仅声明 P0 核心字段(枚举/关键标量/数组);
-- 其余领域字段在 P1(toRecord 落地)以增量 migration 004_* 补齐。所有 DEFINE 用 IF NOT EXISTS,可重复 apply。
-- 约定:领域实体的 string id 映射为 SurrealDB 记录 id(如 point:⟨id⟩),不单独声明 id 字段。

-- 元表:kind → 父类(治理/召回按父类批量遍历)
DEFINE TABLE IF NOT EXISTS entity_kind SCHEMAFULL;
DEFINE FIELD IF NOT EXISTS parent ON entity_kind TYPE string;

-- session(容器) — types.ts:586
DEFINE TABLE IF NOT EXISTS session SCHEMAFULL;
DEFINE FIELD IF NOT EXISTS title       ON session TYPE string;
DEFINE FIELD IF NOT EXISTS mode        ON session TYPE string ASSERT $value IN ['daily','decision','point','learning','organization','long-term'];
DEFINE FIELD IF NOT EXISTS strength    ON session TYPE string ASSERT $value IN ['gentle','standard','sharp'];
DEFINE FIELD IF NOT EXISTS status      ON session TYPE string ASSERT $value IN ['active','completed'];
DEFINE FIELD IF NOT EXISTS startedAt   ON session TYPE datetime DEFAULT time::now();
DEFINE FIELD IF NOT EXISTS completedAt ON session TYPE option<datetime>;

-- turn(Utterance,occurrent:只追加;冷层) — types.ts:251(字段名 timestamp,非 createdAt)
DEFINE TABLE IF NOT EXISTS turn SCHEMAFULL;
DEFINE FIELD IF NOT EXISTS sessionId ON turn TYPE string;
DEFINE FIELD IF NOT EXISTS role      ON turn TYPE string ASSERT $value IN ['user','assistant'];
DEFINE FIELD IF NOT EXISTS content   ON turn TYPE string;
DEFINE FIELD IF NOT EXISTS intent    ON turn TYPE option<string>;
DEFINE FIELD IF NOT EXISTS timestamp ON turn TYPE datetime DEFAULT time::now();

-- note(Distillation:DualTrackNote) — types.ts:657
DEFINE TABLE IF NOT EXISTS note SCHEMAFULL;
DEFINE FIELD IF NOT EXISTS sessionId    ON note TYPE string;
DEFINE FIELD IF NOT EXISTS title        ON note TYPE string;
DEFINE FIELD IF NOT EXISTS summary      ON note TYPE string;
DEFINE FIELD IF NOT EXISTS keyQuote     ON note TYPE string DEFAULT '';
DEFINE FIELD IF NOT EXISTS saidTrack    ON note TYPE array<string> DEFAULT [];
DEFINE FIELD IF NOT EXISTS learnedTrack ON note TYPE array<string> DEFAULT [];
DEFINE FIELD IF NOT EXISTS createdAt    ON note TYPE datetime DEFAULT time::now();

-- point(Distillation:PointAsset) — types.ts:697
DEFINE TABLE IF NOT EXISTS point SCHEMAFULL;
DEFINE FIELD IF NOT EXISTS title      ON point TYPE string;
DEFINE FIELD IF NOT EXISTS content    ON point TYPE string;
DEFINE FIELD IF NOT EXISTS status     ON point TYPE string ASSERT $value IN ['临时想法','稳定观点','被挑战中','已修正','已放弃'];
DEFINE FIELD IF NOT EXISTS confidence ON point TYPE string ASSERT $value IN ['用户确认','AI 推断','待验证'];
DEFINE FIELD IF NOT EXISTS important  ON point TYPE bool DEFAULT false;
DEFINE FIELD IF NOT EXISTS updatedAt  ON point TYPE datetime DEFAULT time::now();

-- decision(Distillation:DecisionAsset) — types.ts:726
DEFINE TABLE IF NOT EXISTS decision SCHEMAFULL;
DEFINE FIELD IF NOT EXISTS title              ON decision TYPE string;
DEFINE FIELD IF NOT EXISTS decisionKind       ON decision TYPE string ASSERT $value IN ['候选决策','用户决策'];
DEFINE FIELD IF NOT EXISTS confirmationStatus ON decision TYPE string ASSERT $value IN ['待用户确认','用户确认'];
DEFINE FIELD IF NOT EXISTS choice             ON decision TYPE string;
DEFINE FIELD IF NOT EXISTS status             ON decision TYPE string ASSERT $value IN ['待复盘','已复盘'];
DEFINE FIELD IF NOT EXISTS updatedAt          ON decision TYPE datetime DEFAULT time::now();

-- debt(Distillation:KnowledgeDebt) — types.ts:743
DEFINE TABLE IF NOT EXISTS debt SCHEMAFULL;
DEFINE FIELD IF NOT EXISTS concept   ON debt TYPE string;
DEFINE FIELD IF NOT EXISTS context   ON debt TYPE string DEFAULT '';
DEFINE FIELD IF NOT EXISTS status    ON debt TYPE string ASSERT $value IN ['待了解','能复述','已应用','不相关'];
DEFINE FIELD IF NOT EXISTS updatedAt ON debt TYPE datetime DEFAULT time::now();

-- question(Inquiry:QuestionAsset) — types.ts:712(字段名 question,非 text)
DEFINE TABLE IF NOT EXISTS question SCHEMAFULL;
DEFINE FIELD IF NOT EXISTS question     ON question TYPE string;
DEFINE FIELD IF NOT EXISTS whyImportant ON question TYPE string DEFAULT '';
DEFINE FIELD IF NOT EXISTS status       ON question TYPE string ASSERT $value IN ['开放','反复出现','正在聚焦','阶段性回答'];
DEFINE FIELD IF NOT EXISTS appearances  ON question TYPE int DEFAULT 0;
DEFINE FIELD IF NOT EXISTS updatedAt    ON question TYPE datetime DEFAULT time::now();

-- theme(Axis:LongTermTheme,反刚性聚合) — types.ts:758
DEFINE TABLE IF NOT EXISTS theme SCHEMAFULL;
DEFINE FIELD IF NOT EXISTS name                ON theme TYPE string;
DEFINE FIELD IF NOT EXISTS summary             ON theme TYPE string DEFAULT '';
DEFINE FIELD IF NOT EXISTS maturity            ON theme TYPE string ASSERT $value IN ['萌芽','重复','聚焦','成型','变化','关闭'];
DEFINE FIELD IF NOT EXISTS representativeQuote ON theme TYPE string DEFAULT '';
DEFINE FIELD IF NOT EXISTS appearances         ON theme TYPE int DEFAULT 0;
DEFINE FIELD IF NOT EXISTS updatedAt           ON theme TYPE datetime DEFAULT time::now();

-- memory(Memory:MemoryRecord) — types.ts:841(status=confirmed|deprecated|deleted;候选在 memory_candidate)
DEFINE TABLE IF NOT EXISTS memory SCHEMAFULL;
DEFINE FIELD IF NOT EXISTS text          ON memory TYPE string;
DEFINE FIELD IF NOT EXISTS status        ON memory TYPE string ASSERT $value IN ['confirmed','deprecated','deleted'];
DEFINE FIELD IF NOT EXISTS sourceType    ON memory TYPE string;
DEFINE FIELD IF NOT EXISTS sourceId      ON memory TYPE string;
DEFINE FIELD IF NOT EXISTS evidenceQuote ON memory TYPE string DEFAULT '';
DEFINE FIELD IF NOT EXISTS sensitivity   ON memory TYPE string DEFAULT 'normal' ASSERT $value IN ['normal','sensitive'];
DEFINE FIELD IF NOT EXISTS importance    ON memory TYPE option<int>;
DEFINE FIELD IF NOT EXISTS embedding     ON memory TYPE option<array<float>>;
DEFINE FIELD IF NOT EXISTS createdAt     ON memory TYPE datetime DEFAULT time::now();
DEFINE FIELD IF NOT EXISTS updatedAt     ON memory TYPE datetime DEFAULT time::now();

-- memory_candidate(Memory:MemoryCandidate) — types.ts:863
DEFINE TABLE IF NOT EXISTS memory_candidate SCHEMAFULL;
DEFINE FIELD IF NOT EXISTS text        ON memory_candidate TYPE string;
DEFINE FIELD IF NOT EXISTS status      ON memory_candidate TYPE string ASSERT $value IN ['pending','approved','rejected'];
DEFINE FIELD IF NOT EXISTS sourceType  ON memory_candidate TYPE string;
DEFINE FIELD IF NOT EXISTS sourceId    ON memory_candidate TYPE string;
DEFINE FIELD IF NOT EXISTS sensitivity ON memory_candidate TYPE string DEFAULT 'normal' ASSERT $value IN ['normal','sensitive'];
DEFINE FIELD IF NOT EXISTS reviewScore ON memory_candidate TYPE float DEFAULT 0;
DEFINE FIELD IF NOT EXISTS createdAt   ON memory_candidate TYPE datetime DEFAULT time::now();

-- material(External:ImportSource) — types.ts:1014(无 embedding!向量在 rag_chunk)
DEFINE TABLE IF NOT EXISTS material SCHEMAFULL;
DEFINE FIELD IF NOT EXISTS title       ON material TYPE string;
DEFINE FIELD IF NOT EXISTS sourceType  ON material TYPE string ASSERT $value IN ['text','webpage'];
DEFINE FIELD IF NOT EXISTS sourceUrl   ON material TYPE option<string>;
DEFINE FIELD IF NOT EXISTS content     ON material TYPE string;
DEFINE FIELD IF NOT EXISTS status      ON material TYPE string DEFAULT 'chunked' ASSERT $value IN ['chunked'];
DEFINE FIELD IF NOT EXISTS sensitivity ON material TYPE string DEFAULT 'normal' ASSERT $value IN ['normal','sensitive'];
DEFINE FIELD IF NOT EXISTS createdAt   ON material TYPE datetime DEFAULT time::now();

-- rag_chunk(External:RagChunk,派生、可重建) — types.ts:1030
DEFINE TABLE IF NOT EXISTS rag_chunk SCHEMAFULL;
DEFINE FIELD IF NOT EXISTS sourceId  ON rag_chunk TYPE string;
DEFINE FIELD IF NOT EXISTS title     ON rag_chunk TYPE string DEFAULT '';
DEFINE FIELD IF NOT EXISTS text      ON rag_chunk TYPE string;
DEFINE FIELD IF NOT EXISTS keywords  ON rag_chunk TYPE array<string> DEFAULT [];
DEFINE FIELD IF NOT EXISTS usage     ON rag_chunk TYPE string ASSERT $value IN ['interview-context','memory-candidate'];
DEFINE FIELD IF NOT EXISTS embedding ON rag_chunk TYPE option<array<float>>;
DEFINE FIELD IF NOT EXISTS createdAt ON rag_chunk TYPE datetime DEFAULT time::now();

-- search_brief(External:SearchBrief) — types.ts:971
DEFINE TABLE IF NOT EXISTS search_brief SCHEMAFULL;
DEFINE FIELD IF NOT EXISTS topic     ON search_brief TYPE string;
DEFINE FIELD IF NOT EXISTS provider  ON search_brief TYPE string;
DEFINE FIELD IF NOT EXISTS status    ON search_brief TYPE string ASSERT $value IN ['ready','needs-review'];
DEFINE FIELD IF NOT EXISTS summary   ON search_brief TYPE string DEFAULT '';
DEFINE FIELD IF NOT EXISTS createdAt ON search_brief TYPE datetime DEFAULT time::now();

-- 种子:kind → 父类(UPSERT 幂等)
UPSERT entity_kind:session          SET parent = 'Container';
UPSERT entity_kind:turn             SET parent = 'Utterance';
UPSERT entity_kind:note             SET parent = 'Distillation';
UPSERT entity_kind:point            SET parent = 'Distillation';
UPSERT entity_kind:decision         SET parent = 'Distillation';
UPSERT entity_kind:debt             SET parent = 'Distillation';
UPSERT entity_kind:question         SET parent = 'Inquiry';
UPSERT entity_kind:theme            SET parent = 'Axis';
UPSERT entity_kind:memory           SET parent = 'Memory';
UPSERT entity_kind:memory_candidate SET parent = 'Memory';
UPSERT entity_kind:material         SET parent = 'External';
UPSERT entity_kind:rag_chunk        SET parent = 'External';
UPSERT entity_kind:search_brief     SET parent = 'External';
