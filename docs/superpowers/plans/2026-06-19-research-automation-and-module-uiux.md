# 外部调研自动化 + 认知资产模块 UI/UX 全面优化 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development。domain 逻辑 TDD;UI 按结构+验收 + Playwright + uiuxpromax 视觉清单。Steps 用 checkbox。

**Goal:** ① 给"外部调研"加真正的自动化情报采集(一键自动盯梢 + 打开即更新 + 可开关后台定时);② 用 uiuxpromax 准则全面优化认知资产模块(我的资产/外部调研/记忆)的 UI 与交互——修 tab 对齐、补全 loading/反馈/空状态闭环、去 emoji 图标、内联编辑替代 prompt。

**Architecture:** A 轨自动化:domain 纯函数编排(agenda→生成/刷新→去重→排序→汇总)+ 新鲜度字段 + 后端 auto-run 端点 + 可开关后台调度。B 轨 UI:CSS 地基(补 token/tab/状态)先行,再逐视图闭环交互。React+Vite+TS,深色主题,样式 `src/styles.css`(主色紫 violet)。

**Tech Stack:** TS/React, Fastify, Vitest, Playwright。验证:`npm run typecheck` / `npx vitest run --exclude "**/*.real.test.ts"` / `npx playwright test`。

设计依据:ui-ux-pro-max 准则(微交互 150–300ms、focus-visible、touch/cursor、loading/empty/error 闭环、无 emoji 图标、reduced-motion)+ 自动化情报工具最佳实践(主动议程/去重/新鲜度/排序,按单用户规模克制)。

## 已核实
- CSS token 已有:surface-{app,panel,muted,raised,glass}、text-{primary,secondary,muted}、border-{default,soft,glow}、accent-{teal,amber,green,rose}、radius-{sm:12,lg:16}。**`--border-strong` 未定义**(被 tab hover 引用 → 失效)。主色紫 rgba(139,92,246)。
- 自动化原语:`buildProactiveSearchAgenda`(search-brief.ts,从 themes/debts/decisions 出 4 议题)、`POST /api/search/auto-briefs`、`POST /api/search/briefs/:id/{refresh,track}`、`resolveInterviewContextSearchBrief`(tracked 优先喂专访)。**全手动、无去重、无新鲜度**。intel-scheduler 已于 R3 删除(需新建通用调度)。
- 缺陷清单见探查报告(本会话)。

## 通用约束
- 顶层 `src/`/`apps/`(忽略 zhuanfang)。提交只 `git add` 本 Task 文件,禁 `git add -A/.`。
- 每 Task:`npm run typecheck` + `npx vitest run --exclude "**/*.real.test.ts"` 全绿 + git status 核无关文件未暂存。

---

## Task B1: CSS 地基(token + tab 对齐 + 按钮态 + 空状态统一)

**Files:** Modify `src/styles.css`。

- [ ] **Step 1:** `:root` 补 token:`--border-strong: #52525b;`(hover 边框)、若缺再补 `--transition-fast: 150ms`/`--transition: 200ms`(若已有内联则统一)、`--focus-ring: 0 0 0 3px var(--border-glow)`。
- [ ] **Step 2:** Tab 系统(`.my-assets-tabs` / `.my-assets-tab`,:2843-2886):修对齐——tab 按钮 `display:flex; align-items:center; gap:8px; justify-content:flex-start`,计数徽章 `margin-left:auto` 右对齐固定;加 `transition: border-color/background 180ms, color 180ms`;`.active` 加底部指示条(`border-bottom:2px solid var(--accent)` 或下划线 ::after)+ 背景区分;hover 用已定义的 `--border-strong`;`margin-bottom` 提到 12–16px。统一为可复用 `.tabs/.tab` 类(供其它视图复用)。
- [ ] **Step 3:** 按钮态(`.primary-action`/`.secondary-action`,:381-425):加 `:focus-visible { box-shadow: var(--focus-ring); outline:none; }`、`:active { transform: translateY(1px); }`、`:disabled` 除 opacity 再加 `filter:grayscale(0.3)`;secondary hover 背景加深(rgba(139,92,246,0.14))。加 `.is-loading` 态(内嵌 spinner;复用一个 `.spinner` keyframes,respect reduced-motion)。
- [ ] **Step 4:** 统一空状态:把 `.empty-state` 与 `.empty-module` 收敛为一个 `.empty-state`(flex 居中、icon 22px、min-height、padding、引导文案 + 可选 CTA);各视图改用它(B2-B4 落地)。
- [ ] **Step 5:** `@media (prefers-reduced-motion: reduce)`:spinner/transition 降级(补全)。
- [ ] **Step 6:** `npm run typecheck`(CSS 不影响,但跑一遍)+ `npx vitest run --exclude "**/*.real.test.ts"` 全绿(CSS 改动不应破坏测试)。
- [ ] **Step 7:** 提交:`git add src/styles.css`,`git commit -m "style(ui): define missing tokens, fix tab alignment + button/empty states (uiux foundation)"`。

---

## Task A1: 自动化 domain(新鲜度 + 去重 + runResearchAgenda 编排,TDD)

**Files:** Modify `src/domain/types.ts`(SearchBrief 加新鲜度字段)、`src/domain/search-brief.ts`(去重 + 编排);Create/Modify 测试。

- [ ] **Step 1:** 读 `src/domain/search-brief.ts`(`buildProactiveSearchAgenda`、`createSearchBriefFromInput`、source 结构)、`types.ts` SearchBrief。
- [ ] **Step 2:** `types.ts` SearchBrief 加 `lastRefreshedAt?: string`、`staleAfterDays?: number`(默认逻辑在函数里)。
- [ ] **Step 3(TDD)新鲜度**:`search-brief.ts` 加纯函数 `isSearchBriefStale(brief, now, defaultStaleDays=14): boolean`(用 lastRefreshedAt ?? createdAt + staleAfterDays ?? default)。测试:新建不 stale、超期 stale、tracked 同样判定。
- [ ] **Step 4(TDD)去重**:加 `dedupeBriefSources(briefs): /* 标记跨简报重复来源 */` 或 `mergeSourcesDedup(existingBriefs, newSources)`——按 source.url(无 url 用 title)去重,返回去重后的 sources + 重复计数。测试:两简报含相同 url 的来源,去重正确。
- [ ] **Step 5(TDD)编排**:加 `planResearchAgendaRun(state, now): { items: SearchAgendaItem[]; staleTrackedBriefIds: string[] }`——结合 `buildProactiveSearchAgenda` + 找出过期的 tracked 简报。**纯函数,不调 provider**(provider 调用在后端 A2 用此计划驱动)。测试:有过期 tracked → 出现在 staleTrackedBriefIds;agenda 来自 buildProactiveSearchAgenda。
- [ ] **Step 6:** `npm run typecheck` + 全量 vitest 全绿。
- [ ] **Step 7:** 提交:`git add src/domain/types.ts src/domain/search-brief.ts src/domain/<test>`,`git commit -m "feat(research): brief freshness + source dedup + agenda-run planner (automation domain)"`。

---

## Task A2: 后端自动化(auto-run 端点 + 打开即更新 + 可开关后台调度)

**Files:** Modify `apps/api/src/routes/search.ts`、`apps/api/src/server.ts`(调度)、`src/api/productApi.ts`;types(SystemConfig 加调度开关)。

- [ ] **Step 1:** 读 `apps/api/src/routes/search.ts`(briefs/auto-briefs/refresh 的 provider 调用)、`server.ts:339 startServer`、`types.ts` SystemConfig(加 `research.autoScheduleEnabled?: boolean`、`research.scheduleIntervalMin?: number`)。
- [ ] **Step 2(auto-run 端点)**:`POST /api/research/auto-run`:用 A1 的 `planResearchAgendaRun(state, now)` → 对每个 agenda item 生成简报(复用现有 brief 创建 + provider 调用 + 无 key 降级)、对 staleTrackedBriefIds 刷新 → `dedupeBriefSources` 去重 → 更新 state 各简报 `lastRefreshedAt` → `replaceState` → 返回 `{ state, summary: { generated, refreshed, dedupedSources } }`(本次新增汇总)。受 llmBudget 守卫。
- [ ] **Step 3(TDD)**:测试 auto-run(注入 fake provider clients):有过期 tracked + 有主题 → 返回 summary.generated/refreshed >0,简报 lastRefreshedAt 更新,跨简报来源去重;无 key 走降级仍 200。
- [ ] **Step 4(后台调度)**:新建 `apps/api/src/research-scheduler.ts`:`startResearchScheduler(repository, clients, { intervalMs, enabled })`——`setInterval` 周期检查,enabled 且到期则跑 auto-run 编排;返回 stop 句柄。`server.ts startServer` 在 `systemConfig.research.autoScheduleEnabled` 时启动(默认关,避免无意义跑)。**仅 startServer 启,测试环境不启**(与原 intel-scheduler 教训一致)。加注释说明:服务常驻时生效,非常驻则靠 auto-run/打开即更新。
- [ ] **Step 5(客户端)**:`productApi.ts` 加 `autoRunResearch(): Promise<{state, summary}>`。
- [ ] **Step 6:** `npm run typecheck` + 全量 vitest 全绿。
- [ ] **Step 7:** 提交:`git add` 改动文件 + 测试,`git commit -m "feat(research): auto-run endpoint + toggleable background scheduler (intel automation)"`。

---

## Task B3: 外部调研视图 UI(自动盯梢 + 逐项 loading/反馈/确认/新鲜度)

**Files:** Modify `src/features/search/SearchIntelligenceView.tsx`、`src/App.tsx`(autoRun 接线 + per-brief 状态)、`src/styles.css`(局部)。

- [ ] **Step 1:** 读 `SearchIntelligenceView.tsx`(:56-226)、App.tsx 给它的 props/回调。
- [ ] **Step 2(自动盯梢)**:视图顶部加「▶ 自动盯梢」按钮 → 调 `autoRunResearch`(A2);运行中显示 loading;完成后显示"本次新增 N 条情报 · 刷新 M 条"汇总(toast/inline,3-5s 自动消失)。
- [ ] **Step 3(逐项闭环)**:每个 brief 的「带入专访/持续追踪/重新调研」按钮改为**单项 loading**(per-brief refreshingId 状态,不再全局 disabled);成功/失败各自反馈;"删除简报"加确认(复用现有 window.confirm 或更佳的确认)。brief 卡片加 `cursor` + 选中态背景 + focus-visible。
- [ ] **Step 4(新鲜度)**:用 A1 `isSearchBriefStale` 给过期简报显示「已过期·建议刷新」标记(accent-amber)。tracked 切换显示中间态。
- [ ] **Step 5(空状态)**:无简报用统一 `.empty-state` + 引导("点自动盯梢,从你的主题和知识债自动采集情报")。
- [ ] **Step 6:** `npm run typecheck` + 全量 vitest 全绿(扩组件测试:auto 盯梢按钮、per-brief loading、过期标记)。
- [ ] **Step 7:** 提交:`git add` 改动文件,`git commit -m "feat(research-ui): auto-watch + per-item loading/feedback + staleness (uiux)"`。

---

## Task B2: 我的资产视图 UI(tab 对齐 + 档案卡闭环)

**Files:** Modify `src/features/my-assets/MyAssetsView.tsx`、`src/styles.css`(局部)。

- [ ] **Step 1:** 读 `MyAssetsView.tsx`(:59-152)。复用 B1 的 tab/empty-state/button 类。
- [ ] **Step 2:** Tab:套用 B1 修好的 tab 类(对齐、过渡、active 指示、计数徽章右对齐)。
- [ ] **Step 3:** 档案卡:加 `cursor:pointer`(若可点)+ focus-visible + hover 背景;"生成播客"按钮加按压/focus 态;若有异步则 loading。资产 tab 透传保持。
- [ ] **Step 4:** 空状态(无档案/无资产)用统一 `.empty-state` + 图标 + 引导。
- [ ] **Step 5:** `npm run typecheck` + 全量 vitest 全绿。
- [ ] **Step 6:** 提交:`git add` 改动文件,`git commit -m "fix(my-assets-ui): tab alignment + archive card states (uiux)"`。

---

## Task B4: 记忆治理视图 UI(内联编辑替代 prompt + 审批闭环 + 图标)

**Files:** Modify `src/features/memory/MemoryGovernanceView.tsx`、`src/styles.css`(局部)。

- [ ] **Step 1:** 读 `MemoryGovernanceView.tsx`(:41 window.prompt、:73-122 审批/导入、:103/133 emoji)。
- [ ] **Step 2(内联编辑)**:候选"修正"从 `window.prompt` 改为**内联编辑态**(点"修正"→ 卡片内出现 textarea + 保存/取消,带字数提示);保存调现有 onEditCandidate。
- [ ] **Step 3(审批闭环)**:approve/reject/edit 按钮加 per-candidate loading + disabled(防重复点)+ 成功反馈。导入加"抽取中…"loading + 文本非空/过长提示。
- [ ] **Step 4(图标)**:🔒emoji 改为 Lucide 图标(如 `Lock`/`ShieldAlert`)。
- [ ] **Step 5(空状态)**:候选空用统一 `.empty-state` + 图标(与其它视图一致)。
- [ ] **Step 6:** `npm run typecheck` + 全量 vitest 全绿(扩测试:内联编辑出现/保存、审批 loading)。
- [ ] **Step 7:** 提交:`git add` 改动文件,`git commit -m "feat(memory-ui): inline candidate edit + approval feedback + icons (uiux)"`。

---

## Task B5: e2e 适配 + 视觉自审 + 推送

**Files:** Modify/Create `tests/e2e/*.spec.ts`。

- [ ] **Step 1:** 跑 `npx playwright test` 看 UI 改动是否破坏现有旅程;修因 DOM/文案变化失效的断言。
- [ ] **Step 2:** 新增/扩展:外部调研「自动盯梢」旅程(点按钮→出现本次新增汇总);记忆内联编辑旅程(点修正→textarea→保存)。
- [ ] **Step 3:** `npx playwright test` 全绿。
- [ ] **Step 4:** 视觉自审(uiuxpromax 清单):tab 对齐?所有异步有 loading/反馈?空状态统一?无 emoji 图标?cursor/focus 态?reduced-motion?移动端 375px 不溢出?有明显弱点改一次。
- [ ] **Step 5:** 提交 e2e + 视觉改动。最后全量 typecheck + vitest + playwright 绿,推送 origin/main(本分支即 main)。

---

## Self-Review
**1. Spec 覆盖:** ① 自动化=A1(域)+A2(端点/调度/打开即更新)+B3(UI);② UI/UX=B1(地基)+B2/B3/B4(三视图)+B5(e2e/视觉)。三种自动化触发(按需 auto-run、打开即更新、可开关后台调度)全覆盖。
**2. 占位扫描:** 无 TBD;domain 给 TDD,UI 给结构+验收+uiux 准则。
**3. 一致性:** tab/empty-state/button/spinner 在 B1 统一定义,B2-B4 复用;`isSearchBriefStale`/`planResearchAgendaRun`/`autoRunResearch` 跨 A1/A2/B3 命名一致。
**4. 风险:** 后台调度按 R3 教训仅 startServer 启、默认关、测试不启;自动化 domain 纯函数可测,provider 调用注入式;UI 改动靠 Playwright + 视觉清单兜底。
