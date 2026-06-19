# R1 · 认知资产清账 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development。每 Task 派 fresh subagent;能 TDD 的 TDD,删除类先 grep 确认零引用。Steps 用 checkbox。

**Goal:** 清除认知资产区的死代码/死字段,补回有路由没 UI 的功能,修断路——为后续合并铺干净地基。

**Architecture:** 删除 + 小修,零新依赖。每项先 grep 全引用确认,再动手。

**Tech Stack:** TypeScript, React, Fastify, Vitest。验证:`npm run typecheck` / `npx vitest run --exclude "**/*.real.test.ts"`。

设计:`docs/superpowers/specs/2026-06-19-cognitive-assets-consolidation-design.md` 第 3 节 R1。

---

## 通用约束

- 真实代码在顶层 `src/`/`apps/`(忽略 zhuanfang,grep 排除)。
- 提交**只 `git add` 本 Task 改动文件**,严禁 `git add -A/.`(zhuanfang/CLAUDE.md/memory/.claude 零误吞)。
- 每 Task:`npm run typecheck` PASS + `npx vitest run --exclude "**/*.real.test.ts"` 全绿 + `git status --short` 核无关文件未暂存,再提交。

---

## Task 1: 删除 ReadingAsset 死类型

**已知事实:** `ReadingAsset` 有类型(types.ts:651-664)、`ProductState.readings`、`apps/api/src/routes/assets.ts` 的 readings status/importance 路由、`searchProductAssets` 检索分支,但**从无生成路径、AssetsView 不渲染**(buildUnifiedAssets 不含 readings)。

- [ ] **Step 1:** `grep -rn "ReadingAsset\|\.readings\b\|readings:\|createReadingAssets\|readings/" src/ apps/ --include="*.ts" --include="*.tsx" | grep -v zhuanfang`。列出所有引用。确认无任何**生成** readings 的写入路径(只有路由/检索/类型,无 finalize 产出)。
- [ ] **Step 2:** 删除:
  - `types.ts`:`ReadingAsset` 接口、`ProductState.readings` 字段。
  - `apps/api/src/routes/assets.ts`:`PATCH /readings/:id/status`、`PATCH /readings/:id/importance` 路由 + `updateReadingAssetStatus`/readings 相关 handler。
  - `src/domain/assets.ts`:`searchProductAssets` 的 readings 分支、`toggleAssetImportance` 的 readings 分支、`updateReadingAssetStatus`。
  - `src/domain/search-brief.ts`:`createReadingAssetsFromSearchBrief`(若存在)及其调用。
  - `src/domain/seed.ts` / `engine.ts createInitialProductState` / `createEmptyProductState`:`readings: []` 字段。
  - `storage.ts normalizeProductState`:readings 归一行。
  - AssetsView / ui.ts:任何 readings 残留(assetFilterOptions 若含 readings)。
  - 相关测试:删 readings 专项断言(不削弱其它)。
- [ ] **Step 3:** `npm run typecheck` exit 0(类型删净,无残留引用)+ `npx vitest run --exclude "**/*.real.test.ts"` 全绿。grep `ReadingAsset` 归零。
- [ ] **Step 4:** 提交:只 add 改动文件,`git commit -m "refactor(assets): remove dead ReadingAsset type (never generated, never rendered) (R1)"`。

---

## Task 2: 删除 LongTermTheme 死字段 kind/pinned/lastActiveAt

**已知事实:** `LongTermTheme.kind/pinned/lastActiveAt`(types.ts:676-679)是 v2 Track 升级遗留,**零写入零消费**(finalize upsert 不写、UI 不渲染)。

- [ ] **Step 1:** `grep -rn "\.kind\b\|\.pinned\b\|\.lastActiveAt\b\|kind:\|pinned:\|lastActiveAt:" src/ apps/ --include="*.ts" --include="*.tsx" | grep -v zhuanfang | grep -iE "theme|track|migrate"`。确认这三个字段只在 类型定义 + seed + 迁移补值处出现,无真实读取。
- [ ] **Step 2:** 删除:`types.ts` 的三字段;`seed.ts` themes 里的三字段;`storage.ts` 的 `migrateThemesToTracks` 不再补这三个(只保留真正用到的迁移);相关测试断言同步删。
- [ ] **Step 3:** `npm run typecheck` exit 0 + `npx vitest run --exclude "**/*.real.test.ts"` 全绿。grep 确认三字段归零。
- [ ] **Step 4:** 提交:只 add 改动文件,`git commit -m "refactor(theme): drop dead Track fields kind/pinned/lastActiveAt (R1)"`。

---

## Task 3: 删除播客 corpus-insight 死路径 + 修复"合成语音"断路

**已知事实:** ① `generatePodcastEpisodeFromCorpusInsight`(podcast.ts)+ 路由 normalizeSourceType 的 corpus-insight 分支是死代码(前端不暴露、路由无分发)。② 前端"合成语音"调 `POST /api/podcast/episodes/:id/synthesize`,但 `apps/api/src/routes/podcast.ts` **无此端点**。

- [ ] **Step 1:** grep 确认:`grep -rn "corpus-insight\|generatePodcastEpisodeFromCorpusInsight" src/ apps/ --include="*.ts" --include="*.tsx" | grep -v zhuanfang`;`grep -rn "synthesize\|/synthesize" src/ apps/ --include="*.ts" --include="*.tsx" | grep -v zhuanfang`(找前端调用与后端是否注册)。
- [ ] **Step 2(死路径):** 删 `generatePodcastEpisodeFromCorpusInsight` + 其专属类型/测试;`podcast.ts` 路由的 normalizeSourceType 移除 corpus-insight 识别;`PodcastSourceType` 枚举移除 corpus-insight(确认前端 sourceOptions 本就不含它)。
- [ ] **Step 3(修断路):** 读现有 `apps/api/src/routes/podcast.ts` 的 TTS 合成逻辑(生成时顺带合成)。注册 `POST /api/podcast/episodes/:id/synthesize`:取已存 episode 的 script,调现有 TTS 合成(BailianPodcastAudioClient),更新该 episode 的 audioUrl/audioRenderStatus 并持久化;无 key 时走现有 fallback(占位 + audioRenderStatus="fallback")。前端 `synthesizePodcastSpeech` 调用对齐。
- [ ] **Step 4:** TDD:写测试——`POST /api/podcast/episodes/:id/synthesize` 对已存 episode 返回 200 + 更新 audioRenderStatus(注入 fake TTS client 验证;无 client 走 fallback)。
- [ ] **Step 5:** `npm run typecheck` exit 0 + `npx vitest run --exclude "**/*.real.test.ts"` 全绿。grep `corpus-insight` 归零。
- [ ] **Step 6:** 提交:只 add 改动文件 + 测试,`git commit -m "fix(podcast): remove dead corpus-insight path + wire synthesize endpoint (R1)"`。

---

## Task 4: 补决策"确认"UI

**已知事实:** `POST /api/assets/decisions/:id/confirm`(assets.ts)有路由,但 `AssetsView` detail 面板**无确认按钮**(决策只读渲染),用户无法从界面确认候选决策。

- [ ] **Step 1:** 读 `src/features/assets/AssetsView.tsx` 的 `AssetDetail`(决策渲染处)+ `src/App.tsx` 给 AssetsView 传的 decision 回调(`onDecisionConfirm`/`onDecisionStatus` 是否已接线)。确认 `productApiClient` 是否已有 confirmDecision 方法。
- [ ] **Step 2:** TDD(组件层可测则测,否则依赖 e2e):在 AssetDetail 对 `decisionKind==="候选决策" && confirmationStatus==="待用户确认"` 的决策渲染"确认决策"按钮,点击调 `onDecisionConfirm(id)` → App.tsx 调 `POST /api/assets/decisions/:id/confirm`(或现有等价方法)→ 更新 state。确认后按钮消失/状态变"用户确认"。
- [ ] **Step 3:** `npm run typecheck` exit 0 + `npx vitest run --exclude "**/*.real.test.ts"` 全绿。
- [ ] **Step 4:** 提交:只 add 改动文件 + 测试,`git commit -m "feat(assets): wire decision-confirm action in AssetsView (R1)"`。

---

## Self-Review

**1. Spec 覆盖:** R1 全部清账项——ReadingAsset(T1)、theme 死字段(T2)、播客死路径+断路(T3)、决策确认 UI(T4)。`intel.relatedDebtIds/relatedThemeIds` 留 R3 合并时处理(spec 已注明可 R3)。

**2. 占位扫描:** 无 TBD;删除类先 grep 确认零生产引用再删。

**3. 一致性:** 命令统一;提交禁 git add -A;每项独立 commit、独立可回滚。

**4. 风险:** 删 ReadingAsset/theme 字段触类型与迁移,靠 typecheck + 全量回归兜底;播客 synthesize 是新增端点(补能力,非破坏)。
