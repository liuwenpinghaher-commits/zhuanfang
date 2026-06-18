# 阶段 0c · 数据层清账 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development。每个 Task 派 fresh subagent,遵循 TDD(先写失败测试→实现→绿)。Steps 用 checkbox 跟踪。

**Goal:** 消解阶段 0 剩余 9 条数据层问题(P0-11、P1-18、P1-19、P1-24、P2-8、P2-18、P2-19、P2-20、P2-23),让数据模型 v2 地基彻底干净。

**Architecture:** 多为 `normalizeProductState`(src/domain/storage.ts)迁移补全 + 隐私/迁移报表补全 + 一处并发校验收紧 + 一处事件裁剪。类型变更型(P2-19/20/23/8)取**最小落地**:先查引用、改后全量回归兜底,不破坏现有行为。

**Tech Stack:** TypeScript, Vitest。验证命令:`npm run typecheck` / `npx vitest run`。

主设计:`docs/superpowers/specs/2026-06-18-notebook-paradigm-refactor-design.md` 第 4 节阶段 0 表。

---

## 通用约束(每个 Task 都适用)

- 真实代码在**顶层** `src/`、`apps/`、`packages/`,**不是** `zhuanfang/`。严禁触碰 `zhuanfang/`、`CLAUDE.md`、`memory/`、`.claude/`。
- 提交时**只 `git add` 本 Task 改动的具体文件**,严禁 `git add -A/.`(仓库有大量无关未提交改动)。
- 每个 Task 结束:`npm run typecheck` PASS + `npx vitest run` 全绿(无新增失败),`git status --short` 确认无关文件未被暂存,再提交。
- TDD:先写失败测试 → 跑确认失败 → 最小实现 → 跑确认通过。

---

## Task 1: P0-11 — intel 数据纳入隐私库存 + 迁移计数

**Files:**
- Modify: `src/domain/privacy.ts`(`buildPrivacyReport`,约 :155)
- Modify: `src/domain/migration.ts`(`buildMigrationEntityCounts`,约 :109)
- Test: `src/domain/privacy.test.ts`、`src/domain/migration.test.ts`(若不存在则在最近的现有测试文件追加)

- [ ] **Step 1:** 先读 `src/domain/privacy.ts` 的 `buildPrivacyReport`、`src/domain/migration.ts` 的 `buildMigrationEntityCounts`,确认 inventory/counts 现有结构与 `ProductState` 上 intel 字段的确切名字(grep `intelTasks`/`intelItems`/`intel` in types.ts)。
- [ ] **Step 2:** 写失败测试:构造含 ≥1 个 intel 任务/条目的 state,断言 `buildPrivacyReport` 的 inventory 含 intel 类别且计数正确;`buildMigrationEntityCounts` 含 intel 计数。
- [ ] **Step 3:** 跑测试确认失败(intel 计数缺失)。
- [ ] **Step 4:** 实现:在 inventory 与 counts 中新增 intel 类别(沿用现有类别的结构/命名风格,计数取对应数组 length)。
- [ ] **Step 5:** 跑测试确认通过 + `npm run typecheck` + `npx vitest run`。
- [ ] **Step 6:** `git status --short` 核对后提交:`git add src/domain/privacy.ts src/domain/migration.ts src/domain/privacy.test.ts src/domain/migration.test.ts`(只 add 实际改动文件),`git commit -m "fix(data): include intel in privacy inventory + migration counts (P0-11)"`。

---

## Task 2: P1-18 — 乐观并发 revision 改为"必须等于"

**Files:**
- Modify: `apps/api/src/routes/state.ts`(约 :10,revision 校验)
- Test: 对应路由测试(grep `routes/state` 的测试文件;如 `apps/api/src/routes/state.test.ts` 或 server 级测试)

- [ ] **Step 1:** 读 `apps/api/src/routes/state.ts` 的 PUT/POST state 处理,确认当前 `incomingRevision < stored.revision → 409` 的确切逻辑,以及服务端 `persistState` 强制递增(`+ 1`)的位置。理解:客户端必须回发**它读到的** stored.revision,服务端递增后下次再读。
- [ ] **Step 2:** 写失败测试:已存 revision=N,客户端发 `revision=N+5`(伪造的更大值)→ 期望 **409**(当前 `<` 逻辑会放行,故失败)。再加一条:发 `revision=N` → 期望成功并服务端递增到 N+1。
- [ ] **Step 3:** 跑测试确认伪造用例失败。
- [ ] **Step 4:** 实现:把校验从 `incomingRevision < stored.revision` 改为 `typeof incomingRevision === "number" && incomingRevision !== stored.revision → 409`(必须严格等于;无 revision 字段时维持现有宽松行为)。
- [ ] **Step 5:** 跑测试确认通过 + 全量 typecheck/vitest(确认没打破现有 state 路由测试;若现有测试发的是过期 revision 需同步)。
- [ ] **Step 6:** 提交:只 add `apps/api/src/routes/state.ts` 及其测试文件,`git commit -m "fix(api): reject mismatched optimistic revision (must-equal) (P1-18)"`。

---

## Task 3: P1-19 — events 表加保留窗口裁剪

**Files:**
- Modify: `packages/db/src/sqlite-product-state-repository.ts`(events INSERT 处,约 :100 附近)
- Test: `packages/db/src/sqlite-product-state-repository.test.ts`

- [ ] **Step 1:** 读 `packages/db/src/sqlite-product-state-repository.ts`,定位 `product_state_events` 的 INSERT 与表结构,确认每次 replaceState 都 append。
- [ ] **Step 2:** 写失败测试:连续 replaceState 多于保留上限次(例如上限 500,写 510 次或用更小可注入上限),断言 events 表行数 ≤ 上限、且保留的是最近的。
- [ ] **Step 3:** 跑测试确认失败(当前无界,行数 = 写入次数)。
- [ ] **Step 4:** 实现:每次 INSERT events 后裁剪——`DELETE FROM product_state_events WHERE id NOT IN (SELECT id FROM product_state_events ORDER BY id DESC LIMIT <MAX>)`。`MAX` 设为常量 `MAX_PERSISTED_EVENTS = 500`,加注释 `// ponytail: 固定保留窗口 500;需要按时间裁剪再说`。
- [ ] **Step 5:** 跑测试确认通过 + 全量 typecheck/vitest。
- [ ] **Step 6:** 提交:只 add 该 repo 文件及其测试,`git commit -m "fix(db): bound product_state_events with retention window (P1-19)"`。

---

## Task 4: P1-24 + P2-18 — normalize 清悬空 relatedThemeIds + 回填 memoryCandidates

**Files:**
- Modify: `src/domain/storage.ts`(`normalizeProductState` 及新增迁移辅助)
- Test: `src/domain/storage.test.ts`

- [ ] **Step 1:** 读 `src/domain/storage.ts` 的 `normalizeProductState` 全貌 + `src/domain/memoryReview.ts` 的 `withMemoryCandidateReview`。确认哪些实体带 `relatedThemeIds`(grep:points/questions/readings/debts/notes/sessions/decisions),以及 `memoryCandidates` 当前归一行(约 :53)。
- [ ] **Step 2(P1-24):** 写失败测试:state 的某资产 `relatedThemeIds` 含一个 `themes` 中不存在的 id(如 `"theme-ghost"`)→ 期望 normalize 后该悬空 id 被剔除,合法 id 保留。
- [ ] **Step 3(P2-18):** 写失败测试:`memoryCandidates` 含一个缺 `reviewScore`/`reviewSignals` 的旧候选 → 期望 normalize 后被 `withMemoryCandidateReview` 补全。
- [ ] **Step 4:** 跑两个测试确认失败。
- [ ] **Step 5:** 实现:
  - 新增 `pruneDanglingThemeRefs(state)`:以 `themes` 的 id 集合为准,过滤所有带 `relatedThemeIds` 实体里的悬空 id(保持字段存在,只删非法成员)。在 normalize 末尾(themes 已迁移后)应用。
  - `memoryCandidates` 归一行改为 `map` 调 `withMemoryCandidateReview(c, { legacyBackfill: true })`(按该函数真实签名调整)。
- [ ] **Step 6:** 跑测试确认通过 + 全量 typecheck/vitest(确认 21 处 `.themes`/现有 storage 用例零破坏)。
- [ ] **Step 7:** 提交:只 add `src/domain/storage.ts src/domain/storage.test.ts`,`git commit -m "fix(data): prune dangling relatedThemeIds + backfill memoryCandidates on normalize (P1-24, P2-18)"`。

---

## Task 5: P2-8 — 策略死分支:类型与引擎对齐

**Files:**
- Modify: `src/domain/types.ts`(策略枚举/接口)、`src/domain/engine.ts`(`decideInterviewStrategy` 等)
- Test: `src/domain/engine.test.ts`(或现有引擎测试)

- [ ] **Step 1:** 读 `src/domain/engine.ts` 的策略决策函数 + `src/domain/types.ts` 的策略相关枚举/接口(`InterviewEnginePolicy`、strategy 枚举)。**精确列出**:类型里声明、但引擎从不消费(无对应分支)的枚举值/字段,以及引擎里 return 的、类型里没有的值。grep 全仓引用确认"死"。
- [ ] **Step 2:** 写测试:对引擎实际支持的每个策略输入断言其输出分支;对拟删除的死枚举,确认全仓(src/apps,排除 zhuanfang)无任何生产引用(测试或断言形式记录)。
- [ ] **Step 3:** 跑测试。
- [ ] **Step 4:** 实现:删除确认无引用的死枚举值/死分支,使类型与引擎严格一致。**若删除会触及 ≥3 处其它文件或改变可观察行为,停下报告 DONE_WITH_CONCERNS,不要硬删。**
- [ ] **Step 5:** 全量 typecheck/vitest。
- [ ] **Step 6:** 提交:只 add 实际改动文件,`git commit -m "refactor(engine): align strategy types with engine, drop dead branch (P2-8)"`。

---

## Task 6: P2-19 + P2-20 — ImportSource.searchBriefId 可选化 + PodcastEpisode.noteId 规范化

**Files:**
- Modify: `src/domain/types.ts`(`ImportSource.searchBriefId`、`PodcastEpisode`)、相关 normalize/使用点
- Test: `src/domain/storage.test.ts` 或对应领域测试

- [ ] **Step 1:** grep 全仓(src/apps,排除 zhuanfang)`searchBriefId` 与 `PodcastEpisode`/`.noteId` 的**所有引用**,逐一记录读/写点。
- [ ] **Step 2(P2-19):** 写测试:含 `searchBriefId` 为空串的 ImportSource 的旧 state → normalize 后该字段被规范(空串 → 省略/undefined)。
- [ ] **Step 3(P2-20):** 写测试:PodcastEpisode 的来源关联以 `sourceType`+`sourceId` 为准;断言 normalize 产出一致的 sourceRef(若引入 sourceRef 派生)或 noteId 仅在 `sourceType==="note"` 时保留。
- [ ] **Step 4:** 跑测试确认失败。
- [ ] **Step 5:** 实现**最小落地**:
  - `ImportSource.searchBriefId?: string`(改可选);normalize 把空串归一为 undefined;`context-pack.ts` 等用 `searchBriefId === x` 的比较点对 undefined 安全。
  - PodcastEpisode:规范化逻辑确保 `noteId` 与 `sourceType/sourceId` 自洽(`sourceType!=="note"` 时不依赖 noteId 做关联);不新增 UX。
  - **任一改动若波及 ≥3 处其它文件或改变前端可见行为,停下报告 DONE_WITH_CONCERNS。**
- [ ] **Step 6:** 全量 typecheck/vitest(重点确认 `context-pack.ts`、`lifecycle.ts`、`PodcastStudioView.tsx` 引用不破)。
- [ ] **Step 7:** 提交:只 add 实际改动文件,`git commit -m "refactor(data): optional ImportSource.searchBriefId + normalize PodcastEpisode source ref (P2-19, P2-20)"`。

---

## Task 7: P2-23 — 会话状态机收敛为 active→completed,去 draft 死枚举 + 清空壳会话

**Files:**
- Modify: `src/domain/types.ts`(`InterviewSession.status`)、`apps/api/src/routes/interview-sessions.ts`、`src/domain/engine.ts`(`createSessionDraft`)、`src/domain/storage.ts`(清空壳)
- Test: 对应会话路由/引擎测试 + `src/domain/storage.test.ts`

- [ ] **Step 1:** grep 全仓(src/apps,排除 zhuanfang)`"draft"`、`status:`、`createSessionDraft`、`InterviewSession` status 的所有读/写/比较点。确认:draft 是否真为死枚举(创建后是否立即转 active),前端是否对 `status==="draft"` 有分支。**这是行为变更,先把现状摸清。**
- [ ] **Step 2:** 写测试:
  - 新建会话 status 初始为 `"active"`(不再 draft);
  - 状态枚举仅 `"active" | "completed"`;
  - normalize 把历史 `"draft"` 会话升级为 `"active"`;
  - (空壳清理)无任何 turn 且为历史 draft 的会话按规则处理(若设计需清理则断言被移除;否则断言被升级为 active 保留——**取不丢数据的保守路径:升级而非删除**)。
- [ ] **Step 3:** 跑测试确认失败。
- [ ] **Step 4:** 实现:`status: "active" | "completed"`;`createSessionDraft` 产出 `"active"`(函数名可保留);normalize 迁移 `"draft" → "active"`;前端若有 draft 分支同步(只在 src/ 内,确认后改)。**若前端有依赖 draft 的可见流程,停下报告 DONE_WITH_CONCERNS。**
- [ ] **Step 5:** 全量 typecheck/vitest。
- [ ] **Step 6:** 提交:只 add 实际改动文件,`git commit -m "refactor(session): converge status to active->completed, migrate draft (P2-23)"`。

---

## Self-Review

**1. Spec 覆盖:** 9 条逐一映射:P0-11→T1、P1-18→T2、P1-19→T3、P1-24/P2-18→T4、P2-8→T5、P2-19/P2-20→T6、P2-23→T7。与主设计第 4 节阶段 0 表「如何解决」列一致。

**2. 占位扫描:** 无 TBD。类型变更型 Task(5/6/7)因爆炸半径不确定,采用"先 grep 全引用→最小落地→超阈值则 DONE_WITH_CONCERNS 上报"而非预写每行代码——这是对未知引用面的诚实处理,非占位。

**3. 一致性:** 命令统一 `npm run typecheck` / `npx vitest run`;提交均显式列文件、禁 `git add -A`;不丢数据优先(P2-23 升级而非删除)。

**4. 风险:** T2 改并发语义、T7 改会话行为是真实行为变更,靠全量回归 + 前端引用核查 + DONE_WITH_CONCERNS 闸门兜底。
