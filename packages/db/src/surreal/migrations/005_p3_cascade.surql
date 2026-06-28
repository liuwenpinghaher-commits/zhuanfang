-- P3 · A5 删除级联(根除孤儿,spec 03 §2-A5)。本次最大收益:把"删会话留孤儿 turn""删素材留孤儿块"
-- 这一整类跨库一致性 bug,从"应用层每处记得 deleteBySource"变成"数据库不可能留下孤儿"。
--
-- ── spike 选型(EVENT vs record-references,实测 @surrealdb/node@3.0.3 = SurrealDB 3.0.2)──
-- 实测结论(三个 spike):
--   1) SurrealDB 3.x **原生**在删除节点时自动移除以它为端点(in/out)的 RELATE 图边——
--      删 turn → 其 part_of / derived_from 边自动消失;删 point → 其 belongs_to_theme 边自动消失。
--      故"孤儿 RELATE 边"这一类在 3.x 已**不可能**存在,无需任何 EVENT/references。
--   2) 真正的孤儿来源是**用普通 string 外键(非图边)关联的子记录**:
--        turn.sessionId(= session id 字符串)、note.sessionId、rag_chunk.sourceId(= material id 字符串)。
--      删父节点时,这些子记录**不会**被自动清(它们不是图边)。
--   3) record-references(`TYPE record<..> REFERENCE ON DELETE CASCADE`)虽被本 build 支持,但要求把
--      turn.sessionId 等字段从 `string` 改成 `record<session>`,会破坏现有 node-mapper/toRecord 的
--      string 往返 + H1(turn append-only)契约,改动面大。
-- → **选 DEFINE EVENT on DELETE**:零字段类型改动、零 persist/diff 逻辑改动,只在父节点真被 DELETE 时
--   触发清其 string-FK 子记录;清子记录又会级联触发 ①(子记录的图边自动消失)。与现有
--   `DEFINE TABLE ... TYPE RELATION ENFORCED`(002)风格一致。已实测在 persist 的
--   `BEGIN; DELETE session WHERE id IN $del; COMMIT;` 事务里正确触发。
--
-- 与 H1(turn 是 append-only 冷层)不冲突:降冷(offloadCompletedSession)只从内存 state 剥
-- session.turns,session 节点仍在 DB → 不发 session DELETE → EVENT 不触发 → turn 节点保留。
-- 只有**真正删除 session**(隐私清除/purge)才发 DELETE → 此时确实要连根清掉它的 turn,正是本意。
-- applySchema 账本(_migration)保证本文件只跑一次;DEFINE EVENT IF NOT EXISTS 双层幂等。

-- 删 session → 清其 turn(turn.sessionId) + note(note.sessionId)。
-- meta::id($value.id) 把 session:⟨id⟩ 还原成裸 id 字符串,与子表存的 string 外键比较。
DEFINE EVENT IF NOT EXISTS cascade_session_delete ON session WHEN $event = 'DELETE' THEN {
  DELETE turn WHERE sessionId = meta::id($value.id);
  DELETE note WHERE sessionId = meta::id($value.id);
};

-- 删 material(ImportSource)→ 清其派生 rag_chunk(rag_chunk.sourceId = material id)。
-- 派生块可重建,删素材即应清其索引块,否则成孤儿块继续被召回(= 删除未生效)。
DEFINE EVENT IF NOT EXISTS cascade_material_delete ON material WHEN $event = 'DELETE' THEN {
  DELETE rag_chunk WHERE sourceId = meta::id($value.id);
};
