# 记忆模块改进 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development(推荐)或 executing-plans。domain 纯函数走 TDD;路由/UI 用 server.inject 集成测试 + 组件测试。Steps 用 checkbox。

**Goal:** 把"HITL 框架成型、记忆智能几乎为零"的记忆模块,升级为"真抽取 + 语义检索 + 去重/冲突提示 + 时序/显著性 + 轻量巩固",全程保留 HITL 与无 key 降级。

**Architecture:** 借鉴已验证最佳实践(Mem0 的 extract-then-update / Generative Agents 的 relevance+recency+importance 三因子 / hermes-agent 的有界治理记忆),**用现有 TS/SQLite 栈原生实现**,复用已有 `vector.ts`(手写 cosine,零新依赖)与 `BailianEmbeddingClient`(已有,无 key 降级)。不引入 sqlite-vec/mem0/Python 依赖。

**Tech Stack:** TS/React, Fastify, Vitest, Playwright。验证:`npm run typecheck` / `npx vitest run --exclude "**/*.real.test.ts"` / `npx playwright test`。

依据:本会话 deep-research(已验证机制,见对话)+ 记忆模块现状调查(file:line)+ hermes-agent 评估(结论:借鉴不替代)。

## 已核实(关键现状,避免走偏)
- **抽取 bug**:`src/domain/finalize.ts:20` `buildMemoryCandidateFromSession` 是写死模板(永远 `用户反复关注"${anchor}"背后的判断责任和机制代价。`);`finalize.ts:136-137` `mergeFinalizedState` **无条件**调它。`FinalizeContent`(:54)**不含 memoryCandidates**。LLM finalize(`apps/api/src/intelligence/finalize-llm.ts:48` `finalizeSessionWithLlm` → `mapToFinalizeContent`)也不产记忆候选,最终仍被模板覆盖。
- **可复用的真抽取**:`apps/api/src/intelligence/memory-extraction-llm.ts:14` `extractCandidateMemories(title, content, chatClient): Promise<ImportedMemoryCandidate[]>`(导入资料已在用)。
- **检索**:`context-pack.ts:835` `collectRelevantMemories(state, topicHint, contextPack)` → `rankMemoryTexts`(:1020,`String.includes` 子串计数)→ 前 5。`buildInterviewContextPack(state, options)`(:266)**故意不传 queryEmbedding**(:279 ponytail 注释)。`buildSemanticRagContext(state, question, topK, queryEmbedding?)`(:673)有 cosine 路径(queryEmbedding 在时)。
- **向量工具**:`src/domain/vector.ts` `cosineSimilarity(a,b)`(:15)、`topKByCosine<T extends {embedding?:number[]}>`(:44)。
- **MemoryRecord**(types.ts):`{id,text,status,sourceType,sourceId,evidenceQuote,sourceCandidateId?,sensitivity?,createdAt,updatedAt,deprecatedReason?}` —— **无 embedding/importance/lastAccessedAt**。
- **approve**:`src/domain/memory.ts:13` `approveMemoryCandidate(state, candidateId)`(纯同步)→ 新建 confirmed MemoryRecord。
- **embedding client**:`BailianEmbeddingClient.embed(texts: string[]): Promise<number[][]>`,server.ts:237 注入,rag.ts:55-69 用(无 client→queryEmbedding=undefined→降级关键词)。
- **死代码**:`profile.confirmedMemories/inferredMemories`(types.ts:108-109)只 seed 写、pipeline 不回写;context-pack.ts:292 还把它们当 record 注入(第二来源,重复)。

## 设计决策(本计划锁定)
1. **向量**:复用 `vector.ts` cosine,给 `MemoryRecord` 加 `embedding?`;**不引 sqlite-vec**(单用户内存 cosine 足够,日后量大再议)。
2. **embedding 是异步 + 需 client** → 一律在**路由层**算好,作为可选参数传进**纯** domain 函数;无 client → 不传 → 检索/比对自动退回子串(保留现有行为)。
3. **extract-then-update 以 HITL 为中心**:产候选时计算"与已有记忆的相似/疑似矛盾",**标注在候选上给审核者看**,不自动改库(契合本系统 HITL 哲学 + 无 key 时无法可靠判矛盾)。
4. **无 key 降级**贯穿:有 key 走 LLM/embedding,无 key 走启发式/子串,均不崩。
5. **M5 巩固**做最轻:手动"整理记忆"动作(去重 + 有 key 时 LLM 概括),非后台自治循环。

## 通用约束
顶层 `src/`/`apps/`(忽略 zhuanfang)。提交只 `git add` 本 Task 文件,禁 `git add -A/.`。每 Task:`npm run typecheck` + `npx vitest run --exclude "**/*.real.test.ts"` 全绿 + git status 核无关文件未暂存。组件用 Write 避免弯引号。

---

## Task 1: 修专访记忆抽取——无 key 启发式做实 + mergeFinalizedState 接收候选(M1a)

**Files:** Modify `src/domain/finalize.ts`;Test `src/domain/finalize.test.ts`(或新建)。

- [ ] **Step 1: 写失败测试**——内容应随会话变化 + 支持外部传入候选。

```ts
// src/domain/finalize.test.ts
import { describe, it, expect } from "vitest";
import { finalizeSession } from "./finalize";
import { createInterviewSession, addTurn } from "./engine";
import { createInitialProductState } from "./engine";

describe("finalize memory extraction (M1a)", () => {
  it("derives candidate text from actual session content, not a fixed template", () => {
    const state = createInitialProductState();
    let s = createInterviewSession({ id: "s1", title: "关于放权的纠结" });
    s = addTurn(s, { role: "user", content: "我一直不敢把审批权交给团队，怕出错。" });
    s = addTurn(s, { role: "assistant", content: "你怕的是结果失控，还是判断力被质疑？" });
    s = addTurn(s, { role: "user", content: "其实是怕我自己不再被需要。" });
    const { nextState } = finalizeSession({ ...state }, s);
    const cand = nextState.memoryCandidates[0];
    // 不再是写死那句；应包含会话里的真实锚点
    expect(cand.text).not.toContain("判断责任和机制代价");
    expect(cand.text.length).toBeGreaterThan(8);
  });
});
```

- [ ] **Step 2: 跑测试确认失败** — `npx vitest run src/domain/finalize.test.ts` → FAIL(当前模板恒定)。
- [ ] **Step 3: 实现**——`buildMemoryCandidateFromSession` 用会话真实内容生成(取最近若干 user 轮 + keyQuote 拼成"用户在《X》中表达:…"),并给 `mergeFinalizedState` 加可选 `providedCandidates`:

```ts
// finalize.ts —— 替换模板实现
function buildMemoryCandidateFromSession(session, note, keyQuote, createdAt): MemoryCandidate {
  const userTurns = session.turns.filter((t) => t.role === "user").map((t) => t.content);
  const salient = userTurns.slice(-2).join(" ").slice(0, 120) || keyQuote;
  const text = `用户在《${note.title}》中表达：${salient}`.slice(0, 160);
  return withMemoryCandidateReview({ id: makeId("memory-candidate"), text, status: "pending",
    sourceType: "interview_session", sourceId: session.id, evidenceQuote: keyQuote,
    reason: `来自会后双轨笔记《${note.title}》，需用户确认后进入长期记忆。`,
    sensitivity: keyQuote.includes("不满") || keyQuote.includes("否定") ? "sensitive" : "normal", createdAt });
}
// mergeFinalizedState 签名加可选第 5 参 providedCandidates?: MemoryCandidate[]
export function mergeFinalizedState(state, session, content, completedAt, providedCandidates?: MemoryCandidate[]) {
  // ...:136 处改为：
  const cands = providedCandidates && providedCandidates.length
    ? providedCandidates
    : [buildMemoryCandidateFromSession(session, note, note.keyQuote, completedAt)];
  nextState.memoryCandidates = [...cands, ...(nextState.memoryCandidates ?? [])];
}
```

- [ ] **Step 4: 跑测试确认通过** — `npx vitest run src/domain/finalize.test.ts` → PASS。
- [ ] **Step 5: 全量回归** — `npm run typecheck` + `npx vitest run --exclude "**/*.real.test.ts"` 全绿(若旧测试断言了那句模板文本,同步)。
- [ ] **Step 6: Commit** — `git add src/domain/finalize.ts src/domain/finalize.test.ts && git commit -m "fix(memory): derive session memory candidate from real content + accept provided candidates (M1a)"`。

---

## Task 2: LLM 专访记忆抽取接进 finalize 路由(M1b)

**Files:** Modify `apps/api/src/intelligence/memory-extraction-llm.ts`(导出可复用的会话抽取,或直接用现有签名)、`apps/api/src/routes/interview-sessions.ts`(finalize 处)、`src/api`(若契约变);Test `apps/api/src/routes/interview-sessions.test.ts`。

- [ ] **Step 1: 读** `interview-sessions.ts` 里 finalize session 的端点(找调用 `finalizeSession`/`finalizeSessionWithLlm` 处)+ `extractCandidateMemories` 用法。
- [ ] **Step 2: 写失败集成测试**——注入 fake chatClient,finalize 一个有内容的会话 → 候选记忆来自 LLM 抽取(多于 1 条、文本来自 fake 返回),且无 client 时回退 Task1 启发式仍出 1 条。

```ts
// interview-sessions.test.ts (新增)
it("uses LLM-extracted memory candidates on finalize when chat client present", async () => {
  const server = buildApiServer({ repository, bailianInterviewClient: fakeInterview,
    // fake chat returns 2 structured candidates
    bailianChatClient: fakeChatReturning([{ text: "用户偏好先验证再放权", evidenceQuote: "...", sensitivity: "normal" },
                                          { text: "用户担心不被团队需要", evidenceQuote: "...", sensitivity: "sensitive" }]) });
  // ... 建会话 + 加 turns + POST finalize 端点
  const cands = state.memoryCandidates;
  expect(cands.length).toBeGreaterThanOrEqual(2);
  expect(cands.map(c => c.text)).toContain("用户偏好先验证再放权");
});
```

- [ ] **Step 3: 跑测试确认失败**(当前 finalize 不调 extract)。
- [ ] **Step 4: 实现**——finalize 路由在有 `bailianChatClient` 时:把会话 transcript 拼成文本,调 `extractCandidateMemories(session.title, transcript, chatClient)` → 转成 `MemoryCandidate[]`(经 `withMemoryCandidateReview` 打分)→ 作为 `providedCandidates` 传给 `mergeFinalizedState`(经 `finalizeSessionWithLlm` 或在路由层合并)。无 client → 不传(走 Task1 启发式)。抽取失败 try/catch 回退启发式,打 `memory_extraction_fallback` 日志。
- [ ] **Step 5: 跑测试确认通过 + 全量回归**(typecheck + vitest 全绿)。
- [ ] **Step 6: Commit** — `git add apps/api/src/routes/interview-sessions.ts apps/api/src/routes/interview-sessions.test.ts apps/api/src/intelligence/memory-extraction-llm.ts && git commit -m "feat(memory): wire LLM memory extraction into session finalize, heuristic fallback (M1b)"`。

---

## Task 3: MemoryRecord 数据模型扩展 + 迁移(M3 数据)

**Files:** Modify `src/domain/types.ts`、`src/domain/storage.ts`(normalizeProductState);Test `src/domain/storage.test.ts`。

- [ ] **Step 1: 写失败迁移测试**——老 record(无新字段)经 normalize 后字段安全存在/可选。

```ts
it("normalizes MemoryRecord without breaking on missing embedding/importance/lastAccessedAt", () => {
  const legacy = { ...createInitialProductState(),
    memoryRecords: [{ id: "m1", text: "x", status: "confirmed", sourceType: "interview_session",
      sourceId: "s", evidenceQuote: "", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" }] };
  const norm = normalizeProductState(legacy as any);
  expect(norm.memoryRecords[0].embedding).toBeUndefined(); // 可选,不报错
  expect(norm.memoryRecords[0].importance ?? 5).toBe(5);     // 默认中性
});
```

- [ ] **Step 2: 跑测试确认失败**(类型不含字段)。
- [ ] **Step 3: 实现**——`MemoryRecord` 加 `embedding?: number[]; importance?: number; lastAccessedAt?: string;`(全可选,向后兼容)。`normalizeProductState` 对 memoryRecords 不强制填(保持可选,检索侧用 `?? 默认`)。`MemoryCandidate` 加 `similarToRecordId?: string; suggestedUpdate?: "add"|"update"|"noop"|"conflict";`(供 Task 6)。
- [ ] **Step 4: 跑测试确认通过 + 全量回归**。
- [ ] **Step 5: Commit** — `git add src/domain/types.ts src/domain/storage.ts src/domain/storage.test.ts && git commit -m "feat(memory): add embedding/importance/lastAccessedAt to MemoryRecord + dedup hint fields, back-compat migration (M3 data)"`。

---

## Task 4: 三因子检索评分(relevance + recency + importance)(M3b)

**Files:** Modify `src/domain/context-pack.ts`(新增 `scoreMemoryForRetrieval` + 重构 `collectRelevantMemories`);Test `src/domain/context-pack.test.ts`(或 memory-retrieval 新测试)。

- [ ] **Step 1: 写失败测试**——纯函数评分:更近 + 更重要 + 语义更相关的记忆排更前;无 queryEmbedding 时退回子串。

```ts
import { scoreMemoryForRetrieval } from "./context-pack";
it("ranks by relevance+recency+importance; falls back to substring without embedding", () => {
  const now = "2026-06-20T00:00:00Z";
  const recent = { id:"a", text:"放权 信任", importance:9, createdAt:"2026-06-19T00:00:00Z", lastAccessedAt:"2026-06-19T00:00:00Z" };
  const old =    { id:"b", text:"放权 信任", importance:2, createdAt:"2026-01-01T00:00:00Z", lastAccessedAt:"2026-01-01T00:00:00Z" };
  const sRecent = scoreMemoryForRetrieval(recent as any, { topicTokens:["放权"], now });
  const sOld = scoreMemoryForRetrieval(old as any, { topicTokens:["放权"], now });
  expect(sRecent).toBeGreaterThan(sOld); // 同文本,近且重要的更高
});
```

- [ ] **Step 2: 跑测试确认失败**。
- [ ] **Step 3: 实现** `scoreMemoryForRetrieval(record, { topicTokens, queryEmbedding?, now, alpha=0.6, beta=0.25, gamma=0.15 })`:
  - relevance = queryEmbedding && record.embedding ? `cosineSimilarity(queryEmbedding, record.embedding)` : 子串/token 命中归一(复用 `rankMemoryTexts` 逻辑,归一到 0-1)。
  - recency = `Math.pow(0.995, hoursSince(record.lastAccessedAt ?? record.createdAt, now))`(Generative Agents 衰减)。
  - importance = `(record.importance ?? 5) / 10`。
  - score = `alpha*relevance + beta*recency + gamma*importance`。
  重构 `collectRelevantMemories` 用它排序取前 5(签名加可选 `queryEmbedding`);无 embedding 时行为与现状一致(子串)。**注:`hoursSince` 用传入的 `now` 字符串计算,不调 `Date.now()`(domain 纯函数)。**
- [ ] **Step 4: 跑测试确认通过 + 全量回归**。
- [ ] **Step 5: Commit** — `git add src/domain/context-pack.ts src/domain/context-pack.test.ts && git commit -m "feat(memory): relevance+recency+importance retrieval scoring with substring fallback (M3b)"`。

---

## Task 5: 接通语义检索 + approve 时算 embedding/importance(M3c 接线)

**Files:** Modify `src/domain/context-pack.ts`(buildInterviewContextPack 接收可选 queryEmbedding)、`src/domain/memory.ts`(approve 接收预计算 embedding/importance)、`apps/api/src/routes/interview-sessions.ts`(turn 端点算 queryEmbedding)、`apps/api/src/routes/memory-candidates.ts`(approve 算 embedding/importance);Test 相应。

- [ ] **Step 1: 读** buildInterviewContextPack 调用链(谁传 options)、memory-candidates approve 路由、interview turn 路由如何拿 embeddingClient。
- [ ] **Step 2(approve 富化,TDD)**:`approveMemoryCandidate(state, candidateId, opts?: { embedding?: number[]; importance?: number })` —— 纯函数,把 opts 存进新 MemoryRecord(默认 importance=从 reviewScore 映射 1-10;embedding 缺省 undefined)。测试:传 embedding/importance → record 带上;不传 → 兼容旧行为。
- [ ] **Step 3(approve 路由)**:`memory-candidates.ts` approve 端点在有 `embeddingClient` 时 `embed([candidate.text])` 取 embedding,importance 用 LLM(有 chatClient,1-10)或 `Math.round(reviewScore/10)` 兜底,传进 `approveMemoryCandidate`。无 client → 不传。
- [ ] **Step 4(检索接线)**:`buildInterviewContextPack(state, options)` 的 options 加可选 `queryEmbedding`;传进 `collectRelevantMemories`。interview turn 路由(`/turns`)在有 embeddingClient 时,对"当前 topic / 最近 user 轮"`embed` 得 queryEmbedding 传入。**改掉 context-pack.ts:279 那条"不穿 queryEmbedding"的 ponytail 决定**(注释更新为"路由有 embeddingClient 时穿入,否则子串")。
- [ ] **Step 5(集成测试)**:server.inject——注入 fake embeddingClient,approve 一条候选→record 带 embedding;之后专访 turn 的 contextPack 召回该记忆(用 cosine);无 embeddingClient 时仍走子串、不崩。
- [ ] **Step 6: 全量回归 + Commit** — `git add` 改动文件+测试,`git commit -m "feat(memory): embed on approve + wire queryEmbedding into interview context pack (M3c)"`。

---

## Task 6: extract-then-update 去重/冲突提示(HITL 中心)(M2)

**Files:** Modify `src/domain/memory.ts`(新增 `planMemoryUpdate`)、产候选处(finalize/import/corpus 调用点标注)、`src/features/memory/MemoryGovernanceView.tsx`(展示建议);Test `src/domain/memory.test.ts`。

- [ ] **Step 1: 写失败测试**——纯函数:新候选与已有记忆高相似 → 标 `update`/`noop` + similarToRecordId;无相似 → `add`。

```ts
import { planMemoryUpdate } from "./memory";
it("flags near-duplicate candidate against existing memories (Mem0 extract-then-update, HITL surfaced)", () => {
  const existing = [{ id:"m1", text:"用户偏好先小范围验证再放权", status:"confirmed", embedding:[0.1,0.2,0.3] } as any];
  const cand = { text:"用户喜欢先验证再授权", embedding:[0.1,0.2,0.31] } as any;
  const plan = planMemoryUpdate(cand, existing, { threshold: 0.9 });
  expect(plan.op).toBe("update");           // 高相似 → 建议更新而非新增
  expect(plan.similarToRecordId).toBe("m1");
  // 无 embedding 时退回 token 重叠
  const plan2 = planMemoryUpdate({ text:"完全无关的内容 xyz" } as any, existing, { threshold: 0.9 });
  expect(plan2.op).toBe("add");
});
```

- [ ] **Step 2: 跑测试确认失败**。
- [ ] **Step 3: 实现** `planMemoryUpdate(candidate, existingRecords, { threshold=0.88, similarityFn? })`:相似度 = embedding 都在用 cosine,否则 token 重叠归一;最相似超 threshold → `{op:"update", similarToRecordId}`(留给 HITL 决定是否合并),否则 `{op:"add"}`。**矛盾(conflict)检测留给有 LLM 时的可选增强**(本任务先做 add/update/noop,conflict 作为 `suggestedUpdate` 取值占位,标注但不自动删)。在产候选的地方(Task1/2 finalize、import、corpus)对新候选填 `similarToRecordId/suggestedUpdate`。
- [ ] **Step 4(UI)**:`MemoryGovernanceView` 候选卡若有 `suggestedUpdate==="update"`,显示提示"似已有记忆:〈similar record 文本〉——确认将合并/或仍新增",给审核者选择(合并到该 record / 仍新增)。保持 HITL 决策权。
- [ ] **Step 5: 全量回归 + Commit** — `git commit -m "feat(memory): extract-then-update dedup hint surfaced to HITL reviewer (M2)"`。

---

## Task 7: 清理死的 profile 记忆平行存储(M4)

**Files:** Modify `src/domain/context-pack.ts`(去掉第二来源注入)、`src/features/profile/ProfileView.tsx`(改从 memoryRecords 取)、可能 `types.ts`/`seed.ts`(若删字段);Test。

- [ ] **Step 1: 读** context-pack.ts:292 把 `profile.confirmedMemories/inferredMemories` 当 record 注入处 + ProfileView 展示处(:130/:134)。
- [ ] **Step 2: 写测试**——contextPack 的记忆来源只来自 memoryRecords(不再混入 profile 两数组),无重复。
- [ ] **Step 3: 实现**——context-pack 去掉对 `profile.confirmedMemories/inferredMemories` 的注入(单一来源=memoryRecords)。ProfileView 的"系统记忆"区改从 `state.memoryRecords.filter(status==="confirmed")` 取展示。**择简:保留 profile 两字段于 type(避免大面积迁移),但停止写入/注入**;在 seed 里清空它们(或保留作纯展示的初始示例,注释说明)。grep 确认无其它消费者。
- [ ] **Step 4: 全量回归 + Commit** — `git commit -m "refactor(memory): single source of truth = memoryRecords, drop dead profile parallel store from context (M4)"`。

---

## Task 8: 轻量记忆巩固"整理记忆"(M5,可选最轻)

**Files:** Modify `src/domain/memory.ts`(`dedupeMemoryRecords`)、`apps/api/src/routes/memory-candidates.ts` 或新增 route(整理动作)、`MemoryGovernanceView.tsx`(按钮);Test。

- [ ] **Step 1: 写失败测试**——`dedupeMemoryRecords(records, { threshold, similarityFn? })` 把近重复 confirmed 记忆合并(保留较新/较重要那条,另一条标 deprecated + reason)。

```ts
it("dedupeMemoryRecords merges near-identical confirmed memories", () => {
  const recs = [{ id:"a", text:"先验证再放权", status:"confirmed", importance:8, createdAt:"2026-06-19...", embedding:[0.1,0.2] },
                { id:"b", text:"先验证再授权", status:"confirmed", importance:3, createdAt:"2026-05-01...", embedding:[0.1,0.21] }] as any;
  const out = dedupeMemoryRecords(recs, { threshold: 0.9 });
  expect(out.find(r=>r.id==="b").status).toBe("deprecated"); // 弱的被弃,强的留
});
```

- [ ] **Step 2: 跑确认失败 → 实现** `dedupeMemoryRecords`(纯函数,相似度 embedding/token;成对超阈值则弃 importance 低/更旧者,标 deprecated + `deprecatedReason="记忆整理:与〈id〉合并"`)。
- [ ] **Step 3(动作)**:记忆页加"整理记忆"按钮 → 调一个端点跑 dedupe(有 chatClient 时可附 LLM 概括"把这组相似记忆提炼成一条",作为新候选交 HITL;无则仅去重)。loading + 结果反馈(setNotice"整理:合并 N 条")。
- [ ] **Step 4: 全量回归 + Commit** — `git commit -m "feat(memory): lightweight consolidation 整理记忆 (dedup + optional LLM summary, HITL) (M5)"`。

---

## Task 9: 全量验证 + 视觉自审 + 推送

- [ ] **Step 1:** 停 dev(`lsof -ti :5173 :8787|xargs kill -9`),`npx playwright test`;修因记忆 UI 变化(候选合并提示、整理按钮)失效的 spec(memory-inline-edit / data-governance 等)。
- [ ] **Step 2:** 自审:专访结束产生的候选是否随内容变化(不再模板)?有 key 时召回是否语义化?候选去重提示是否出现?整理记忆是否可用?全程无 key 是否仍可用不崩?
- [ ] **Step 3:** 全量 `npm run typecheck` + `npx vitest run --exclude "**/*.real.test.ts"` + `npx playwright test` 全绿;推送 origin/main。
- [ ] **Step 4:** 派独立对抗审查(像之前几轮)审 M1-M5:重点查"语义检索是否真接进主访谈线(不是又一个不被调用的函数)"、"无 key 路径真不崩"、"approve embedding 真存真用"。整改真缺陷。

---

## Self-Review
**1. 覆盖:** M1 抽取做实=Task1/2;M3 语义检索=Task3/4/5;M2 去重冲突=Task6;M4 死代码=Task7;M5 巩固=Task8;验证+对抗审查=Task9。能力矩阵 9 项中 ❌/⚠️ 的(语义检索/时序/冲突/去重/巩固/抽取)均有对应 Task;HITL/分型保留。
**2. 占位扫描:** 无 TBD;每 Task 有具体文件、签名、TDD 代码。embedding 异步统一在路由层、domain 纯函数接收预计算值——一致。
**3. 类型一致:** `scoreMemoryForRetrieval`/`planMemoryUpdate`/`dedupeMemoryRecords`/`approveMemoryCandidate(…,opts)` 跨 Task 命名/签名一致;MemoryRecord 新字段(embedding/importance/lastAccessedAt)Task3 定义、Task4/5/8 使用。
**4. 风险:** 语义检索接线(Task5)是"假打通"高发区→Task9 对抗审查专项核验;全程无 key 降级 + 复用现有 cosine/embedding client,零新依赖;HITL 决策权保留(Task6 不自动改库)。
