# 时间轴首页 + 主题线工作区 + 3 区导航 设计文档

**Goal:** 兑现 notebook-paradigm 设计的「区1 访谈工作台」可见改版——把卡片仪表盘首页改为**时间轴叙事首页**,新增**主题线 Track 工作区**,并把 12 项平级导航收敛为 **3 区**。一眼可见的界面升级,零后端改动(数据已存在)。

**Architecture:** 纯前端 + 2 个领域纯函数。复用现有 `ProductState`(themes/sessions/notes/points/questions/debts/decisions/importSources + `relatedThemeIds` 软标签)。新增 `buildTimeline(state)` 与 `buildTrackWorkspace(state, themeId)` 两个纯函数(可单测),2 个视图组件,App.tsx 导航重组 + 新视图路由。

**Tech Stack:** React + Vite + TS, Vitest(领域函数 + 组件)、Playwright(导航/首页 e2e)。

设计依据:`docs/superpowers/specs/2026-06-18-notebook-paradigm-refactor-design.md` 第 3.1 节(3 区 IA,专访为心脏)。

---

## 1. 信息架构:12 项平级 → 3 区

左侧导航重组(App.tsx `groupedNavigation`),保留所有现有视图,只重新分组 + 新增「主题线」:

- **区1 · 访谈工作台**(核心):今日访谈台(=时间轴首页)、实时专访、**主题线**(新)
- **区2 · 认知资产**(跨线经营):双轨笔记、资产库、长期追踪、记忆治理、联网素材、情报中心、语料学习、播客工作台
- **区3 · 系统**:系统配置、个人档案

不删任何视图、不改任何视图内部逻辑,只改分组标签与顺序。

---

## 2. 时间轴首页(重写 `HomeView`)

三段式,自上而下:

### 2.1 Hero(强化现有今日建议)
- `card.title` 大标题 + 「▶ 一键开始」主 CTA(沿用 P2-16 一键开始 `onStart`)。
- `card.whyNow` 一句话 + 代表性原话引用 + 视角标签 chips。
- 视觉:全宽、强对比,作为页面锚点。

### 2.2 主题线横排(可点进工作区)
- 来源 `state.themes`(已是软主题)。每个主题线一张紧凑卡:名称 + 成熟度(萌芽/重复/聚焦/成型/变化/关闭)+ 出现次数 `appearances` + 成熟度圆点进度。
- 点击 → 进入主题线工作区(view=`track`,带 `themeId`)。
- 末尾「＋ 新建主题线」(本期可先只做"占位/引导",真正创建留后续;或直接 `onStart("long-term")`)。
- 空状态:「还没有主题线,完成专访后会自动浮现」。

### 2.3 时间轴叙事流(★全新)
- 新领域函数 `buildTimeline(state, limit)`:把以下实体按时间倒序合并为统一事件流:
  - 专访会话(`sessions`:date/mode/relatedThemeIds → "决策专访 · 控制感")
  - 双轨笔记(`notes`:createdAt → 摘要)
  - 主题线浮现(`themes`:createdAt → "主题线「X」浮现")
  - 重要产出(可选:decisions 确认、knowledgeDebt 识别)
- 每个事件:时间点(圆点+竖线连成时间轴)、类型标签、标题、一行摘要、右侧产出计数("→ 3 观点 · 1 笔记")。
- 事件可点(跳到对应视图/主题线)。空状态:引导首次专访。
- `TimelineEvent` 类型:`{ id, kind, at, title, summary?, themeIds?, outputs?: {label,count}[], href }`。

---

## 3. 主题线工作区(新视图 `TrackWorkspaceView`)

进入条件:首页/导航点某主题线,App.tsx `view="track"` + `selectedTrackId`。

- 新领域函数 `buildTrackWorkspace(state, themeId)` → `{ theme, sources, sessions, outputs }`:
  - `sources`:`importSources`/`ragChunks` 中 `relatedThemeIds`(或 usage 关联)含该 themeId 的。
  - `sessions`:`sessions` 中 `relatedThemeIds` 含该 themeId 的(历次专访)。
  - `outputs`:`points`/`questions`/`decisions`/`debts` 中 `relatedThemeIds` 含该 themeId 的。
- 布局:主题线头部(名称 + 成熟度 + 代表原话 + 「▶ 继续这条线」CTA `onStart("long-term")`)+ 三列(Sources / 历次专访 / Outputs),每列卡片列表 + 计数 + 空状态。
- 头部「← 返回」回首页。

---

## 4. 文件结构

- **Modify** `src/App.tsx` — 导航 3 区重组;新增 `view="track"` 路由与 `selectedTrackId` 状态;HomeView 主题线点击 → 进 track。
- **Rewrite** `src/features/home/HomeView.tsx` — 三段式时间轴首页。
- **Create** `src/features/track/TrackWorkspaceView.tsx` — 主题线工作区。
- **Create** `src/domain/timeline.ts` — `buildTimeline` + `buildTrackWorkspace`(纯函数)。
- **Create** `src/domain/timeline.test.ts` — 两个函数的单测。
- **Modify** `src/index.css`(或现有样式文件) — 时间轴、主题线卡、三列工作区、3 区导航样式;响应式 + 空状态。

---

## 5. 测试

- `timeline.test.ts`:`buildTimeline` 倒序合并多实体、limit 截断、空 state 返回空;`buildTrackWorkspace` 按 themeId 正确聚合 sources/sessions/outputs、不含他线、空主题线返回空三列。
- 组件:扩 `empty-state-render.test.tsx` 或新增——HomeView 空 state 渲染时间轴空状态;TrackWorkspaceView 渲染三列。
- e2e:`navigation.spec.ts` 适配 3 区导航分组标签;新增「点首页主题线 → 进工作区 → 看到三列 → 返回」。
- 视觉自审(UI 模式):Hero 是否够强、时间轴节奏、主题线卡对齐、移动端、空状态齐全。

---

## 6. 范围与非目标

- **做**:时间轴首页、主题线工作区、3 区导航、2 个领域函数 + 测试、配套样式。
- **不做**:不改后端/数据模型(软标签字段已存在);不改专访引擎内核;主题线「新建」的完整 CRUD 留后续(本期点击=进入/引导);不引新依赖。
- **风险**:App.tsx(1450 行)改导航 + 加路由,靠 Playwright 回归兜底;时间轴/工作区聚合靠纯函数单测保证正确。
