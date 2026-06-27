# SurrealDB × 本体论 · P2b 召回消费切换(设计)

- 日期:2026-06-28 · 前置:[P2a 原生召回方法实施计划](../plans/2026-06-27-surreal-ontology-p2a-native-recall.md)、[04 召回与检索](2026-06-27-surreal-ontology-04-召回与检索.md)
- 阶段 P2b:让召回链在 **surreal 权威**时真正消费 P2a 落地的原生召回方法(图遍历 + HNSW 向量 + 溯源),sqlite/默认路径回落到现有域层纯函数。
- 范围决策(已与用户确认):**核心三块 + 溯源接入**;追求最优效果,不以工作量为约束。
- 架构决策:**server 预召回 + 域函数同步接受预召回数据**(见 §3 修订说明:原拟「全链 async」因前端共享域函数被否决)。

---

## 1. 目标与非目标

**目标**
- surreal 权威(`surreal` / `dual-surreal`)时,召回改用原生:① 主题资产走图遍历(精确按边,自动覆盖新资产类型);② 两处记忆语义召回走 HNSW + 三因子精排;③ 召回出的资产沿 `derived_from` 附证据原文 turn。
- sqlite / 默认 / `dual`(sqlite 权威)时,行为**零变化**,回落到现有域层纯函数。
- **域函数签名保持同步**;前端共享调用(`useMemo`/离线 fallback)零改动。
- 域层不依赖具体 repo——通过**可选的预召回数据**注入,保持可测、可回落、纯函数。

**非目标(留后续)**
- chat/RAG 混合检索(向量 + BM25 + `search::rrf()`)——spec 04 §4,需 rag_chunk embedding 落地,单独排。
- `evolves_into` 主题演化时间线(新能力)。
- **删除**域层手工列举:必须保留为回落(sqlite/前端无图/HNSW),不删。与 spec 04 §5「删手工列举」的差异是有意的——只有彻底弃用 sqlite + 前端不再共享域召回时才删。
- P3 公理落 DB。

---

## 2. 现状与约束(承接 P2a)

- **召回链全同步纯函数,state 全驻内存**:`createSessionDraft → buildInterviewCard/buildInterviewGuide → buildInterviewContextPack + collectRelevantMemories`;`repository.getState()` 同步返回完整内存 `ProductState`(SurrealStore 亦为内存工作副本 + 异步落库)。
- **⚠️ 前端共享域召回函数(硬约束)**:
  - `src/App.tsx:341` `const card = useMemo(() => buildInterviewCard(productState, activeSearchBriefId), [...])` —— **render 期同步调用**,useMemo 不能 async。
  - `src/App.tsx:672` 离线 fallback 同步调 `createSessionDraft`;`src/features/empty-state-render.test.tsx` 同步调 `buildInterviewCard`。
  - ⇒ 这些域函数**必须保持同步签名**;前端无 repo/SurrealDB,只能走纯路径。**这否决了「把域函数改 async」的方案。**
- **原生方法在消费侧类型不可见**:`SurrealRepoHandle extends ProductStateRepository`(surreal-product-state-repository.ts:62),三个 `recall*` 是扩展;server/routes 持有基础接口 `ProductStateRepository`,原生方法被类型擦除。
- **两处独立的记忆语义召回**:① `buildInterviewContextPack.confirmedMemories`(`rankMemoryRecordsBySemantics(queryEmbedding)`,context-pack.ts:298);② `buildInterviewGuide → collectRelevantMemories`(三因子排序,context-pack.ts:768)。两处都需统一切原生。
- **主题资产现状**:`collectRelevantMemories` 的 `otherCandidates`(notes/points/questions/decisions/themes 全量 + 子串排序)+ `buildContextPackMemoryEdges`(按 token 重叠过滤边)。`decisions` 已纳入(782 行,「漏 decisions」域层早修)。
- **溯源边已落**:`edge-mapper.ts` 把 `EvidenceAnchor → derived_from`(带 provenance,指向现存 turn);凡带 `evidenceAnchors` 的资产(point/decision 等)皆有 `derived_from→turn`。当前召回链**不读它取 turn**——溯源是 P2b 新建的消费点。
- **基线**:vitest 1004 passed | 6 skipped(P2a 后),typecheck 绿。

---

## 3. 架构:server 预召回 + 域函数同步接受预召回数据

> **修订说明**:初稿拟「全链 async + 域层端口注入」。因 §2 的前端硬约束(`buildInterviewCard` 在 `useMemo` 中同步调用,无法 async),改为本方案——server 在 async route 内 `await` 原生召回,把结果作为**纯数据**喂给保持同步的域函数。域层因此更纯(数据进/数据出,无 I/O),前端零改动。

### 3.1 召回端口 `NativeRecallPort`(server 层用)

新建 `apps/api/src/recall/native-recall-port.ts`,签名与 `SurrealRepoHandle` 子集一致(故 handle 结构兼容):

```ts
export interface NativeRecallPort {
  recallThemeAssets(themeId: string): Promise<{ points: string[]; decisions: string[]; questions: string[]; memories: string[] }>;
  recallMemoriesByVector(embedding: number[], k: number, opts?: { includeSensitive?: boolean }): Promise<Array<{ id: string; text: string }>>;
  recallProvenanceTurns(table: string, id: string): Promise<Array<{ id: string; content: string; sessionId: string; role: string }>>;
}
```

### 3.2 预召回数据 `RecallResult`(域层纯类型)

域层新增(`src/domain/types.ts` 或 `src/domain/recall.ts`):

```ts
export interface RecallProvenanceEntry {
  assetTable: string;
  assetId: string;
  turns: Array<{ id: string; content: string; sessionId: string; role: string }>;
}
export interface RecallResult {
  /** 主题资产 id(图遍历);键对齐 recallThemeAssets。 */
  themeAssets?: { points: string[]; decisions: string[]; questions: string[]; memories: string[] };
  /** 记忆向量召回命中(HNSW),按相似度近似序。 */
  memoryHits?: Array<{ id: string; text: string }>;
  /** 溯源:资产→证据 turn。 */
  provenance?: RecallProvenanceEntry[];
}
```

域函数只读这个**数据**,不持有任何 repo/端口/Promise。

### 3.3 域函数:同步签名 + 可选 `recall?: RecallResult`

| 函数 | 改动(保持同步) |
|---|---|
| `collectRelevantMemories` | 末尾加 `recall?: RecallResult`;有 `recall.memoryHits` → 按 id 取内存 record 三因子精排;有 `recall.themeAssets` → 按 id 取资产文本(替代 otherCandidates 子串);否则现状纯逻辑 |
| `buildInterviewContextPack` | 加 `recall?`;`confirmedMemories` 用 `memoryHits` 精排;新 `provenanceTurns` 用 `recall.provenance` |
| `buildInterviewGuide` | 加 `recall?`(透传给 pack/collectRelevantMemories) |
| `buildInterviewCard` | 加 `recall?`(透传) |
| `createSessionDraft` | `options.recall?`(透传) |

全部**可选参数**:不传 → 行为逐字节不变(前端、测试、sqlite 路径)。

### 3.4 topicHint 一致性(DRY)

server 预召回需要的「当前主题」必须与域函数内部算的一致。现状 topicHint 解析散在 `buildInterviewGuide:385` 与 `buildInterviewContextPack:266`。抽纯函数(域层导出):

```ts
export function resolveInterviewTopicHint(state: ProductState, options: { topicHint?: string; searchBriefId?: string }): string;
```

server 预召回与两个域函数共用它,保证 query 主题对齐。

### 3.5 server 预召回器 `prefetchRecall`

新建 `apps/api/src/recall/prefetch-recall.ts`:

```ts
export async function prefetchRecall(
  port: NativeRecallPort,
  state: ProductState,
  topicHint: string,
  queryEmbedding: number[] | undefined,
  opts: { includeSensitive: boolean; topN: number }
): Promise<RecallResult>;
```

- 解析当前主题:`state.themes.find(t => t.name === topicHint) ?? topThemeByAppearances`。
- 并行 `Promise.all`:`recallThemeAssets(themeId)`、`queryEmbedding ? recallMemoriesByVector(queryEmbedding, topN*4, {includeSensitive}) : undefined`、对 themeAssets.points/decisions 各 `recallProvenanceTurns(table,id)`(有界:资产数 ≤ N、每资产 turn ≤ M)。
- **fail-safe**:每个子召回各自 `try/catch`,抛错 → 该字段 `undefined`(域函数对应回落);记 `console.warn` 降级事件。整体绝不抛(绝不阻断 session 创建)。

### 3.6 注入策略(模式矩阵)+ 能力探测

新建 `apps/api/src/recall/native-recall-capability.ts`:`asNativeRecall(repo): NativeRecallPort | undefined`。

| `PRODUCT_STORE` | repository | 权威 | `asNativeRecall` | 召回路径 |
|---|---|---|---|---|
| `sqlite`(默认/未知值) | Sqlite | sqlite | `undefined` | 域层纯函数 |
| `surreal` | `SurrealRepoHandle` | surreal | **repo 自身** | 原生 |
| `dual` | DualWrite{auth:sqlite, shadow:surreal} | sqlite | `undefined` | 域层(权威 sqlite) |
| `dual-surreal` | DualWrite{auth:surreal, shadow:sqlite} | surreal | **转发器** | 原生 |

- `asNativeRecall`:repo 自身具 `recall*` → 返回 repo;repo 是 `DualWriteRepository` 且 **authoritative** 具 `recall*` → 返回委托 authoritative 的转发器(只读、不碰 shadow);否则 `undefined`。
- `DualWriteRepository` 暴露只读取 `authoritative` 的途径(`getAuthoritative()` 或在 `DualWriteOptions` 回传),供能力探测;`dual`(auth=sqlite 无 `recall*`)自然得 `undefined`。

### 3.7 回落与降级(fail-safe)

- **无 recall**(undefined / 字段缺失):走现有域层纯逻辑,行为逐字节不变。
- **原生抛错**:`prefetchRecall` 内 per-call `try/catch` → 对应字段 undefined → 域函数回落;`console.warn` 降级。绝不阻断 session 创建(对齐 `embedQueryText` fail-safe)。

---

## 4. 三块核心 + 溯源 详细设计(注入机制 = §3 数据)

### 4.1 主题资产图遍历(替代子串匹配)
- `recall.themeAssets`(来自 `recallThemeAssets(themeId)`)给出挂在当前主题的 point/decision/question/memory 的 **id**;域函数从内存 state 按 id 映射回资产文本(`title：content` 等,格式与现状一致)。
- **语义变化(有意)**:从「全量资产 + 子串排序」变为「精确按主题归属(图入边)」——不漏不误、自动覆盖新资产类型。
- 回落:无 `themeAssets` → 现状 `otherCandidates` 子串排序。

### 4.2 记忆语义召回:HNSW 粗召回 + 三因子精排(两处统一)
两处(`buildInterviewContextPack.confirmedMemories` + `collectRelevantMemories` 记忆段)统一:
1. 有 `recall.memoryHits`:取其 id 对应的内存 `MemoryRecord` → 现有**三因子 scorer**(`scoreMemoryForRetrieval`:relevance+recency+importance)精排 → topN。`prefetchRecall` 已用 `topN*4` 大候选集 + A4 门控(`includeSensitive = memoryPolicy.includeSensitiveMemoriesInContext`)逼近精确、对齐过滤。
2. 无 `memoryHits`:现状逻辑(三因子 / 子串)。
- **不降级**:HNSW 只做语义粗筛,recency/importance 由内存精排叠加。

### 4.3 溯源接入(`recall.provenance` → context pack)
- `InterviewContextPack` 新增字段 `provenanceTurns?: RecallProvenanceEntry[]`,直接取自 `recall.provenance`(有界)。
- **消费**:`buildInterviewCard`/`buildInterviewGuide` 把证据原文纳入(在 `historyReferences` 追加「证据原话」条目),让 LLM 能引用受访者原话佐证观点。
- 回落:无 `recall.provenance` → 字段 `undefined`,既有行为不变。

---

## 5. 数据流(surreal 权威,session 创建)

```
route(interview-sessions,已 async):
  state  = repository.getState()                                  // 内存全量
  port   = asNativeRecall(repository)                             // SurrealRepoHandle / DualWrite 转发 / undefined
  topic  = resolveInterviewTopicHint(state, { topicHint, searchBriefId })
  qEmb   = await embedQueryText(topic)                            // 现有
  recall = port ? await prefetchRecall(port, state, topic, qEmb, { includeSensitive, topN }) : undefined
  session = createSessionDraft(state, mode, strength, { topicHint, queryEmbedding: qEmb, searchBriefId, recall })  // 同步
      └─ buildInterviewCard / buildInterviewGuide(state, opts, recall)        // 同步,透传 recall
            └─ buildInterviewContextPack(state, opts, recall)                 // confirmedMemories 精排 / provenanceTurns
            └─ collectRelevantMemories(state, topic, pack, qEmb, now, recall) // themeAssets + memoryHits 精排
  repository.replaceState(upsertSession(state, session))
```
前端 / sqlite:`port = undefined` → `recall = undefined` → 同步纯逻辑(不变)。

---

## 6. 测试策略(TDD)

- **域层单测(注入 `RecallResult` 数据,无需 mock 端口)**:`collectRelevantMemories` / `buildInterviewContextPack` 传入构造的 `RecallResult`,断言走原生分支(themeAssets/memoryHits/provenance 被采纳);传 `undefined` 断言回落**等价旧行为**(既有快照/断言不变)。
- **HNSW + 三因子精排**:`memoryHits` 给乱序候选,验证最终序由三因子决定(recency/importance 生效,非纯 HNSW 序)。
- **主题资产图遍历**:`themeAssets` 给特定 id,验证精确按主题归属(含 decisions),不混入他主题。
- **溯源接入**:`provenance` 注入,验证 `provenanceTurns` 填充 + 证据原话进入 card/guide `historyReferences`;无则空。
- **`prefetchRecall`(server)**:mock `NativeRecallPort`,验证并行召回组装 `RecallResult`;某子召回抛错 → 该字段 undefined 且整体不抛(fail-safe)。
- **`asNativeRecall` 矩阵**:四模式断言(surreal=repo、dual-surreal=转发、dual/sqlite=undefined);`DualWriteRepository` 仅在 auth=surreal 时透出 `recall*`、只读 authoritative。
- **route 集成**:`surreal` 模式创建 session,guide 召回来自原生(特征区分);原生抛错 → 回落,session 仍创建。
- **前端不回归**:`buildInterviewCard` 同步签名不变,`App.tsx:341` useMemo / `empty-state-render.test.tsx` 编译运行如常。
- **全量回归**:基线 1004 绿之上净增 P2b 测试,零回归;typecheck 绿(含 apps/api)。

---

## 7. 文件清单

```
src/domain/
  recall.ts                            # 新:RecallResult / RecallProvenanceEntry 类型 + resolveInterviewTopicHint 纯函数
  context-pack.ts                      # 改:5 个域函数加可选 recall?(同步);三块分支 + provenanceTurns;复用 resolveInterviewTopicHint
  types.ts                             # 改:InterviewContextPack 加 provenanceTurns
  context-pack-recall.test.ts          # 新:原生分支 / 回落等价 / 精排序 / 溯源 / topicHint
apps/api/src/
  recall/native-recall-port.ts         # 新:NativeRecallPort 接口
  recall/native-recall-capability.ts   # 新:asNativeRecall(四模式探测 + DualWrite 转发)
  recall/prefetch-recall.ts            # 新:prefetchRecall(并行召回 + fail-safe 组装 RecallResult)
  recall/prefetch-recall.test.ts       # 新:组装 / fail-safe / 矩阵
  dual-write-repository.ts             # 改:暴露 authoritative 供能力探测(getAuthoritative)
  routes/interview-sessions.ts         # 改:探测 port → 预召回 → 传 recall 给 createSessionDraft
  routes/realtime-voice.ts             # 改:guide 调用点(:348)探测 + 预召回 + 传 recall
packages/db/src/surreal/
  surreal-product-state-repository.ts  # 改:import type 自检 SurrealRepoHandle 满足 NativeRecallPort + 注释(可选,无逻辑改动)
```

---

## 8. 阶段门(验收)

- surreal 权威召回真正消费原生:图遍历主题资产(含 decisions)、HNSW+三因子精排两处统一、溯源原文进 context。
- 域函数同步签名不变;前端 `useMemo`/离线 fallback / `empty-state-render` 零回归。
- sqlite/默认/`dual` 路径行为逐字节不变(回落等价);原生抛错 fail-safe 回落,session 仍创建。
- `asNativeRecall` 四模式矩阵正确;DualWrite 仅在 auth=surreal 时透出原生、只读 authoritative。
- 全量 ≥1004 + P2b 净增、零回归;typecheck 绿(含 apps/api)。

---

## 9. 自查

- **Spec 覆盖**:spec 04 §2 图遍历(=4.1)、§3 HNSW+A4(=4.2)、§2 溯源 derived_from→turn(=4.3);§4 RAG 混合 / §6 evolves_into / §5 删手工列举 显式划到非目标(§1)。
- **前端约束**:§2 列明 `useMemo` 同步调用硬约束 → §3 架构改为「同步域函数 + 数据注入」,§6 含前端不回归用例。
- **占位扫描**:无 TBD;`topN`、provenance 资产/turn 上限为实现时按数据坐实的有界参数,非占位。
- **一致性**:`NativeRecallPort`(server)= `SurrealRepoHandle` 子集;`RecallResult`(域层数据)三字段 ↔ `prefetchRecall` 组装 ↔ 域函数消费 ↔ 测试注入,字段名一致(themeAssets/memoryHits/provenance);注入矩阵(§3.6)/fail-safe(§3.7)/数据流(§5)自洽;「保留域层回落」贯穿,与 spec 04 §5 差异已显式说明(§1)。
- **边界清晰**:`NativeRecallPort`(端口)/`asNativeRecall`(探测)/`prefetchRecall`(组装)/`RecallResult`(数据契约)各单一职责,域层经数据契约与 server 解耦,各单元可独立测试。
