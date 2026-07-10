-- R1a · 消灭 state_meta blob(前半):11 类非流水实体真表化(方案 2026-07-10 §4 R1)。
-- 流水 4 类(audit_event/ai_run_event/workflow_run/operational_check)留待 R1b,仍在 state_meta.rest。
-- 风格沿用 001:SCHEMAFULL 核心列 + ASSERT 枚举;rest FLEXIBLE 兜全字段(同 004 模式)。
-- 枚举 ASSERT 白名单与 src/domain/storage.ts clampPersistableEnums 的 R1a 钳制逐一对齐(fail-closed 一致,
-- 防"normalize 放行、schema 拒写"的 wedge 裂缝)。
-- 历史数据不迁移(用户决策 2026-07-10):apply 后旧 state_meta.rest 里残留的同名键是死数据,
-- loadState 一律以表数据为准并忽略 blob 残留(见 surreal-product-state-repository.ts loadState)。

-- profile(单例:profile:main)— types.ts:97 UserProfile。
-- 单例的价值是"离开 blob、可独立读写",内容整体作 FLEXIBLE object,不过度拆列。
DEFINE TABLE IF NOT EXISTS profile SCHEMAFULL;
DEFINE FIELD IF NOT EXISTS data ON profile TYPE object FLEXIBLE DEFAULT {};

-- system_config(单例:system_config:main)— types.ts:29 SystemConfig。同 profile 模式。
DEFINE TABLE IF NOT EXISTS system_config SCHEMAFULL;
DEFINE FIELD IF NOT EXISTS data ON system_config TYPE object FLEXIBLE DEFAULT {};

-- profile_suggestion(ProfileSuggestion) — types.ts:173
-- field 刻意不 ASSERT:钳制坏 field 到任一合法画像列是 fail-open(approve 会写错列),故保持
-- TYPE string 原样落库;非法 field 由域层 approveProfileSuggestion 的白名单守卫真拒绝
-- (置 rejected + 警示审计,画像不动,见 src/domain/profile.ts PROFILE_SUGGESTION_FIELDS)。
DEFINE TABLE IF NOT EXISTS profile_suggestion SCHEMAFULL;
DEFINE FIELD IF NOT EXISTS field           ON profile_suggestion TYPE string;
DEFINE FIELD IF NOT EXISTS currentValue    ON profile_suggestion TYPE string DEFAULT '';
DEFINE FIELD IF NOT EXISTS suggestedValue  ON profile_suggestion TYPE string DEFAULT '';
DEFINE FIELD IF NOT EXISTS sourceSessionId ON profile_suggestion TYPE string DEFAULT '';
DEFINE FIELD IF NOT EXISTS status          ON profile_suggestion TYPE string ASSERT $value IN ['pending','approved','rejected'];
DEFINE FIELD IF NOT EXISTS createdAt       ON profile_suggestion TYPE datetime DEFAULT time::now();
DEFINE FIELD IF NOT EXISTS rest            ON profile_suggestion TYPE object FLEXIBLE DEFAULT {};

-- interview_annotation(InterviewAnnotation) — types.ts:112
DEFINE TABLE IF NOT EXISTS interview_annotation SCHEMAFULL;
DEFINE FIELD IF NOT EXISTS sessionId ON interview_annotation TYPE string;
DEFINE FIELD IF NOT EXISTS turnId    ON interview_annotation TYPE string;
DEFINE FIELD IF NOT EXISTS text      ON interview_annotation TYPE string;
DEFINE FIELD IF NOT EXISTS createdAt ON interview_annotation TYPE datetime DEFAULT time::now();
DEFINE FIELD IF NOT EXISTS rest      ON interview_annotation TYPE object FLEXIBLE DEFAULT {};

-- chat_session(ChatSession) — types.ts:162(messages 整体进 rest,整段读写无需拆列)
DEFINE TABLE IF NOT EXISTS chat_session SCHEMAFULL;
DEFINE FIELD IF NOT EXISTS title     ON chat_session TYPE string;
DEFINE FIELD IF NOT EXISTS createdAt ON chat_session TYPE datetime DEFAULT time::now();
DEFINE FIELD IF NOT EXISTS updatedAt ON chat_session TYPE datetime DEFAULT time::now();
DEFINE FIELD IF NOT EXISTS rest      ON chat_session TYPE object FLEXIBLE DEFAULT {};

-- memory_correction(MemoryCorrection) — types.ts:875
DEFINE TABLE IF NOT EXISTS memory_correction SCHEMAFULL;
DEFINE FIELD IF NOT EXISTS text      ON memory_correction TYPE string;
DEFINE FIELD IF NOT EXISTS createdAt ON memory_correction TYPE datetime DEFAULT time::now();
DEFINE FIELD IF NOT EXISTS rest      ON memory_correction TYPE object FLEXIBLE DEFAULT {};

-- podcast_episode(PodcastEpisode) — types.ts:1111(script/chapters/audioUrl 等进 rest)。
-- sourceType/sourceId 是 optional 列,不 ASSERT:normalize 的 optStr 只钳**类型**坏值
-- (null/数字 → 缺省不落列),超出 4 值联合的 string 会原样落库——展示性来源标签,
-- 不构成 wedge(option<string> 接受任意 string)也不放大权限,接受此宽松度。
DEFINE TABLE IF NOT EXISTS podcast_episode SCHEMAFULL;
DEFINE FIELD IF NOT EXISTS noteId             ON podcast_episode TYPE string;
DEFINE FIELD IF NOT EXISTS title              ON podcast_episode TYPE string;
DEFINE FIELD IF NOT EXISTS format             ON podcast_episode TYPE string ASSERT $value IN ['solo','host-guest'];
DEFINE FIELD IF NOT EXISTS voice              ON podcast_episode TYPE string;
DEFINE FIELD IF NOT EXISTS status             ON podcast_episode TYPE string ASSERT $value IN ['draft','generating','ready'];
DEFINE FIELD IF NOT EXISTS scriptReviewStatus ON podcast_episode TYPE string ASSERT $value IN ['待确认','用户确认'];
DEFINE FIELD IF NOT EXISTS sourceType         ON podcast_episode TYPE option<string>;
DEFINE FIELD IF NOT EXISTS sourceId           ON podcast_episode TYPE option<string>;
DEFINE FIELD IF NOT EXISTS createdAt          ON podcast_episode TYPE datetime DEFAULT time::now();
DEFINE FIELD IF NOT EXISTS rest               ON podcast_episode TYPE object FLEXIBLE DEFAULT {};

-- corpus_import(CorpusImport) — types.ts:1183(turns 进 rest)
DEFINE TABLE IF NOT EXISTS corpus_import SCHEMAFULL;
DEFINE FIELD IF NOT EXISTS title     ON corpus_import TYPE string;
DEFINE FIELD IF NOT EXISTS mediaType ON corpus_import TYPE string ASSERT $value IN ['text','audio'];
DEFINE FIELD IF NOT EXISTS content   ON corpus_import TYPE string;
DEFINE FIELD IF NOT EXISTS sourceUrl ON corpus_import TYPE option<string>;
DEFINE FIELD IF NOT EXISTS status    ON corpus_import TYPE string DEFAULT 'analyzed' ASSERT $value IN ['analyzed'];
DEFINE FIELD IF NOT EXISTS createdAt ON corpus_import TYPE datetime DEFAULT time::now();
DEFINE FIELD IF NOT EXISTS rest      ON corpus_import TYPE object FLEXIBLE DEFAULT {};

-- corpus_insight(CorpusInsight) — types.ts:1233(dimensions/improvementPlan/recommendedPatches 进 rest)
DEFINE TABLE IF NOT EXISTS corpus_insight SCHEMAFULL;
DEFINE FIELD IF NOT EXISTS importId  ON corpus_insight TYPE string;
DEFINE FIELD IF NOT EXISTS title     ON corpus_insight TYPE string;
DEFINE FIELD IF NOT EXISTS createdAt ON corpus_insight TYPE datetime DEFAULT time::now();
DEFINE FIELD IF NOT EXISTS rest      ON corpus_insight TYPE object FLEXIBLE DEFAULT {};

-- playbook_patch(PlaybookPatch) — types.ts:1210(rules/ruleTypes 位置对齐,整体进 rest)
DEFINE TABLE IF NOT EXISTS playbook_patch SCHEMAFULL;
DEFINE FIELD IF NOT EXISTS title           ON playbook_patch TYPE string;
DEFINE FIELD IF NOT EXISTS sourceInsightId ON playbook_patch TYPE string DEFAULT '';
DEFINE FIELD IF NOT EXISTS sourceImportId  ON playbook_patch TYPE option<string>;
DEFINE FIELD IF NOT EXISTS status          ON playbook_patch TYPE string ASSERT $value IN ['proposed','applied','reverted'];
DEFINE FIELD IF NOT EXISTS impact          ON playbook_patch TYPE string ASSERT $value IN ['low','medium','high'];
DEFINE FIELD IF NOT EXISTS createdAt       ON playbook_patch TYPE datetime DEFAULT time::now();
DEFINE FIELD IF NOT EXISTS rest            ON playbook_patch TYPE object FLEXIBLE DEFAULT {};

-- config_version(ConfigVersion) — types.ts:74(diff/affectedSessions/snapshot 进 rest)
DEFINE TABLE IF NOT EXISTS config_version SCHEMAFULL;
DEFINE FIELD IF NOT EXISTS version   ON config_version TYPE string;
DEFINE FIELD IF NOT EXISTS changedBy ON config_version TYPE string ASSERT $value IN ['user','system'];
DEFINE FIELD IF NOT EXISTS reason    ON config_version TYPE string DEFAULT '';
DEFINE FIELD IF NOT EXISTS active    ON config_version TYPE bool DEFAULT false;
DEFINE FIELD IF NOT EXISTS createdAt ON config_version TYPE datetime DEFAULT time::now();
DEFINE FIELD IF NOT EXISTS rest      ON config_version TYPE object FLEXIBLE DEFAULT {};

-- 注:R1a 实体是运维/产品记录,非认知本体(Container/Distillation/...家族),刻意不入 entity_kind
-- 分类表(治理/召回按父类批量遍历只覆盖认知实体)。
