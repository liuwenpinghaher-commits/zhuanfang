# SurrealDB × 本体论 · P2b 召回消费切换(设计)

- 日期:2026-06-28 · 前置:[P2a 原生召回方法实施计划](../plans/2026-06-27-surreal-ontology-p2a-native-recall.md)、[04 召回与检索](2026-06-27-surreal-ontology-04-召回与检索.md)
- 阶段 P2b:让召回链在 **surreal 权威**时真正消费 P2a 落地的原生召回方法(图遍历 + HNSW 向量 + 溯源),sqlite/默认路径回落到现有域层纯函数。
- 范围决策(已与用户确认):**approach ① 依赖倒置端口 + 全链 async**;**核心三块 + 溯源接入**;追求最优效果,不以工作量为约束。

---

## 1. 目标与非目标

**目标**
- surreal 权威(`surreal` / `dual-surreal`)时,召回改用原生:① 主题资产走图遍历(精确按边,自动覆盖新资产类型);② 两处记忆语义召回走 HNSW + 三因子精排;③ 召回出的资产沿 `derived_from` 附证据原文 turn。
- sqlite / 默认 / `dual`(sqlite 权威)时,行为**零变化**,回落到现有域层纯函数。
- 域层不依赖具体 repo——通过纯接口端口注入,保持可测、可回落。

**非目标(留后续)**
- chat/RAG 混合检索(向量 + BM25 + `search::rrf()`)——spec 04 §4,需 rag_chunk embedding 落地,单独排。
- `evolves_into` 主题演化时间线(新能力)。
- **删除**域层手工列举:必须保留为 sqlite 回落(sqlite 模式无图/HNSW),不删。这与 spec 04 §5「删手工列举」的差异是有意的——只有彻底弃用 sqlite 时才删。
- P3 公理落 DB。

---

## 2. 现状(承接 P2a)

- **召回链全同步纯函数,state 全驻内存**:`createSessionDraft → buildInterviewCard/buildInterviewGuide → buildInterviewContextPack + collectRelevantMemories`;`repository.getState()` 同步返回完整内存 `ProductState`(SurrealStore 亦为内存工作副本 + 异步落库)。
- **原生方法在消费侧类型不可见**:`SurrealRepoHandle extends ProductStateRepository`(surreal-product-state-repository.ts:62),三个 `recall*` 是扩展;server/routes 持有基础接口 `ProductStateRepository`,原生方法被类型擦除。
- **两处独立的记忆语义召回**:① `buildInterviewContextPack.confirmedMemories`(`rankMemoryRecordsBySemantics(queryEmbedding)`,context-pack.ts:298);② `buildInterviewGuide → collectRelevantMemories`(三因子排序,context-pack.ts:768)。两处都需统一切原生。
- **主题资产现状**:`collectRelevantMemories` 的 `otherCandidates`(notes/points/questions/decisions/themes 全量 + 子串排序)+ `buildContextPackMemoryEdges`(按 token 重叠过滤边)。`decisions` 已纳入(782 行,「漏 decisions」域层早修)。
- **溯源边已落**:`edge-mapper.ts` 把 `EvidenceAnchor → derived_from`(带 provenance,指向现存 turn);凡带 `evidenceAnchors` 的资产(point/decision 等)皆有 `derived_from→turn`。当前召回链**不读它取 turn**——溯源是 P2b 新建的消费点。
- **基线**:vitest 1004 passed | 6 skipped(P2a 后),typecheck 绿。

---

## 3. 架构:依赖倒置端口 + 全链 async

### 3.1 召回端口 `NativeRecallPort`(域层纯接口)

新建 `src/domain/recall-port.ts`,只含召回需要的方法(签名与 `SurrealRepoHandle` 子集一致,故 handle 结构兼容):

```ts
export interface NativeRecallPort {
  /** 主题聚合:指向该 theme 的资产 id(图入边,含 decisions)。 */
  recallThemeAssets(themeId: string): Promise<{ points: string[]; decisions: string[]; questions: string[]; memories: string[] }>;
  /** 记忆向量召回(HNSW KNN + 余弦);A4 门控:默认 confirmed+normal,includeSensitive 含 sensitive。 */
  recallMemoriesByVector(embedding: number[], k: number, opts?: { includeSensitive?: boolean }): Promise<Array<{ id: string; text: string }>>;
  /** 溯源:沿 derived_from 取某资产的证据 turn。 */
  recallProvenanceTurns(table: string, id: string): Promise<Array<{ id: string; content: string; sessionId: string; role: string }>>;
}
```

- 域层只依赖这个抽象端口(依赖倒置),不 import 任何 repo。
- `SurrealRepoHandle` 已实现这三个签名 → 结构兼容,无需改 handle(仅加一行 `import type` 自检 + 注释说明它满足端口)。

### 3.2 async 化召回链 + 可选 `recall` 注入

把召回链改为 async,并在签名末尾追加可选 `recall?: NativeRecallPort`:

| 函数 | 改动 |
|---|---|
| `collectRelevantMemories` | `async` + `recall?`;有 recall 走原生分支,否则现状纯逻辑 |
| `buildInterviewContextPack` | `async` + `recall?`;`confirmedMemories` / `memoryEdges` / 新 `provenanceTurns` 走原生 |
| `buildInterviewGuide` | `async` + `recall?`(透传) |
| `buildInterviewCard` | `async` + `recall?`(透传) |
| `createSessionDraft` | `async` + `recall?`(透传) |
| `buildInterviewResumeCard` 等其他召回消费点 | 按需 async 适配(实现时枚举) |

调用点 callers 全部 `await` + 透传 recall:`interview-sessions.ts`(已 async)、`realtime-voice.ts`(已 async)、`engine.ts`、各测试。

### 3.3 注入策略(模式矩阵)

route 持有 `repository`,用能力探测 `asNativeRecall(repo): NativeRecallPort | undefined` 决定是否注入:

| `PRODUCT_STORE` | repository | 权威 | 注入 recall? | 召回路径 |
|---|---|---|---|---|
| `sqlite`(默认/未知值) | Sqlite | sqlite | 否 | 域层纯函数 |
| `surreal` | `SurrealRepoHandle` | surreal | **是(直接)** | 原生 |
| `dual` | DualWrite{auth:sqlite, shadow:surreal} | sqlite | 否 | 域层(权威是 sqlite) |
| `dual-surreal` | DualWrite{auth:surreal, shadow:sqlite} | surreal | **是(转发)** | 原生 |

- `asNativeRecall`:若 repo 自身具 `recall*`(SurrealRepoHandle)→ 返回 repo;若 repo 是 `DualWriteRepository` 且其 **authoritative** 具 `recall*` → 返回转发器;否则 `undefined`。
- **DualWrite 转发**:`DualWriteRepository` 在构造时探测 `authoritative` 是否满足 `NativeRecallPort`,满足则自身 expose `recall*`(委托 authoritative,只读、不碰 shadow),不满足则不 expose。这样 `dual-surreal`(auth=surreal)透出原生,`dual`(auth=sqlite)不透出——矩阵自洽。

### 3.4 回落与降级(fail-safe)

- **无注入**(undefined recall):走现有域层纯逻辑,行为逐字节不变。
- **原生抛错**(DB 异常/查询失败):`try/catch` → 回落到域层纯逻辑,**绝不让召回失败阻断 session 创建**(对齐 `embedQueryText` 现有 fail-safe);记 `console.warn` 降级事件。

---

## 4. 三块核心 + 溯源 详细设计

### 4.1 主题资产图遍历(替代子串匹配)

- 由 `topicHint` 解析当前主题:`state.themes.find(name===topicHint) ?? topTheme`。
- `recallThemeAssets(themeId)` 取挂在该主题的 point/decision/question/memory 的 **id**,从内存 state 按 id 映射回资产文本(`title：content` 等,与现状文本格式一致)。
- **语义变化(有意,体现最优)**:从「全量资产 + topicHint 子串排序」变为「精确按主题归属(图入边)」——不漏不误、自动覆盖未来新资产类型。
- 回落:无 recall → 现状 `otherCandidates` 子串排序。

### 4.2 记忆语义召回:HNSW 粗召回 + 三因子精排(两处统一)

两处(`buildInterviewContextPack.confirmedMemories` + `collectRelevantMemories` 记忆段)统一为:

1. 有 recall + queryEmbedding:
   - `candidateIds = await recall.recallMemoriesByVector(queryEmbedding, K, { includeSensitive })`,K 取较大候选集(如 `max(maxSources, topN) * 4`)以**逼近精确**(HNSW 是近似最近邻)。
   - `includeSensitive = memoryPolicy.includeSensitiveMemoriesInContext`,与现有 A4 过滤(context-pack.ts:286-290)对齐。
   - 从内存 records 取 candidateIds 对应的完整 `MemoryRecord` → 用现有**三因子 scorer**(`scoreMemoryForRetrieval`:relevance+recency+importance)精排 → 取 topN。
   - **不降级**:HNSW 只做语义粗筛,recency/importance 仍由内存精排叠加。
2. 无 recall 或无 queryEmbedding:现状逻辑(三因子 / 子串)。

> 诚实权衡:当前规模(数百~数千、全驻内存),HNSW 近似精度略逊于内存精确余弦;真实收益是统一栈 + 未来规模可扩展 + A4 门控在 DB 层一致。用大候选集 + 内存精排把精度损失压到最小。

### 4.3 溯源接入(`recallProvenanceTurns` → context pack)

- `InterviewContextPack` 新增字段:
  ```ts
  provenanceTurns?: Array<{ assetTable: string; assetId: string; turns: Array<{ id: string; content: string; sessionId: string; role: string }> }>;
  ```
- 对召回出的、带证据的资产(主要 point/decision)调 `recallProvenanceTurns(table, id)` 取证据原文 turn,填入 `provenanceTurns`(有界:资产数与每资产 turn 数都设上限,防膨胀)。
- **消费**:`buildInterviewCard`/`buildInterviewGuide` 把证据原文纳入(如 `historyReferences` 或新增「证据原话」),让 LLM 能引用受访者原话佐证观点——这是溯源接入的价值落点。
- 回落:无 recall → `provenanceTurns` 为 `undefined`,既有行为不变(现状本就无此能力)。

---

## 5. 数据流(surreal 权威,session 创建)

```
route(interview-sessions)：
  state = repository.getState()                       // 内存全量
  recall = asNativeRecall(repository)                 // SurrealRepoHandle / DualWrite 转发
  queryEmbedding = await embedQueryText(topic)        // 现有
  session = await createSessionDraft(state, mode, strength, { topicHint, queryEmbedding, recall })
      └─ await buildInterviewCard / buildInterviewGuide(state, opts, recall)
            └─ await buildInterviewContextPack(state, opts, recall)
                  ├─ confirmedMemories ← HNSW 粗召回 + 三因子精排
                  ├─ themeAssets       ← recallThemeAssets(themeId)
                  └─ provenanceTurns   ← recallProvenanceTurns(table,id) per asset
            └─ await collectRelevantMemories(state, topic, pack, queryEmbedding, now, recall)
  repository.replaceState(upsertSession(state, session))
```

---

## 6. 测试策略(TDD)

- **域层单测(注入 mock 端口)**:`collectRelevantMemories` / `buildInterviewContextPack` 注入 mock `NativeRecallPort`,断言走原生分支(mock 返回特定 id/text 被采纳);注入 `undefined` 断言回落**等价旧行为**(既有快照/断言不变)。
- **HNSW + 三因子精排**:mock 返回乱序候选,验证最终序由三因子决定(recency/importance 生效,非纯 HNSW 序)。
- **主题资产图遍历**:mock `recallThemeAssets` 返回特定 id,验证精确按主题归属(含 decisions),不混入他主题。
- **溯源接入**:mock `recallProvenanceTurns`,验证 `provenanceTurns` 填充 + 证据原文进入 guide/card;无 recall 时字段为空。
- **端口转发**:`DualWriteRepository` authoritative 支持时 expose 并委托 `recall*`(只读 authoritative,不碰 shadow);不支持时不 expose。`asNativeRecall` 矩阵四模式断言。
- **fail-safe**:原生抛错 → 回落域层,session 仍创建。
- **route 集成**:`surreal` 模式创建 session,guide 召回来自原生(特征区分)。
- **全量回归**:sqlite/默认路径零变化;基线 1004 绿之上净增 P2b 测试,零回归;typecheck 绿。

---

## 7. 文件清单

```
src/domain/
  recall-port.ts                       # 新:NativeRecallPort 接口
  context-pack.ts                      # 改:async 化召回链 + recall 注入 + 三块 + provenanceTurns
  types.ts                             # 改:InterviewContextPack 加 provenanceTurns(+ guide 证据字段如需)
  context-pack-recall.test.ts          # 新:原生分支 / 回落等价 / 精排 / 溯源 / fail-safe
apps/api/src/
  dual-write-repository.ts             # 改:条件转发 recall* 到 authoritative
  recall-capability.ts                 # 新:asNativeRecall 能力探测(或并入 routes 工具)
  routes/interview-sessions.ts         # 改:探测 + 注入 + await
  routes/realtime-voice.ts             # 改:同上(buildInterviewGuide/agent-context 调用点)
packages/db/src/surreal/
  surreal-product-state-repository.ts  # 改:import type 自检 SurrealRepoHandle 满足 NativeRecallPort + 注释
```

---

## 8. 阶段门(验收)

- surreal 权威召回真正消费原生:图遍历主题资产(含 decisions)、HNSW+三因子精排两处统一、溯源原文进 context。
- sqlite/默认/`dual` 路径零行为变化(回落等价);原生抛错 fail-safe 回落。
- `asNativeRecall` 四模式矩阵正确;DualWrite 仅在 auth=surreal 时透出原生。
- 全量 ≥1004 + P2b 净增、零回归;typecheck 绿。

---

## 9. 自查

- **Spec 覆盖**:spec 04 §2 图遍历(=4.1)、§3 HNSW+A4(=4.2)、§2 溯源 derived_from→turn(=4.3);§4 RAG 混合 / §6 evolves_into / §5 删手工列举 显式划到非目标(§1)。
- **占位扫描**:无 TBD;K 候选集大小、provenanceTurns 上限为实现时按数据坐实的有界参数,非占位。
- **一致性**:端口签名 = `SurrealRepoHandle` 子集 = 测试 mock;注入矩阵(§3.3)与 fail-safe(§3.4)/数据流(§5)自洽;「保留域层回落」贯穿全文,与 spec 04 §5 的差异已显式说明(§1 非目标)。
- **边界清晰**:`NativeRecallPort` 单一职责(召回端口),域层经它解耦 repo;`asNativeRecall` 单一职责(能力探测);各单元可独立测试。
