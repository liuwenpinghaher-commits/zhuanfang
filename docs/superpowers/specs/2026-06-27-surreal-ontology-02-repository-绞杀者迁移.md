# SurrealDB × 本体论 · 02 repository 绞杀者迁移

- 日期:2026-06-27 · 前置:[00](2026-06-27-surreal-ontology-00-总纲与决策.md)、[01 数据建模](2026-06-27-surreal-ontology-01-数据建模.md)
- 阶段 P1:在 `ProductStateRepository` 接口后实现 `SurrealStore`,整状态 ⇄ 节点/边双向映射;双写/影子读逐步切换。**域层 148 纯函数与 960 测试不动。**

---

## 1. 绞杀点:现有注入边界

`apps/api/src/product-state-repository.ts:29`:
```ts
export interface ProductStateRepository {
  getState(): ProductState;
  replaceState(state: ProductState, opts?: ReplaceStateOptions): ProductState; // opts.expectedRevision 乐观锁
}
```
- 域层所有 `(state)=>state` 纯函数只经此接口读写;不知底层是 SQLite 还是 SurrealDB。
- 现有实现:`createSqliteProductStateRepository`(整 blob + revision)、`createInMemory...`(测试);并被 `withKnowledgeReindex` 包裹(`server.ts:143`)做派生索引增量。
- **绞杀目标**:新增 `createSurrealProductStateRepository` 实现同接口;`server.ts` 按 env 注入;其余一切不变。

---

## 2. 映射:ProductState ⇄ 节点 + 边

`SurrealStore` 内部承担双向映射:

### 2.1 读(getState):节点/边 → ProductState
```
SELECT * FROM point/decision/theme/...      → state.points/decisions/themes/...(节点表 → 各数组)
SELECT ->belongs_to_theme->theme FROM ...    → 回填 relatedThemeIds[](或新 relations[],见 §6)
SELECT ->derived_from->turn ...              → 回填 evidenceAnchors / provenance
```
- 整状态在内存重建为 `ProductState`,域层照常工作。
- 大体量冷层(turn 逐字稿)不进热状态(对齐现冷热分层),按需 `getRawMaterial` 查 `turn` 表。

### 2.2 写(replaceState):ProductState → 节点/边(按 diff,只改变更)
- **不全量重写整图**(那会很贵)。复用现 `diffIndexableSources`(`src/domain/knowledge.ts`)的思路:比对 prev/next 的可索引数组,只对**变更/删除**的实体/边做 upsert / `DELETE`。
- 单一落库点 + 事务:所有写经一个 `_executeWrite`(SurrealQL 事务 `BEGIN/COMMIT`),保不变量(参照 scribe3 SurrealStore 的"改世界状态只经单一落库点")。
- 乐观锁:整库存一个 `state_meta:main { revision }`;`replaceState(opts.expectedRevision)` 在事务内校验 revision,不符抛 `StateRevisionConflictError`(语义与现 SQLite 实现一致)。

---

## 3. diff-upsert 草案

```ts
function applyStateDiff(prev: ProductState, next: ProductState, db): void {
  // 节点:每个可索引数组逐条 id 配对
  for (const arr of DIFFABLE_NODE_ARRAYS) {        // points/decisions/themes/notes/memoryRecords/...
    const {added, changed, removed} = diffById(prev[arr.key], next[arr.key]);
    for (const e of [...added, ...changed]) db.upsert(arr.table, e.id, toRecord(e));
    for (const e of removed) db.delete(arr.table, e.id);   // 出入边由 DB 级联清(A5,spec 03)
  }
  // 边:把 next 的 EvidenceAnchor/relatedThemeIds/MemoryEdge 投影成期望边集,与库现有边做集合差,RELATE/DELETE 增量
  reconcileEdges(prev, next, db);
}
```
- `reconcileEdges` 复用 [02 三元组篇 §6](../../ontology/02-三元组与图模型.md) 的 `collectRelations` 投影逻辑,把三套旧编码 → 期望 `Relation[]`,与库现有边对账。
- P1 期:旧字段(EvidenceAnchor 等)**保留并存**;映射双向(读时从边回填旧字段,写时从旧字段投影成边)。P2 末下游切到图后再删旧字段。

---

## 4. 双写 / 影子读(安全切换)

| 子阶段 | 写 | 读(权威) | 校验 |
|---|---|---|---|
| P1a | SQLite + Surreal 双写 | SQLite | 每次写后比对两边 getState 等价(影子读),记差异日志 |
| P1b | 双写 | Surreal | 同上;问题可秒切回 SQLite |
| P1c | 仅 Surreal | Surreal | 关旧写;SQLite 留作冷备 |

- 等价比对:对 `ProductState` 做规范化(排序数组、忽略派生)后深比;不等即告警(fail-loud,不静默)。
- 任意子阶段可回退(env 切 repo 实现)。

---

## 5. P1 动手清单(TDD)

- [ ] T1 `createSurrealProductStateRepository(opts)` 实现 `ProductStateRepository`;`getState`/`replaceState` + revision。复用现 repo 契约测试(同一套断言跑两实现)。
- [ ] T2 `toRecord` / `fromRecord`:节点 ⇄ 各 TS 类型双向映射,往返幂等(`fromRecord(toRecord(x))===x`)。
- [ ] T3 `reconcileEdges`:三套旧编码 ⇄ 边集对账,幂等;删节点后其出入边被清(配合 spec 03 A5)。
- [ ] T4 diff-upsert:改一个 point → 只 upsert 该记录;删一个 session → 级联清其 turn/边,无孤儿(回归"删除孤儿")。
- [ ] T5 乐观锁:并发两写,旧 revision 抛 `StateRevisionConflictError`(对齐 `server.ts` 写串行化语义)。
- [ ] T6 影子读等价:对一批真实 state 变换,SQLite 与 Surreal 两路 getState 规范化后相等。
- [ ] T7 `withKnowledgeReindex` 兼容:包裹 Surreal repo 后,reindex 仍触发(或被原生派生边取代,见 spec 04)。

---

## 6. 可选演进:`state.relations[]` 显式化

P1 先做"旧字段 ⇄ 边"双向映射(不改 `ProductState` 形状)。后续可给 `ProductState` 加可选 `relations?: Relation[]`(向后兼容,对齐 [02 §7 T1](../../ontology/02-三元组与图模型.md)),逐步让域层直接读 `relations`,旧内嵌字段在 P2 末下线。**此演进不影响绞杀者主线,可独立排期。**

> 验收:P1 结束,系统以 SurrealDB 为权威存储,节点/边原生持久化,域层与测试不变、全绿;删除无孤儿;新旧字段并存、可回退。
