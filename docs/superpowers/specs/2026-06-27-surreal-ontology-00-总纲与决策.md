# SurrealDB × 本体论重构 · 00 总纲与决策

- 日期:2026-06-27
- 性质:可执行迁移设计(spec 群的总纲)。配套理论篇见 [docs/ontology/03](../../ontology/03-SurrealDB-多模型与本体落地.md)。
- 决策已定(2026-06-27 与用户确认):**绞杀者渐进迁移 + 嵌入式进程内 + 单用户本地**。

> 本 spec 群刷新并部分推翻两份旧文档的前提:[2026-06-21 SurrealDB 评估](2026-06-21-surrealdb-migration-evaluation.md)(结论"现阶段不要换"——用户已决定换)与 [docs/ontology 01/02](../../ontology/01-本体论重构总纲-理论与实践.md)("存储层不动"——现存储换 SurrealDB)。绞杀者策略让这次"换"不等于"重写"。

---

## 1. 目标(为什么做)

把"认知资产知识图谱"产品的**隐性本体**(散落实体 + 三套不一致的边编码)提升为 **SurrealDB 原生的显式本体**:节点表 + `RELATE` 图边 + `ASSERT`/`EVENT` 约束 + 原生向量/全文检索。一处建模、处处一致,根治一类根因 bug(删除孤儿 / 召回漏类 / 归属靠子串猜 / 双轨边),并解锁原生图遍历与向量混合检索。

**第一性原理**:本体论的"领域模型层"(EntityNode/Relation/Provenance/分类法/公理)是真相;持久化层这次升级到能**原生表达**它。

---

## 2. 范围与非范围

**范围**:
- 存储层:`node:sqlite`(整状态 blob + 3 个冷层 sqlite)→ **嵌入式 SurrealDB**(`@surrealdb/node`,`surrealkv://`)。
- 数据建模:25 数组 → 节点表;三套边(`EvidenceAnchor` / `relatedThemeIds[]` / `MemoryEdge`)→ 统一 `RELATE` 图边 + `provenance` 字段。
- 召回/检索:手工列举 + JS 余弦 + 手工 knowledge_index → 原生图遍历 + HNSW + BM25 混合。
- 公理 A1–A5:散落手写 → DB `ASSERT`/`EVENT`/级联引用 + 域层确定性校验器。

**非范围(明确不做)**:
- 不上 L3 语义网(OWL/RDF 库/SPARQL/reasoner);CWA 仍成立(理论篇 §4)。
- 不改 `ProductState` 域层契约与 148 个纯函数的签名(绞杀者:只换 repository 内脏)。
- 不做多用户/多设备(单用户本地);服务端形态留作未来(spec 05 §6)。
- 不重写前端状态范式(仍持整 `productState` + autosave + revision 乐观锁)。

---

## 3. 核心决策(及理由)

| # | 决策 | 理由 | 备择与否决 |
|---|---|---|---|
| D1 | **绞杀者**(非大爆炸重写) | 保住 148 纯函数 + 960 测试这块已验证底座;任意阶段可叫停、可回滚 | 大爆炸:数周-数月冻结、风险贯穿全栈(旧评估 §3),否决 |
| D2 | **嵌入式 `@surrealdb/node`**(`surrealkv://`) | 单用户本地零运维、备份=拷目录;与现"零外部依赖"气质一致 | 独立 `surreal start` 服务:多一层运维,留给未来多用户(spec 05) |
| D3 | **节点表 + RELATE 图边**(非单 blob 表) | 拿到 SurrealDB 价值的唯一方式;本体一等关系原生持久化 | 当文档库存整 blob:白受运维成本(旧评估 §3),否决 |
| D4 | **保留 `ProductState` 作域层工作模型 + 契约** | 绞杀者的关键;域层/前端不动 | 域层改按记录 CRUD:= 大爆炸,否决 |
| D5 | **公理进 DB(能强制的)+ 纯函数校验器(其余)** | A5 级联删等引用完整性 DB 强制最可靠;复杂语义公理留纯函数(可测可调试) | 全靠应用层:孤儿类 bug 反复(现状),部分下沉 DB |
| D6 | **推理仍是确定性纯函数,不引入 reasoner** | CWA + 规模不匹配;可控可测(01 §4.3/4.4) | OWL reasoner:否决 |

---

## 4. 成功标准(可验证)

1. **功能等价**:迁移后 960 单测 + e2e 全绿(域层纯函数不变,repository 适配层通过)。
2. **本体一等化**:`EvidenceAnchor` / `relatedThemeIds[]` / `MemoryEdge` 三套编码统一为 `RELATE` 边;主题反查、溯源、级联删走单一图模型。
3. **召回正确性**:"指向某主题的所有 Distillation/Inquiry/Memory"一次图遍历拿全(回归测试覆盖"曾漏 decisions")。
4. **删除无孤儿**:删 session/资产,出入边与派生块由 DB 级联清,`A5` 回归测试绿。
5. **检索现代化**:记忆/RAG 召回走原生 HNSW + BM25 混合,与 JS 余弦结果一致或更好。
6. **零运维回退**:任意阶段可切回 `node:sqlite`(双写期);备份/恢复有脚本。

---

## 5. 阶段门(每阶段结束系统必须绿且可用)

| 阶段 | 交付 | 门(通过条件) | 文档 |
|---|---|---|---|
| P0 | 目标 schema(DDL migrations) | `surreal import` 干净建库;schema 自测脚本绿 | [spec 01](2026-06-27-surreal-ontology-01-数据建模.md) |
| P1 | `SurrealStore` 实现 repo + 整状态映射 | repo 契约测试绿;双写影子读一致 | [spec 02](2026-06-27-surreal-ontology-02-repository-绞杀者迁移.md) |
| P2 | 召回/聚合走原生图+向量 | 召回回归绿(含漏类用例);性能不退 | [spec 04](2026-06-27-surreal-ontology-04-召回与检索.md) |
| P3 | 公理 A1–A5 落 DB + 校验器 | A1/A5 回归绿;违例被拦/记审计 | [spec 03](2026-06-27-surreal-ontology-03-公理引擎与DB约束.md) |
| 贯穿 | 部署/迁移脚本/回滚 | 数据迁移幂等;一键回退验证 | [spec 05](2026-06-27-surreal-ontology-05-嵌入式部署与运维.md) / [spec 06](2026-06-27-surreal-ontology-06-迁移阶段与回滚.md) |

---

## 6. 风险与缓解

| 风险 | 缓解 |
|---|---|
| 新旧并存期数据漂移 | 双写 + 影子读比对(spec 02 §4);P1 末以 SurrealDB 为准、关旧写 |
| 原生 addon 跨平台/Node 22 兼容 | spike 先验证 `@surrealdb/node` 在 Node 22.5+ 装载;CI 加冒烟(spec 05 §3) |
| 整状态映射性能(每次 replaceState 重写全图) | 按 diff 只 upsert 变更节点/边(复用现 `diffIndexableSources` 思路,spec 02 §3) |
| SurrealDB 相对年轻/向量功能新 | 嵌入式 + 单用户、规模小;关键路径有纯函数回退;锁定兼容版本区间 |
| 迁移把活代码当死代码删 | 迁移脚本只增不删旧字段,P2 末再删;以 routes 实际注册 + 测试为准 |

---

## 7. 工作分解(链接到各 spec 的 TDD 清单)

- 数据建模 DDL:[spec 01 §4](2026-06-27-surreal-ontology-01-数据建模.md)
- repository 适配 + 映射:[spec 02 §5](2026-06-27-surreal-ontology-02-repository-绞杀者迁移.md)
- 公理引擎:[spec 03 §4](2026-06-27-surreal-ontology-03-公理引擎与DB约束.md)
- 召回检索:[spec 04 §5](2026-06-27-surreal-ontology-04-召回与检索.md)
- 部署运维:[spec 05 §5](2026-06-27-surreal-ontology-05-嵌入式部署与运维.md)
- 迁移回滚:[spec 06 §3](2026-06-27-surreal-ontology-06-迁移阶段与回滚.md)
