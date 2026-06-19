# R3 · 外部调研合并(删 intel,统一到 SearchBrief)Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development。迁移走 TDD + 往返;删除先 grep 确认;UI 配 Playwright。

**Goal:** 把"情报中心"并入"联网素材",合为一个**外部调研**功能。删掉断在闭环外的 intel 子系统,统一到 `SearchBrief`(本就深度喂专访,断点由统一自动修复);"持续追踪"语义用 brief 的 `tracked` 标志 + 手动刷新保留(丢弃弱的自动调度)。

**Architecture:** 删除 intel 全套(IntelTask/IntelItem/triage/scheduler/IntelView/routes)+ migration 丢弃历史 intel 数据(诚实清除,记日志)+ SearchBrief 加 `tracked?`。前端 SearchIntelligenceView 升级为"外部调研"。

**Tech Stack:** TS/React, Fastify, Vitest, Playwright。验证:`npm run typecheck` / `npx vitest run --exclude "**/*.real.test.ts"` / `npx playwright test`。

设计:`docs/superpowers/specs/2026-06-19-cognitive-assets-consolidation-design.md` 第 3 节 R3。

---

## 通用约束
- 顶层 `src/`/`apps/`(忽略 zhuanfang)。提交只 `git add` 本 Task 文件,禁 `git add -A/.`。
- 每 Task:`npm run typecheck` PASS + `npx vitest run --exclude "**/*.real.test.ts"` 全绿 + git status 核无关文件未暂存。

## 已核实(删除清单 + 喂专访路径)
- **删文件**:`apps/api/src/intel-run.ts`、`intel-scheduler.ts`、`intelligence/intel-triage-llm.ts`、`routes/intel.ts`、`src/domain/intel.ts`、`src/domain/intel.test.ts`、`src/features/intel/IntelView.tsx`。
- **改引用**:`src/domain/types.ts`(IntelTask/IntelItem + ProductState.intelTasks/intelItems)、`storage.ts`(normalize)、`migration.ts`(counts)、`privacy.ts`(P0-11 加的 intel inventory)、`seed.ts`、`engine.ts`(re-export + createInitialProductState/createEmptyProductState)、`apps/api/src/server.ts`(intel 路由注册 + startIntelScheduler)、`src/App.tsx`(intel view/回调)、`src/api/productApi.ts`(intel 客户端方法)。
- `SearchBrief` 经 `resolveInterviewContextSearchBrief`(context-pack.ts:209/279)→ `InterviewContextPack.searchBriefs`(:338)喂专访。`appliedToSessionIds`(types.ts:878)已有。

---

## Task 1: 删除 intel 子系统 + 迁移丢弃历史 intel 数据 + SearchBrief 加 tracked

**Files:** Delete 上述 7 文件;Modify types/storage/migration/privacy/seed/engine/server/productApi。

- [ ] **Step 1:** `grep -rn "intelTasks\|intelItems\|IntelTask\|IntelItem\|runIntelTaskOnce\|startIntelScheduler\|triageIntelResults\|intelItemToKnowledgeDebt\|createIntelTask\|/intel/" src/ apps/ --include="*.ts" --include="*.tsx" | grep -v zhuanfang`。掌握全部引用点。
- [ ] **Step 2(删文件):** `git rm` 上述 7 个 intel 文件。
- [ ] **Step 3(剥引用):**
  - `types.ts`:删 `IntelTask`、`IntelItem` 接口 + `ProductState.intelTasks`、`ProductState.intelItems`。
  - `engine.ts`:删 intel 相关 re-export;`createInitialProductState`/`createEmptyProductState` 删 `intelTasks: []`/`intelItems: []`。
  - `seed.ts`:删 intelTasks/intelItems 字段。
  - `storage.ts normalizeProductState`:删 intelTasks/intelItems 归一行(它们不再是 ProductState 字段);若历史 localStorage 含这俩 key,normalize 自然丢弃(不再读取)。
  - `migration.ts buildMigrationEntityCounts` + `privacy.ts buildPrivacyReport`:删 intel 计数/inventory 类别(P0-11 加的)。
  - `apps/api/src/server.ts`:删 `registerIntelRoutes`(或等价)注册 + `startIntelScheduler` 调用 + import。
  - `src/api/productApi.ts`:删 intel 相关客户端方法(createIntelTask/runIntelTask/...)与类型。
  - `src/App.tsx`:删 intel 的 view 分支、回调、import IntelView。
- [ ] **Step 4(SearchBrief tracked):** `types.ts` `SearchBrief` 加 `tracked?: boolean;`(注释"持续追踪:可重新调研刷新")。
- [ ] **Step 5(TDD 迁移):** `storage.test.ts` 加用例:含历史 `intelTasks:[...]`/`intelItems:[...]` 的旧 state 经 `normalizeProductState` 后,产物**不含** intelTasks/intelItems(被丢弃),其它字段无损;含 `tracked:true` 的 brief 往返保留。先跑确认(若现状会保留 intel 则失败)→ 实现 → 通过。
- [ ] **Step 6:** `npm run typecheck` exit 0(intel 引用全清,无残留)+ `npx vitest run --exclude "**/*.real.test.ts"` 全绿(删 intel.test;同步删/改其它引用 intel 的测试)。`grep -rn "IntelTask\|intelTasks" src/ apps/ | grep -v zhuanfang` 归零。
- [ ] **Step 7:** 提交:只 add 删除/改动文件,`git commit -m "refactor(research): remove disconnected intel subsystem, unify on SearchBrief + tracked (R3)"`。

---

## Task 2: 外部调研前端(升级 SearchIntelligenceView + 持续追踪 + 删 IntelView 残留)

**Files:** Modify `src/features/search/SearchIntelligenceView.tsx`、`src/App.tsx`、`src/api/productApi.ts`(刷新方法,若需);可能 `apps/api/src/routes/search.ts`(refresh 端点)。

- [ ] **Step 1:** 读 `SearchIntelligenceView.tsx`(现有 brief 创建/列表/带入专访)、App.tsx 给它的 props、`apps/api/src/routes/search.ts`(`POST /api/search/briefs` 创建 brief 的逻辑)。
- [ ] **Step 2(持续追踪):** 在外部调研视图:
  - brief 列表每条加"持续追踪"开关(置 `brief.tracked`)+ "重新调研/刷新"动作(对 tracked brief 重跑研究、更新其 sources/facts)。
  - 刷新实现:复用 `POST /api/search/briefs`(同 topic 重跑)或加 `POST /api/search/briefs/:id/refresh` 端点(重跑研究、更新该 brief 并持久化)。择简,以"能真刷新"为准;无 key 走现有降级。
  - 视图标题/文案改为"外部调研"(与导航一致);保留"带入专访"。
- [ ] **Step 3:** 确认 intel 在 App.tsx 已无 view 分支(Task 1 已删);若 SearchIntelligenceView 之前有 intel 相关 UI(provider 列表外的)清理干净。
- [ ] **Step 4(TDD/测试):** 后端若加 refresh 端点则补测试(tracked brief refresh → 更新 sources、persist);前端能组件测则测追踪开关。**至少**保证 tracked brief 仍走 `resolveInterviewContextSearchBrief` 喂专访(加一条断言:tracked brief 在 buildInterviewContextPack 的 searchBriefs 里)。
- [ ] **Step 5:** `npm run typecheck` exit 0 + `npx vitest run --exclude "**/*.real.test.ts"` 全绿。
- [ ] **Step 6:** 提交:只 add 改动文件 + 测试,`git commit -m "feat(research): 外部调研 view with tracked topics + refresh (R3)"`。

---

## Task 3: e2e 适配 + 清理验证

**Files:** Modify 受影响 e2e spec;Create/Modify 外部调研 spec。

- [ ] **Step 1:** grep `tests/e2e` 里对 `情报中心`/`intel`/`联网素材` 的引用。情报中心入口已删→删相关 e2e/断言;`外部调研`(原 search)旅程适配新文案。
- [ ] **Step 2:** `tests/e2e` 外部调研旅程:创建调研简报 → 标记持续追踪 → (可选)刷新 → 带入专访;断言 brief 可见、tracked 状态、带入入口。
- [ ] **Step 3:** `npx playwright test` 全绿。
- [ ] **Step 4:** 验证清理彻底:`grep -rn "IntelTask\|intelTasks\|IntelView\|情报中心\|/intel/" src/ apps/ tests/ --include="*.ts" --include="*.tsx" | grep -v zhuanfang` 归零(除非有意保留的历史迁移注释)。
- [ ] **Step 5:** 提交:只 add 改动 e2e,`git commit -m "test(e2e): external-research journey, remove intel (R3)"`。

---

## Self-Review
**1. Spec 覆盖:** 删 intel(T1)、统一 SearchBrief + tracked 保留追踪语义(T1/T2)、修喂专访断点=统一即修复(T1/T2 验证 tracked 喂专访)、前端外部调研(T2)、e2e(T3)。
**2. 占位扫描:** 无 TBD;删除先 grep 确认;迁移丢弃 intel 有测试与日志。
**3. 一致性:** `tracked`、外部调研命名跨 Task 一致;privacy/migration 的 intel 计数与 types 删除同步(否则 typecheck/测试会挂)。
**4. 风险:** 删整个子系统——靠 typecheck(引用全清)+ 全量回归 + 迁移往返测试 + Playwright 兜底。历史 intel 数据丢弃是有意(分析证实其断连),记日志诚实告知。
