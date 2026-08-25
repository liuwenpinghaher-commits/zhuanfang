# C2 三区九口信息架构 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans。本仓本轮由同一会话内联执行。Steps 用 checkbox。

**Goal:** 侧栏从 13 项收到 9 项；页面全留；同名「带入专访」改名；旧 `?view=` / citation 不炸。

**Architecture:** 导航降级 + 两个薄容器。`notes`/`my-assets` 外包「本场记录」；`asset-chat`/`material` 外包「资料」。不新增 View id。`podcast`/`corpus`/`track` 仍可 `setView`。

**Tech Stack:** React/TS, Vitest, Playwright。

**Spec:** 本会话「信息架构最优方案」C2；旧 R2 文档不得照抄。

## Global Constraints

- 当前代码是唯一真相。不删任何现有 View 分支。
- 档案徽章过滤已走 `assetAppearedInSession`，本轮不动。
- App.tsx 禁止再巨胀：新 UI 进容器文件。
- 禁止削弱 e2e 实质断言。
- 未要求不 commit。

---

### Task 1: 导航真源 13 → 9

**Files:** Modify `src/ui.ts` `src/ui.test.ts`

- [ ] 先改 `ui.test.ts` 期望为 9 项：home/interview/themes + notes/memory/asset-chat/search + config/profile
- [ ] 跑测确认失败
- [ ] `groupedNavigation` 改标签：notes=本场记录，asset-chat=资料；去掉 material/my-assets/podcast/corpus
- [ ] 测绿

---

### Task 2: 本场记录容器

**Files:** Create `src/features/session-record/SessionRecordView.tsx` + test

页内三段：笔记 | 档案 | 资产。eyebrow 保留「双轨笔记」。空态写「这里就是以前的双轨笔记」。

---

### Task 3: 资料容器

**Files:** Create `src/features/library/LibraryView.tsx` + test

页内两段：问全书 | 导入与索引。

---

### Task 4: App 接线 + 空态 + 动词改名

**Files:** Modify `src/App.tsx` 及相关 View

- notes/my-assets → SessionRecordView；asset-chat/material → LibraryView
- 侧栏高亮：my-assets 点亮本场记录；material 点亮资料
- 实时专访空态改为回今日台，不再第二开场台
- 记忆去掉导入表，改链到资料
- 配置加「引擎调校」进 corpus
- 带入专访 → 就这条开场 / 用这份简报开场；就这个开专访 → 用这句当题开场

---

### Task 5: 测试与验收

**Files:** e2e navigation / my-assets / clean-start / corpus-podcast / external-research / interview-lifecycle / interview-api / visual-regression；相关单测

`npm run typecheck`；相关 vitest；能跑则跑 navigation + my-assets e2e。
