# SurrealDB × 本体论 · 01 数据建模(节点表 / 边表 / 向量·全文 / DDL)

- 日期:2026-06-27 · 前置:[00 总纲](2026-06-27-surreal-ontology-00-总纲与决策.md) · 理论:[ontology/03](../../ontology/03-SurrealDB-多模型与本体落地.md)
- 阶段 P0:把 01 §5 本体落成 SurrealQL DDL(migrations),作为绞杀者迁移的目标 schema。零运行时风险(纯建库)。

---

## 1. 命名空间与库

- `NS=interview` / `DB=main`(与任何其他 SurrealDB 用途隔离)。
- 连接:嵌入式 `surrealkv://<dataDir>/surreal`(见 [spec 05](2026-06-27-surreal-ontology-05-嵌入式部署与运维.md))。

---

## 2. 节点表(= EntityNode,01 §5.2 分类法)

按 `EntityKind` 一表一类,SCHEMAFULL。父类(CognitiveEntity 下的 Utterance/Distillation/Inquiry/Axis/Memory/External)用**命名约定 + 元表 `entity_kind`** 记录,供治理/召回按父类批量遍历。

| kind | 表 | 父类(01 §5.2) | 关键字段(沿用 `src/domain/types.ts`) |
|---|---|---|---|
| session | `session` | 容器 | title, mode, status, startedAt, completedAt |
| turn | `turn` | Utterance(occurrent,不可变只追加) | sessionId, role, content, createdAt |
| note | `note` | Distillation | title, summary, keyQuote, saidTrack, learnedTrack |
| point | `point` | Distillation | title, content, status |
| decision | `decision` | Distillation | title, choice, status |
| debt | `debt` | Distillation | concept, context, status |
| question | `question` | Inquiry | text, whyImportant, status |
| theme | `theme` | Axis(聚合,反刚性) | name, summary, representativeQuote, maturity, appearances |
| memory | `memory` | Memory | text, evidenceQuote, status, sensitivity, embedding |
| memory_candidate | `memory_candidate` | Memory | text, status, similarHints |
| material | `material` | External | title, content, sensitivity, sourceUrl, embedding |
| rag_chunk | `rag_chunk` | External | text, sourceId, embedding |
| search_brief | `search_brief` | External | summary, sources |

```surql
-- 元表:kind → 父类(治理/召回按父类批量遍历)
DEFINE TABLE entity_kind SCHEMAFULL;
DEFINE FIELD parent ON entity_kind TYPE string;   -- 'Distillation' | 'Inquiry' | 'Axis' | ...
-- 例:CREATE entity_kind:point   SET parent='Distillation';

-- 节点示例(其余表同构)
DEFINE TABLE point SCHEMAFULL;
DEFINE FIELD title     ON point TYPE string;
DEFINE FIELD content   ON point TYPE string;
DEFINE FIELD status    ON point TYPE string ASSERT $value IN ['待验证','已验证','已修正'];
DEFINE FIELD createdAt ON point TYPE datetime DEFAULT time::now();

DEFINE TABLE turn SCHEMAFULL;   -- occurrent:不可变,只追加(BFO,01 §4.5)
DEFINE FIELD sessionId ON turn TYPE string;
DEFINE FIELD role      ON turn TYPE string ASSERT $value IN ['user','assistant'];
DEFINE FIELD content   ON turn TYPE string;
DEFINE FIELD createdAt ON turn TYPE datetime DEFAULT time::now();

DEFINE TABLE memory SCHEMAFULL;
DEFINE FIELD text        ON memory TYPE string;
DEFINE FIELD status      ON memory TYPE string ASSERT $value IN ['candidate','confirmed','deprecated'];
DEFINE FIELD sensitivity ON memory TYPE string DEFAULT 'normal' ASSERT $value IN ['normal','sensitive'];
DEFINE FIELD embedding   ON memory TYPE option<array<float>>;
```

---

## 3. 关系边(= Relation 三元组,01 §5.3;吞掉三套旧编码)

三套旧编码(诊断见 [ontology/01 §3](../../ontology/01-本体论重构总纲-理论与实践.md))统一成 `RELATE` 边表,边带 `provenance`:

| RelationType | from → to | 取代现状(`src/domain/types.ts`) | 理论 |
|---|---|---|---|
| `derived_from` | CognitiveEntity → turn | `EvidenceAnchor`(types.ts:105,内嵌 evidenceAnchors/keyQuoteAnchor) | PROV-O wasDerivedFrom |
| `belongs_to_theme` | Distillation/Inquiry → theme | `relatedThemeIds?: string[]`(types.ts:611/668/704/718/737/751…) | RDFS domain/range |
| `about_theme` | memory → theme | `MemoryEdge`(独立实体 memoryEdges) | 统一掉双轨 |
| `promoted_from` | question → note | 仅 `whyImportant` 文案 | functional |
| `part_of` | turn → session | `sessionId` 外键 | Mereology |
| `corrects` | memory_correction → memory | 隐式 | —— |
| `contradicts` | point ↔ point | 无(**新能力**) | symmetric |
| `evolves_into` | theme(t) → theme(t+1) | `appearances` | 时序演化 |

```surql
DEFINE TABLE derived_from SCHEMAFULL TYPE RELATION;
DEFINE FIELD provenance ON derived_from FLEXIBLE TYPE object;  -- {origin,turnId,sessionId,confidence}
DEFINE FIELD provenance.origin ON derived_from TYPE string
  ASSERT $value IN ['llm_extracted','user_confirmed','heuristic','imported','seed'];

DEFINE TABLE belongs_to_theme SCHEMAFULL TYPE RELATION;
DEFINE FIELD weight ON belongs_to_theme TYPE option<float>;

DEFINE TABLE about_theme   SCHEMAFULL TYPE RELATION;
DEFINE TABLE contradicts   SCHEMAFULL TYPE RELATION;   -- 推理层检出(symmetric)
DEFINE TABLE evolves_into  SCHEMAFULL TYPE RELATION;
```

> 建边:`RELATE point:P1->belongs_to_theme->theme:放权;`
> 反查"哪些资产属于放权主题":`SELECT <-belongs_to_theme<-(point,decision,question) FROM theme:放权;`(02 §6 的"召回漏 decisions"在图模型下天然消失)。

---

## 4. 向量与全文索引(= 召回原生化,spec 04 详)

```surql
-- 向量:记忆/素材/rag_chunk 的 embedding 建 HNSW(余弦)。DIMENSION 取实际嵌入维度。
DEFINE INDEX memory_emb   ON memory    FIELDS embedding HNSW DIMENSION 1024 DIST COSINE;
DEFINE INDEX material_emb ON material  FIELDS embedding HNSW DIMENSION 1024 DIST COSINE;
DEFINE INDEX rag_emb      ON rag_chunk FIELDS embedding HNSW DIMENSION 1024 DIST COSINE;

-- 全文:中文 analyzer + BM25,供混合检索 search::rrf()
DEFINE ANALYZER zh TOKENIZERS class FILTERS lowercase;
DEFINE INDEX memory_ft ON memory FIELDS text SEARCH ANALYZER zh BM25;
```

> KNN 查询:`SELECT id, text FROM memory WHERE embedding <|8,40|> $q ORDER BY vector::similarity::cosine(embedding,$q) DESC;`(`<|K,EF|>` 近似)。维度需与 bailian embedding 实际维度对齐(实现时 spike 确认)。

---

## 5. 冷热分层(turn / audio / 派生块)

- `turn`(逐字稿,occurrent,体量大):独立表,只追加;不进热状态映射的"轻量字段",按需查(对齐现冷层 raw-material 思路)。
- 音频:二进制不入库,沿用 `local-object://` + 文件;表里只存元数据与引用。
- `rag_chunk`(派生):由 material/turn 派生,可重建;迁移时不必从旧库搬,reindex 重建。

---

## 6. P0 动手清单(TDD)

> 纯建库/纯函数,零业务风险。每条 RED→GREEN。

- [ ] T1 写 migrations:`001_nodes.surql`(节点表 + entity_kind)/`002_relations.surql`(边表 + provenance ASSERT)/`003_index.surql`(HNSW + BM25)。
- [ ] T2 `applySchema()` 幂等:重复 apply 不报错、不重建(参照 scribe3 `apply_schema` 的 `_migration` 表模式)。
- [ ] T3 schema 自测脚本:建库 → `INFO FOR DB` 断言表/字段/索引齐全;`ASSERT` 拒非法 status/origin。
- [ ] T4 维度对齐:spike 取一条 bailian embedding,确认 `DIMENSION` 常量与实际一致,写进 migration。
- [ ] T5 边语义冒烟:`RELATE`(三种边)+ 双向遍历查询返回预期;`derived_from` 边带 provenance 可读。

完成 P0,后续 [spec 02](2026-06-27-surreal-ontology-02-repository-绞杀者迁移.md) 的整状态映射才有目标 schema 可落。
