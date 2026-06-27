# SurrealDB × 本体论 · 03 公理引擎与 DB 约束(A1–A5)

- 日期:2026-06-27 · 前置:[00](2026-06-27-surreal-ontology-00-总纲与决策.md)、[01](2026-06-27-surreal-ontology-01-数据建模.md)、[02](2026-06-27-surreal-ontology-02-repository-绞杀者迁移.md)
- 阶段 P3:把 [ontology/01 §5.4](../../ontology/01-本体论重构总纲-理论与实践.md) 的公理 A1–A5 从"散落手写"提升为 **DB 强制(能强制的)+ 域层确定性校验器(其余)**。理论:CWA + SHACL 式校验,不引入 OWL reasoner(决策 D5/D6)。

---

## 1. 分工原则:DB 强制 vs 纯函数校验器

| 公理类型 | 落点 | 理由 |
|---|---|---|
| 引用完整性(删除级联) | **DB 强制**(record-references / EVENT) | 最可靠、跨进程一致,根治孤儿 |
| 字段域/枚举/基数 | **DB 强制**(`ASSERT`) | 写入即拦,不依赖应用记得 |
| 语义/跨实体推导(成熟度、矛盾、HITL 门控) | **域层确定性纯函数校验器** `axioms.check(state)` | 可测、可调试、可解释;SHACL 式(CWA,01 §4.9) |

> 现状:A1–A4 散落在 finalize / context-pack / knowledge 各写一遍、容易漏(系统审查里大半 bug 是"某条链路漏了某条规则")。**公理化 = 写一处,统一兜底。**

---

## 2. 逐条公理落地

### A1 · 每个 Distillation ≥1 条 `derived_from`(无溯源=幻觉)
- 现状:finalize 各处手写。新近修复(`finalize-llm` 主题归属)正是这类"散落规则"。
- 落地:**域层校验器**(写入边集后检查每个 Distillation 节点的 `->derived_from->` 出度≥1);违例 → 标记/拒收 + 记审计。DB 侧可加 `DEFINE EVENT` 巡检告警(非阻塞)。
```surql
-- 巡检事件(非阻塞,记审计):新增 distillation 节点若无 derived_from 出边,写一条 audit
DEFINE EVENT a1_orphan ON point WHEN $event='CREATE' THEN {
  IF count(SELECT 1 FROM ->derived_from) = 0 { CREATE audit SET kind='a1_no_provenance', node=$value.id; }
};
```

### A2 · `Theme.maturity ≤ f(belongs_to_theme 边数)`(涌现属性,01 §4.7)
- 现状:`clampMaturityByAppearances`(域层)。
- 落地:**保留域层纯函数推导**(maturity 由入边数封顶);可由 `DEFINE EVENT` 在边增删时重算 `theme.maturity`(确定性,不调 LLM)。

### A3 · `provenance.origin='llm_extracted'` 未经 `user_confirmed` 不得呈现为"事实"(HITL 门控)
- 现状:HITL 各链路手写。
- 落地:**域层校验器**按 `provenance.origin` 统一门控召回/呈现(对齐现 `context-pack` 的 `status==='confirmed'` 过滤)。这是查询期过滤,不是写入拦截。

### A4 · `sensitivity='sensitive'` 的 Memory 不产生进入 chat 索引的派生边(除非 policy 开)
- 现状:`buildKnowledgeChunks` 的 sensitivity 过滤(近期修复又补了 status 过滤)。
- 落地:派生 `rag_chunk`/索引边时,按 `memory.sensitivity` + policy 过滤(查询期 + 派生期双重)。原生图下,"不建派生边"即天然不被召回遍历命中。

### A5 · 删除任一 EntityNode → 出入边级联删(根除孤儿)—— **本次最大收益**
- 现状:**应用层 reindex 兜底**(`reindexOnStateChange` 的 removed 分支 deleteBySource);跨库一致性靠应用记得。
- 落地:**DB 强制级联**。两条路径(实现时 spike 选稳定者):
  1. **record-references + `ON DELETE CASCADE`**:节点间引用声明级联,删节点自动清引用记录。
  2. **`DEFINE EVENT` on DELETE**:删节点触发清其所有 `RELATE` 边。
```surql
-- 方案2示例:删 session → 清其 turn 及指向它们的边
DEFINE EVENT cascade_session ON session WHEN $event='DELETE' THEN {
  DELETE turn WHERE sessionId = meta::id($value.id);
  -- RELATE 边:删端点后悬挂边由 references 或巡检清
};
```
> A5 落 DB 后,02 §6 / 当前审查里"删会话留孤儿""删素材留孤儿块"这一整类跨库一致性 bug 从"应用层每处记得"变成"数据库不可能留下孤儿"。

---

## 3. 统一校验器 `axioms.check(state)`(SHACL 式,CWA)

```ts
// 域层纯函数:封闭世界、报违例(不推新事实)。在写路径后/巡检时跑。
function checkAxioms(state: ProductState, graph: OntologyView): AxiomViolation[] {
  return [
    ...checkA1_provenance(state, graph),   // 每个 Distillation 有 derived_from
    ...checkA2_maturity(state, graph),     // maturity ≤ f(入边)
    ...checkA3_hitl(state),                // llm_extracted 未确认不当事实
    ...checkA4_sensitive(state),           // 敏感记忆不进公开召回
    // A5 由 DB 强制,这里只做事后审计核对
  ];
}
```
- 违例 → 记 `auditEvent` / 必要时拦截(对齐现 `withAuditEvent`)。
- 与现有散落规则的关系:P3 期把 finalize/context-pack/knowledge 里的散落检查**收敛**到此处一份,逐处替换为调用 `checkAxioms`,删重复。

---

## 4. P3 动手清单(TDD)

- [ ] T1 `checkA1_provenance`:构造无 derived_from 的 point → 违例;有则放行。
- [ ] T2 A5 DB 级联:删 session → 其 turn + 出入边全清,`SELECT` 无孤儿(spike 选 references vs EVENT,锁定其一)。
- [ ] T3 `checkA3_hitl`:`llm_extracted` 未确认记忆不进召回上下文(对齐 context-pack 现行为,回归)。
- [ ] T4 `checkA4_sensitive`:敏感记忆默认不建/不召回 chat 索引边;policy 开则进(回归近期修复)。
- [ ] T5 `checkA2_maturity`:单次深对话 theme 入边=1 → maturity 被钳到"萌芽";多边才升级。
- [ ] T6 收敛:finalize/context-pack/knowledge 三处散落规则替换为统一 `checkAxioms`,删重复,全测试绿。

> 验收:A1–A5 一处定义、统一兜底;A5 由 DB 强制,删除无孤儿;散落规则收敛;违例可审计。
