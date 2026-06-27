# SurrealDB × 本体论 · P1b 边投影 + turn 正规化 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 P1a 留在 `rest` 里的三套旧边编码（`relatedThemeIds[]` / `evidenceAnchors`·`keyQuoteAnchor`·`representativeQuoteAnchor` / `memoryEdges`）投影成 SurrealDB 原生 `RELATE` 边，并把 `session.turns` 正规化进 `turn` 表（+ `part_of` 边）——让 P0 建好的边表真正有数据，为 P2 图召回（"谁指向某主题""沿 derived_from 溯源"）铺好底；**仍 opt-in、默认 sqlite、域层与既有测试不动**。

**Architecture:** 纯增量,只扩 P1a 的 `SurrealStore`。新增 `edge-mapper.ts`（纯函数 `collectEdges(state): EdgeSpec[]`,吞四套旧编码,= [ontology/02 §6](../../ontology/02-三元组与图模型.md) 的 `collectRelations` 在 SurrealDB 落地）。`persist` 在节点全量覆盖后,**追加**:把各 session 的 turns 写进 `turn` 表 + DELETE 四张受管边表(`belongs_to_theme`/`derived_from`/`about_theme`/`part_of`)后按 `collectEdges` 全量 `RELATE`(同一事务)。**边只写不读**:`getState` 仍从 `rest` 读旧字段(P1a 无损往返不变),边是给 P2 图查询的冗余投影。

**Tech Stack:** 同 P1a（`surrealdb`@2.0.4 + `@surrealdb/node`@3.0.3 = SurrealDB 3.0.2 核心,3.x 语法）。

---

## 0. 上下文与护栏

### 0.1 纪律（不可触碰）
- 不改 `src/domain/**`、不改既有测试、不改默认存储（仍 sqlite）。`ProductStateRepository` 接口不变。
- `getState`/`loadState` **不变**：旧字段继续从 `rest` 读，**不从边回填**（P1a 已无损存旧字段;spec 02 §3 的"读时回填"留到 P2 末下线旧字段时）。
- 边投影是**写侧增量**;`turn` 表数据与 `session.rest.turns` 在 P1b **暂并存**（重复存储,P1c/P2 把 turns 移出 rest 后去重）。
- 保护无关已改文件;**绝不 `git add -A`**;在隔离 worktree 执行。

### 0.2 承接 P1a 的事实（必懂）
- `persist`（`packages/db/src/surreal/surreal-product-state-repository.ts`）已是"事务内每表 delete-all + `CREATE type::record(table,$id) CONTENT $rec`",P1b 在其内追加 turn 写入 + 边 RELATE。
- **SurrealDB 删节点不自动删其 RELATE 边**（A5 是 P3 才落 DB）。所以 P1b 的边也走**全量覆盖**:每次 persist 先 `DELETE` 四张受管边表再重建,不留悬挂边。
- 3.x 坑(P1a 已踩):`type::record`(非 `type::thing`);`RELATE` 端点同样用 `type::record('tbl',$id)`(实现时若 RELATE 不接受 type::record,fallback 用 `RecordId` 参数对象——见 Task 2 校正点);边对象字段已在 002 用 `provenance.origin` ASSERT(`llm_extracted` 合法)。
- `normalizeProductState` 的 `pruneDanglingThemeRefs` 已剪掉指向不存在主题的 `relatedThemeIds`,故 persist 时 relatedThemeIds 只指向现存主题;`collectEdges` 仍用 known-id 集二次过滤,防 derived_from 指向不存在的 turn。

### 0.3 边映射（据 `src/domain/types.ts` 真值 + ontology/02 §6）
| 旧编码（字段:types.ts 行） | 来源数组(表) | → 边 | to | data |
|---|---|---|---|---|
| `relatedThemeIds[]`(:611/668/704/718/737/751/1027) | sessions(session)/notes(note)/points(point)/questions(question)/decisions(decision)/debts(debt)/importSources(material) | `belongs_to_theme` | `theme:<id>` | — |
| `evidenceAnchors[]`(:709/740/754/860/886) | points(point)/decisions(decision)/debts(debt)/memoryRecords(memory)/memoryCandidates(memory_candidate) | `derived_from` | `turn:<turnId>` | `provenance={origin:'llm_extracted',sessionId,turnId}` |
| `keyQuoteAnchor`(:669) | notes(note) | `derived_from` | `turn:<turnId>` | 同上 |
| `representativeQuoteAnchor`(:770) | themes(theme) | `derived_from` | `turn:<turnId>` | 同上 |
| `memoryEdges[]`(MemoryEdge :889) | memoryEdges(state 顶层数组) | `about_theme` | `theme:<themeId>` | — |
| `session.turns[]`(InterviewTurn :251) | 各 session.turns | `part_of`(turn→session) + 写 `turn` 表 | `session:<sessionId>` | — |

- `EvidenceAnchor = { sessionId, turnId }`（types.ts:105）。`MemoryEdge = { fromMemoryRecordId, themeId }`（:889）。
- provenance.origin 统一 `'llm_extracted'`（锚点不带 origin;P3 公理按 status 细化）。
- 过滤:`belongs_to_theme`/`about_theme` 的 `to` themeId 必须 ∈ `state.themes` id 集;`derived_from` 的 turnId 必须 ∈ 所有 session.turns 的 id 集（否则跳过该边,旧字段仍在 rest 无损,只是不建该边）。

### 0.4 不做（后续）
- P1c:diff-upsert（替 P1b 的全量覆盖;边也增量）；把 turns 移出 `session.rest`（去重,getState 改从 turn 表读 turns 回填）。
- P1d:双写/影子读/切读 Surreal 权威（接入运行 server,高风险）。
- P3:`contradicts`/`evolves_into`/`corrects`/`promoted_from` 边(推理层检出,非旧编码投影);A5 级联删落 DB。

---

## 1. 文件结构
```
packages/db/src/surreal/
  edge-mapper.ts        # 新:collectEdges(state)→EdgeSpec[];turnRecordsOf(state)→turn 记录;known-id 过滤
  edge-mapper.test.ts   # 新:四套编码投影 + 过滤 + provenance 单测
  surreal-product-state-repository.ts  # 改:persist 追加 turn 写入 + 边全量覆盖 RELATE
  surreal-product-state-repository.test.ts  # 改:加图遍历集成测试(含"曾漏 decisions"回归)
```

---

## 2. 任务

### Task 1: `edge-mapper.ts`（collectEdges + turn 提取）+ 单测

**Files:**
- Create: `packages/db/src/surreal/edge-mapper.ts`
- Create: `packages/db/src/surreal/edge-mapper.test.ts`

- [ ] **Step 1: 写失败测试（RED）**

`packages/db/src/surreal/edge-mapper.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { collectEdges, turnRecordsOf } from "./edge-mapper";
import { createInitialProductState } from "../../../../src/domain/engine";

function baseState() {
  const s = createInitialProductState();
  return {
    ...s,
    themes: [{ id: "th_1", name: "放权", summary: "", maturity: "聚焦" as const, representativeQuote: "", appearances: 1, nextQuestion: "", updatedAt: "2026-06-27T00:00:00.000Z" }],
    sessions: [{ ...s.sessions[0], id: "se_1", turns: [
      { id: "tu_1", role: "user" as const, content: "原话", intent: "", timestamp: "2026-06-27T00:00:00.000Z" }
    ] }],
    points: [{ id: "pt_1", title: "t", content: "c", status: "稳定观点" as const, confidence: "用户确认" as const, evidence: [], relatedThemeIds: ["th_1"], important: false, updatedAt: "2026-06-27T00:00:00.000Z", evidenceAnchors: [{ sessionId: "se_1", turnId: "tu_1" }] }],
    decisions: [{ id: "de_1", title: "t", decisionKind: "用户决策" as const, confirmationStatus: "用户确认" as const, choice: "c", tradeOff: "", riskHypothesis: "", reviewAt: "", status: "待复盘" as const, updatedAt: "2026-06-27T00:00:00.000Z", relatedThemeIds: ["th_1"] }],
    memoryRecords: [{ id: "me_1", text: "x", status: "confirmed" as const, sourceType: "profile" as const, sourceId: "p", evidenceQuote: "", createdAt: "2026-06-27T00:00:00.000Z", updatedAt: "2026-06-27T00:00:00.000Z" }],
    memoryEdges: [{ fromMemoryRecordId: "me_1", themeId: "th_1" }]
  };
}

describe("edge-mapper", () => {
  it("relatedThemeIds → belongs_to_theme(point + decision 都覆盖,根治召回漏类)", () => {
    const edges = collectEdges(baseState());
    const bt = edges.filter((e) => e.edge === "belongs_to_theme");
    expect(bt).toContainEqual(expect.objectContaining({ edge: "belongs_to_theme", fromTable: "point", fromId: "pt_1", toTable: "theme", toId: "th_1" }));
    expect(bt).toContainEqual(expect.objectContaining({ fromTable: "decision", fromId: "de_1", toTable: "theme", toId: "th_1" }));
  });

  it("evidenceAnchors → derived_from(带 provenance,指向现存 turn)", () => {
    const df = collectEdges(baseState()).filter((e) => e.edge === "derived_from");
    expect(df).toContainEqual(expect.objectContaining({
      edge: "derived_from", fromTable: "point", fromId: "pt_1", toTable: "turn", toId: "tu_1",
      data: { provenance: { origin: "llm_extracted", sessionId: "se_1", turnId: "tu_1" } }
    }));
  });

  it("memoryEdges → about_theme", () => {
    const at = collectEdges(baseState()).filter((e) => e.edge === "about_theme");
    expect(at).toContainEqual(expect.objectContaining({ edge: "about_theme", fromTable: "memory", fromId: "me_1", toTable: "theme", toId: "th_1" }));
  });

  it("session.turns → part_of + turn 记录", () => {
    const st = baseState();
    expect(collectEdges(st)).toContainEqual(expect.objectContaining({ edge: "part_of", fromTable: "turn", fromId: "tu_1", toTable: "session", toId: "se_1" }));
    const turns = turnRecordsOf(st);
    expect(turns).toContainEqual(expect.objectContaining({ id: "tu_1", sessionId: "se_1", role: "user", content: "原话" }));
  });

  it("过滤悬挂边:指向不存在 turn/theme 的锚点/关联不产边", () => {
    const st = baseState();
    st.points[0].evidenceAnchors = [{ sessionId: "se_x", turnId: "tu_missing" }];
    st.decisions[0].relatedThemeIds = ["th_missing"];
    const edges = collectEdges(st);
    expect(edges.some((e) => e.edge === "derived_from" && e.toId === "tu_missing")).toBe(false);
    expect(edges.some((e) => e.edge === "belongs_to_theme" && e.toId === "th_missing")).toBe(false);
  });
});
```

- [ ] **Step 2: 跑确认 RED**
Run: `npx vitest run packages/db/src/surreal/edge-mapper.test.ts`
Expected: FAIL（`./edge-mapper` 不存在）。

- [ ] **Step 3: 实现 edge-mapper**

`packages/db/src/surreal/edge-mapper.ts`:
```ts
import type { ProductState, EvidenceAnchor } from "../../../../src/domain/types";

export interface EdgeSpec {
  edge: "belongs_to_theme" | "derived_from" | "about_theme" | "part_of";
  fromTable: string;
  fromId: string;
  toTable: string;
  toId: string;
  data?: Record<string, unknown>;
}

/** turn 记录(写 turn 表用):从各 session.turns 摊平,带 sessionId 外键。 */
export function turnRecordsOf(state: ProductState): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const s of state.sessions) {
    for (const t of s.turns ?? []) {
      out.push({ id: t.id, sessionId: s.id, role: t.role, content: t.content, intent: t.intent, timestamp: t.timestamp });
    }
  }
  return out;
}

/** 把四套旧编码 + turns 投影成统一 EdgeSpec[]。known-id 集过滤悬挂边。 */
export function collectEdges(state: ProductState): EdgeSpec[] {
  const edges: EdgeSpec[] = [];
  const themeIds = new Set(state.themes.map((t) => t.id));
  const turnIds = new Set<string>();
  for (const s of state.sessions) for (const t of s.turns ?? []) turnIds.add(t.id);

  // ① relatedThemeIds[] → belongs_to_theme
  const theme = (fromTable: string, fromId: string, ids?: string[]) => {
    for (const tid of ids ?? []) if (themeIds.has(tid)) edges.push({ edge: "belongs_to_theme", fromTable, fromId, toTable: "theme", toId: tid });
  };
  for (const x of state.points)        theme("point", x.id, x.relatedThemeIds);
  for (const x of state.questions)     theme("question", x.id, x.relatedThemeIds);
  for (const x of state.decisions)     theme("decision", x.id, x.relatedThemeIds);
  for (const x of state.debts)         theme("debt", x.id, x.relatedThemeIds);
  for (const x of state.notes)         theme("note", x.id, x.relatedThemeIds);
  for (const x of state.sessions)      theme("session", x.id, x.relatedThemeIds);
  for (const x of state.importSources) theme("material", x.id, x.relatedThemeIds);

  // ② EvidenceAnchor → derived_from(带 provenance,指向现存 turn)
  const derived = (fromTable: string, fromId: string, anchors?: EvidenceAnchor[]) => {
    for (const a of anchors ?? []) if (turnIds.has(a.turnId)) edges.push({
      edge: "derived_from", fromTable, fromId, toTable: "turn", toId: a.turnId,
      data: { provenance: { origin: "llm_extracted", sessionId: a.sessionId, turnId: a.turnId } }
    });
  };
  for (const x of state.points)           derived("point", x.id, x.evidenceAnchors);
  for (const x of state.decisions)        derived("decision", x.id, x.evidenceAnchors);
  for (const x of state.debts)            derived("debt", x.id, x.evidenceAnchors);
  for (const x of state.memoryRecords)    derived("memory", x.id, x.evidenceAnchors);
  for (const x of state.memoryCandidates) derived("memory_candidate", x.id, x.evidenceAnchors);
  for (const x of state.notes)            derived("note", x.id, x.keyQuoteAnchor ? [x.keyQuoteAnchor] : undefined);
  for (const x of state.themes)           derived("theme", x.id, x.representativeQuoteAnchor ? [x.representativeQuoteAnchor] : undefined);

  // ③ MemoryEdge → about_theme
  for (const e of state.memoryEdges) if (themeIds.has(e.themeId)) edges.push({ edge: "about_theme", fromTable: "memory", fromId: e.fromMemoryRecordId, toTable: "theme", toId: e.themeId });

  // ④ session.turns → part_of(turn→session)
  for (const s of state.sessions) for (const t of s.turns ?? []) edges.push({ edge: "part_of", fromTable: "turn", fromId: t.id, toTable: "session", toId: s.id });

  return edges;
}

/** persist 管理(全量覆盖前 DELETE)的边表。 */
export const MANAGED_EDGE_TABLES = ["belongs_to_theme", "derived_from", "about_theme", "part_of"] as const;
```

- [ ] **Step 4: 跑确认 GREEN**
Run: `npx vitest run packages/db/src/surreal/edge-mapper.test.ts`
Expected: PASS。

- [ ] **Step 5: Commit**
```bash
git add packages/db/src/surreal/edge-mapper.ts packages/db/src/surreal/edge-mapper.test.ts
git commit -m "feat(db): edge-mapper — project legacy encodings (relatedThemeIds/anchors/memoryEdges/turns) to RELATE specs

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: `persist` 追加 turn 写入 + 边全量覆盖

**Files:**
- Modify: `packages/db/src/surreal/surreal-product-state-repository.ts`（`persist` 函数 + import）

- [ ] **Step 1: 扩 persist（在节点 CREATE 后、UPSERT state_meta 前,追加 turn 表 + 边）**

在 `surreal-product-state-repository.ts` 顶部 import 追加：
```ts
import { collectEdges, turnRecordsOf, MANAGED_EDGE_TABLES } from "./edge-mapper";
```
把 `persist` 改为（在节点循环之后、`UPSERT state_meta` 之前插入 turn + 边段）：
```ts
async function persist(db: Surreal, snapshot: ProductState): Promise<void> {
  const meta: Record<string, unknown> = {};
  for (const k of META_KEYS) meta[k] = (snapshot as unknown as Record<string, unknown>)[k];

  let surql = "BEGIN TRANSACTION;\n";
  const vars: Record<string, unknown> = {};
  let i = 0;

  // 1) 节点表全量覆盖(P1a)
  for (const m of NODE_MAPPINGS) {
    surql += `DELETE ${m.table};\n`;
    const arr = ((snapshot as unknown as Record<string, unknown>)[m.stateKey] as Array<{ id: string }>) ?? [];
    for (const entity of arr) {
      const recVar = `r${i++}`;
      vars[recVar] = toRecord(entity as Record<string, unknown>, m);
      vars[`${recVar}_id`] = entity.id;
      surql += `CREATE type::record('${m.table}', $${recVar}_id) CONTENT $${recVar};\n`;
    }
  }

  // 2) turn 表正规化(P1b):全量覆盖。turns 同时仍在 session.rest(P1a,无损读),此处冗余写入供边引用 + P2 图查询。
  surql += `DELETE turn;\n`;
  for (const t of turnRecordsOf(snapshot)) {
    const tv = `t${i++}`;
    vars[tv] = t;
    vars[`${tv}_id`] = t.id;
    surql += `CREATE type::record('turn', $${tv}_id) CONTENT $${tv};\n`;
  }

  // 3) 边全量覆盖(P1b):先清四张受管边表,再按 collectEdges RELATE。
  //    (删节点不自动清边,A5 是 P3;此处全量重建保不留悬挂边。)
  for (const et of MANAGED_EDGE_TABLES) surql += `DELETE ${et};\n`;
  for (const e of collectEdges(snapshot)) {
    const ev = `e${i++}`;
    vars[`${ev}_f`] = e.fromId;
    vars[`${ev}_t`] = e.toId;
    let rel = `RELATE type::record('${e.fromTable}', $${ev}_f)->${e.edge}->type::record('${e.toTable}', $${ev}_t)`;
    if (e.data) { vars[`${ev}_d`] = e.data; rel += ` CONTENT $${ev}_d`; }
    surql += rel + ";\n";
  }

  // 4) state_meta(P1a)
  vars.meta = meta;
  vars.rev = snapshot.revision ?? 0;
  surql += `UPSERT ${META_ID} SET revision = $rev, rest = $meta;\n`;
  surql += "COMMIT TRANSACTION;";

  await db.query(surql, vars);
}
```
> **校正点（按真实 3.x SDK 坐实）**:① `RELATE type::record('point',$f)->belongs_to_theme->type::record('theme',$t)` 若 3.x 不接受 `type::record` 作 RELATE 端点,fallback:在 JS 构造 `new RecordId(table, id)` 作参数 `RELATE $from->edge->$to`（`import { RecordId } from "surrealdb"`,本文件已 import）。② `RELATE ... CONTENT $d` 写边字段;若 3.x RELATE 用 `SET` 而非 `CONTENT`,改 `SET provenance = $..._d_provenance`（data 仅 derived_from 有,形如 `{provenance:{...}}`）。③ derived_from.provenance.origin 受 002 ASSERT,`llm_extracted` 合法。

- [ ] **Step 2: typecheck**
Run: `npx tsc -p packages/db/tsconfig.json --noEmit`
Expected: 通过。

- [ ] **Step 3: Commit**
```bash
git add packages/db/src/surreal/surreal-product-state-repository.ts
git commit -m "feat(db): persist writes turn records + RELATE edges (full-overwrite) from edge-mapper

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: 图遍历集成测试（含"曾漏 decisions"回归）

**Files:**
- Modify: `packages/db/src/surreal/surreal-product-state-repository.test.ts`（追加 describe）

- [ ] **Step 1: 追加图遍历测试（mem://,直接查底层 db 验边）**

> SurrealStore 不暴露 db。测试用一个 helper 经 `createSurrealConnection` + `applySchema` 直连同一 `mem://` 不行（不同实例）。改为:测试构造 repo、replaceState、flush 后,**用 repo 的 `close` 前**无法查 db。故新增一个**仅测试用**的导出:在 `surreal-product-state-repository.ts` 给 `SurrealRepoHandle` 加 `query<T>(surql:string):Promise<T>`(转发 `db.query`),供集成测试查边。

先在 `surreal-product-state-repository.ts` 的 `SurrealRepoHandle` 接口 + 返回对象加：
```ts
// 接口里:
  /** 仅测试/诊断用:直查底层 db(读边等)。生产路径不应依赖。 */
  query<T>(surql: string, vars?: Record<string, unknown>): Promise<T>;
// 返回对象里(close 之前):
    query<T>(surql: string, vars?: Record<string, unknown>) { return db.query<T>(surql, vars) as Promise<T>; },
```
再在 `surreal-product-state-repository.test.ts` 追加：
```ts
describe("surreal graph edges (mem://)", () => {
  it("belongs_to_theme 入边:point + decision + question 一次拿全(含曾漏 decisions 回归)", async () => {
    const repo = await makeMem();
    const base = repo.getState();
    repo.replaceState({ ...base,
      themes: [{ id: "th_1", name: "放权", summary: "", maturity: "聚焦" as const, representativeQuote: "", appearances: 1, nextQuestion: "", updatedAt: "2026-06-27T00:00:00.000Z" }],
      points: [{ id: "pt_1", title: "t", content: "c", status: "稳定观点" as const, confidence: "用户确认" as const, evidence: [], relatedThemeIds: ["th_1"], important: false, updatedAt: "2026-06-27T00:00:00.000Z" }],
      decisions: [{ id: "de_1", title: "t", decisionKind: "用户决策" as const, confirmationStatus: "用户确认" as const, choice: "c", tradeOff: "", riskHypothesis: "", reviewAt: "", status: "待复盘" as const, updatedAt: "2026-06-27T00:00:00.000Z", relatedThemeIds: ["th_1"] }],
      questions: [{ id: "qu_1", question: "q", whyImportant: "", status: "开放" as const, appearances: 1, relatedThemeIds: ["th_1"], nextPrompt: "", important: false, updatedAt: "2026-06-27T00:00:00.000Z" }]
    });
    await repo.flush();
    const [pts] = await repo.query<[unknown[]]>("SELECT VALUE <-belongs_to_theme<-point FROM theme:th_1;");
    const [decs] = await repo.query<[unknown[]]>("SELECT VALUE <-belongs_to_theme<-decision FROM theme:th_1;");
    const [qus] = await repo.query<[unknown[]]>("SELECT VALUE <-belongs_to_theme<-question FROM theme:th_1;");
    expect((pts?.[0] as unknown[] ?? []).length).toBe(1);
    expect((decs?.[0] as unknown[] ?? []).length).toBe(1);   // 曾漏 decisions:图模型下天然覆盖
    expect((qus?.[0] as unknown[] ?? []).length).toBe(1);
  });

  it("derived_from 带 provenance 指向 turn;part_of 连 turn→session", async () => {
    const repo = await makeMem();
    const base = repo.getState();
    repo.replaceState({ ...base,
      sessions: [{ ...base.sessions[0], id: "se_1", turns: [{ id: "tu_1", role: "user" as const, content: "原话", intent: "", timestamp: "2026-06-27T00:00:00.000Z" }] }],
      points: [{ id: "pt_1", title: "t", content: "c", status: "稳定观点" as const, confidence: "用户确认" as const, evidence: [], relatedThemeIds: [], important: false, updatedAt: "2026-06-27T00:00:00.000Z", evidenceAnchors: [{ sessionId: "se_1", turnId: "tu_1" }] }]
    });
    await repo.flush();
    const [prov] = await repo.query<[Array<{ provenance: { origin: string } }>]>("SELECT provenance FROM derived_from;");
    expect(prov?.[0]?.provenance?.origin).toBe("llm_extracted");
    const [src] = await repo.query<[unknown[]]>("SELECT VALUE ->derived_from->turn FROM point:pt_1;");
    expect((src?.[0] as unknown[] ?? []).length).toBe(1);
    const [parent] = await repo.query<[unknown[]]>("SELECT VALUE ->part_of->session FROM turn:tu_1;");
    expect((parent?.[0] as unknown[] ?? []).length).toBe(1);
  });

  it("边全量覆盖:删掉关联后重写,旧边不残留", async () => {
    const repo = await makeMem();
    const base = repo.getState();
    const theme = { id: "th_1", name: "x", summary: "", maturity: "聚焦" as const, representativeQuote: "", appearances: 1, nextQuestion: "", updatedAt: "2026-06-27T00:00:00.000Z" };
    repo.replaceState({ ...base, themes: [theme], points: [{ id: "pt_1", title: "t", content: "c", status: "稳定观点" as const, confidence: "用户确认" as const, evidence: [], relatedThemeIds: ["th_1"], important: false, updatedAt: "2026-06-27T00:00:00.000Z" }] });
    await repo.flush();
    // 去掉 relatedThemeIds 再写
    repo.replaceState({ ...repo.getState(), points: [{ ...repo.getState().points[0], relatedThemeIds: [] }] });
    await repo.flush();
    const [bt] = await repo.query<[unknown[]]>("SELECT * FROM belongs_to_theme;");
    expect((bt ?? []).length).toBe(0);   // 全量覆盖:旧边已清
  });
});
```
> 说明:给 `SurrealRepoHandle` 加 `query` 转发是为集成测试能验证原生边（contract 测试只验 ProductState 往返,看不到边）。该方法标注"仅测试/诊断用",生产路径不依赖。

- [ ] **Step 2: 跑测试**
Run: `npx vitest run packages/db/src/surreal/surreal-product-state-repository.test.ts`
Expected: PASS。若 RELATE/遍历语法因 3.x 微调,按 Task 2 校正点对齐后再跑。

- [ ] **Step 3: Commit**
```bash
git add packages/db/src/surreal/surreal-product-state-repository.ts packages/db/src/surreal/surreal-product-state-repository.test.ts
git commit -m "test(db): graph-edge integration — belongs_to_theme in-traversal (decisions regression) + derived_from/part_of

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: 全量回归 + typecheck

- [ ] **Step 1: 全量 + typecheck**
Run:
```bash
npm run typecheck && npx vitest run
```
Expected: typecheck 绿;vitest 在 P1a 基线（976 passed | 6 skipped）之上净增 edge-mapper + 图遍历测试,全绿、零回归。粘贴 summary。

- [ ] **Step 2: 契约未回退确认**
Run: `npx vitest run packages/db/src/surreal/ apps/api/src/product-state-repository.contract.test.ts`
Expected: 全绿（P1a 的契约 + 持久化重载仍过;边投影未破坏 ProductState 往返）。

- [ ] **Step 3: Commit（若上面有无伤大雅的调整）**
（通常无新改动;若 Task 2 校正点改了代码,确保已在对应 Task 提交。）

---

## 3. P1b 阶段门
- [ ] `collectEdges` 把四套旧编码 + turns 投影为 belongs_to_theme/derived_from/about_theme/part_of;known-id 过滤无悬挂边。
- [ ] persist 全量覆盖写 turn 表 + 四边表;"曾漏 decisions"图遍历回归绿;derived_from 带 provenance;part_of 连通。
- [ ] 边全量覆盖:去关联后旧边不残留。
- [ ] P1a 契约/持久化往返不回退;全量 ≥976、零回归;typecheck 绿。
- [ ] 默认 sqlite 不变;域层/既有测试未动;边只写不读（getState 仍从 rest）。

## 4. 自查（已执行）
- **Spec 覆盖**:spec 02 §3（旧字段并存 + 写侧投影边）/§5 T3（reconcileEdges）、ontology/02 §6（collectRelations 四套→一套）、spec 04 §2（belongs_to_theme 入边遍历"谁指向主题"= Task 3 回归）。turns→turn 表对齐 spec 01 §5 冷层。读侧回填、diff、双写显式划到 P1c/P1d/P2（§0.4）。
- **占位扫描**:无;edge-mapper/persist/测试均完整代码;枚举用 types.ts 真值;校正点为 3.x SDK 实测项(给 fallback),非占位。
- **类型一致**:`EdgeSpec`/`collectEdges`/`turnRecordsOf`/`MANAGED_EDGE_TABLES` 跨 Task 1/2/3 一致;`SurrealRepoHandle.query` 新增点在 Task 3 定义并使用;边表名与 002_relations.surql 一致(belongs_to_theme/derived_from/about_theme/part_of)。

## 5. 执行交接
**1. Subagent-Driven (recommended)** — 每 Task 派子代理 + 两阶段 review。
**2. Inline Execution** — 批执行 + checkpoint。
**Which approach?**
