# 阶段 2 · 信息架构前端清账 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development。每 Task 派 fresh subagent,前端改动用 vitest 组件测试 + 现有 Playwright 兜底。Steps 用 checkbox。

**Goal:** 消解阶段 2 的 8 条前端 清账 问题(P1-5/P1-6 空状态、P1-22 provider 单一真源、P1-23 label 嵌套、P2-1 死代码、P2-11 默认 voice、P2-13 React key、P2-16 一键开始)。

**Architecture:** 全部为对**已拆分的独立视图组件**(`src/features/*`)与 `src/App.tsx` 的局部修复。无新依赖。

**Tech Stack:** React + Vite + TypeScript, Vitest(组件测试), Playwright(e2e 兜底)。验证:`npm run typecheck` / `npx vitest run`。

主设计:`docs/superpowers/specs/2026-06-18-notebook-paradigm-refactor-design.md` 第 4 节阶段 2 表(8 条)。

---

## Scope 决策(诚实划界)

主设计阶段 2「关键交付」含"时间轴首页 + Track 工作区 + App.tsx 拆分"的大 IA 重构愿景。但:
1. **可验收 清账 = 这 8 条**(design 第 260 行统计:阶段2 = 8 条),本计划全覆盖 8 条。
2. 调查证实**所有视图已是独立组件**,App.tsx 长是因状态+业务+实时语音逻辑,**非内联视图**;8 条里只有 P2-1(一行死代码)涉及 App.tsx 结构。
3. **不做**:投机式全量 IA 视觉重写 / App.tsx 大拆分——8 条不要求、高回归风险、且 IA 视觉重设计属创意 UI 工作需单独 brainstorm+用户确认。按 ponytail 不为偏好而重写。

→ 本计划 = 修 8 条。大 IA 重构若要做,另立 spec 走 brainstorming。

---

## 通用约束(每 Task 适用)

- 真实代码在顶层 `src/`,**不是** zhuanfang/。grep 排除 zhuanfang。
- 提交**只 `git add` 本 Task 改动的具体文件**,严禁 `git add -A/.`。
- 每 Task 结束:`npm run typecheck` PASS + `npx vitest run` 全绿(无新增失败)+ `git status --short` 确认无关文件未暂存,再提交。
- 前端有行为/渲染变更的 Task:写 vitest 组件测试(参考现有 `src/features/empty-state-render.test.tsx`、`ConfigView.test.tsx` 的写法)。

---

## Task 1: P1-23 + P2-1 — 显见 bug(label 嵌套 + 死 return)

**Files:** Modify `src/features/config/ConfigView.tsx`(label 嵌套,约 :525-562)、`src/App.tsx`(:1239 `return;return;`)。

- [ ] **Step 1:** 读 `src/features/config/ConfigView.tsx:505-565` 确认 `<label>` 嵌套——第 526 行新开 label、第 562 行多余 `</label>`。读 `src/App.tsx:1235-1242` 确认 `toggleRealtimeRecording` catch 块里第 1239 行的双 `return;`。
- [ ] **Step 2:** 修 ConfigView:修正 label 结构(删多余的 `</label>` 或调整开闭顺序,使每个 `<label>` 正确配对、无非法嵌套)。修 App.tsx:删第二个不可达 `return;`。
- [ ] **Step 3:** `npm run typecheck` exit 0 + `npx vitest run` 全绿(ConfigView.test.tsx 仍过)。若能,补一条 ConfigView 渲染断言确认 label 结构合法。
- [ ] **Step 4:** 提交:只 add ConfigView.tsx + App.tsx(+测试若改),`git commit -m "fix(ui): correct ConfigView label nesting + remove dead return (P1-23, P2-1)"`。

---

## Task 2: P1-5 + P1-6 — NotesView / ThemesView 空状态

**Files:** Modify `src/features/notes/NotesView.tsx`、`src/features/themes/ThemesView.tsx`;Test `src/features/empty-state-render.test.tsx`(扩展)。

- [ ] **Step 1:** 读 `src/features/notes/NotesView.tsx`(:20-21 `state.notes.map`)、`src/features/themes/ThemesView.tsx`(:51-52 `state.themes.map`)、以及 `src/features/corpus/CorpusLearningView.tsx:99-104` 的 `empty-module` 空状态模式(复用其 className/结构)。读 `src/features/empty-state-render.test.tsx` 看现有空状态测试写法。
- [ ] **Step 2:** 写失败测试:扩 `empty-state-render.test.tsx`——NotesView 在 `notes: []` 时渲染空状态文案(非空容器);ThemesView 在 `themes: []` 时渲染空状态文案。
- [ ] **Step 3:** 跑确认失败。
- [ ] **Step 4:** 实现:两个视图在 `.map` 前加 `length === 0` 条件,渲染与 CorpusLearningView 一致风格的空状态(真实有用的引导文案,如"还没有笔记 / 主题线,完成一次专访后会出现")。
- [ ] **Step 5:** 跑通过 + 全量 typecheck/vitest。
- [ ] **Step 6:** 提交:只 add 两视图 + 测试,`git commit -m "feat(ui): empty states for NotesView and ThemesView (P1-5, P1-6)"`。

---

## Task 3: P1-22 — provider 列表统一到单一真源

**Files:** Modify `src/features/config/ConfigView.tsx`(:341 硬编码 3 个)、`src/features/search/SearchIntelligenceView.tsx`(:35-41);真源 `src/capabilities/contracts.ts` 的 `searchProviderLabels`(6 个)。

- [ ] **Step 1:** 读 `src/capabilities/contracts.ts` 的 `searchProviderLabels`(6 provider 真源)。读 `ConfigView.tsx:341` 硬编码 `["bailian","anysearch","local-demo"]` 与 `SearchIntelligenceView.tsx:35-41`(providerActions 3 个 + :41 allProviders 6 个未用)。确认前端可直接 import `searchProviderLabels`(同 src/ 下)。
- [ ] **Step 2:** 写失败测试(ConfigView.test.tsx 或新建):ConfigView provider 选择项数量/集合 = `searchProviderLabels` 的键集合(当前只 3 个 → FAIL)。
- [ ] **Step 3:** 跑确认失败。
- [ ] **Step 4:** 实现:ConfigView 与 SearchIntelligenceView 都改为从 `searchProviderLabels`(单一真源)派生 provider 列表与展示名,删除硬编码。注意保持仅展示**有效/已配置**的 provider 的既有过滤逻辑(若有),不要把 UI 暴露的 provider 集合无意义扩大到不支持的——以"单一真源 + 一致过滤"为准。**若发现 3-vs-6 的差异是有意的(某些 provider 后端未接,前端故意不暴露),则单一真源应是"已接线 provider"集合,统一各处用它,而非强行显示 6 个。DONE_WITH_CONCERNS 说明取舍。**
- [ ] **Step 5:** 跑通过 + 全量 typecheck/vitest。
- [ ] **Step 6:** 提交:只 add 改动文件 + 测试,`git commit -m "refactor(ui): unify provider lists to single source (P1-22)"`。

---

## Task 4: P2-11 — 默认 voice 修正(消除 418)

**Files:** Modify `src/domain/seed.ts`(:211 `defaultVoice`);可能 `src/domain/storage.ts` 的 voice normalize。

- [ ] **Step 1:** 读 `src/domain/seed.ts:211`(当前 `defaultVoice: "warm-interviewer"` —— 后端不存在该 voice → 418)。读 `src/domain/storage.ts` 的 `normalizeVoiceConfig`(看合法 voice 校验与默认回退逻辑、合法 voice 取值集合)。**确认有效 voice ID**:据项目约定 cosyvoice-v3-plus 仅 `longanyang`/`longanhuan` 可用(见 [[zhuanfang-cascade-voice]]),设计指定默认 `longanyang`。
- [ ] **Step 2:** 写失败测试(storage.test.ts 或 seed 相关):`createInitialProductState().systemConfig.voice.defaultVoice` 是合法 voice(在 normalizeVoiceConfig 的合法集合内)→ 当前 `warm-interviewer` 非法 → FAIL(或 normalize 会把它改掉的断言)。
- [ ] **Step 3:** 跑确认失败。
- [ ] **Step 4:** 实现:seed `defaultVoice` 改为 `"longanyang"`;确认 normalizeVoiceConfig 对历史非法默认值有安全回退(若无则补:非法 defaultVoice → 回退 longanyang)。
- [ ] **Step 5:** 跑通过 + 全量 typecheck/vitest。
- [ ] **Step 6:** 提交:只 add 改动文件 + 测试,`git commit -m "fix(voice): default to valid longanyang voice, avoid 418 (P2-11)"`。

---

## Task 5: P2-13 — 内容字符串作 React key 改稳定 key

**Files:** Modify `src/features/corpus/CorpusLearningView.tsx`(:121 `key={dimension.name}`、:135 `key={rule}`)。grep 全 features 其它同类。

- [ ] **Step 1:** `grep -rn "key={" src/features src/components --include="*.tsx" | grep -vE "key={[a-zA-Z]+\.(id|Id)}"` 粗筛用内容串/index 之外可疑 key。重点确认 `CorpusLearningView.tsx:121,135`。判断这些列表项是否有稳定 id 可用;若无,用 `${稳定父id}-${index}` 组合(index 仅作为无 id 时的兜底,且列表非重排场景)。
- [ ] **Step 2:** 实现:把内容字符串 key 改为稳定 key(优先实体 id;无 id 用 `父id-index` 组合)。不改渲染输出。
- [ ] **Step 3:** `npm run typecheck` exit 0 + `npx vitest run` 全绿。
- [ ] **Step 4:** 提交:只 add 改动文件,`git commit -m "fix(ui): use stable React keys instead of content strings (P2-13)"`。

---

## Task 6: P2-16 — 首页一键开始

**Files:** Modify `src/App.tsx`(`prepareInterview` :453-459 / `startInterview` :461-481 / HomeView onStart 绑定 :1298)、可能 `src/features/home/HomeView.tsx`。

- [ ] **Step 1:** 读 `src/App.tsx:453-481`(`prepareInterview` 设 view="interview" 但不建会话;`startInterview` 才建会话)、:1298(`onStart={prepareInterview}`)、:1316(InterviewView 内部 `onStart={startInterview}`)、`src/features/home/HomeView.tsx:33`(`onStart("decision")`)。理解二次点击根因:首页点击只 prepare,真正 start 在 InterviewView 内再点一次。
- [ ] **Step 2:** 设计最小修法:**首页点击直接一键启动**——HomeView 的 onStart 走"prepare + 立即 startInterview"(合并),使点一次即创建会话并进入进行中的专访。**同时保留 InterviewView 内部 start 路径**,以兼容用户从导航菜单(非首页)进入 interview 视图时仍需显式开始的场景(确认该场景存在;若不存在则简化)。
- [ ] **Step 3:** 写测试(若可在组件层):或依赖现有 Playwright `interview-lifecycle.spec.ts`/`navigation.spec.ts` 兜底。至少加一条断言:首页 onStart 后 session 非 null(已创建)。**若一键合并会破坏 InterviewView 既有流程或 e2e,DONE_WITH_CONCERNS 说明。**
- [ ] **Step 4:** `npm run typecheck` exit 0 + `npx vitest run` 全绿。
- [ ] **Step 5:** 提交:只 add 改动文件,`git commit -m "fix(ui): one-click start from home page (P2-16)"`。

---

## Self-Review

**1. Spec 覆盖:** 8 条全覆盖——T1(P1-23,P2-1)、T2(P1-5,P1-6)、T3(P1-22)、T4(P2-11)、T5(P2-13)、T6(P2-16)。

**2. 占位扫描:** 无 TBD。P1-22/P2-16 的取舍不确定处用 DONE_WITH_CONCERNS 闸门。

**3. 一致性:** 命令统一;提交禁 git add -A;无新依赖;空状态复用 CorpusLearningView 既有模式。

**4. Scope 诚实:** 明确不做投机式 IA 全量重写;8 条 清账 = 阶段 2 可验收口径。大 IA 重构另立 spec。
