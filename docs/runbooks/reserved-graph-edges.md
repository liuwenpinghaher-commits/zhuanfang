# 预留 / 死表图边（C14 · reserved-no-consumer）

> **范围：** Surreal `TYPE RELATION` 表中 **schema 已 DEFINE、应用层无消费者** 的边。  
> **决策：** **文档化保留，不假接线**；审计排除；产品未明确要「晋升/修正图层」前 **不** 为接线而接线。  
> **真源：** `packages/db/src/surreal/migrations/002_relations.surql` · `AUDITED_EDGE_TABLES`（`surreal-product-state-repository.ts`）· `edge-mapper.collectEdges`  
> **配套：** [`../ontology/`](../ontology/) · [`../COST-ENVELOPE.md`](../COST-ENVELOPE.md) §8 · graph-consistency 告警 [ALERTS A-13](./ALERTS.md)

---

## 1. 边表状态一览

| 表 | 语义（设计意图） | 应用层 | 图审计 `AUDITED_EDGE_TABLES` | 标签 |
| --- | --- | --- | --- | --- |
| `derived_from` | 认知实体 → turn 溯源 | **投影** | 是 | live |
| `belongs_to_theme` | 蒸馏/追问 → theme（含可选 `weight`） | **投影**；`weight` 暂不读写 | 是 | live（weight 闲置，非死表） |
| `about_theme` | memory → theme | **投影** | 是 | live |
| `part_of` | turn → session | **投影**；审计路径另有豁免 | 否（append-only 豁免） | live |
| `contradicts` | point ↔ point | **投影**（对称软链） | 是 | live |
| `evolves_into` | 演化/取代 | **投影** | 是 | live |
| **`promoted_from`** | question → note（观点晋升） | **不投影、不写** | **否** | **`reserved-no-consumer`** |
| **`corrects`** | memory_correction → memory | **不投影、不写**；修正走实体 + `memory.status` | **否** | **`reserved-no-consumer`** |

---

## 2. 为何保留空表

1. **迁移账本 append-only：** 已发布的 `002_relations.surql` 不回改正文删表；已上线库已 `DEFINE` 过空表。  
2. **复活路径清晰：** 若产品要「晋升/修正图层」，按 `contradicts`/`evolves_into` 先例做 **纯应用层** 接线即可（表已在，**无需新迁移**）：  
   - `edge-mapper.collectEdges` 加投影  
   - `EdgeSpec.edge` 联合类型  
   - `AUDITED_EDGE_TABLES` 纳入  
3. **避免假接线：** 空表进审计会制造「绿勾但无业务」的噪音；故审计 **故意排除**。

---

## 3. 运维注意

- `GET /api/ops/graph-consistency` **不会**因 `promoted_from`/`corrects` 恒空而报红。  
- 手工 `RELATE` 写入这两张表 **不会** 被 persist 投影覆盖逻辑当作一等公民维护——不要依赖。  
- `belongs_to_theme.weight`：字段保留；应用层读写属 **后续可选 PR**，非本 epic。

---

## 4. 相关链接

| 位置 | 内容 |
| --- | --- |
| `packages/db/src/surreal/migrations/002_relations.surql` | DEFINE + 历史预留注释（交叉链到本文） |
| `packages/db/src/surreal/surreal-product-state-repository.ts` | `AUDITED_EDGE_TABLES` 注释 |
| [`../ontology/01-本体论重构总纲-理论与实践.md`](../ontology/01-本体论重构总纲-理论与实践.md) §5.3 | 关系类型表 |
| [`../ontology/2026-06-28-落地符合度审视-还差什么.md`](../ontology/2026-06-28-落地符合度审视-还差什么.md) | 符合度（空建 → reserved） |

**C14/C15 完成定义：** 死表标为 **reserved-no-consumer**；文档与 schema 注释互链；**不**强制业务接线。
