-- R1b · 消灭 state_meta blob(后半):4 类流水实体真表化为 append-only 事件流表
-- (方案 2026-07-10 §4 R1;R1a=007 已迁 11 类非流水实体)。
--
-- 记录 id 用复合数组:`audit_event:[<时间戳 ISO>, <领域 id>]`(四表同构,时间戳字段见各表注释)
-- —— record range 天然按时间有序,支持 `table:[cutoff]..` 范围删除(保留期清理)与按时间段分页,
-- 零索引(record-ids-and-addressing.md 复合 ID 分区模式)。写侧构造见 streamRecordIdOf()。
--
-- append-only 语义:persist 只 UPSERT 新增/变更,内存滚动窗(MAX_EVENT_LOG=1000)滑出的条目
-- **绝不 DELETE**(照 turn 表 H1 模式)——DB 保全史、内存只保窗口;无限增长由启动时的
-- 保留期清理(EVENT_STREAM_RETENTION_DAYS)兜住。治理操作(reset/purge/import)例外:
-- 显式清除,隐私优先于保全史(与 turn 被 A5 级联清除同口径),见 persist 的流水段注释。
--
-- ⚠️ 刻意不加 CHANGEFEED:R0 实测 @surrealdb/node 3.0.3(SurrealDB 3.0.2)定义 CHANGEFEED 的表
-- 每笔写会向 stderr 打十几行 dbg! 调试噪声——R5(增量同步)启用前需先评估/升级 SDK 再补
-- `CHANGEFEED 7d`。COUNT 索引同样后置到 R4(读路径物化阶段统一做)。
--
-- 枚举 ASSERT 与 src/domain/storage.ts clampPersistableEnums 的 R1b 钳制逐一对齐(fail-closed
-- 一致,防"normalize 放行、schema 拒写"的 wedge 裂缝)。type/entityType/workflow/providerId/kind
-- 这类**宽面、随功能演进高频扩充**的枚举刻意不 ASSERT(否则每加一个事件类型都是一次 schema
-- 迁移,漏了就 wedge;它们是展示/归类标签,坏值不放大权限)——只保证 TYPE string(钳制 str() 兜底)。
-- 历史数据不迁移(用户决策 2026-07-10):旧 state_meta.rest 里的流水键残留是死数据,
-- loadState 一律以表数据为准(见 surreal-product-state-repository.ts loadState)。

-- audit_event(AuditEvent)— types.ts:352;时间戳=createdAt。
DEFINE TABLE IF NOT EXISTS audit_event SCHEMAFULL;
DEFINE FIELD IF NOT EXISTS type       ON audit_event TYPE string;
DEFINE FIELD IF NOT EXISTS label      ON audit_event TYPE string;
DEFINE FIELD IF NOT EXISTS detail     ON audit_event TYPE string;
-- severity 坏值钳到 warning:既不虚报 critical(假警报)也不降为 info(掩盖问题)。
DEFINE FIELD IF NOT EXISTS severity   ON audit_event TYPE string ASSERT $value IN ['info','warning','critical'];
DEFINE FIELD IF NOT EXISTS entityType ON audit_event TYPE string;
DEFINE FIELD IF NOT EXISTS entityId   ON audit_event TYPE string;
DEFINE FIELD IF NOT EXISTS createdAt  ON audit_event TYPE datetime DEFAULT time::now();
DEFINE FIELD IF NOT EXISTS rest       ON audit_event TYPE object FLEXIBLE DEFAULT {};

-- ai_run_event(AiRunEvent)— types.ts:413;时间戳=createdAt(workflowRunId/latencyMs/metrics 进 rest)。
DEFINE TABLE IF NOT EXISTS ai_run_event SCHEMAFULL;
DEFINE FIELD IF NOT EXISTS workflow      ON ai_run_event TYPE string;
DEFINE FIELD IF NOT EXISTS providerId    ON ai_run_event TYPE string;
-- status 坏值钳到 failed:坏数据绝不冒充 succeeded(质量报告/健康统计会误读)。
DEFINE FIELD IF NOT EXISTS status        ON ai_run_event TYPE string ASSERT $value IN ['succeeded','degraded','failed'];
DEFINE FIELD IF NOT EXISTS entityType    ON ai_run_event TYPE string;
DEFINE FIELD IF NOT EXISTS entityId      ON ai_run_event TYPE string;
DEFINE FIELD IF NOT EXISTS inputSummary  ON ai_run_event TYPE string;
DEFINE FIELD IF NOT EXISTS outputSummary ON ai_run_event TYPE string;
DEFINE FIELD IF NOT EXISTS createdAt     ON ai_run_event TYPE datetime DEFAULT time::now();
DEFINE FIELD IF NOT EXISTS rest          ON ai_run_event TYPE object FLEXIBLE DEFAULT {};

-- workflow_run(WorkflowRun)— types.ts:458;时间戳=startedAt(不可变,复合 id 的稳定前提;
-- completedAt/latencyMs/metadata 进 rest)。同 id 的状态更新(queued→running→succeeded)映射到
-- 同一复合 id 的 UPSERT 覆盖。
DEFINE TABLE IF NOT EXISTS workflow_run SCHEMAFULL;
DEFINE FIELD IF NOT EXISTS workflow      ON workflow_run TYPE string;
-- status 坏值钳到 failed(绝不冒充 succeeded/running)。
DEFINE FIELD IF NOT EXISTS status        ON workflow_run TYPE string ASSERT $value IN ['queued','running','succeeded','degraded','failed'];
DEFINE FIELD IF NOT EXISTS providerId    ON workflow_run TYPE string;
DEFINE FIELD IF NOT EXISTS entityType    ON workflow_run TYPE string;
DEFINE FIELD IF NOT EXISTS entityId      ON workflow_run TYPE string;
DEFINE FIELD IF NOT EXISTS inputSummary  ON workflow_run TYPE string;
DEFINE FIELD IF NOT EXISTS outputSummary ON workflow_run TYPE string;
DEFINE FIELD IF NOT EXISTS traceId       ON workflow_run TYPE string;
DEFINE FIELD IF NOT EXISTS startedAt     ON workflow_run TYPE datetime DEFAULT time::now();
DEFINE FIELD IF NOT EXISTS rest          ON workflow_run TYPE object FLEXIBLE DEFAULT {};

-- operational_check(OperationalCheckEvidence)— types.ts:478;时间戳=checkedAt
-- (summary/requiredEnv/generatedAt/metadata 进 rest)。当前无代码产出此类记录(privacy.ts 同注),
-- 建表是为分区完整性:一旦产出即走真表,不再回流 blob。内存侧无滚动窗钳制(storage.ts 不 slice),
-- 故 loadState 全量读、窗口滑出判定恒为治理清除(见 STREAM_MAPPINGS.window 注释)。
-- kind 同上述宽面枚举口径不 ASSERT(运维检查种类会随工具演进扩充)。
DEFINE TABLE IF NOT EXISTS operational_check SCHEMAFULL;
DEFINE FIELD IF NOT EXISTS kind      ON operational_check TYPE string;
DEFINE FIELD IF NOT EXISTS label     ON operational_check TYPE string;
-- status 坏值钳到 failed(绝不冒充 passed)。
DEFINE FIELD IF NOT EXISTS status    ON operational_check TYPE string ASSERT $value IN ['passed','failed','skipped'];
DEFINE FIELD IF NOT EXISTS detail    ON operational_check TYPE string;
DEFINE FIELD IF NOT EXISTS checkedAt ON operational_check TYPE datetime DEFAULT time::now();
DEFINE FIELD IF NOT EXISTS rest      ON operational_check TYPE object FLEXIBLE DEFAULT {};

-- 注:同 R1a——流水是运维记录,非认知本体,不入 entity_kind 分类表;
-- 也同 turn 一样豁免图审计的节点核对(append-only 下 DB 合法多于内存窗口)。
