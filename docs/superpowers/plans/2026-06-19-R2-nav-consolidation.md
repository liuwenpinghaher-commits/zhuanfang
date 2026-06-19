# R2 · 导航收 3 + 笔记资产打通 + 移位降级 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development。领域函数 TDD;UI 按结构+验收 + Playwright 回归。Steps 用 checkbox。

**Goal:** 认知资产区导航从 7 个平级收敛为 3 个(我的资产/外部调研/记忆);语料学习移入系统区;播客撤出顶层降级为动作;笔记与资产用 sessionId 打通("档案"tab)。

**Architecture:** 加 `sourceSessionId` 到 4 类资产(finalize 时填,session 就在手边)+ `buildSessionArchive` 纯函数;新建"我的资产"带 tab 容器视图;ui.ts 导航重组;App.tsx 路由调整。零新依赖。

**Tech Stack:** React/TS, Vitest, Playwright。验证:`npm run typecheck` / `npx vitest run --exclude "**/*.real.test.ts"` / `npx playwright test`。

设计:`docs/superpowers/specs/2026-06-19-cognitive-assets-consolidation-design.md` 第 3 节 R2。

---

## 通用约束
- 顶层 `src/`(忽略 zhuanfang)。提交只 `git add` 本 Task 文件,禁 `git add -A/.`(zhuanfang/CLAUDE.md/memory/.claude 零误吞)。
- 每 Task:`npm run typecheck` PASS + `npx vitest run --exclude "**/*.real.test.ts"` 全绿 + git status 核无关文件未暂存。

## 已核实
- 资产(PointAsset/QuestionAsset/DecisionAsset/KnowledgeDebt)无 session 链;`mergeFinalizedState(state, session, content, completedAt)`(`src/domain/finalize.ts:103`)持有 `session.id`,note 即在此获得 `sessionId: session.id`(:81)。
- 当前 `View`/`groupedNavigation` 在 `src/ui.ts`;`navIconByView`+view switch 在 `src/App.tsx`。区2 当前 = notes/assets/memory/search/intel/corpus/podcast。

---

## Task 1: 资产加 sourceSessionId + buildSessionArchive 纯函数

**Files:** Modify `src/domain/types.ts`、`src/domain/finalize.ts`、`src/domain/storage.ts`(normalize 无需补值,可选字段);Create `src/domain/session-archive.ts` + 测试。

- [ ] **Step 1:** 读 `src/domain/finalize.ts:103` 的 `mergeFinalizedState`——确认 points/questions/decisions/debts 在哪几行被 prepend(它们来自 `content`,在该函数内与 session 同作用域)。
- [ ] **Step 2:** `types.ts`:给 4 类资产各加 `sourceSessionId?: string;`(可选,注释"产出该资产的专访会话 id")。
- [ ] **Step 3:** `finalize.ts mergeFinalizedState`:prepend 各资产时,给每条补 `sourceSessionId: session.id`(`content.points.map(p => ({...p, sourceSessionId: session.id}))` 之类,4 类都补)。
- [ ] **Step 4(TDD):** 新建 `src/domain/session-archive.ts`:
  ```typescript
  import type { ProductState, InterviewSession, DualTrackNote, PointAsset, QuestionAsset, DecisionAsset, KnowledgeDebt } from "./types";
  export interface SessionArchiveEntry {
    session?: InterviewSession;      // note.sessionId 对应的会话(可能已不存在)
    note: DualTrackNote;
    points: PointAsset[]; questions: QuestionAsset[]; decisions: DecisionAsset[]; debts: KnowledgeDebt[];
  }
  // 以 note 为骨架(每次专访产出一条 note),按 sessionId 聚合该次产出的资产。倒序(最近在前)。
  export function buildSessionArchive(state: ProductState): SessionArchiveEntry[];
  ```
  实现:`state.notes` 倒序(按 createdAt),每条 note 找 `state.sessions.find(s=>s.id===note.sessionId)`,各资产数组 `filter(a => a.sourceSessionId === note.sessionId)`。
  测试(`session-archive.test.ts`):用 `createInitialProductState`——若 seed 无 sessions/notes,构造一个含 note + 带 sourceSessionId 资产的 state,断言 archive 把该 note 与其资产正确聚合;不属该 session 的资产不混入;空 state 返回 []。
- [ ] **Step 5:** `npm run typecheck` + `npx vitest run --exclude "**/*.real.test.ts"` 全绿。
- [ ] **Step 6:** 提交:`git add src/domain/types.ts src/domain/finalize.ts src/domain/session-archive.ts src/domain/session-archive.test.ts`(+若改了 finalize 测试),`git commit -m "feat(assets): link assets to source session + buildSessionArchive (R2)"`。

---

## Task 2: 导航收 3 区 + 注册 my-assets 视图 + 移位

**Files:** Modify `src/ui.ts`(View + groupedNavigation)、`src/App.tsx`(navIconByView)。

- [ ] **Step 1:** 读 `src/ui.ts` 的 `View`、`groupedNavigation`;`src/App.tsx` 的 `navIconByView`。
- [ ] **Step 2:** `src/ui.ts`:`View` 加 `| "my-assets"`(保留 notes/assets/podcast 等,它们仍被内部使用/动作触发)。`groupedNavigation` 改为:
  ```typescript
  [
    { label: "访谈工作台", items: [
      { id: "home", label: "今日访谈台" },
      { id: "interview", label: "实时专访" },
      { id: "themes", label: "主题线" }
    ]},
    { label: "认知资产", items: [
      { id: "my-assets", label: "我的资产" },
      { id: "search", label: "外部调研" },   // R3 会把 intel 并进来;R2 先改标签
      { id: "memory", label: "记忆" }
    ]},
    { label: "系统", items: [
      { id: "config", label: "系统配置" },
      { id: "corpus", label: "语料学习" },    // 移入系统区(引擎调校)
      { id: "profile", label: "个人档案" }
    ]}
  ]
  ```
  **podcast、notes、assets、intel 不再出现在 groupedNavigation**(notes/assets 并入 my-assets;podcast 降级为动作;intel 待 R3 并入 search)。
- [ ] **Step 3:** `src/App.tsx` `navIconByView`:加 `"my-assets"` 的图标(复用已 import 的合适图标如 `Archive` 或 `BookOpen`);保留 notes/assets/podcast/intel 键(Record<View> 要求全键存在)。
- [ ] **Step 4:** `npm run typecheck`(my-assets 的 view switch 分支在 Task 3 加;若 typecheck 因缺分支报错则临时占位,Task 3 补)+ `npx vitest run --exclude "**/*.real.test.ts"` 全绿(ui.test.ts 同步)。
- [ ] **Step 5:** 提交:`git add src/ui.ts src/App.tsx`(+ui.test.ts),`git commit -m "feat(nav): consolidate 认知资产 to 3 entries, move corpus to 系统, drop podcast from nav (R2)"`。

---

## Task 3: 我的资产合并视图(档案/资产 tab)+ 播客降级为动作

**Files:** Create `src/features/my-assets/MyAssetsView.tsx`;Modify `src/App.tsx`(my-assets 路由 + 播客动作入口)、样式。

- [ ] **Step 1:** 读 `src/features/notes/NotesView.tsx`、`src/features/assets/AssetsView.tsx`(它们的 props)、`src/domain/session-archive.ts` 的 `buildSessionArchive`、App.tsx 给 notes/assets 视图传的 props、播客动作(`view="podcast"` 入口)。
- [ ] **Step 2:** Create `src/features/my-assets/MyAssetsView.tsx`:带两个 tab 的容器:
  - **档案 tab**(默认):用 `buildSessionArchive(state)` 渲染——每个 entry 是一张"专访档案"卡:标题/日期(来自 session 或 note)、双轨笔记摘要(saidTrack/learnedTrack/keyQuote)、**本次产出**(N 观点·M 问题·K 决策·J 债,可点跳到资产 tab 并预选)、一个「生成播客」动作(onGeneratePodcast(note.id))。空→引导首次专访。
  - **资产 tab**:复用现有 `AssetsView`(原样嵌入,把 App.tsx 原来传给 AssetsView 的 props 透传进来)。
  - tab 切换用本地 state;视觉复用现有 token,移动端可用。
- [ ] **Step 3:** App.tsx:
  - view switch 加 `view === "my-assets"` → `<MyAssetsView ... />`(透传 AssetsView 所需的全部 props + state + onGeneratePodcast + 切到资产 tab 的回调)。
  - 移除/保留 notes、assets 的独立 view 分支:**保留**(无害,可能被内部复用),但导航不再指向(Task 2 已移除)。
  - `onGeneratePodcast(noteId)`:设置播客来源为该 note 并 `setView("podcast")`(打开现有 PodcastStudioView)——这就是播客降级后的入口。
- [ ] **Step 4:** 样式:`.my-assets-tabs`、档案卡片(复用 panel/record 风格)。
- [ ] **Step 5:** `npm run typecheck` exit 0 + `npx vitest run --exclude "**/*.real.test.ts"` 全绿。扩组件测试:MyAssetsView 渲染档案 tab(有 note 时显示卡+产出计数)、切到资产 tab 显示 AssetsView、空状态。
- [ ] **Step 6:** 提交:`git add src/features/my-assets/MyAssetsView.tsx src/App.tsx src/styles.css`(+测试),`git commit -m "feat(my-assets): merged 档案/资产 view + podcast as generate action (R2)"`。

---

## Task 4: e2e 适配 + 视觉自审

**Files:** Modify `tests/e2e/navigation.spec.ts`、相关受影响 spec;Create `tests/e2e/my-assets.spec.ts`。

- [ ] **Step 1:** 读 `tests/e2e/navigation.spec.ts` 的 `views` 数组与 `openView`/`helpers.ts`。把导航断言适配新 3 区:认知资产 = 我的资产/外部调研/记忆;系统 = 系统配置/语料学习/个人档案;**移除 notes/assets/podcast/intel 作为顶层导航项的断言**(它们不再在 nav)。其它 spec 若用 `openView(page,"双轨笔记"/"资产库"/"播客工作台"/"情报中心")` 导航,改为经"我的资产"tab 或相应新路径(以实际渲染为准,先读组件确认文案)。**不削弱实质断言。**
- [ ] **Step 2:** Create `tests/e2e/my-assets.spec.ts`:reset demo 后进"我的资产"→ 默认档案 tab(断言可见档案/笔记内容)→ 切"资产"tab(断言资产库可见)→(若有 note)断言档案卡有"生成播客"动作。
- [ ] **Step 3:** `npx playwright test` 全绿。修失败。
- [ ] **Step 4:** 视觉自审(UI 模式):导航 3 区是否清爽?我的资产 tab 切换是否清晰?档案卡"本次产出"是否一目了然?移动端?有明显弱点改一次。
- [ ] **Step 5:** 提交:`git add tests/e2e/navigation.spec.ts tests/e2e/my-assets.spec.ts`(+其它适配的 spec + 视觉改动),`git commit -m "test(e2e): 3-entry 认知资产 nav + my-assets archive journey (R2)"`。

---

## Self-Review
**1. Spec 覆盖:** 导航收 3(T2)、我的资产合并+笔记资产打通(T1/T3)、语料移系统(T2)、播客降级为动作(T3)、e2e+视觉(T4)。
**2. 占位扫描:** 无 TBD;领域函数给签名+实现要点,UI 给结构+验收。
**3. 一致性:** `sourceSessionId`/`buildSessionArchive`/`SessionArchiveEntry`/`my-assets`/`onGeneratePodcast` 跨 Task 命名一致。
**4. 风险:** 加 sourceSessionId 是可选字段(旧资产 undefined,archive 仍以 note 为骨架可用);nav 重组靠 Playwright 兜底;notes/assets/podcast view 分支保留避免路由破裂。
