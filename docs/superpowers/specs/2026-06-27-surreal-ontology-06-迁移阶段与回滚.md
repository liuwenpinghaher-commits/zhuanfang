# SurrealDB × 本体论 · 06 迁移阶段与回滚

- 日期:2026-06-27 · 前置:[00 总纲](2026-06-27-surreal-ontology-00-总纲与决策.md) ~ [05](2026-06-27-surreal-ontology-05-嵌入式部署与运维.md)
- 把 P0→P3 串成可执行、可叫停、可回退的迁移序列。**纪律:任意阶段结束系统必须绿且可用。**

---

## 1. 阶段总览(与各 spec 对应)

| 阶段 | 内容 | 风险 | 可回退 | 门 |
|---|---|---|---|---|
| **S0 spike** | [05 §3] 嵌入式 + 向量 + 全文 + 级联 跑通 | 低 | n/a | 5 个 spike 全过 |
| **P0 schema** | [01] DDL migrations + 自测 | 0(纯建库) | 删库重来 | INFO 断言齐全 |
| **P1a 双写** | [02 §4] SQLite+Surreal 双写,读 SQLite,影子读比对 | 低 | env 切回 sqlite | 影子读等价 |
| **P1b 切读** | 读切 Surreal,仍双写 | 低 | 秒切回 sqlite | 全测试绿 + e2e 绿 |
| **P1c 收旧** | 关 SQLite 写,Surreal 权威 | 中 | sqlite 冷备恢复 | 稳定运行 N 天无差异 |
| **P2 召回** | [04] 召回/聚合走原生图+向量 | 低 | 改回手工列举 | 召回回归绿(含漏类) |
| **P3 公理** | [03] A1–A5 落 DB+校验器,散落规则收敛 | 中 | 保留旧散落检查 | A1/A5 回归绿 |
| **(可选)边显式化** | [02 §6] `state.relations[]` + 删旧内嵌字段 | 中 | 保留旧字段 | 下游全切图 |

---

## 2. 数据迁移脚本(P0→P1)

`scripts/migrate-sqlite-to-surreal.mjs`:
1. 读旧 `product-state.db` 整 `ProductState` + 冷层(raw-material/audio/knowledge)。
2. 节点:每数组 → 对应表 upsert(`toRecord`)。
3. 边:`collectRelations(state)`(投影三套旧编码)→ 批量 `RELATE`,`derived_from` 带 provenance。
4. 冷层:turn 逐字稿 → `turn` 表;音频元数据 → 引用;`rag_chunk` 不搬、迁后 reindex 重建。
5. **幂等**:可重复跑(用稳定 id upsert,不重复建边);跑前后 `getState` 等价校验。
6. 干跑模式:`--dry-run` 只报将写入的节点/边计数,不落库。

```bash
node scripts/migrate-sqlite-to-surreal.mjs --src .data/product-state.db --dst .data/surreal --dry-run
node scripts/migrate-sqlite-to-surreal.mjs --src .data/product-state.db --dst .data/surreal
```

---

## 3. 动手清单(迁移与回滚)

- [ ] T1 迁移脚本 + `--dry-run` + 幂等(重复跑结果一致)。
- [ ] T2 迁移后等价校验:Surreal `getState` 规范化 == 旧 SQLite `getState`(同 [02 §4] 影子读断言)。
- [ ] T3 回滚脚本/流程:`PRODUCT_STORE=sqlite` 秒切回;P1c 后从 SQLite 冷备 + 重放 Surreal 增量(或定期导 SQLite 快照作冷备)。
- [ ] T4 阶段门自动化:每阶段一条 CI/脚本跑该阶段的"门"断言(影子读等价 / 召回回归 / A5 无孤儿)。
- [ ] T5 隐私治理一致:迁移后 export/purge(`/api/state/*`)在 Surreal 下行为等价(隐私清单计数、scoped purge 级联);对齐近期隐私修复。

---

## 4. 回退预案(每阶段)

| 触发 | 动作 |
|---|---|
| 影子读持续不等价 | 停在 P1a,排查映射;不切读 |
| Surreal 读异常/性能退化 | `PRODUCT_STORE=sqlite` 切回(P1b 前一切可逆) |
| 嵌入式 addon 故障 | 回 sqlite repo;数据从最近 SQLite 冷备 / `surreal export` 恢复 |
| 公理 DB 约束误拦合法写 | 关该 EVENT/ASSERT,降级为域层校验器(非阻塞审计) |

---

## 5. 完成定义(整个重构)

- 存储为嵌入式 SurrealDB;节点/边/约束/向量/全文原生;域层纯函数与 960 测试不变、全绿。
- 三套边统一为 `RELATE`;删除无孤儿(DB 强制 A5);召回走图+向量+全文,无漏类。
- 隐私 export/purge、生产 auth、媒体回放等 API 行为等价。
- 备份/恢复/迁移/回退脚本齐备且演练过。
- 旧 SQLite 路径保留为可切回的冷备(直到稳定后再决定移除)。

> 这套 spec 群是设计蓝图;真正实施是长跑。绞杀者保证每一步都可叫停、可回退、系统常绿。先做 S0 spike 与 P0 schema(零~低风险),再逐阶段推进。
