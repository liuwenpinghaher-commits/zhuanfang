# Phase 4: 去 seed 污染 + 真今日台/会前卡片 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** 用户的第一屏（今日访谈台 + 会前卡片）反映"用户自己"，不再复读"救火/授权"demo；新用户得到干净起点，demo 改为显式可选。

**Architecture:** (1) 去掉 `context-pack.ts` 里硬编码的 `控制感/救火/标题/张力`，改为从真实 top theme / 最近资产泛化推导；(2) 新增 `intelligence/interview-card-llm.ts`，创建 session 时（有 chatClient）用 LLM 基于真实召回数据合成 whyNow / openingQuestion / 选题，失败回退确定性；(3) 拆分 demo 种子与空起点：默认空，reset 归空，提供"加载示例数据"显式入口。

**Tech Stack:** TypeScript, vitest, React, 既有 BailianChatClient。

---

### Task 1: 去硬编码 + LLM 合成会前卡片

**Files:**
- Modify: `src/domain/context-pack.ts` (`buildInterviewCard:217`, `buildInterviewGuide:468` 的硬编码串)
- Create: `apps/api/src/intelligence/interview-card-llm.ts`
- Modify: `apps/api/src/routes/interview-sessions.ts` (`POST /` 创建时调用)
- Test: `src/domain/context-pack.test.ts`（去硬编码回归）+ `apps/api/src/intelligence/interview-card-llm.test.ts`（mock client）

- [ ] **Step 1: 写失败测试** — 卡片不再含硬编码 demo 串（当 state 无"控制感"主题时）

`src/domain/context-pack.test.ts` 追加：
```ts
it("does not parrot the 救火/控制感 demo when the user has unrelated themes", () => {
  const state = createInitialProductState();
  // 把种子主题改成无关主题，模拟真实用户
  state.themes = [{ id: "t1", name: "搬家焦虑", summary: "关于搬到新城市的不安", maturity: "聚焦", representativeQuote: "我怕在新城市没有朋友", appearances: 2, nextQuestion: "你最担心失去什么？", updatedAt: new Date().toISOString() }];
  const card = buildInterviewCard(state);
  expect(card.title).not.toContain("救火");
  expect(card.potentialTension).not.toContain("授权");
  expect(`${card.title}${card.whyNow}`).toMatch(/搬家|新城市|朋友/);
});
```

- [ ] **Step 2: 跑测试确认失败** — `npx vitest run src/domain/context-pack.test.ts` → FAIL（当前硬编码 `救火/控制感`）。

- [ ] **Step 3: 去硬编码 context-pack.ts**

把 `buildInterviewCard`/`buildInterviewGuide` 里所有字面量 `控制感`/`救火`/标题 `"你对"救火"和放手的真实边界"`/张力 `"你一边想授权…"` 替换为从数据泛化：
- 选 `topTheme = [...state.themes].sort((a,b)=>b.appearances-a.appearances)[0]`；
- `title = topTheme ? \`关于「${topTheme.name}」的专访\` : "今天想聊点什么？"`；
- `whyNow = topTheme?.summary ?? "从你最近的一段记录继续。"`；
- `potentialTension = topTheme?.nextQuestion ?? "（暂无明显张力，先自由聊。）"`；
- `suggestedOpening = topTheme?.nextQuestion ?? "最近有什么一直在想、却没说清楚的事？"`。
> 不要再出现 `theme.name === "控制感"` 这类按 demo 名硬匹配。

- [ ] **Step 4: 新增 LLM 卡片合成器**

`apps/api/src/intelligence/interview-card-llm.ts`：导出 `synthesizeInterviewCard(state, baseGuide, chatClient): Promise<{ whyNow; suggestedOpening; potentialTension; likelyOutputs: string[] }>`。prompt 喂入真实召回（top themes、open debts、最近 notes 的 summary、relevantMemories），要求基于真实数据生成"为什么现在聊/开场问题/潜在张力/可能产出"，JSON 输出，反幻觉（"只基于给定数据"）。复用 `intelligence/llm-json.ts` 解析；解析失败 throw。

测试 `interview-card-llm.test.ts`：mock chatClient 返回固定 JSON，断言映射正确；mock 抛错时上层（route）回退确定性（在 Step 6 路由层验证）。

- [ ] **Step 5: 路由接线（创建 session 时合成）**

`POST /api/interview-sessions` handler：在 `createSessionDraft` 得到 session 后，若 `options.bailianChatClient` 存在，`try { const synth = await synthesizeInterviewCard(state, session.guide, chatClient); session.card = { ...session.card, ...synth }; } catch { /* 结构化 fallback 日志，保留确定性 card */ }`。

- [ ] **Step 6: 跑测试 + 全量** — `npx vitest run`、`npx tsc -b`、后端 tsc 自查（Phase 3 后用 `npm run typecheck:api`）。手动：`npx tsx scripts/verify-finalize.ts` 改造或新写脚本确认创建 session 的 card 反映真实主题。

- [ ] **Step 7: 提交**
```bash
git add src/domain/context-pack.ts src/domain/context-pack.test.ts apps/api/src/intelligence/interview-card-llm.ts apps/api/src/intelligence/interview-card-llm.test.ts apps/api/src/routes/interview-sessions.ts
git commit -m "fix(credibility): de-hardcode interview card + LLM-synthesize it from the user's real assets"
```

---

### Task 2: 干净起点 + demo 改为显式可选

**Files:**
- Modify: `src/domain/engine.ts` (`createInitialProductState` 拆为 `createDemoProductState` + `createEmptyProductState`)
- Modify: `apps/api/src/product-state-repository.ts`、`packages/db/src/sqlite-product-state-repository.ts`（默认/reset 用 empty）
- Modify: `src/domain/storage.ts`（`loadProductState` 首次用 empty）
- Modify: `src/App.tsx` + 某 view（"加载示例数据"按钮）
- Test: `src/domain/engine.test.ts`

- [ ] **Step 1: 写失败测试**
```ts
it("a fresh/empty state has no seeded demo assets", () => {
  const s = createEmptyProductState();
  expect(s.points).toHaveLength(0);
  expect(s.themes).toHaveLength(0);
  expect(s.notes).toHaveLength(0);
});
```

- [ ] **Step 2: 跑测试确认失败**（`createEmptyProductState` 不存在）。

- [ ] **Step 3: 拆分种子**
- 把现 `createInitialProductState`（=demo 种子）改名/包装为 `createDemoProductState`（保留所有 demo 资产，供"加载示例"用）。
- 新增 `createEmptyProductState()`：与 demo 同 `systemConfig`/`profile`/`revision:0`，但所有资产数组为 `[]`。
- 为兼容大量现有调用，保留 `createInitialProductState` 名字但让它 = `createEmptyProductState`（**默认空**）。检查并更新依赖 demo 数据的测试（它们改用 `createDemoProductState`）。

- [ ] **Step 4: 默认与 reset 归空**
- 两个 repo 的初始 + `resetState` 用 `createEmptyProductState`。
- `storage.ts` 首次加载（localStorage 空时）用 `createEmptyProductState`。

- [ ] **Step 5: "加载示例数据"入口**
`App.tsx` 加 handler `loadDemoData()`：`setProductState(createDemoProductState())` + 提示；在 HomeView 空态或 ConfigView 放一个按钮调用它（仅当资产全空时显示，避免覆盖真实数据；覆盖前 `window.confirm`）。

- [ ] **Step 6: 跑测试 + 全量**（注意：很多现有测试假设了 demo 数据，需逐一改用 `createDemoProductState`；`npx vitest run` 全绿为准）。

- [ ] **Step 7: 提交**
```bash
git add -A
git commit -m "fix(credibility): empty state by default; demo data is now an explicit opt-in load"
```

---

## Self-Review
- **Spec coverage**：审计 E（硬编码卡片 + seed 是唯一初始态 + reset 重播种）→ Task 1（去硬编码 + LLM 卡片）+ Task 2（空起点 + demo 可选）。
- **类型一致性**：`InterviewCard` 字段不变，只换内容来源；`createEmptyProductState`/`createDemoProductState` 返回同 `ProductState`。
- **Placeholder 扫描**：无；卡片字段推导给了具体表达式。
- **风险（重要）**：Task 2 把默认初始态从 demo 改空，会让**大量现有测试**（断言种子资产存在）失败——这是预期的，Step 6 要求逐一改用 `createDemoProductState` 并全绿。这是本套方案改动面最广的一处，建议放在 Phase 1–3 之后做。
