# SurrealDB × 本体论 · 04 召回与检索(图遍历 + 向量 + 全文混合)

- 日期:2026-06-27 · 前置:[01 数据建模](2026-06-27-surreal-ontology-01-数据建模.md)、[02](2026-06-27-surreal-ontology-02-repository-绞杀者迁移.md)
- 阶段 P2:召回/时间线/主题聚合改走 **原生图遍历 + HNSW 向量 + BM25 全文**,替代手工列举 25 数组 + JS 余弦 + 手工 knowledge_index。删手工列举。

---

## 1. 现状与目标

| 能力 | 现状 | 目标(SurrealDB 原生) |
|---|---|---|
| 主题聚合"谁指向放权" | 手工遍历 notes/points/decisions/themes(曾漏 decisions) | `SELECT <-belongs_to_theme<-? FROM theme:放权` 一次拿全 |
| 记忆语义召回 | JS 余弦(`src/domain/vector.ts`)+ 内存排序 | HNSW KNN `<|K,EF|>` |
| chat/RAG 检索 | 手工 `knowledge_index` SQLite + JS 余弦(近期加了相关性闸门) | 向量 + 全文 BM25 **混合** `search::rrf()` |
| 证据溯源 | 内嵌 `EvidenceAnchor` 分散字段 | `SELECT ->derived_from->turn FROM <node>` |
| 时间线/主题演化 | `appearances` 计数 | `evolves_into` 边的传递遍历 |

---

## 2. 图遍历召回(根治"漏类")

```surql
-- 指向某主题的所有认知资产(Distillation/Inquiry/Memory),一次遍历;新增 kind 自动覆盖
SELECT
  <-belongs_to_theme<-point   AS points,
  <-belongs_to_theme<-decision AS decisions,
  <-belongs_to_theme<-question AS questions,
  <-about_theme<-memory        AS memories
FROM theme:放权;

-- 某资产的全部证据(PROV-O):沿 derived_from 回到 turn
SELECT ->derived_from->turn.* FROM decision:D1;
```
> 这正是 [02 §5](../../ontology/02-三元组与图模型.md) 的 `neighbors(theme,_, 'in')` 的原生 SurrealQL 形态——把"加一种资产、召回自动覆盖"从内存图变成库查询。`collectRelevantMemories` 类手工列举可下线。

---

## 3. 向量召回(HNSW 替代 JS 余弦)

```surql
-- 记忆语义召回 top-8(EF=40 近似);维度对齐 bailian 实际嵌入维
SELECT id, text, status, sensitivity
FROM memory
WHERE status='confirmed'
  AND (sensitivity='normal' OR $includeSensitive)        -- A4 门控
  AND embedding <|8,40|> $queryEmb
ORDER BY vector::similarity::cosine(embedding,$queryEmb) DESC;
```
- 与现行的关系:替代 `src/domain/vector.ts` + 召回手工排序;A3/A4 门控写进 WHERE(对齐 context-pack 现有过滤)。
- 规模:当前向量数百~数千,HNSW 杀鸡用牛刀但**统一栈**收益(图+向量+全文一处查),且无需维护手工 knowledge_index。

---

## 4. 混合检索(chat / RAG:向量 + 全文 BM25 + RRF)

```surql
-- 向量路 + 全文路,RRF 融合(替代手工 reciprocal_rank_fusion)
LET $vec = (SELECT id FROM rag_chunk WHERE embedding <|20,64|> $q);
LET $bm  = (SELECT id FROM rag_chunk WHERE text @@ $queryText);     -- BM25 全文
SELECT * FROM rag_chunk WHERE id IN search::rrf($vec, $bm) LIMIT 8;
```
- 对齐近期 chat 召回的"相关性闸门 + 注入清洗":闸门在 WHERE/阈值,清洗(prompt injection)仍在域层 `sanitizeExternalMaterialText`(检索回的 chunk 拼 prompt 前清洗,不变)。
- deprecated 记忆不召回:`status='confirmed'` 进 WHERE(对齐近期 `buildKnowledgeChunks` status 过滤),原生层一致。

---

## 5. P2 动手清单(TDD)

- [ ] T1 主题聚合走图遍历:返回所有挂某主题的 point/decision/question/memory;**含"曾漏 decisions"回归用例**。
- [ ] T2 记忆向量召回走 HNSW:与 JS 余弦 top-k 结果一致(同一组向量),A4 敏感门控生效。
- [ ] T3 chat/RAG 混合检索:向量+BM25+RRF;零相关 query 不返无关块(对齐现"相关性闸门");deprecated 不召回。
- [ ] T4 溯源:`->derived_from->turn` 返回正确证据;替代内嵌 anchor 读取点。
- [ ] T5 下线手工列举:`collectRelevantMemories` 等改为图查询,删旧手工遍历,全召回测试绿。
- [ ] T6(可选)`evolves_into` 主题演化时间线:传递遍历串出主题演化(新能力)。

> 验收:召回/聚合/溯源走原生图+向量+全文;"漏类"回归绿;deprecated/敏感门控一致;手工列举与手工索引下线。
