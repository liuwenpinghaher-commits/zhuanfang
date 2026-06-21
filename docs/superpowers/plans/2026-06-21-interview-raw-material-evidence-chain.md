# 专访原始材料 / 证据链（Phase 1）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让每条派生资产（记忆/主题/笔记/观点/决策/知识债）能跳回产生它的那一句专访原文，并把完成会话的原文降冷到独立存储，避免热 state blob 膨胀。

**Architecture:** 复用已存在的 `session.turns` + `strategyTrace`；在 domain finalize 内按"逐字引用"把资产锚定到来源 turn（纯函数 `resolveEvidenceAnchors`）；完成会话的原文由路由层降冷到新表 `interview_raw_material`，热 state 只留派生资产 + 轻量锚点 + 旁注；查看器按需懒加载冷层。

**Tech Stack:** TypeScript、Fastify、better-sqlite3（packages/db）、React + Vite、vitest。纯函数 domain 层 + 仓储双实现（内存/SQLite）。

参考设计文档：`docs/superpowers/specs/2026-06-21-interview-raw-material-evidence-chain-design.md`

---

## 文件结构

**新建：**
- `src/domain/raw-material.ts` — 纯域逻辑：`resolveEvidenceAnchors`、`stampFinalizeAnchors`、`addAnnotation`、`removeAnnotation`、`backfillEvidenceAnchors`。
- `src/domain/raw-material.test.ts` — 上述纯函数的 TDD 测试。
- `apps/api/src/raw-material-repository.ts` — `RawMaterialRepository` 接口 + 内存实现（镜像 `apps/api/src/product-state-repository.ts`）。
- `packages/db/src/sqlite-raw-material-repository.ts` — SQLite 实现 + 表 DDL。
- `packages/db/src/sqlite-raw-material-repository.test.ts` — SQLite 仓储测试。
- `apps/api/src/routes/raw-material.ts` — `GET /api/sessions/:id/raw-material` + 降冷 helper `offloadCompletedSession`。
- `src/features/notes/RawMaterialViewer.tsx` — 证据链查看器组件。

**修改：**
- `src/domain/types.ts` — 新类型 + 资产加 `evidenceAnchors?`、note 加 `keyQuoteAnchor?`、session 加 `rawMaterialOffloaded?`、`ProductState.interviewAnnotations`、审计类型。
- `src/domain/finalize.ts` — `mergeFinalizedState` 内调用 `stampFinalizeAnchors`。
- `src/domain/seed.ts` / `src/domain/engine.ts`（createEmptyProductState）/ `src/domain/privacy.ts`（purge）/ `src/domain/migration.ts`（计数）— `interviewAnnotations: []`。
- `src/domain/storage.ts` — normalize `interviewAnnotations`（封顶 500）。
- `apps/api/src/routes/interview-sessions.ts` — `/end` 调用 `offloadCompletedSession`。
- `apps/api/src/server.ts` — 装配 `RawMaterialRepository`、注册 raw-material 路由、purge 清冷层。
- `src/App.tsx` / `src/features/notes/NotesView.tsx` / `src/api/productApiClient`（或等价）— 查看器入口 + `getRawMaterial` + 旁注 handler。

**里程碑：** M1 数据模型/管道 → M2 溯源+旁注（domain）→ M3 冷store+降冷+懒加载 → M4 迁移/回填 → M5 UI → M6 导出/清除治理。

---

## Milestone 1 — 数据模型 + 状态管道

### Task 1: 新类型与 ProductState 字段

**Files:**
- Modify: `src/domain/types.ts`

- [ ] **Step 1: 加类型**（放在 `UserProfile` 之后、`InterviewTurn` 已存在处附近）

```ts
export interface EvidenceAnchor {
  sessionId: string;
  turnId: string;
}

export interface InterviewAnnotation {
  id: string;
  sessionId: string;
  turnId: string;
  text: string;
  createdAt: string;
}

export interface InterviewRawMaterial {
  sessionId: string;
  turns: InterviewTurn[];
  strategyTrace: InterviewStrategyDecision[];
  createdAt: string;
}
```

- [ ] **Step 2: 资产加可选锚点**（在各 interface 内加一行；不破坏现有数据）

```ts
// MemoryRecord / MemoryCandidate / PointAsset / DecisionAsset / KnowledgeDebt 各加：
  evidenceAnchors?: EvidenceAnchor[];
// DualTrackNote 加：
  keyQuoteAnchor?: EvidenceAnchor;
// InterviewSession 加：
  rawMaterialOffloaded?: boolean;
```

- [ ] **Step 3: ProductState 加数组**（紧跟 `profileSuggestions` 之后）

```ts
  interviewAnnotations: InterviewAnnotation[];
```

- [ ] **Step 4: 审计类型**（AuditEvent.type union 内）

```ts
    | "annotation_created"
    | "annotation_removed"
```

- [ ] **Step 5: 类型检查**

Run: `npx tsc -p tsconfig.json --noEmit`
Expected: 多处报 `interviewAnnotations` 缺失（seed/empty/privacy/test 等）——下个 Task 修。先确认**没有** EvidenceAnchor/InterviewAnnotation 本身的语法错误。

- [ ] **Step 6: Commit**

```bash
git add src/domain/types.ts
git commit -m "feat(types): 原始材料证据链类型(EvidenceAnchor/InterviewAnnotation/RawMaterial)"
```

### Task 2: 状态管道补 interviewAnnotations

**Files:**
- Modify: `src/domain/seed.ts`, `src/domain/engine.ts`, `src/domain/storage.ts`, `src/domain/privacy.ts`, `src/domain/migration.ts`

- [ ] **Step 1: seed**（`src/domain/seed.ts`，`profileSuggestions: []` 之后加）

```ts
  interviewAnnotations: [],
```

- [ ] **Step 2: createEmptyProductState**（`src/domain/engine.ts`，`profileSuggestions: [],` 之后加）

```ts
    interviewAnnotations: [],
```

- [ ] **Step 3: normalize + 封顶**（`src/domain/storage.ts`，文件顶部常量区加 `const MAX_ANNOTATIONS = 500;`；在 `profileSuggestions` 归一化之后加）

```ts
    interviewAnnotations: Array.isArray(candidate.interviewAnnotations)
      ? candidate.interviewAnnotations.slice(0, MAX_ANNOTATIONS)
      : fallback.interviewAnnotations,
```

- [ ] **Step 4: 全量 purge**（`src/domain/privacy.ts` 的 `createPurgedProductState` 返回对象，`profileSuggestions: [],` 之后加 `interviewAnnotations: [],`）；**scoped purge** 的 `case "interviews"` 改为同时清旁注：

```ts
    case "interviews":
      next = { ...currentState, sessions: [], notes: [], interviewAnnotations: [] };
      break;
```

- [ ] **Step 5: 迁移计数**（`src/domain/migration.ts`，`interviews` 条目 count 加 `+ (state.interviewAnnotations ?? []).length`）

- [ ] **Step 6: 类型检查 + 修测试夹具**

Run: `npx tsc -p tsconfig.json --noEmit && npx tsc -p apps/api/tsconfig.json`
Expected: 报 `src/domain/types.test.ts` / `src/domain/session-archive.test.ts` 等 ProductState 字面量缺 `interviewAnnotations`。给这些字面量各加 `interviewAnnotations: [],`，直至两个 tsc 都干净。

- [ ] **Step 7: Commit**

```bash
git add src/domain/seed.ts src/domain/engine.ts src/domain/storage.ts src/domain/privacy.ts src/domain/migration.ts src/domain/types.test.ts src/domain/session-archive.test.ts
git commit -m "feat: interviewAnnotations 接入 seed/empty/normalize(封顶)/purge/migration"
```

---

## Milestone 2 — 溯源 + 旁注（domain 纯函数 TDD）

### Task 3: resolveEvidenceAnchors（逐字引用 → 来源轮次）

**Files:**
- Create: `src/domain/raw-material.ts`
- Test: `src/domain/raw-material.test.ts`

- [ ] **Step 1: 写失败测试**（`src/domain/raw-material.test.ts`）

```ts
import { describe, it, expect } from "vitest";
import { resolveEvidenceAnchors } from "./raw-material";
import type { InterviewTurn } from "./types";

const turn = (id: string, role: "user" | "assistant", content: string): InterviewTurn => ({
  id, role, content, intent: "", timestamp: "2026-06-21T00:00:00.000Z"
});

describe("resolveEvidenceAnchors", () => {
  const turns = [
    turn("t1", "assistant", "你怕的是结果失控，还是判断力被质疑？"),
    turn("t2", "user", "其实是怕我自己不再被需要。"),
    turn("t3", "user", "我一直不敢把审批权交给团队，怕出错。")
  ];

  it("精确匹配逐字引用到来源 turn", () => {
    const a = resolveEvidenceAnchors("其实是怕我自己不再被需要。", "s1", turns);
    expect(a).toEqual([{ sessionId: "s1", turnId: "t2" }]);
  });

  it("引用是某 turn 的子串也能命中", () => {
    const a = resolveEvidenceAnchors("不敢把审批权交给团队", "s1", turns);
    expect(a).toEqual([{ sessionId: "s1", turnId: "t3" }]);
  });

  it("空引用 / 匹配不到 → 空数组(不伪造)", () => {
    expect(resolveEvidenceAnchors("", "s1", turns)).toEqual([]);
    expect(resolveEvidenceAnchors("一句对话里根本没有的话", "s1", turns)).toEqual([]);
  });

  it("只在 user 轮里找(默认不锚到主持人的话)", () => {
    const a = resolveEvidenceAnchors("你怕的是结果失控", "s1", turns);
    expect(a).toEqual([]);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run src/domain/raw-material.test.ts`
Expected: FAIL — 模块不存在。

- [ ] **Step 3: 实现**（`src/domain/raw-material.ts`）

```ts
import type { EvidenceAnchor, InterviewTurn } from "./types";

/** 把 LLM 逐字摘录的用户原话匹配回它来自的 user 轮。精确子串优先；归一化(去空白/标点)子串退化匹配；
 *  匹配不到返回空数组——绝不伪造来源。只在 user 轮里找。 */
export function resolveEvidenceAnchors(
  quote: string,
  sessionId: string,
  turns: InterviewTurn[]
): EvidenceAnchor[] {
  const q = quote.trim();
  if (!q) {
    return [];
  }
  const userTurns = turns.filter((t) => t.role === "user");
  const exact = userTurns.find((t) => t.content.includes(q) || q.includes(t.content.trim()));
  if (exact) {
    return [{ sessionId, turnId: exact.id }];
  }
  const norm = (s: string) => s.replace(/[\s。，、；：！？·.,;:!?"'「」（）()]/g, "");
  const nq = norm(q);
  if (!nq) {
    return [];
  }
  const fuzzy = userTurns.find((t) => {
    const nt = norm(t.content);
    return nt.includes(nq) || nq.includes(nt);
  });
  return fuzzy ? [{ sessionId, turnId: fuzzy.id }] : [];
}
```

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run src/domain/raw-material.test.ts`
Expected: PASS（4 例）。

- [ ] **Step 5: Commit**

```bash
git add src/domain/raw-material.ts src/domain/raw-material.test.ts
git commit -m "feat(raw-material): resolveEvidenceAnchors 逐字引用→来源轮次(TDD)"
```

### Task 4: addAnnotation / removeAnnotation

**Files:**
- Modify: `src/domain/raw-material.ts`, `src/domain/raw-material.test.ts`

- [ ] **Step 1: 追加失败测试**

```ts
import { addAnnotation, removeAnnotation } from "./raw-material";
import { createInitialProductState } from "./engine";

describe("interview annotations", () => {
  it("addAnnotation 追加一条带 turn 锚点的旁注,trim,记审计", () => {
    const s = createInitialProductState();
    const next = addAnnotation(s, "sess-1", "turn-9", "  这里他其实在回避  ");
    expect(next.interviewAnnotations).toHaveLength(1);
    expect(next.interviewAnnotations[0].text).toBe("这里他其实在回避");
    expect(next.interviewAnnotations[0].sessionId).toBe("sess-1");
    expect(next.interviewAnnotations[0].turnId).toBe("turn-9");
    expect(next.auditEvents.some((e) => e.type === "annotation_created")).toBe(true);
  });

  it("空白旁注被忽略", () => {
    const s = createInitialProductState();
    expect(addAnnotation(s, "sess-1", "turn-9", "   ").interviewAnnotations).toHaveLength(0);
  });

  it("removeAnnotation 删除指定 id,不存在则原样返回", () => {
    const s = addAnnotation(createInitialProductState(), "sess-1", "turn-9", "x");
    const id = s.interviewAnnotations[0].id;
    expect(removeAnnotation(s, id).interviewAnnotations).toHaveLength(0);
    expect(removeAnnotation(s, "nope")).toBe(s);
  });

  it("不可变:不改输入 state", () => {
    const s = createInitialProductState();
    addAnnotation(s, "sess-1", "turn-9", "x");
    expect(s.interviewAnnotations).toHaveLength(0);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run src/domain/raw-material.test.ts`
Expected: FAIL — `addAnnotation` 未导出。

- [ ] **Step 3: 实现**（`src/domain/raw-material.ts` 追加）

```ts
import type { EvidenceAnchor, InterviewAnnotation, InterviewTurn, ProductState } from "./types";
import { cloneState, makeId, nowIso, withAuditEvent } from "./utils";

export function addAnnotation(
  state: ProductState,
  sessionId: string,
  turnId: string,
  text: string
): ProductState {
  const body = text.trim();
  if (!body) {
    return state;
  }
  const createdAt = nowIso();
  const annotation: InterviewAnnotation = { id: makeId("annotation"), sessionId, turnId, text: body, createdAt };
  const next = cloneState(state);
  next.interviewAnnotations = [annotation, ...next.interviewAnnotations];
  return withAuditEvent(next, {
    type: "annotation_created",
    label: "新增专访旁注",
    detail: body,
    severity: "info",
    entityType: "interview_session",
    entityId: sessionId,
    createdAt
  });
}

export function removeAnnotation(state: ProductState, annotationId: string): ProductState {
  const target = state.interviewAnnotations.find((a) => a.id === annotationId);
  if (!target) {
    return state;
  }
  const createdAt = nowIso();
  const next = cloneState(state);
  next.interviewAnnotations = next.interviewAnnotations.filter((a) => a.id !== annotationId);
  return withAuditEvent(next, {
    type: "annotation_removed",
    label: "删除专访旁注",
    detail: target.text,
    severity: "info",
    entityType: "interview_session",
    entityId: target.sessionId,
    createdAt
  });
}
```

注意：把 Step 3 的 import 与 Task 3 已有的 import 合并去重（`EvidenceAnchor`/`InterviewTurn` 已引入）。

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run src/domain/raw-material.test.ts`
Expected: PASS（全部）。

- [ ] **Step 5: Commit**

```bash
git add src/domain/raw-material.ts src/domain/raw-material.test.ts
git commit -m "feat(raw-material): addAnnotation/removeAnnotation(TDD)"
```

### Task 5: stampFinalizeAnchors + 接入 finalize

**Files:**
- Modify: `src/domain/raw-material.ts`, `src/domain/raw-material.test.ts`, `src/domain/finalize.ts`

- [ ] **Step 1: 追加失败测试**（在 raw-material.test.ts）

```ts
import { stampFinalizeAnchors } from "./raw-material";

describe("stampFinalizeAnchors", () => {
  const turns = [turn("t2", "user", "其实是怕我自己不再被需要。")];
  it("给带 evidenceQuote 的记忆候选盖上锚点", () => {
    const candidates = [{ evidenceQuote: "其实是怕我自己不再被需要。" } as any];
    const out = stampFinalizeAnchors(candidates, "s1", turns);
    expect(out[0].evidenceAnchors).toEqual([{ sessionId: "s1", turnId: "t2" }]);
  });
  it("匹配不到则不加 evidenceAnchors(保持 undefined)", () => {
    const out = stampFinalizeAnchors([{ evidenceQuote: "没有的话" } as any], "s1", turns);
    expect(out[0].evidenceAnchors).toBeUndefined();
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run src/domain/raw-material.test.ts`
Expected: FAIL — `stampFinalizeAnchors` 未导出。

- [ ] **Step 3: 实现**（raw-material.ts 追加；泛型，给任何带 `evidenceQuote` 的对象盖锚点）

```ts
export function stampFinalizeAnchors<T extends { evidenceQuote?: string; evidenceAnchors?: EvidenceAnchor[] }>(
  items: T[],
  sessionId: string,
  turns: InterviewTurn[]
): T[] {
  return items.map((item) => {
    if (item.evidenceAnchors && item.evidenceAnchors.length > 0) {
      return item;
    }
    const anchors = resolveEvidenceAnchors(item.evidenceQuote ?? "", sessionId, turns);
    return anchors.length > 0 ? { ...item, evidenceAnchors: anchors } : item;
  });
}
```

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run src/domain/raw-material.test.ts`
Expected: PASS。

- [ ] **Step 5: 接入 mergeFinalizedState**（`src/domain/finalize.ts`）：在把 `providedCandidates` 注入前，对其盖锚点；并对 points（用其 evidence[0] 作 quote 包一层）盖锚点。最小改动：import `stampFinalizeAnchors`，在 `nextState.memoryCandidates = [...annotated, ...]` 之前：

```ts
const anchored = stampFinalizeAnchors(annotated, session.id, session.turns);
nextState.memoryCandidates = [...anchored, ...(nextState.memoryCandidates ?? [])];
```

（points/decisions/debts 的锚点可在 M5 之前补；本 Task 只锚记忆候选，先打通最核心的"记忆→源头"。）

- [ ] **Step 6: 全量回归**

Run: `npx vitest run src/domain/finalize.test.ts src/domain/raw-material.test.ts`
Expected: PASS。

- [ ] **Step 7: Commit**

```bash
git add src/domain/raw-material.ts src/domain/raw-material.test.ts src/domain/finalize.ts
git commit -m "feat(finalize): 记忆候选在 finalize 时按逐字引用盖证据锚点"
```

---

## Milestone 3 — 冷层存储 + 降冷 + 懒加载

### Task 6: RawMaterialRepository 接口 + 内存实现

**Files:**
- Create: `apps/api/src/raw-material-repository.ts`
- Test: `apps/api/src/raw-material-repository.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
import { describe, it, expect } from "vitest";
import { createInMemoryRawMaterialRepository } from "./raw-material-repository";
import type { InterviewRawMaterial } from "../../../src/domain/types";

const material = (id: string): InterviewRawMaterial => ({
  sessionId: id, turns: [], strategyTrace: [], createdAt: "2026-06-21T00:00:00.000Z"
});

describe("in-memory RawMaterialRepository", () => {
  it("put 后能 get 回来,不存在返回 undefined", () => {
    const repo = createInMemoryRawMaterialRepository();
    expect(repo.get("s1")).toBeUndefined();
    repo.put(material("s1"));
    expect(repo.get("s1")?.sessionId).toBe("s1");
  });
  it("delete 删单条, deleteAll 清空", () => {
    const repo = createInMemoryRawMaterialRepository();
    repo.put(material("s1")); repo.put(material("s2"));
    repo.delete("s1");
    expect(repo.get("s1")).toBeUndefined();
    expect(repo.get("s2")?.sessionId).toBe("s2");
    repo.deleteAll();
    expect(repo.get("s2")).toBeUndefined();
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run apps/api/src/raw-material-repository.test.ts`
Expected: FAIL — 模块不存在。

- [ ] **Step 3: 实现**

```ts
import type { InterviewRawMaterial } from "../../../src/domain/types";

export interface RawMaterialRepository {
  get(sessionId: string): InterviewRawMaterial | undefined;
  put(material: InterviewRawMaterial): void;
  delete(sessionId: string): void;
  deleteAll(): void;
}

export function createInMemoryRawMaterialRepository(): RawMaterialRepository {
  const store = new Map<string, InterviewRawMaterial>();
  return {
    get: (id) => store.get(id),
    put: (m) => { store.set(m.sessionId, m); },
    delete: (id) => { store.delete(id); },
    deleteAll: () => { store.clear(); }
  };
}
```

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run apps/api/src/raw-material-repository.test.ts`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/raw-material-repository.ts apps/api/src/raw-material-repository.test.ts
git commit -m "feat(raw-material): RawMaterialRepository 接口 + 内存实现(TDD)"
```

### Task 7: SQLite 实现

**Files:**
- Create: `packages/db/src/sqlite-raw-material-repository.ts`
- Test: `packages/db/src/sqlite-raw-material-repository.test.ts`

- [ ] **Step 1: 写失败测试**（用内存 sqlite `:memory:`，镜像 `sqlite-product-state-repository.test.ts` 的建库方式）

```ts
import { describe, it, expect } from "vitest";
import { createSqliteRawMaterialRepository } from "./sqlite-raw-material-repository";
import type { InterviewRawMaterial } from "../../../src/domain/types";

const mk = (id: string): InterviewRawMaterial => ({
  sessionId: id,
  turns: [{ id: "t1", role: "user", content: "原话", intent: "", timestamp: "2026-06-21T00:00:00.000Z" }],
  strategyTrace: [],
  createdAt: "2026-06-21T00:00:00.000Z"
});

describe("sqlite RawMaterialRepository", () => {
  it("put→get 往返,跨实例持久(同 dbPath)", () => {
    const repo = createSqliteRawMaterialRepository({ dbPath: ":memory:" });
    repo.put(mk("s1"));
    expect(repo.get("s1")?.turns[0].content).toBe("原话");
    expect(repo.get("missing")).toBeUndefined();
  });
  it("delete / deleteAll", () => {
    const repo = createSqliteRawMaterialRepository({ dbPath: ":memory:" });
    repo.put(mk("s1")); repo.put(mk("s2"));
    repo.delete("s1");
    expect(repo.get("s1")).toBeUndefined();
    repo.deleteAll();
    expect(repo.get("s2")).toBeUndefined();
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run packages/db/src/sqlite-raw-material-repository.test.ts`
Expected: FAIL — 模块不存在。

- [ ] **Step 3: 实现**（镜像 `sqlite-product-state-repository.ts` 的 better-sqlite3 用法）

```ts
import Database from "better-sqlite3";
import type { InterviewRawMaterial } from "../../../src/domain/types";
import type { RawMaterialRepository } from "../../../apps/api/src/raw-material-repository";

export function createSqliteRawMaterialRepository(opts: { dbPath: string }): RawMaterialRepository {
  const db = new Database(opts.dbPath);
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS interview_raw_material (
      session_id          TEXT PRIMARY KEY,
      turns_json          TEXT NOT NULL,
      strategy_trace_json TEXT,
      created_at          TEXT NOT NULL
    );
  `);
  const upsert = db.prepare(
    `INSERT INTO interview_raw_material (session_id, turns_json, strategy_trace_json, created_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(session_id) DO UPDATE SET turns_json=excluded.turns_json,
       strategy_trace_json=excluded.strategy_trace_json, created_at=excluded.created_at`
  );
  const selectOne = db.prepare("SELECT * FROM interview_raw_material WHERE session_id = ?");
  const deleteOne = db.prepare("DELETE FROM interview_raw_material WHERE session_id = ?");
  const deleteAllStmt = db.prepare("DELETE FROM interview_raw_material");
  return {
    get(sessionId) {
      const row = selectOne.get(sessionId) as
        | { session_id: string; turns_json: string; strategy_trace_json: string | null; created_at: string }
        | undefined;
      if (!row) return undefined;
      return {
        sessionId: row.session_id,
        turns: JSON.parse(row.turns_json),
        strategyTrace: row.strategy_trace_json ? JSON.parse(row.strategy_trace_json) : [],
        createdAt: row.created_at
      };
    },
    put(m) {
      upsert.run(m.sessionId, JSON.stringify(m.turns), JSON.stringify(m.strategyTrace ?? []), m.createdAt);
    },
    delete(sessionId) { deleteOne.run(sessionId); },
    deleteAll() { deleteAllStmt.run(); }
  };
}
```

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run packages/db/src/sqlite-raw-material-repository.test.ts`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add packages/db/src/sqlite-raw-material-repository.ts packages/db/src/sqlite-raw-material-repository.test.ts
git commit -m "feat(db): SQLite RawMaterialRepository + interview_raw_material 表(TDD)"
```

### Task 8: 降冷 helper + /end 接入 + 懒加载端点

**Files:**
- Create: `apps/api/src/routes/raw-material.ts`
- Modify: `apps/api/src/routes/interview-sessions.ts`, `apps/api/src/server.ts`
- Test: `apps/api/src/routes/raw-material.test.ts`

- [ ] **Step 1: 写失败测试**（纯函数 `offloadCompletedSession` 先 TDD：给定 state + sessionId，返回 `{ hotState, material }`，热 state 该会话 turns 清空 + `rawMaterialOffloaded:true`）

```ts
import { describe, it, expect } from "vitest";
import { offloadCompletedSession } from "./raw-material";
import { createInitialProductState } from "../../../../src/domain/engine";

describe("offloadCompletedSession", () => {
  it("把指定会话的 turns/strategyTrace 抽成冷层载荷,热 state 剥离并打标", () => {
    const base = createInitialProductState();
    const state = { ...base, sessions: [{
      id: "s1", title: "t", mode: "daily", strength: "standard", status: "completed",
      startedAt: "2026-06-21T00:00:00.000Z", turns: [
        { id: "t1", role: "user", content: "原话", intent: "", timestamp: "2026-06-21T00:00:00.000Z" }
      ], strategyTrace: [], card: {} as any, guide: {} as any
    } as any] };
    const { hotState, material } = offloadCompletedSession(state, "s1");
    expect(material?.turns).toHaveLength(1);
    const s = hotState.sessions.find((x) => x.id === "s1")!;
    expect(s.turns).toHaveLength(0);
    expect(s.rawMaterialOffloaded).toBe(true);
  });
  it("会话不存在 → material undefined,hotState 原样", () => {
    const state = createInitialProductState();
    const { hotState, material } = offloadCompletedSession(state, "nope");
    expect(material).toBeUndefined();
    expect(hotState).toBe(state);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run apps/api/src/routes/raw-material.test.ts`
Expected: FAIL — 模块不存在。

- [ ] **Step 3: 实现 helper + 路由**（`apps/api/src/routes/raw-material.ts`）

```ts
import type { FastifyInstance } from "fastify";
import type { InterviewRawMaterial, ProductState } from "../../../../src/domain/types";
import type { RawMaterialRepository } from "../raw-material-repository";

export function offloadCompletedSession(
  state: ProductState,
  sessionId: string
): { hotState: ProductState; material?: InterviewRawMaterial } {
  const session = state.sessions.find((s) => s.id === sessionId);
  if (!session) {
    return { hotState: state };
  }
  const material: InterviewRawMaterial = {
    sessionId,
    turns: session.turns,
    strategyTrace: session.strategyTrace ?? [],
    createdAt: session.completedAt ?? session.startedAt
  };
  const hotState: ProductState = {
    ...state,
    sessions: state.sessions.map((s) =>
      s.id === sessionId ? { ...s, turns: [], strategyTrace: [], rawMaterialOffloaded: true } : s
    )
  };
  return { hotState, material };
}

export async function registerRawMaterialRoutes(
  server: FastifyInstance,
  rawRepo: RawMaterialRepository
): Promise<void> {
  server.get("/api/sessions/:id/raw-material", async (request, reply) => {
    const id = (request.params as { id?: string }).id ?? "";
    const material = rawRepo.get(id);
    if (!material) {
      return reply.code(404).send({ error: "Raw material not found for session." });
    }
    return material;
  });
}
```

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run apps/api/src/routes/raw-material.test.ts`
Expected: PASS。

- [ ] **Step 5: 接入 /end**（`apps/api/src/routes/interview-sessions.ts`：找到 finalize 后 `repository.replaceState(...)` 的位置；改为先降冷再落库）

```ts
// finalize 产出 nextState 后：
const { hotState, material } = offloadCompletedSession(nextState, session.id);
if (material) {
  options.rawMaterialRepository.put(material);
}
repository.replaceState(hotState);
```

需要把 `rawMaterialRepository` 加入该路由工厂的 options 类型与签名（沿 `embeddingClient` 等既有 options 模式）。

- [ ] **Step 6: server.ts 装配**（`apps/api/src/server.ts`）

```ts
// 顶部 import
import { createSqliteRawMaterialRepository } from "../../../packages/db/src/sqlite-raw-material-repository";
import { registerRawMaterialRoutes } from "./routes/raw-material";
// 生产装配处(createSqliteProductStateRepository 附近)：
const rawMaterialRepository = createSqliteRawMaterialRepository({ dbPath: rawMaterialDbPath });
// 注册：
void server.register(async (s) => { await registerRawMaterialRoutes(s, rawMaterialRepository); });
// 并把 rawMaterialRepository 传进 interview-sessions 路由 options。
// 测试装配处用 createInMemoryRawMaterialRepository()。
```
`rawMaterialDbPath` 取与 product-state db 同目录、文件名 `raw-material.sqlite`。

- [ ] **Step 7: 类型检查 + 回归**

Run: `npx tsc -p apps/api/tsconfig.json && npx vitest run apps/api/src/routes/raw-material.test.ts apps/api/src/routes/interview-sessions.test.ts`
Expected: 干净 + PASS（interview-sessions 测试若装配缺 rawMaterialRepository，补 in-memory 实例）。

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/routes/raw-material.ts apps/api/src/routes/raw-material.test.ts apps/api/src/routes/interview-sessions.ts apps/api/src/server.ts
git commit -m "feat(api): 完成会话降冷到 raw-material 冷层 + 懒加载端点 + /end 接入"
```

---

## Milestone 4 — 迁移 / 回填

### Task 9: 存量会话降冷 + 锚点回填脚本

**Files:**
- Create: `scripts/migrate-raw-material.mjs`
- Modify: `src/domain/raw-material.ts`（加 `backfillEvidenceAnchors`）+ 测试

- [ ] **Step 1: 写 backfillEvidenceAnchors 失败测试**（raw-material.test.ts）

```ts
import { backfillEvidenceAnchors } from "./raw-material";

describe("backfillEvidenceAnchors", () => {
  it("用 sessions 的 turns 给已有 memoryRecords 补锚点,幂等", () => {
    const base = createInitialProductState();
    const state = {
      ...base,
      sessions: [{ id: "s1", turns: [turn("t2", "user", "其实是怕我自己不再被需要。")] } as any],
      memoryRecords: [{ id: "m1", evidenceQuote: "其实是怕我自己不再被需要。", sourceId: "s1" } as any]
    };
    const out = backfillEvidenceAnchors(state);
    expect(out.memoryRecords[0].evidenceAnchors).toEqual([{ sessionId: "s1", turnId: "t2" }]);
    // 幂等：再跑一次不变
    expect(backfillEvidenceAnchors(out).memoryRecords[0].evidenceAnchors).toEqual([{ sessionId: "s1", turnId: "t2" }]);
  });
});
```

- [ ] **Step 2: 运行确认失败 → 实现**（raw-material.ts）

```ts
export function backfillEvidenceAnchors(state: ProductState): ProductState {
  const turnsBySession = new Map<string, InterviewTurn[]>();
  for (const s of state.sessions) {
    turnsBySession.set(s.id, s.turns ?? []);
  }
  const stamp = <T extends { evidenceQuote?: string; evidenceAnchors?: EvidenceAnchor[]; sourceId?: string }>(items: T[]): T[] =>
    items.map((item) => {
      if (item.evidenceAnchors?.length || !item.sourceId) return item;
      const turns = turnsBySession.get(item.sourceId) ?? [];
      const anchors = resolveEvidenceAnchors(item.evidenceQuote ?? "", item.sourceId, turns);
      return anchors.length ? { ...item, evidenceAnchors: anchors } : item;
    });
  return { ...cloneState(state), memoryRecords: stamp(state.memoryRecords), memoryCandidates: stamp(state.memoryCandidates) };
}
```

注意：回填须在 turns 仍在热层时跑（即降冷之前）。

- [ ] **Step 3: 运行确认通过**

Run: `npx vitest run src/domain/raw-material.test.ts`
Expected: PASS。

- [ ] **Step 4: 一次性迁移脚本**（`scripts/migrate-raw-material.mjs`）：GET 现有 state → 对每个 `status==="completed"` 且未 offloaded 的会话先 `backfillEvidenceAnchors`，再逐会话 `offloadCompletedSession` 并把 material POST 到一个临时迁移端点或直接写库；最后 import 回热 state。**因 mjs 不便调 TS 仓储，简化为：** 脚本只负责回填锚点 + 把 turns 留在 state，由"下次该会话被 /end 或一个新增的 `POST /api/admin/offload-all` 端点"完成降冷。

> 决策点（留给执行者按现状择一，二选一即可，都可工作）：
> - **A（推荐，简单可靠）**：新增内部端点 `POST /api/admin/offload-completed`，服务端遍历完成会话→`backfillEvidenceAnchors`→逐个 `offloadCompletedSession`+`rawRepo.put`→`replaceState`。脚本只调它一次。
> - **B**：纯脚本，用 tsx 直接 import 仓储与域函数离线迁移 sqlite 文件。

- [ ] **Step 5: 实现迁移端点（采用 A）**：在 `apps/api/src/routes/raw-material.ts` 加 `POST /api/admin/offload-completed`，逻辑如上；TDD 一个路由测试（构造含完成会话+turns 的 state → 调用 → 热 state 剥离 + 冷层有数据 + 锚点已补）。

- [ ] **Step 6: 跑迁移 + 验证**

```bash
node scripts/migrate-raw-material.mjs   # 或 curl POST /api/admin/offload-completed
```
验证：`GET /api/state` 的 blob 显著变小（turns 剥离）；`GET /api/sessions/<id>/raw-material` 能取回原文；某条记忆带 evidenceAnchors。

- [ ] **Step 7: Commit**

```bash
git add src/domain/raw-material.ts src/domain/raw-material.test.ts apps/api/src/routes/raw-material.ts apps/api/src/routes/raw-material.test.ts scripts/migrate-raw-material.mjs
git commit -m "feat(migration): 存量会话降冷 + 证据锚点回填(幂等)"
```

---

## Milestone 5 — UI（证据链查看器）

### Task 10: productApiClient.getRawMaterial + 旁注 handler

**Files:**
- Modify: 前端 API 客户端（`src/api/*` 中现有 productApiClient）、`src/App.tsx`

- [ ] **Step 1: 加 API 客户端方法**

```ts
async getRawMaterial(sessionId: string): Promise<InterviewRawMaterial | null> {
  const res = await fetch(`${BASE}/api/sessions/${sessionId}/raw-material`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`raw-material ${res.status}`);
  return res.json();
}
```

- [ ] **Step 2: App.tsx 旁注 handler**（沿 addCorrection 模式）

```ts
function addInterviewAnnotation(sessionId: string, turnId: string, text: string) {
  setProductState(addAnnotation(productState, sessionId, turnId, text));
}
function removeInterviewAnnotation(id: string) {
  setProductState(removeAnnotation(productState, id));
}
```
（import 自 `./domain/raw-material`；走现有 autosave，无新端点。）

- [ ] **Step 3: 类型检查**

Run: `npx tsc -p tsconfig.json --noEmit`
Expected: 干净。

- [ ] **Step 4: Commit**

```bash
git add src/api src/App.tsx
git commit -m "feat(web): getRawMaterial 客户端 + 旁注 handler(autosave)"
```

### Task 11: RawMaterialViewer 组件 + NotesView 入口

**Files:**
- Create: `src/features/notes/RawMaterialViewer.tsx`
- Modify: `src/features/notes/NotesView.tsx`

- [ ] **Step 1: 组件**（懒加载冷层 turns + 内联 AI 思考 + 每轮旁注 + 反向溯源）

```tsx
// props: { sessionId, state, onAddAnnotation, onRemoveAnnotation, getRawMaterial }
// 行为：
//  - useEffect 拉 getRawMaterial(sessionId) → {turns, strategyTrace}
//  - 逐轮渲染 content + timestamp；assistant 轮旁显示对应 strategyTrace[turnIndex] 的 reason/strategy
//  - 每轮：state.interviewAnnotations.filter(a=>a.turnId===turn.id) 列出 + “加旁注”输入
//  - 反向溯源：state.memoryRecords/points/... 中 evidenceAnchors 命中此 turn 的 → 列“由此产生”
//  - 加载中/404 空态
```
（完整 JSX 由执行者按现有组件风格写；关键是上述行为契约 + 复用 field-stack/clean-list/empty-hint 类。）

- [ ] **Step 2: NotesView 入口**：每条笔记加“查看原始材料”按钮 → 展开/打开 `RawMaterialViewer sessionId={note.sessionId}`。

- [ ] **Step 3: 类型检查 + 手测**

Run: `npx tsc -p tsconfig.json --noEmit`
然后 `npm run dev:full`，打开档案页 → 某条笔记 → 查看原始材料：能看到专访稿 + AI 思考 + 加旁注 + “由此产生”。

- [ ] **Step 4: Commit**

```bash
git add src/features/notes/RawMaterialViewer.tsx src/features/notes/NotesView.tsx
git commit -m "feat(web): 证据链查看器(专访稿+AI思考+旁注+反向溯源) + 笔记入口"
```

### Task 12: 记忆库/主题线“查看原文出处”跳转

**Files:**
- Modify: 记忆视图 + 主题视图（`src/features/memory/*`、`src/features/track/*` 或 `themes/*`）

- [ ] **Step 1:** 对带 `evidenceAnchors` 的记忆/主题，加“查看原文出处”链接 → 打开 `RawMaterialViewer`（anchor.sessionId）并滚动到 `anchor.turnId`（RawMaterialViewer 接受可选 `focusTurnId` prop，加载后 scrollIntoView）。

- [ ] **Step 2:** RawMaterialViewer 增 `focusTurnId?` prop + 加载后滚动高亮。

- [ ] **Step 3: 类型检查 + 手测**：从一条长期记忆点“查看原文出处” → 跳到那次专访的那一句。

- [ ] **Step 4: Commit**

```bash
git add src/features
git commit -m "feat(web): 记忆/主题→原文出处跳转(锚点+滚动高亮)"
```

---

## Milestone 6 — 导出 / 清除治理

### Task 13: 导出含冷层 + purge 清冷层

**Files:**
- Modify: `apps/api/src/routes/state.ts`（export/import/purge）、`apps/api/src/server.ts`

- [ ] **Step 1: 写失败测试**（state 路由测试：export 返回里含 rawMaterial；purge all/interviews 后 rawRepo 被清）

```ts
it("purge(all) 清空冷层 raw material", async () => {
  // 装配带 in-memory rawRepo,先 put 一条;调用 purge all;断言 rawRepo.get(...) undefined
});
it("export 打包冷层原始材料,可经 import 恢复", async () => {
  // put 一条; GET export; 断言 payload 含该 sessionId 的 turns
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run apps/api/src/routes/state.test.ts`
Expected: 新用例 FAIL。

- [ ] **Step 3: 实现**：
  - purge 处理器在清热 state 后调用 `rawMaterialRepository.deleteAll()`（all）或对 interviews scope 删被清会话的冷层行。
  - export 端点把 `rawMaterialRepository` 全量读出并并入导出包（新字段 `rawMaterials: InterviewRawMaterial[]`）。
  - import 端点若 payload 含 `rawMaterials`，逐条 `rawRepo.put`。
  - 这些都需要 state 路由工厂 options 注入 `rawMaterialRepository`（沿现有模式）。

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run apps/api/src/routes/state.test.ts`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/state.ts apps/api/src/server.ts apps/api/src/routes/state.test.ts
git commit -m "feat(governance): 导出含冷层原始材料 + purge 清冷层(隐私闭环)"
```

### Task 14: 全量回归 + 收尾

- [ ] **Step 1: typecheck 双工程**

Run: `npx tsc -p tsconfig.json --noEmit && npx tsc -p apps/api/tsconfig.json`
Expected: 干净。

- [ ] **Step 2: 全量测试**

Run: `npx vitest run`
Expected: 全绿（含新增用例；当前基线 86 文件不破）。

- [ ] **Step 3: 端到端手测**：新跑一次短专访 → /end → 档案页查看原始材料（专访稿+思考）→ 加旁注 → 从产出的记忆“查看原文出处”跳回 → `GET /api/state` blob 不含该完成会话 turns（已降冷）。

- [ ] **Step 4: Commit（如有收尾改动）**

```bash
git commit -am "chore: 原始材料证据链 Phase 1 收尾与回归"
```

---

## 自审记录（写计划后对照 spec）

- **spec 覆盖**：§3 冷热拆分→T6-8；§4 类型→T1；§5 溯源→T3/T5；§6 降冷→T8；§7 懒加载→T8；§8 旁注→T4/T10；§9 查看器→T11;§10 融合(导出/清除)→T13,跳转→T12;§11 迁移→T9;§12 测试散落各 Task;§13 风险(读 turns 旧代码审计)→T8 Step5 注释提示 + T14 手测兜底。
- **类型一致**：`offloadCompletedSession`/`resolveEvidenceAnchors`/`stampFinalizeAnchors`/`backfillEvidenceAnchors`/`addAnnotation`/`removeAnnotation`/`RawMaterialRepository` 全程同名。
- **已知留白（执行者决策）**：T9 迁移 A/B 两法择一（已写明，均可工作）；points/decisions/debts 的锚点在 T5 暂只锚记忆候选，UI(T11/T12)主要消费记忆/主题锚点——如需扩展到 points 等，按 `stampFinalizeAnchors` 同法在 T5 追加（低风险）。
- **YAGNI**：无音频、无实时旁注、无字符级范围。
