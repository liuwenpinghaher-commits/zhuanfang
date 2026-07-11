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
--
-- P3-13(已知,记档不扩修):本级联【不】触及冷层 raw_material / audio(它们是独立冷层表,
-- 按 sessionId 字符串关联)。故"整包 PUT 移除某 session"触发 session DELETE 时,turn 被级联清、
-- 但该 session 的 raw_material / audio 冷层行会成为孤儿。当前可接受:① 无"单删某会话"的产品入口
-- (删会话只经 reset/purge,而 purge 会全量清冷层三库);② 孤儿只占空间、不构成隐私召回面(逐字稿
-- turn 已删)。⚠️ 未来若新增"单删/归档单个会话"功能,必须同步删该 session 的冷层 raw_material/audio
-- (级联无法覆盖跨表字符串外键,须在删除路径显式调冷层 deleteBySession),否则孤儿原声/逐字稿残留。
REMOVE EVENT IF EXISTS cascade_session_delete ON TABLE session;
DEFINE EVENT IF NOT EXISTS cascade_session_delete ON session WHEN $event = 'DELETE' THEN {
  DELETE turn WHERE sessionId = meta::id($value.id);
};
