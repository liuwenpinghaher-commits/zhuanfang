# 阶段 3 · 内存向量 RAG Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development。每 Task 派 fresh subagent,TDD。Steps 用 checkbox。

**Goal:** 新增**纯 TS 内存 cosine 语义检索 RAG**(资料/记忆语义召回 + 资料问答),零新依赖、跨平台、带离线 fallback。

**Architecture:** embedding 经百炼 API 算好存进 `ProductState.ragChunks[].embedding`(可选字段);检索时内存算余弦,top-k。**有 embedding 走 cosine,无 embedding 退回现有关键词检索**(离线/无 key 时无缝降级,这是系统既有的"真智能+离线 fallback"原则)。资料问答端点:cosine 召回 → LLM 生成带引用答案(LLM 同样有离线确定性 fallback)。

**Tech Stack:** TypeScript, Vitest。**严禁** sqlite-vec / pgvector / 任何向量库(node:sqlite 在 macOS 加载扩展失败;PG 已于阶段 0b 删除)——纯内存 cosine。验证:`npm run typecheck` / `npx vitest run --exclude "**/*.real.test.ts"`。

主设计:第 3.4 节(诚实克制:内存 cosine、mem0 不做、对谈播客借思路)。

---

## Scope 决策

- **做(净新增)**:内存 cosine RAG —— 百炼 embedding 客户端(+离线 fallback)、`RagChunk.embedding` 字段、cosine 检索工具、检索升级(cosine + 关键词 fallback)、资料问答端点。
- **不做**:① mem0(设计明确留 D4 复评,单用户不引);② sqlite-vec/pgvector(平台不稳 + 已删 PG);③ **对谈播客**已满足(`format:"host-guest"` 与脚本生成已存在,"双人播客可出"达标),多声音 TTS 设计标"可选"→ 不做(YAGNI)。
- **离线 fallback 是硬要求**:测试不得依赖外部 API;embedding 客户端可注入,真实现调百炼、缺 key 时不产 embedding;检索对无 embedding 的 chunk 用现有关键词路径。

---

## 通用约束(每 Task 适用)

- 真实代码在顶层 `src/`/`apps/`,**不是** zhuanfang/。grep 排除 zhuanfang。
- 提交**只 `git add` 本 Task 改动的具体文件**,严禁 `git add -A/.`。
- 每 Task 结束:`npm run typecheck` PASS + `npx vitest run --exclude "**/*.real.test.ts"` 全绿 + `git status --short` 确认无关文件未暂存,再提交。
- TDD;外部 API 调用一律用注入式 mock/fake,确定性。

---

## Task 1: cosine 相似度工具 + RagChunk.embedding 字段

**Files:** Create `src/domain/vector.ts`;Modify `src/domain/types.ts`(`RagChunk` 加 `embedding?`);Test `src/domain/vector.test.ts`。

- [ ] **Step 1:** 读 `src/domain/types.ts:938-948` 的 `RagChunk`。
- [ ] **Step 2:** 写失败测试 `src/domain/vector.test.ts`:`cosineSimilarity([1,0],[1,0])===1`;`cosineSimilarity([1,0],[0,1])===0`;反向 `-1`;零向量返回 0(不 NaN);维度不等抛错或返回 0(定义清楚)。`topKByCosine(query, items, k)` 返回按相似度降序的 top-k(items 为 `{embedding:number[], ...}[]`)。
- [ ] **Step 3:** 跑确认失败。
- [ ] **Step 4:** 实现 `src/domain/vector.ts`:纯函数 `cosineSimilarity(a:number[],b:number[]):number`(处理零向量/维度不等)、`topKByCosine<T extends {embedding?:number[]}>(query:number[], items:T[], k:number):T[]`(忽略无 embedding 项)。给 `RagChunk` 加 `embedding?: number[]`(可选,兼容现有数据)。
- [ ] **Step 5:** 跑通过 + 全量 typecheck/vitest。
- [ ] **Step 6:** 提交:只 add `src/domain/vector.ts src/domain/vector.test.ts src/domain/types.ts`,`git commit -m "feat(rag): cosine similarity util + RagChunk.embedding field (phase 3)"`。

---

## Task 2: 百炼 embedding 客户端(+离线 fallback)

**Files:** Modify `apps/api/src/providers/bailian.ts`(加 embedding 客户端);Modify `apps/api/src/server.ts`(装配注入);Test 对应 provider 测试。

- [ ] **Step 1:** 读 `apps/api/src/providers/bailian.ts` 现有客户端工厂模式(如 `createBailianChatClient`)、它们如何读 key/baseUrl、如何在 server.ts 装配与注入路由。确认百炼 text-embedding 模型名(DashScope `text-embedding-v3` 或 compatible-mode `text-embedding-*`;以百炼兼容接口为准,baseUrl 复用现有 `BAILIAN_BASE_URL`)。
- [ ] **Step 2:** 写失败测试:`createBailianEmbeddingClient({apiKey,baseUrl,fetchImpl})` 的 `.embed(texts:string[]):Promise<number[][]>`——用 fake fetchImpl 返回固定向量,断言解析正确;无 apiKey 时工厂返回 `null`(表示不可用,触发上层 fallback)。
- [ ] **Step 3:** 跑确认失败。
- [ ] **Step 4:** 实现 `createBailianEmbeddingClient`:POST 到百炼 embedding 接口,解析 `data[].embedding`;无 key 返回 null。server.ts 装配 `embeddingClient` 注入需要它的路由(随其它 providerClients 一起)。**不改现有客户端行为。**
- [ ] **Step 5:** 跑通过 + 全量 typecheck/vitest。
- [ ] **Step 6:** 提交:只 add `apps/api/src/providers/bailian.ts apps/api/src/server.ts` + 测试,`git commit -m "feat(rag): Bailian embedding client with no-key fallback (phase 3)"`。

---

## Task 3: 导入时计算 embedding + 检索升级(cosine + 关键词 fallback)

**Files:** Modify `apps/api/src/routes/import.ts`(导入时 embed chunks)、`src/domain/context-pack.ts`(`buildSemanticRagContext`/`scoreRagChunkForTopic` 升级);Test 对应测试。

- [ ] **Step 1:** 读 `src/domain/import.ts` 的 `ingestImportSource`/`chunkDocument`、`apps/api/src/routes/import.ts` 的导入流程。读 `src/domain/context-pack.ts:736-766` 的 `buildSemanticRagContext` 与 `:1136-1145` 的 `scoreRagChunkForTopic`(现关键词匹配)。
- [ ] **Step 2:** 写失败测试:
  - 检索:给一组**带 embedding** 的 ragChunks + 一个 query embedding,`buildSemanticRagContext` 用 cosine 召回最相近的(注入 query 向量;断言顺序按 cosine);给**无 embedding** 的 chunks,退回关键词路径(现有行为不破)。
  - 导入:`ingestImportSource` 在传入 embedding 客户端时给 chunk 填 `embedding`;无客户端时 chunk 无 embedding(不报错)。
- [ ] **Step 3:** 跑确认失败。
- [ ] **Step 4:** 实现:
  - `ingestImportSource` 接受可选 embedding 客户端,有则对每个 chunk.text 批量 embed 填入 `embedding`(失败/无客户端则跳过,chunk 照常入库)。import.ts 路由把注入的 embeddingClient 传进去。
  - `buildSemanticRagContext`:query 有 embedding 且存在带 embedding 的 chunk → 用 `topKByCosine`;否则用现有 `scoreRagChunkForTopic` 关键词。**关键词路径必须保留为 fallback**(零破坏现有 context-pack 测试)。query embedding 从哪来:检索入口若有 embedding 客户端则对 topic 即时 embed;否则纯关键词。
- [ ] **Step 5:** 跑通过 + 全量 typecheck/vitest(确认现有 context-pack/engine 测试零破坏)。
- [ ] **Step 6:** 提交:只 add 改动文件 + 测试,`git commit -m "feat(rag): embed chunks on import + cosine retrieval with keyword fallback (phase 3)"`。

---

## Task 4: 资料问答端点 POST /api/rag/query

**Files:** Create/Modify `apps/api/src/routes/rag.ts`(新路由)+ `apps/api/src/server.ts`(注册);Test 对应路由测试。

- [ ] **Step 1:** 读 server.ts 路由注册方式、`apps/api/src/routes/search.ts` 等已接 LLM + budget + 离线 fallback 的路由作模板(如何拿 chatClient/embeddingClient/llmBudget、降级响应形状)。读 `src/domain/vector.ts` 的 `topKByCosine`。
- [ ] **Step 2:** 写失败测试:`POST /api/rag/query {question}` → 200,body 含 `answer` 与 `citations`(召回的 chunk 引用:id/title)。注入 fake embeddingClient + fake chatClient → 断言:问题被 embed、cosine 召回 top-k chunks、答案由 chatClient 据 chunks 生成、citations 对应召回项。无 embeddingClient/chatClient(离线)→ 关键词召回 + 确定性 fallback 答案(拼接召回片段),仍 200 且 citations 非空(当有相关资料时)。被 llmBudget 守卫。
- [ ] **Step 3:** 跑确认失败(404)。
- [ ] **Step 4:** 实现 `registerRagRoutes`:question →(有 embeddingClient 则 embed →cosine;否则关键词)召回 top-k ragChunks → chatClient 据召回片段生成带引用答案(离线则确定性拼接 fallback)→ 返回 `{answer, citations}`。加 `llmBudget.tryConsume("rag_query")` 守卫(复用既有模式)。server.ts 注册路由。
- [ ] **Step 5:** 跑通过 + 全量 typecheck/vitest。
- [ ] **Step 6:** 提交:只 add `apps/api/src/routes/rag.ts apps/api/src/server.ts` + 测试,`git commit -m "feat(rag): material Q&A endpoint POST /api/rag/query with offline fallback (phase 3)"`。

---

## Self-Review

**1. Spec 覆盖:** 对应设计 3.4「资料/记忆语义检索 RAG = 纯 TS 内存 cosine」。embedding(T2)+ 存储字段(T1)+ cosine 检索(T1/T3)+ 资料问答(T4)。mem0/sqlite-vec/对谈播客多声音明确不做并说明理由。

**2. 占位扫描:** 无 TBD。embedding 模型名在 T2 Step 1 现场核实百炼接口。

**3. 一致性:** `embedding` 字段名、`cosineSimilarity`/`topKByCosine` 函数名跨 T1/T3/T4 一致;离线 fallback 在每个外部调用点都有(embedding 无 key→关键词;LLM 无 key→确定性拼接)。

**4. 风险:** 纯内存 cosine 零新依赖、跨平台(规避 sqlite-vec macOS 问题);检索升级保留关键词 fallback 确保零破坏现有 context-pack 测试;外部 API 全注入式测试,确定性。
