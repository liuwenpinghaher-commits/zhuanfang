# 时间轴首页 + 主题线工作区 + 3 区导航 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development。每 Task 派 fresh subagent;领域函数走 TDD,UI 组件按结构+验收实现并配 Playwright 回归。Steps 用 checkbox。

**Goal:** 把卡片仪表盘首页改为**时间轴叙事首页**,新增**主题线 Track 工作区**,导航收敛为 **3 区**。纯前端 + 2 个领域纯函数,零后端改动。

**Architecture:** `src/domain/timeline.ts` 提供 `buildTimeline`/`buildTrackWorkspace`(纯函数,单测);`HomeView` 重写为三段式;新增 `TrackWorkspaceView`;`src/ui.ts` 重组导航 + 加 `track` 视图;App.tsx 加 `track` 路由 + `selectedTrackId`。

**Tech Stack:** React + Vite + TS, Vitest, Playwright。验证:`npm run typecheck` / `npx vitest run --exclude "**/*.real.test.ts"` / `npx playwright test`。

设计:`docs/superpowers/specs/2026-06-19-timeline-home-track-workspace-design.md`。

---

## 通用约束(每 Task 适用)

- 真实代码在顶层 `src/`(忽略 zhuanfang)。提交**只 `git add` 本 Task 文件**,严禁 `git add -A/.`(zhuanfang/CLAUDE.md/memory/.claude 零误吞)。
- 每 Task 结束:`npm run typecheck` PASS + `npx vitest run --exclude "**/*.real.test.ts"` 全绿 + `git status --short` 核无关文件未暂存,再提交。
- 复用现有样式 token/类名(panel/empty-module/view-stack/dashboard-grid 等),不引新依赖。

## 已核实字段(实现按此,勿臆造)

- `LongTermTheme`: `id,name,summary,maturity("萌芽"|"重复"|"聚焦"|"成型"|"变化"|"关闭"),representativeQuote,appearances,nextQuestion,updatedAt,createdAt?,lastActiveAt?,pinned?`
- `InterviewSession`: `id,mode,status("active"|"completed"),title,startedAt,relatedThemeIds?`
- `DualTrackNote`: `id,sessionId,title,summary,createdAt,relatedThemeIds?`
- `PointAsset`: `id,title,content,status,relatedThemeIds`(必填);`QuestionAsset`: `id,question,status,relatedThemeIds`(必填);`DecisionAsset`: `id,title,status,relatedThemeIds?`;`KnowledgeDebt`: `id,concept,status,relatedThemeIds?`;`ImportSource`: `id,title,content,status,createdAt`(无 relatedThemeIds — 见 Task 1 注)
- `View` 与 `groupedNavigation` 在 `src/ui.ts`;`navIconByView` 与 view switch 在 `src/App.tsx`。

---

## Task 1: 领域纯函数 `timeline.ts`(buildTimeline + buildTrackWorkspace)

**Files:** Create `src/domain/timeline.ts`、`src/domain/timeline.test.ts`。

- [ ] **Step 1: 写失败测试** `src/domain/timeline.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { buildTimeline, buildTrackWorkspace } from "./timeline";
import { createInitialProductState } from "./seed";
import type { ProductState } from "./types";

describe("buildTimeline", () => {
  it("merges sessions/notes/themes into reverse-chronological events", () => {
    const s = createInitialProductState();
    const events = buildTimeline(s, 50);
    expect(events.length).toBeGreaterThan(0);
    // 倒序:每个元素的 at >= 下一个
    for (let i = 1; i < events.length; i++) {
      expect(events[i - 1].at >= events[i].at).toBe(true);
    }
    // 含会话类事件
    expect(events.some((e) => e.kind === "session")).toBe(true);
  });

  it("respects limit and returns [] for empty state", () => {
    const empty = { ...createInitialProductState(), sessions: [], notes: [], themes: [], points: [], questions: [], decisions: [], debts: [] } as ProductState;
    expect(buildTimeline(empty, 10)).toEqual([]);
    const s = createInitialProductState();
    expect(buildTimeline(s, 1).length).toBeLessThanOrEqual(1);
  });
});

describe("buildTrackWorkspace", () => {
  it("aggregates sources/sessions/outputs for a theme by relatedThemeIds", () => {
    const s = createInitialProductState();
    const themeId = s.themes[0].id;
    const ws = buildTrackWorkspace(s, themeId);
    expect(ws.theme?.id).toBe(themeId);
    // outputs 只含归属该线的(points 必填 relatedThemeIds)
    ws.outputs.points.forEach((p) => expect(p.relatedThemeIds).toContain(themeId));
    ws.sessions.forEach((sess) => expect(sess.relatedThemeIds ?? []).toContain(themeId));
  });

  it("returns empty groups + undefined theme for unknown id", () => {
    const s = createInitialProductState();
    const ws = buildTrackWorkspace(s, "theme-does-not-exist");
    expect(ws.theme).toBeUndefined();
    expect(ws.sessions).toEqual([]);
    expect(ws.outputs.points).toEqual([]);
  });
});
```

- [ ] **Step 2:** Run `npx vitest run src/domain/timeline.test.ts` — Expected FAIL(模块不存在)。
- [ ] **Step 3: 实现** `src/domain/timeline.ts`:

```typescript
import type { ProductState, InterviewSession, DualTrackNote, LongTermTheme, PointAsset, QuestionAsset, DecisionAsset, KnowledgeDebt, ImportSource } from "./types";

export type TimelineEventKind = "session" | "note" | "theme";

export interface TimelineEvent {
  id: string;
  kind: TimelineEventKind;
  at: string;            // ISO,用于倒序与展示
  title: string;
  summary?: string;
  themeIds: string[];
  outputs: Array<{ label: string; count: number }>;
  href: { view: "interview" | "notes" | "track"; trackId?: string };
}

export interface TrackWorkspace {
  theme?: LongTermTheme;
  sources: ImportSource[];
  sessions: InterviewSession[];
  outputs: { points: PointAsset[]; questions: QuestionAsset[]; decisions: DecisionAsset[]; debts: KnowledgeDebt[] };
}

const has = (ids: string[] | undefined, id: string) => (ids ?? []).includes(id);

export function buildTimeline(state: ProductState, limit = 30): TimelineEvent[] {
  const events: TimelineEvent[] = [];

  for (const s of state.sessions) {
    const noteCount = state.notes.filter((n) => n.sessionId === s.id).length;
    events.push({
      id: `tl-session-${s.id}`,
      kind: "session",
      at: s.startedAt,
      title: s.title,
      themeIds: s.relatedThemeIds ?? [],
      outputs: noteCount ? [{ label: "笔记", count: noteCount }] : [],
      href: { view: "interview" }
    });
  }
  for (const n of state.notes) {
    events.push({
      id: `tl-note-${n.id}`,
      kind: "note",
      at: n.createdAt,
      title: n.title,
      summary: n.summary,
      themeIds: n.relatedThemeIds ?? [],
      outputs: [],
      href: { view: "notes" }
    });
  }
  for (const t of state.themes) {
    events.push({
      id: `tl-theme-${t.id}`,
      kind: "theme",
      at: t.createdAt ?? t.updatedAt,
      title: `主题线「${t.name}」`,
      summary: t.summary,
      themeIds: [t.id],
      outputs: [{ label: "出现", count: t.appearances }],
      href: { view: "track", trackId: t.id }
    });
  }

  return events
    .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))
    .slice(0, limit);
}

export function buildTrackWorkspace(state: ProductState, themeId: string): TrackWorkspace {
  const theme = state.themes.find((t) => t.id === themeId);
  return {
    theme,
    // 已核实:RagChunk / ImportSource 均无 relatedThemeIds —— 数据模型当前没有"资料↔主题线"关联。
    // ponytail: sources MVP 返回 [],工作区 Sources 列显示诚实空状态;待数据模型支持资料软标签后再接。
    sources: [],
    sessions: theme ? state.sessions.filter((s) => has(s.relatedThemeIds, themeId)) : [],
    outputs: {
      points: theme ? state.points.filter((p) => has(p.relatedThemeIds, themeId)) : [],
      questions: theme ? state.questions.filter((q) => has(q.relatedThemeIds, themeId)) : [],
      decisions: theme ? state.decisions.filter((d) => has(d.relatedThemeIds, themeId)) : [],
      debts: theme ? state.debts.filter((d) => has(d.relatedThemeIds, themeId)) : []
    }
  };
}
```

> 已核实:`RagChunk` 仅有 `sourceId`/`usage`,`ImportSource` 无 `relatedThemeIds` → 当前无"资料↔主题线"关联,`sources` 返回 `[]`,工作区 Sources 列显示空状态「资料尚未按主题线归类」。测试断言 `ws.sources` 为 `[]`。`ImportSource` import 可省去。

- [ ] **Step 4:** Run `npx vitest run src/domain/timeline.test.ts` — Expected PASS。
- [ ] **Step 5:** `npm run typecheck` + 全量 `npx vitest run --exclude "**/*.real.test.ts"` 全绿。
- [ ] **Step 6:** 提交:`git add src/domain/timeline.ts src/domain/timeline.test.ts && git commit -m "feat(timeline): buildTimeline + buildTrackWorkspace pure functions"`。

---

## Task 2: 导航收 3 区 + 注册 `track` 视图

**Files:** Modify `src/ui.ts`(View 加 `track`、`groupedNavigation` 重组)、`src/App.tsx`(`navIconByView` 加 `track`)。

- [ ] **Step 1:** 读 `src/ui.ts:4-16`(View)、`:73-104`(groupedNavigation)、`src/App.tsx:102-116`(navIconByView)。
- [ ] **Step 2:** `src/ui.ts`:View 联合加 `| "track"`。`groupedNavigation` 改为 3 区:

```typescript
export const groupedNavigation: NavigationGroup[] = [
  {
    label: "访谈工作台",
    items: [
      { id: "home", label: "今日访谈台" },
      { id: "interview", label: "实时专访" },
      { id: "themes", label: "主题线" }
    ]
  },
  {
    label: "认知资产",
    items: [
      { id: "notes", label: "双轨笔记" },
      { id: "assets", label: "资产库" },
      { id: "memory", label: "记忆治理" },
      { id: "search", label: "联网素材" },
      { id: "intel", label: "情报中心" },
      { id: "corpus", label: "语料学习" },
      { id: "podcast", label: "播客工作台" }
    ]
  },
  {
    label: "系统",
    items: [
      { id: "config", label: "系统配置" },
      { id: "profile", label: "个人档案" }
    ]
  }
];
```

> `track` 不进 `groupedNavigation`(它是点击进入的详情视图,无顶层入口)。`themes`(原"长期追踪")改标签为"主题线"并归入区1。

- [ ] **Step 3:** `src/App.tsx` `navIconByView` 加一行 `track: Brain,`(复用已 import 的 Brain 图标;`Record<View,...>` 要求 track 键存在,否则 typecheck 报错)。
- [ ] **Step 4:** `npm run typecheck`(此时 view switch 还没处理 track,但 navIconByView 已满足 Record;若 typecheck 因 view switch 的 exhaustive 检查报错,Task 3 会补 track case——本 Task 先保证 ui.ts + navIconByView 编译过)。`npx vitest run --exclude "**/*.real.test.ts"` 全绿(注:`navigation.spec.ts` 的分组标签断言会变,留 Task 6 适配;本 Task 仅跑 vitest)。
- [ ] **Step 5:** 提交:`git add src/ui.ts src/App.tsx && git commit -m "feat(nav): collapse navigation into 3 zones + register track view"`。

---

## Task 3: 主题线工作区视图 `TrackWorkspaceView` + 路由接线

**Files:** Create `src/features/track/TrackWorkspaceView.tsx`;Modify `src/App.tsx`(`selectedTrackId` 状态、`view==="track"` 渲染、导航到 track 的回调)。

- [ ] **Step 1:** 读 `src/App.tsx` 视图 switch 区(约 :1297-1444,各 `view === "..."` 分支)与一个现有 view 组件(如 `ThemesView.tsx`)的结构/className 约定。读 `src/domain/timeline.ts` 的 `buildTrackWorkspace` 返回结构。
- [ ] **Step 2:** Create `src/features/track/TrackWorkspaceView.tsx`:props `{ workspace: ReturnType<typeof buildTrackWorkspace>, onBack: () => void, onContinue: () => void }`。结构:
  - 头部:`← 返回`(onBack)+ 主题线名 + 成熟度徽章 + `appearances` + `representativeQuote` 引用 + `▶ 继续这条线`(onContinue)。
  - 三列(复用 `dashboard-grid`/`panel` 风格):**Sources**(workspace.sources,空→「该主题线暂无关联资料」)、**历次专访**(workspace.sessions,每条 title+mode+startedAt)、**Outputs**(points/questions/decisions/debts 计数 + 列表)。
  - 每列有计数标题与空状态。`theme` 为 undefined 时整页渲染「主题线不存在」+ 返回。
  - 用稳定 key(实体 id),语义化 HTML,移动端单列堆叠。
- [ ] **Step 3:** `src/App.tsx`:加 `const [selectedTrackId, setSelectedTrackId] = useState<string | null>(null);`。加导航辅助 `const openTrack = (id: string) => { setSelectedTrackId(id); setView("track"); };`。在 view switch 加分支:
  ```tsx
  ) : view === "track" ? (
    <TrackWorkspaceView
      workspace={buildTrackWorkspace(productState, selectedTrackId ?? "")}
      onBack={() => setView("home")}
      onContinue={() => launchInterview("long-term")}
    />
  ) : ...
  ```
  import `TrackWorkspaceView` 与 `buildTrackWorkspace`。`launchInterview` 是 P2-16 已有的一键开始函数(确认名,若不同则用现有的)。
- [ ] **Step 4:** 样式:在主样式文件加 `.track-workspace` 三列 + 头部样式(复用现有 panel/grid token,移动端 `grid-template-columns:1fr`)。
- [ ] **Step 5:** `npm run typecheck` exit 0 + `npx vitest run --exclude "**/*.real.test.ts"` 全绿。
- [ ] **Step 6:** 提交:`git add src/features/track/TrackWorkspaceView.tsx src/App.tsx <样式文件> && git commit -m "feat(track): Track workspace view (sources/sessions/outputs) + routing"`。

---

## Task 4: 时间轴首页(重写 `HomeView`)

**Files:** Modify `src/features/home/HomeView.tsx`、`src/App.tsx`(传 `onOpenTrack` 给 HomeView)、样式文件。

- [ ] **Step 1:** 读现有 `src/features/home/HomeView.tsx`(保留 Hero/今日建议/模式网格的可复用部分)、`src/domain/timeline.ts` 的 `buildTimeline`/`TimelineEvent`。
- [ ] **Step 2:** 重写 `HomeView` 为三段式(props 增 `onOpenTrack: (themeId: string) => void`):
  1. **Hero**:沿用 `HeaderBlock`(card.title + 「▶ 一键开始」`onStart` + whyNow + 引用 + 视角 chips)。
  2. **主题线横排**:`state.themes.map` → 紧凑卡(name + 成熟度徽章 + appearances + 成熟度圆点);点击 `onOpenTrack(theme.id)`;末尾「＋ 新建主题线」按钮(本期 `onStart("long-term")`)。空→「还没有主题线,完成专访后会自动浮现」。
  3. **时间轴流**:`buildTimeline(state, 20).map` → 时间轴项(左侧圆点+竖线、时间、kind 徽章、title、summary、右侧 outputs 计数);项点击按 `event.href` 跳转(view==="track" 时 `onOpenTrack(href.trackId)`,否则 `setView`——通过 props 回调)。空→引导首次专访。
  - 保留底部「选择访谈模式」网格(现有 modeOptions,作为次级入口)。
- [ ] **Step 3:** `src/App.tsx`:给 `<HomeView>` 传 `onOpenTrack={openTrack}`(Task 3 的 openTrack);时间轴项的非 track 跳转用现有 setView。
- [ ] **Step 4:** 样式:`.timeline`(竖线 + 圆点 + 项)、`.track-chip-row`(横向滚动/wrap 的主题线卡)、成熟度徽章配色。复用现有 token,保证强 Hero、清晰层次、一致留白、移动端可用。
- [ ] **Step 5:** `npm run typecheck` exit 0 + `npx vitest run --exclude "**/*.real.test.ts"` 全绿。扩 `src/features/empty-state-render.test.tsx`:空 state 下 HomeView 渲染时间轴/主题线空状态文案。
- [ ] **Step 6:** 提交:`git add src/features/home/HomeView.tsx src/App.tsx src/features/empty-state-render.test.tsx <样式文件> && git commit -m "feat(home): timeline narrative homepage with track chips"`。

---

## Task 5: e2e 适配 + 视觉自审

**Files:** Modify `tests/e2e/navigation.spec.ts`(3 区分组标签)、Create `tests/e2e/timeline-track.spec.ts`。

- [ ] **Step 1:** 读 `tests/e2e/navigation.spec.ts` 中对导航分组/标签的断言,适配为新 3 区(访谈工作台/认知资产/系统)与「主题线」标签。**只改因导航重组而失效的断言,不削弱其它断言。**
- [ ] **Step 2:** 新增 `tests/e2e/timeline-track.spec.ts`:
  - 首页可见「时间轴」与至少一个主题线卡;
  - 点击首页某主题线卡 → 进入主题线工作区,可见三列标题(Sources/历次专访/Outputs)与「继续这条线」;
  - 点「← 返回」回到首页。
- [ ] **Step 3:** Run `npx playwright test` — 期望全绿(含原有 + 新增)。修正失败。
- [ ] **Step 4: 视觉自审**(UI 模式定稿前一轮):Hero 是否够强?时间轴节奏是否清晰?主题线卡对齐与留白?移动端单列是否可用?空状态是否齐全?交互(hover/点击)是否清楚?若有一处明显弱点,改进一次。
- [ ] **Step 5:** 提交:`git add tests/e2e/navigation.spec.ts tests/e2e/timeline-track.spec.ts <视觉自审改动> && git commit -m "test(e2e): 3-zone nav + timeline/track workspace journeys"`。

---

## Self-Review

**1. Spec 覆盖:** 3 区导航(T2)、时间轴首页 Hero/主题线/时间轴流(T4)、主题线工作区(T3)、2 个领域函数+测试(T1)、e2e+视觉自审(T5)——逐一对应 spec 第 1/2/3/5 节。

**2. 占位扫描:** 领域函数给完整代码;UI 组件给结构+验收+关键回调(JSX/CSS 按现有 token 实现,非占位)。`sources` 关联在 Task 1 显式标注"以实际 RagChunk 类型为准,无字段则返回 []"。

**3. 类型一致:** `TimelineEvent`/`TrackWorkspace` 字段在 T1 定义、T3/T4 消费一致;`View` 加 `track` 在 T2、消费在 T3;`onOpenTrack`/`openTrack`/`launchInterview` 命名跨 Task 一致。

**4. 风险:** App.tsx 改导航+加路由靠 Playwright(T5)兜底;聚合正确性靠纯函数单测(T1);视觉质量靠 T5 自审。
