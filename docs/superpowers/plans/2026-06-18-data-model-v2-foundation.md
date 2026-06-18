# 数据模型 v2 地基（Track 软聚合）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 `LongTermTheme` 升级为 `Track`（软聚合主题线），引入 `schemaVersion=2` 与 v1→v2 迁移，为后续"时间轴 + 主题线"信息架构打地基——**保留 `themes`/`relatedThemeIds` 字段名，零破坏现有 21 处 `.themes` 引用**。

**Architecture:** 类型升级而非重命名。`LongTermTheme` 加 `kind`/`pinned`/`createdAt`/`lastActiveAt` 四个**可选**字段并导出 `Track` 别名；给 `InterviewSession`/`DualTrackNote`/`DecisionAsset`/`KnowledgeDebt` 加**可选** `relatedThemeIds` 软标签；`normalizeProductState` 做 v1→v2 迁移（补默认值 + `schemaVersion=2`），用现有 `buildStableDigest`/字段对比做往返无损测试。可选字段保证旧数据与现有引用全部兼容。

**Tech Stack:** TypeScript, Vitest。

---

## Scope

本 plan 是**阶段 0 的地基子计划（0a）**。范围严格限定为数据模型类型升级 + 迁移 + 测试。

**不包含**（落地、测试全绿后各自出独立 plan）：
- **0b 删 PostgreSQL**：删 `packages/db/src/pg-product-state-repository.ts`、`pg-schema.ts`、`src/domain/postgresMigration.ts` 及引用（消解 P0-10、P1-17）。
- **0c 数据层清账（8 条）**：P0-11(intel 纳入隐私/迁移)、P1-18(revision 伪造)、P1-19(events 无界)、P2-8(策略死分支)、P2-18(candidate backfill)、P2-19(ImportSource.searchBriefId)、P2-20(PodcastEpisode.noteId)、P2-23(draft 死枚举)。
- **P1-24**（seed `theme-control` 悬空引用）：留到 0c，因它与 seed/资产生成相关，非纯迁移。

理由：地基（类型 + 迁移）是其它一切的前提，独立可交付可测；删 PG 与清账互不依赖，分开做 diff 更小、更易审查。

## File Structure

- **Modify** `src/domain/types.ts` — `LongTermTheme` 升级 + `Track` 别名 + 4 实体软标签字段 + `ProductState.schemaVersion`
- **Modify** `src/domain/seed.ts` — `themes` 两个种子元素补 v2 字段
- **Modify** `src/domain/storage.ts` — `normalizeProductState` 接入 `migrateThemesToTracks` + `schemaVersion`
- **Test** `src/domain/storage.test.ts` — 迁移补全 + 往返无损两个用例

---

## Task 1: Track 类型升级（types.ts）

**Files:**
- Modify: `src/domain/types.ts:662-671`（LongTermTheme）
- Modify: `src/domain/types.ts:499-517`（InterviewSession）、`:562-573`（DualTrackNote）、`:624-635`（DecisionAsset）、`:637-645`（KnowledgeDebt）
- Modify: `src/domain/types.ts:1151-1181`（ProductState）

- [ ] **Step 1: 升级 LongTermTheme 并导出 Track 别名**

把 `src/domain/types.ts:662-671` 的 `LongTermTheme` 替换为：

```typescript
export interface LongTermTheme {
  id: string;
  name: string;
  summary: string;
  maturity: "萌芽" | "重复" | "聚焦" | "成型" | "变化" | "关闭";
  representativeQuote: string;
  appearances: number;
  nextQuestion: string;
  updatedAt: string;
  // ── v2 Track 升级字段（可选以兼容 v1 数据；迁移函数补默认值）──
  kind?: "journal" | "theme" | "subject" | "project";
  pinned?: boolean;
  createdAt?: string;
  lastActiveAt?: string;
}

/** Track 是 LongTermTheme 升级后的对外概念名（软聚合主题线）。
 *  存储字段名保持 `themes` 不变，避免 21 处 `.themes` 引用的机械改名。 */
export type Track = LongTermTheme;
```

- [ ] **Step 2: 给 4 个实体加可选软标签字段**

在 `InterviewSession`（`:499`）接口体内，于 `interactionPreSignals?` 行后加一行：

```typescript
  /** v2 软标签：本会话软归属的主题线（可多归属、可为空）。 */
  relatedThemeIds?: string[];
```

在 `DualTrackNote`（`:562`）接口体内，于 `feedback?` 行后加：

```typescript
  relatedThemeIds?: string[];
```

在 `DecisionAsset`（`:624`）接口体内，于 `updatedAt` 行后加：

```typescript
  relatedThemeIds?: string[];
```

在 `KnowledgeDebt`（`:637`）接口体内，于 `updatedAt` 行后加：

```typescript
  relatedThemeIds?: string[];
```

> 注：`PointAsset`/`QuestionAsset`/`ReadingAsset`/`IntelTask` 已有 `relatedThemeIds`（必填），无需改动。

- [ ] **Step 3: ProductState 加 schemaVersion**

在 `ProductState`（`:1151`）接口体内，于 `revision: number;` 行后加：

```typescript
  /** 数据模型版本。v2 迁移后为 2；缺失视为 v1。 */
  schemaVersion?: number;
```

- [ ] **Step 4: 类型检查**

Run: `npm run typecheck`
Expected: PASS（exit 0）。新增字段均为可选，不破坏任何现有引用。

- [ ] **Step 5: 提交**

```bash
git add src/domain/types.ts
git commit -m "feat(types): upgrade LongTermTheme to Track + add soft-label fields (v2 foundation)"
```

---

## Task 2: seed 种子数据产出 v2 Track 字段（seed.ts）

**Files:**
- Modify: `src/domain/seed.ts:86-107`（themes 数组）

- [ ] **Step 1: 给两个种子主题补 v2 字段**

把 `src/domain/seed.ts:86-107` 的 `themes` 数组替换为（仅在每个元素末尾增加 4 个 v2 字段，其余不动）：

```typescript
  themes: [
    {
      id: "theme-control",
      name: "控制感",
      summary: "用户经常在团队授权、项目风险和亲自下场之间摆动。",
      maturity: "聚焦",
      representativeQuote: "我不是不想管，是不想每次都替他们兜底。",
      appearances: 5,
      nextQuestion: "如果你允许短期失控，最坏会发生什么？",
      updatedAt: "2026-06-05T09:00:00.000Z",
      kind: "theme",
      pinned: true,
      createdAt: "2026-06-05T09:00:00.000Z",
      lastActiveAt: "2026-06-05T09:00:00.000Z"
    },
    {
      id: "theme-role",
      name: "问题定义权",
      summary: "用户反复区分纯交付和真正的问题定义。",
      maturity: "重复",
      representativeQuote: "我不想把产品做成普通记录工具。",
      appearances: 3,
      nextQuestion: "你说的问题定义权，具体包括哪些不可让渡的判断？",
      updatedAt: "2026-06-08T09:00:00.000Z",
      kind: "theme",
      pinned: false,
      createdAt: "2026-06-08T09:00:00.000Z",
      lastActiveAt: "2026-06-08T09:00:00.000Z"
    }
  ],
```

- [ ] **Step 2: 类型检查**

Run: `npm run typecheck`
Expected: PASS。

- [ ] **Step 3: 提交**

```bash
git add src/domain/seed.ts
git commit -m "feat(seed): add v2 Track fields to seed themes"
```

---

## Task 3: v1→v2 迁移函数 + 测试（storage.ts）

**Files:**
- Modify: `src/domain/storage.ts:36`（themes 归一行）、`:64-65`（return 加 schemaVersion）、新增 `migrateThemesToTracks`
- Test: `src/domain/storage.test.ts`（新增用例）

- [ ] **Step 1: 写失败测试**

在 `src/domain/storage.test.ts` 的 `describe` 块内追加：

```typescript
  it("migrates v1 themes to v2 Track fields and sets schemaVersion", () => {
    const v1 = createInitialProductState();
    // 模拟 v1 数据：剥掉 v2 新增字段
    const v1Themes = v1.themes.map(({ kind, pinned, createdAt, lastActiveAt, ...rest }) => rest);
    const normalized = normalizeProductState({ ...v1, themes: v1Themes, schemaVersion: undefined });

    expect(normalized.schemaVersion).toBe(2);
    expect(normalized.themes[0].kind).toBe("theme");
    expect(normalized.themes[0].pinned).toBe(false);
    expect(normalized.themes[0].createdAt).toBe(normalized.themes[0].updatedAt);
    expect(normalized.themes[0].lastActiveAt).toBe(normalized.themes[0].updatedAt);
  });
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/domain/storage.test.ts -t "migrates v1 themes to v2"`
Expected: FAIL（`schemaVersion` 为 undefined / `kind` 为 undefined）。

- [ ] **Step 3: 实现迁移函数**

在 `src/domain/storage.ts` 的 `migrateWorkflowRuns` 函数（`:84`）上方新增：

```typescript
function migrateThemesToTracks(value: unknown[]): import("./types").LongTermTheme[] {
  return value.map((theme) => {
    if (!theme || typeof theme !== "object") return theme as import("./types").LongTermTheme;
    const t = theme as import("./types").LongTermTheme;
    return {
      ...t,
      kind: t.kind ?? "theme",
      pinned: t.pinned ?? false,
      createdAt: t.createdAt ?? t.updatedAt,
      lastActiveAt: t.lastActiveAt ?? t.updatedAt
    };
  });
}
```

- [ ] **Step 4: 在 normalizeProductState 接入**

把 `src/domain/storage.ts:36` 的 themes 归一行：

```typescript
    themes: Array.isArray(candidate.themes) ? migrateThemesToTracks(candidate.themes) : fallback.themes,
```

在 `src/domain/storage.ts:64`（`revision:` 行）后增加一行：

```typescript
    schemaVersion: 2,
```

- [ ] **Step 5: 跑测试确认通过**

Run: `npx vitest run src/domain/storage.test.ts -t "migrates v1 themes to v2"`
Expected: PASS。

- [ ] **Step 6: 提交**

```bash
git add src/domain/storage.ts src/domain/storage.test.ts
git commit -m "feat(storage): v1->v2 migration — backfill Track fields + schemaVersion"
```

---

## Task 4: 迁移往返无损测试（storage.test.ts）

**Files:**
- Test: `src/domain/storage.test.ts`（新增用例）

- [ ] **Step 1: 写往返无损测试**

在 `src/domain/storage.test.ts` 的 `describe` 块内追加：

```typescript
  it("v1->v2 migration preserves all existing theme content (no data loss)", () => {
    const v1 = createInitialProductState();
    const v1Themes = v1.themes.map(({ kind, pinned, createdAt, lastActiveAt, ...rest }) => rest);
    const normalized = normalizeProductState({ ...v1, themes: v1Themes });

    // 现有字段必须逐一无损
    expect(normalized.themes.map((t) => t.name)).toEqual(v1.themes.map((t) => t.name));
    expect(normalized.themes.map((t) => t.summary)).toEqual(v1.themes.map((t) => t.summary));
    expect(normalized.themes.map((t) => t.maturity)).toEqual(v1.themes.map((t) => t.maturity));
    expect(normalized.themes.map((t) => t.appearances)).toEqual(v1.themes.map((t) => t.appearances));
    // 其它资产数组不受影响
    expect(normalized.notes).toHaveLength(v1.notes.length);
    expect(normalized.points[0].relatedThemeIds).toEqual(v1.points[0].relatedThemeIds);
  });

  it("re-normalizing an already-v2 state is idempotent", () => {
    const once = normalizeProductState(createInitialProductState());
    const twice = normalizeProductState(once);
    expect(twice.schemaVersion).toBe(2);
    expect(twice.themes[0].kind).toBe(once.themes[0].kind);
    expect(twice.themes[0].pinned).toBe(once.themes[0].pinned);
  });
```

- [ ] **Step 2: 跑全部 storage 测试**

Run: `npx vitest run src/domain/storage.test.ts`
Expected: PASS（含原有用例 + 3 个新增用例）。

- [ ] **Step 3: 全量类型检查 + 全测试回归**

Run: `npm run typecheck && npx vitest run`
Expected: PASS（确认零破坏现有 442+ 用例）。

- [ ] **Step 4: 提交**

```bash
git add src/domain/storage.test.ts
git commit -m "test(storage): v1->v2 migration round-trip + idempotency"
```

---

## Self-Review

**1. Spec 覆盖**：本 plan 对应 spec 第 3.2 节"核心数据模型 v2"的地基部分（Track 类型、trackIds 软标签、schemaVersion、迁移函数）。spec 阶段 0 的删 PG、8 条清账已在 Scope 显式划归 0b/0c。

**2. 占位扫描**：无 TBD/TODO；每个代码步骤均给出完整可粘贴代码与确切命令。

**3. 类型一致性**：`Track = LongTermTheme` 别名；新增字段 `kind`/`pinned`/`createdAt`/`lastActiveAt` 在 types.ts（Task 1）、seed.ts（Task 2）、迁移（Task 3）、测试（Task 3/4）中名称完全一致；`schemaVersion` 在 types/storage/test 中一致。`maturity` 枚举用真实的 `萌芽|重复|聚焦|成型|变化|关闭`（非 spec 初稿误写的三值）。

**4. 兼容性**：所有新增字段可选；`themes`/`relatedThemeIds` 字段名不变 → 21 处 `.themes`、17 处 `relatedThemeIds` 引用零改动。Task 4 Step 3 全量回归兜底。

---

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-06-18-data-model-v2-foundation.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — 每个 Task 派一个 fresh subagent，task 间双段审查，快速迭代。

**2. Inline Execution** — 在本会话内用 executing-plans 批量执行，带检查点复查。

**Which approach?**
