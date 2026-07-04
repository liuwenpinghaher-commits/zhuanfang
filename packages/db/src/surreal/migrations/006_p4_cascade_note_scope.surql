-- P4 · A5 级联范围收缩(全系统审查 P0-1 根修)。
--
-- 背景:005 的 cascade_session_delete 同时级联删 turn + note。真实审查实测发现该设计与
-- 域层语义冲突:note(蒸馏资产)在产品语义上可脱离 session 独立存在(种子数据 note-seed-1
-- 即无对应 session;purge interviews 由域层成对删除 sessions+notes,不依赖本级联)。
-- 冲突后果:任何"删 session 而 hot 仍持有其 note"的合法状态(手工 PUT/备份导入),级联会在
-- persist 事务内静默删掉 DB 的 note 行,而事务成功、diff 基线照常推进 → 内存/sqlite/surreal
-- 三份真相静默发散,重启即丢 note(审查实测:图审计 missing=1 抓到)。
--
-- 修复:session 级联只保留 turn(隐私核心=逐字稿,且 H1 append-only 需要它在真删除时清理);
-- note 生命周期完全交还域层(purge/删除路径本就成对处理)。3.x 无 DEFINE EVENT OVERWRITE
-- 的普遍保证,用 REMOVE + 重新 DEFINE;applySchema 账本保证本文件只跑一次,IF EXISTS 幂等。
REMOVE EVENT IF EXISTS cascade_session_delete ON TABLE session;
DEFINE EVENT IF NOT EXISTS cascade_session_delete ON session WHEN $event = 'DELETE' THEN {
  DELETE turn WHERE sessionId = meta::id($value.id);
};
