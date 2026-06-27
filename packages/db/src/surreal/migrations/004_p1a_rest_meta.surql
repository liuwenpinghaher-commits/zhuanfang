-- P1a · 给 12 本体表 + turn 加 rest(FLEXIBLE object) 兜全字段(无损往返);新增 state_meta 存运维尾巴 + revision。
-- 3.x:object 字段写 `TYPE object FLEXIBLE`。applySchema 账本保证只跑一次。
-- DEFAULT {} 确保不写 rest 的 SET 操作不触发 "Expected object but found NONE"。
DEFINE FIELD IF NOT EXISTS rest ON session          TYPE object FLEXIBLE DEFAULT {};
DEFINE FIELD IF NOT EXISTS rest ON turn             TYPE object FLEXIBLE DEFAULT {};
DEFINE FIELD IF NOT EXISTS rest ON note             TYPE object FLEXIBLE DEFAULT {};
DEFINE FIELD IF NOT EXISTS rest ON point            TYPE object FLEXIBLE DEFAULT {};
DEFINE FIELD IF NOT EXISTS rest ON decision         TYPE object FLEXIBLE DEFAULT {};
DEFINE FIELD IF NOT EXISTS rest ON debt             TYPE object FLEXIBLE DEFAULT {};
DEFINE FIELD IF NOT EXISTS rest ON question         TYPE object FLEXIBLE DEFAULT {};
DEFINE FIELD IF NOT EXISTS rest ON theme            TYPE object FLEXIBLE DEFAULT {};
DEFINE FIELD IF NOT EXISTS rest ON memory           TYPE object FLEXIBLE DEFAULT {};
DEFINE FIELD IF NOT EXISTS rest ON memory_candidate TYPE object FLEXIBLE DEFAULT {};
DEFINE FIELD IF NOT EXISTS rest ON material         TYPE object FLEXIBLE DEFAULT {};
DEFINE FIELD IF NOT EXISTS rest ON rag_chunk        TYPE object FLEXIBLE DEFAULT {};
DEFINE FIELD IF NOT EXISTS rest ON search_brief     TYPE object FLEXIBLE DEFAULT {};

-- 整状态元:revision(乐观锁) + rest(运维尾巴:profile/systemConfig/审计/配置/chat/corpus/... + schemaVersion)
DEFINE TABLE IF NOT EXISTS state_meta SCHEMAFULL;
DEFINE FIELD IF NOT EXISTS revision ON state_meta TYPE int DEFAULT 0;
DEFINE FIELD IF NOT EXISTS rest     ON state_meta TYPE object FLEXIBLE;
