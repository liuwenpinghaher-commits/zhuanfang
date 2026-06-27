# 03 · SurrealDB:多模型库与本体的原生落地(理论 × 实践)

> 前置:[01 总纲](01-本体论重构总纲-理论与实践.md)、[02 三元组与图模型](02-三元组与图模型.md)。
> 本篇是**决策转向篇**:01/02 当时定了"存储层不动、本体图只做内存投影、不上 L3";现在引入 **SurrealDB 整体替换存储层**(用户 2026-06-27 决策),这个前提变了——本体的"一等关系"可以从**内存投影**升级为**数据库原生持久化的图边**。
> 阅读方式延续三段式:**理论 → 项目映射(file:line)→ 动手**。

---

## 0. 一句话:本体模型 ≈ SurrealDB 数据模型,二者近乎同构

01 §1 的层级谱系里,SurrealDB 不是"又一个数据库",它**同时是文档库 + 原生图 + 关系表 + 向量库 + 全文库**。这意味着 01/02 里被迫做成"内存投影"的本体结构(因为当时存储是 KV-blob 的 SQLite),在 SurrealDB 里**每一个构件都有原生对应物**:

| 本体构件(01/02) | SQLite 现状(被迫的妥协) | SurrealDB 原生落地 |
|---|---|---|
| `EntityNode`(个体,按 `kind` 分类) | 25 个数组塞进一个 JSON blob | 每个 `EntityKind` 一张 **SCHEMAFULL 表**,记录即个体 |
| `Relation`(三元组 from-type-to) | 内存 `collectRelations` 投影 | **`RELATE` 图边**(边本身是记录、可带字段) |
| `Provenance`(PROV-O 溯源) | 内嵌字段 `EvidenceAnchor` | 图边上的**字段**(origin/turnId/confidence) |
| 分类法 `CognitiveEntity` 父类 | 口头概念 | 表命名约定 + `kind→parent` 元表 |
| 公理 A1(必有 derived_from) | finalize 各处手写 | `DEFINE FIELD ... ASSERT` + 写校验 |
| 公理 A5(删除级联根治孤儿) | **应用层 reindex 兜底** | **record-references `ON DELETE CASCADE` / `DEFINE EVENT`(DB 强制)** |
| 召回(图遍历 + 向量) | 手工列举 25 数组 + JS 余弦 | 原生 `->edge->` 遍历 + `DEFINE INDEX ... HNSW` KNN |
| RAG / 全文 | knowledge_index 手工 SQLite | 原生全文 BM25 + 向量**混合检索** `search::rrf()` |

> **结论**:换 SurrealDB 的唯一正当理由,不是"把 blob 换个地方存",而是**让本体论从"纸上规范 + 内存投影"变成"数据库强制执行的一等结构"**。否则就像 [2026-06-21 SurrealDB 评估](../superpowers/specs/2026-06-21-surrealdb-migration-evaluation.md) 说的:纯当文档库用,白受运维成本。

---

## 1. SurrealDB 是什么(力求准确,经官方文档核实 2026-06-27)

### 理论
**多模型数据库(Rust)**:文档 + 图(`RELATE`)+ 关系表 + 原生向量(HNSW/MTREE/DISKANN,余弦/欧氏 KNN)+ 原生全文(BM25 analyzer)。查询语言 **SurrealQL**(类 SQL 但不同)。

**部署形态(本项目选嵌入式)**:
- **嵌入式进程内**:`@surrealdb/node`(原生 addon),连接串 `surrealkv://path` / `rocksdb://path` / `mem://`。**不需起独立服务**,贴合单用户本地、零运维。JS SDK 兼容 SurrealDB **v2.0.0–2.3.x**。
- (独立 `surreal start` 服务形态本项目暂不用,见 [spec 05](../superpowers/specs/2026-06-27-surreal-ontology-05-嵌入式部署与运维.md)。)

**关键 SurrealQL 原语(本次重构会用到)**:
- `DEFINE TABLE x SCHEMAFULL` + `DEFINE FIELD f ON x TYPE ... ASSERT <cond>` —— 类型与约束(= TBox/SHACL)。
- `RELATE a->edge->b SET k=v` —— 建图边(= 三元组),边可带字段(= Provenance)。
- 图遍历箭头:`a->edge->node`(出)、`node<-edge<-a`(入)。
- `DEFINE INDEX i ON tbl FIELDS emb HNSW DIMENSION 1024 DIST COSINE` + KNN 算子 `<|K,EF|>` + `vector::similarity::cosine()`。
- 级联删除:record-references 的 `ON DELETE CASCADE`,或 `DEFINE EVENT`(触发器)。

### 项目映射
当前存储是 **`node:sqlite`**(Node 内置 `DatabaseSync`,零外部依赖),把整个 `ProductState`(29 字段、25 数组)存成单 JSON blob + revision 乐观锁;冷层 `raw-material.sqlite` / `audio.sqlite` / `knowledge.sqlite`(派生索引)。见 `apps/api/src/server.ts:117-148`、`packages/db/src/sqlite-product-state-repository.ts`。

### 动手
P0 写本体规范时,把 §3 的表/边/约束直接落成 SurrealQL DDL(migrations),作为后续绞杀者迁移的目标 schema。

---

## 2. 为什么是"绞杀者"而非"推倒重写"(决策)

### 理论
绞杀者模式(Strangler Fig):新系统在旧系统的**接口边界**后面逐步生长,旧实现一块块被替换,任意时刻系统都可用。对照"大爆炸重写"——后者要把 148 个纯函数 / 56 端点 / 95 测试一次性改完,功能冻结数周到数月([2026-06-21 评估](../superpowers/specs/2026-06-21-surrealdb-migration-evaluation.md) §3 量化过)。

### 项目映射(本系统的天然绞杀点)
系统已有干净的注入边界:`ProductStateRepository`(`apps/api/src/product-state-repository.ts:29`)——`getState(): ProductState` / `replaceState(state, opts?): ProductState`(`opts.expectedRevision` 乐观锁,违例抛 `StateRevisionConflictError`)。**域层 148 个纯函数 `(state)=>state` 只依赖这个接口,不知道底下是 SQLite 还是 SurrealDB。**

> 这就是绞杀点:**只换 `SurrealStore` 这一层的内脏,域层纯函数与 960 测试基本不动**。repository 负责"整状态 ⇄ 节点/边"的双向映射(投影 + 重组),把本体图原生持久化,同时对上层仍呈现 `ProductState` 契约。

### 动手
见 [spec 02 repository 绞杀者迁移](../superpowers/specs/2026-06-27-surreal-ontology-02-repository-绞杀者迁移.md):新旧仓库同接口、双写/影子读、逐"子域"迁移、保持全绿。

---

## 3. 目标 schema:把 01 §5 的本体落成 SurrealQL

### 3.1 节点表(= EntityNode / 个体)
每个 `EntityKind` 一张 SCHEMAFULL 表(`point` / `theme` / `memory` / `note` / `decision` / `debt` / `question` / `session` / `material` / `rag_chunk` / `search_brief`)。属性沿用现有 TS 类型字段。

```surql
DEFINE TABLE point SCHEMAFULL;
DEFINE FIELD title   ON point TYPE string;
DEFINE FIELD content ON point TYPE string;
DEFINE FIELD status  ON point TYPE string ASSERT $value IN ['待验证','已验证','已修正'];
DEFINE FIELD createdAt ON point TYPE datetime;
```

### 3.2 关系边(= Relation / 三元组,01 §5.3)
用 `RELATE` 建边表,边带 `provenance` 字段(= PROV-O)。**这正是 01/02 里"一等关系"的原生落地**——不再是内存投影,而是库里真实存在、可被图查询遍历的边。

```surql
-- (point:P1)--belongs_to_theme-->(theme:放权)
RELATE point:P1->belongs_to_theme->theme:放权;
-- (decision:D1)--derived_from-->(turn:T7),边上挂溯源
RELATE decision:D1->derived_from->turn:T7
  SET provenance = { origin: 'llm_extracted', turnId: 'T7', confidence: 0.9 };
```

### 3.3 公理(= TBox/SHACL,01 §5.4)
- **A1**(每个 Distillation ≥1 条 `derived_from`):写入校验 + 可选 `DEFINE EVENT` 巡检。
- **A2**(`Theme.maturity ≤ f(belongs_to_theme 边数)`):`DEFINE EVENT` 或域层纯函数推导。
- **A5**(删节点 → 出入边级联删,根治孤儿):record-references `ON DELETE CASCADE`,把 02 §6"删除孤儿"从应用层兜底升级为 **DB 强制**。

(详见 [spec 03 公理引擎与 DB 约束](../superpowers/specs/2026-06-27-surreal-ontology-03-公理引擎与DB约束.md)。)

### 3.4 召回(= 01 §6 推理/遍历的原生化)
- 图遍历:`SELECT ->belongs_to_theme->theme FROM point:P1` / `SELECT <-belongs_to_theme<-point FROM theme:放权`("哪些资产属于放权主题"一行搞定,根治 02 §6 的"召回漏 decisions")。
- 向量:`DEFINE INDEX mem_emb ON memory FIELDS embedding HNSW DIMENSION 1024 DIST COSINE` + KNN `<|8,40|>` 替代 JS 余弦。
- 全文 + 向量混合:`search::rrf()`(替代手工 RRF)。

(详见 [spec 04 召回与检索](../superpowers/specs/2026-06-27-surreal-ontology-04-召回与检索.md)。)

---

## 4. 与 01/02 的关系:哪些结论被刷新

| 01/02 的旧结论 | 本篇刷新 |
|---|---|
| "存储层不动"(01 §8 决策4、02 §4) | **推翻**:存储换 SurrealDB(用户决策);但仍用绞杀者,域层纯函数边界不动 |
| "OntologyGraph 是内存投影,不是第二份真相"(02 §4) | **升级**:图边成为库内一等持久化结构;`ProductState` 仍是域层工作模型与契约,repository 做双向映射 |
| "不上 L3(OWL/RDF/SPARQL/reasoner)"(01 §8 决策3) | **保留**:SurrealDB 不是语义网栈;我们用它的"图+向量+约束"原生能力,推理仍是确定性纯函数 + DB 约束,不引入 reasoner;CWA 仍成立 |
| "不需要数据库、内存图足够"(02 §3) | **场景已变**:换库后图直接落 SurrealDB,内存投影退化为可选的查询缓存 |

> 一句话:**本体论的"领域模型层"不变(EntityNode/Relation/Provenance/分类法/公理),变的是它的"持久化层"从"blob + 内存投影"换成"SurrealDB 原生节点 + 图边 + 约束"。** 这正是 01 §6 那句"本体是领域模型层的事,与持久化正交"的兑现——只是这次持久化层也升级到能原生表达本体。

---

## 5. 落地主线(与 specs 对应)

| 阶段 | 内容 | 文档 |
|---|---|---|
| P0 | 写目标 schema(SCHEMAFULL DDL + 边表 + 约束 + 向量/全文索引) | [spec 01 数据建模](../superpowers/specs/2026-06-27-surreal-ontology-01-数据建模.md) |
| P1 | `SurrealStore` 实现 `ProductStateRepository`,整状态 ⇄ 节点/边映射,双写/影子读 | [spec 02](../superpowers/specs/2026-06-27-surreal-ontology-02-repository-绞杀者迁移.md) |
| P2 | 召回/时间线/主题聚合改走原生图 + 向量 + 混合检索 | [spec 04](../superpowers/specs/2026-06-27-surreal-ontology-04-召回与检索.md) |
| P3 | 公理 A1–A5 落 DB 约束/事件 + 轻量推理 | [spec 03](../superpowers/specs/2026-06-27-surreal-ontology-03-公理引擎与DB约束.md) |
| 贯穿 | 嵌入式部署/运维/回滚/迁移阶段 | [spec 05](../superpowers/specs/2026-06-27-surreal-ontology-05-嵌入式部署与运维.md) / [spec 06](../superpowers/specs/2026-06-27-surreal-ontology-06-迁移阶段与回滚.md) |

总纲与决策见 [spec 00](../superpowers/specs/2026-06-27-surreal-ontology-00-总纲与决策.md)。

---
**下一篇(理论线)**:04 描述逻辑与 OWL(为何不上 reasoner,公理用确定性纯函数 + DB 约束表达)——SurrealDB 的 `ASSERT`/`EVENT` 正是"轻量 TBox"的工程对应。
