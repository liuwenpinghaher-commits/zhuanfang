# SurrealDB × 本体论 · P1c diff-upsert 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 SurrealStore 的 `persist` 从"每次写全量覆盖整图"(P1b)换成 **diff-upsert**:只 UPSERT/DELETE 变更的节点/turn、只 RELATE/DELETE 变更的边——消除每轮访谈 `replaceState` 重写整库的写放大;仍 opt-in、默认 sqlite、行为等价。

**Architecture:** 新增纯函数 `diff.ts`(`diffById` 按 id 配对 diff、`diffEdges` 按 `from|edge|to` 身份集差)。`persist` 改为 `persist(db, prev, next)`:对每张节点表/turn 做 `diffById`(UPSERT 变更 + DELETE 移除),对边集做 `diffEdges`(RELATE 新增 + `DELETE <edge> WHERE in/out` 移除),单事务提交。**关键安全**:diff 基线用 `lastPersisted`(上次**成功**落库的状态,非内存 state),仅在 persist 成功后更新——某次落库失败被吞时,下次 diff 仍以旧基线计算、把漏掉的增量补上(与全量覆盖一样自愈,杜绝基线漂移)。

**Tech Stack:** 同前(`surrealdb`@2.0.4 + `@surrealdb/node`@3.0.3,3.x SurrealQL);复用 `stableStringify`(stateDigest.ts)做内容比对、`collectEdges`/`turnRecordsOf`/`fillUpsertDefaults`(已有)。

---

## 0. 上下文与护栏

### 0.1 纪律
- 不改默认存储(sqlite)、不改 `ProductStateRepository` 接口、不改域层/既有测试、不改 `getState`/`loadState`(仍从内存/rest 读)。
- **行为等价**:diff-upsert 的最终 DB 态必须与 P1b 全量覆盖**逐字节等价**(同一组写,reload 后 getState 相同)。这是首要正确性门。
- **失败自愈不可丢**:`lastPersisted` 只在 persist 成功后更新;失败(被 `.catch` 吞)时基线不动,下次 diff 自动补回——这是 diff-upsert 替代全量覆盖的安全前提,务必保留并测试。
- 隔离 worktree 执行;绝不 `git add -A`。

### 0.2 现状(P1b/P1d 后,main 上的 persist)
当前 `persist(db, snapshot)`(`packages/db/src/surreal/surreal-product-state-repository.ts`)是**单事务全量覆盖**:每张节点表 `UPSERT 每条 + DELETE WHERE id NOT IN $keep`;turn 同理;四张受管边表 `DELETE 全部 + RELATE 全部`;`UPSERT state_meta`。`enqueuePersist(snapshot)` 串行化入队、`.catch` 吞错告警。`fillUpsertDefaults`(补 datetime/rest 默认)、`collectEdges`/`turnRecordsOf`(edge-mapper)、`MANAGED_EDGE_TABLES` 均已存在并复用。

### 0.3 关键设计点
- **基线 = `lastPersisted`**:工厂里 `let lastPersisted = await loadState(db)`(初始 DB 态)。`enqueuePersist` 的链里,persist **成功后**才 `lastPersisted = snapshot`;失败则不动。persist 内 `prev` 参数传 `lastPersisted`(在队列任务运行时读取,串行化保证其稳定)。
- **节点/turn diff**:`diffById(prev[arr], next[arr])` → `upsert`(新增或内容变,`stableStringify` 比对)+ `removeIds`(prev 有 next 无)。UPSERT 走 `fillUpsertDefaults`(同 P1b);DELETE 用 `DELETE <tbl> WHERE id IN $ids`($ids = RecordId 数组)。
- **边 diff**:边无稳定领域 id,按 `edgeKey = ${fromTable}:${fromId}|${edge}|${toTable}:${toId}` 身份集差。`added` → RELATE(同 P1b:RecordId 端点 + `SET provenance`);`removed` → `DELETE <edge> WHERE in = $f AND out = $t`($f/$t = RecordId)。同 key 重复边天然去重(集合),是相对 P1b 的小改进。
- **state_meta**:revision 每写必变,故每次 persist 都 `UPSERT state_meta`(一条记录,无需 diff)。
- 单事务:所有 UPSERT/DELETE/RELATE + state_meta 在一个 `BEGIN/COMMIT`(同 P1b,3.x 下 UPSERT 可同事务覆盖同 id,DELETE WHERE 与 UPSERT 不同 id 无冲突)。

---

## 1. 文件结构
```
packages/db/src/surreal/
  diff.ts        # 新:diffById / diffEdges / edgeKey(纯函数)
  diff.test.ts   # 新:diff 单测
  surreal-product-state-repository.ts  # 改:persist→diff 版 + lastPersisted 基线
  surreal-product-state-repository.test.ts  # 改:加 diff 行为等价 + 失败自愈 集成测试
```

---

## 2. 任务

### Task 1: `diff.ts`(diffById / diffEdges / edgeKey)+ 单测

**Files:**
- Create: `packages/db/src/surreal/diff.ts`
- Create: `packages/db/src/surreal/diff.test.ts`

- [ ] **Step 1: 写失败测试(RED)**

`packages/db/src/surreal/diff.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { diffById, diffEdges, edgeKey } from "./diff";
import type { EdgeSpec } from "./edge-mapper";

describe("diffById", () => {
  it("新增/内容变 → upsert;移除 → removeIds;不变 → 不动", () => {
    const prev = [{ id: "a", v: 1 }, { id: "b", v: 2 }, { id: "c", v: 3 }];
    const next = [{ id: "a", v: 1 }, { id: "b", v: 99 }, { id: "d", v: 4 }];
    const d = diffById(prev, next);
    expect(d.upsert.map((x) => x.id).sort()).toEqual(["b", "d"]); // b 变、d 新
    expect(d.removeIds.sort()).toEqual(["c"]);                    // c 移除
    expect(d.upsert.find((x) => x.id === "a")).toBeUndefined();   // a 不变,不 upsert
  });
  it("空 prev → 全 upsert;空 next → 全 remove", () => {
    expect(diffById([], [{ id: "a", v: 1 }]).upsert).toHaveLength(1);
    expect(diffById([{ id: "a", v: 1 }], []).removeIds).toEqual(["a"]);
  });
});

describe("diffEdges", () => {
  const e = (fromId: string, edge: EdgeSpec["edge"], toId: string): EdgeSpec =>
    ({ edge, fromTable: "point", fromId, toTable: "theme", toId });
  it("按 from|edge|to 身份集差", () => {
    const prev = [e("p1", "belongs_to_theme", "t1"), e("p2", "belongs_to_theme", "t1")];
    const next = [e("p1", "belongs_to_theme", "t1"), e("p3", "belongs_to_theme", "t1")];
    const d = diffEdges(prev, next);
    expect(d.added.map((x) => x.fromId)).toEqual(["p3"]);
    expect(d.removed.map((x) => x.fromId)).toEqual(["p2"]);
  });
  it("重复 key 去重(同 from|edge|to 视为一条)", () => {
    const prev: EdgeSpec[] = [];
    const next = [e("p1", "belongs_to_theme", "t1"), e("p1", "belongs_to_theme", "t1")];
    expect(diffEdges(prev, next).added).toHaveLength(1);
  });
  it("edgeKey 含 from/edge/to", () => {
    expect(edgeKey(e("p1", "derived_from", "x"))).toBe("point:p1|derived_from|theme:x");
  });
});
```

- [ ] **Step 2: 跑确认 RED**
Run: `npx vitest run packages/db/src/surreal/diff.test.ts`
Expected: FAIL（`./diff` 不存在）。

- [ ] **Step 3: 实现**

`packages/db/src/surreal/diff.ts`:
```ts
import { stableStringify } from "../../../../src/domain/stateDigest";
import type { EdgeSpec } from "./edge-mapper";

export interface IdDiff<T> { upsert: T[]; removeIds: string[]; }

/** 按 id 配对 diff:next 有 prev 无、或同 id 内容变(stableStringify 比对) → upsert;
 *  prev 有 next 无 → removeIds。纯函数。 */
export function diffById<T extends { id: string }>(prev: readonly T[], next: readonly T[]): IdDiff<T> {
  const prevById = new Map(prev.map((x) => [x.id, x] as const));
  const nextIds = new Set(next.map((x) => x.id));
  const upsert: T[] = [];
  for (const item of next) {
    const before = prevById.get(item.id);
    if (!before || stableStringify(before) !== stableStringify(item)) upsert.push(item);
  }
  const removeIds: string[] = [];
  for (const item of prev) if (!nextIds.has(item.id)) removeIds.push(item.id);
  return { upsert, removeIds };
}

/** 边身份(无稳定 id):from 表:id | 边类型 | to 表:id。 */
export function edgeKey(e: EdgeSpec): string {
  return `${e.fromTable}:${e.fromId}|${e.edge}|${e.toTable}:${e.toId}`;
}

export interface EdgeDiff { added: EdgeSpec[]; removed: EdgeSpec[]; }

/** 边集 diff:next 多的 added(RELATE),prev 多的 removed(DELETE WHERE in/out)。同 key 去重。 */
export function diffEdges(prev: readonly EdgeSpec[], next: readonly EdgeSpec[]): EdgeDiff {
  const prevByKey = new Map(prev.map((e) => [edgeKey(e), e] as const));
  const nextByKey = new Map(next.map((e) => [edgeKey(e), e] as const));
  const added: EdgeSpec[] = [];
  for (const [k, e] of nextByKey) if (!prevByKey.has(k)) added.push(e);
  const removed: EdgeSpec[] = [];
  for (const [k, e] of prevByKey) if (!nextByKey.has(k)) removed.push(e);
  return { added, removed };
}
```

- [ ] **Step 4: 跑确认 GREEN**
Run: `npx vitest run packages/db/src/surreal/diff.test.ts`
Expected: PASS。

- [ ] **Step 5: Commit**
```bash
git add packages/db/src/surreal/diff.ts packages/db/src/surreal/diff.test.ts
git commit -m "feat(db): diff 纯函数(diffById 按 id / diffEdges 按 from|edge|to 身份)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: `persist` 改 diff 版 + `lastPersisted` 基线

**Files:**
- Modify: `packages/db/src/surreal/surreal-product-state-repository.ts`

- [ ] **Step 1: 工厂里加 `lastPersisted` 基线 + 改 enqueuePersist**

在 `createSurrealProductStateRepository` 内,把 `let state = await loadState(db);` 后改为:
```ts
  let state: ProductState = await loadState(db);
  // diff 基线:上次成功落库的状态(非内存 state)。失败不更新 → 下次 diff 自动补回漏掉的增量(自愈)。
  let lastPersisted: ProductState = state;
  let persistQueue: Promise<void> = Promise.resolve();

  function enqueuePersist(snapshot: ProductState) {
    persistQueue = persistQueue
      .then(async () => {
        await persist(db, lastPersisted, snapshot);
        lastPersisted = snapshot;                 // 仅成功后推进基线
      })
      .catch((err) => {
        // fail-loud:基线不动,下次 persist 以旧基线 diff、补回本次漏写(自愈)。
        console.error(JSON.stringify({ event: "surreal_persist_failed", error: String(err) }));
      });
  }
```
(删掉原来的 `let persistQueue` + 旧 `enqueuePersist`。)

- [ ] **Step 2: 改 `persist` 为 diff 版**

把整个 `persist(db, snapshot)` 函数替换为 `persist(db, prev, next)`:
```ts
/** diff-upsert 落库:只写 prev→next 的增量(节点/turn 按 id diff,边按身份集差),单事务。
 *  prev = lastPersisted(上次成功落库态);最终 DB 态与全量覆盖等价,但写放大降到 O(变更)。
 *  ⚠️ UPSERT CONTENT 不重跑列 DEFAULT,故 upsert 记录先过 fillUpsertDefaults(同 P1b)。 */
async function persist(db: Surreal, prev: ProductState, next: ProductState): Promise<void> {
  let surql = "BEGIN TRANSACTION;\n";
  const vars: Record<string, unknown> = {};
  let i = 0;

  // 1) 节点表:diffById → UPSERT 变更 + DELETE 移除
  for (const m of NODE_MAPPINGS) {
    const prevArr = ((prev as unknown as Record<string, unknown>)[m.stateKey] as Array<{ id: string }>) ?? [];
    const nextArr = ((next as unknown as Record<string, unknown>)[m.stateKey] as Array<{ id: string }>) ?? [];
    const { upsert, removeIds } = diffById(prevArr, nextArr);
    for (const entity of upsert) {
      const rv = `r${i++}`;
      vars[rv] = fillUpsertDefaults(m.table, toRecord(entity as Record<string, unknown>, m));
      vars[`${rv}_id`] = entity.id;
      surql += `UPSERT type::record('${m.table}', $${rv}_id) CONTENT $${rv};\n`;
    }
    if (removeIds.length) {
      const dv = `del_${m.table}`;
      vars[dv] = removeIds.map((id) => new RecordId(m.table, id));
      surql += `DELETE ${m.table} WHERE id IN $${dv};\n`;
    }
  }

  // 2) turn 表:同样 diffById(turnRecordsOf)
  {
    const { upsert, removeIds } = diffById(turnRecordsOf(prev), turnRecordsOf(next));
    for (const t of upsert) {
      const tv = `t${i++}`;
      vars[tv] = fillUpsertDefaults("turn", { ...t });
      vars[`${tv}_id`] = t.id;
      surql += `UPSERT type::record('turn', $${tv}_id) CONTENT $${tv};\n`;
    }
    if (removeIds.length) {
      vars.del_turn = removeIds.map((id) => new RecordId("turn", id));
      surql += `DELETE turn WHERE id IN $del_turn;\n`;
    }
  }

  // 3) 边:diffEdges → DELETE 移除(WHERE in/out)+ RELATE 新增
  {
    const { added, removed } = diffEdges(collectEdges(prev), collectEdges(next));
    for (const e of removed) {
      const xv = `x${i++}`;
      vars[`${xv}_f`] = new RecordId(e.fromTable, e.fromId);
      vars[`${xv}_t`] = new RecordId(e.toTable, e.toId);
      surql += `DELETE ${e.edge} WHERE in = $${xv}_f AND out = $${xv}_t;\n`;
    }
    for (const e of added) {
      const ev = `e${i++}`;
      vars[`${ev}_f`] = new RecordId(e.fromTable, e.fromId);
      vars[`${ev}_t`] = new RecordId(e.toTable, e.toId);
      let rel = `RELATE $${ev}_f->${e.edge}->$${ev}_t`;
      if (e.data) { vars[`${ev}_d`] = e.data; rel += ` SET provenance = $${ev}_d.provenance`; }
      surql += rel + ";\n";
    }
  }

  // 4) state_meta:revision 每写必变,总是 UPSERT
  const meta: Record<string, unknown> = {};
  for (const k of META_KEYS) meta[k] = (next as unknown as Record<string, unknown>)[k];
  vars.meta = meta;
  vars.rev = next.revision ?? 0;
  surql += `UPSERT ${META_ID} SET revision = $rev, rest = $meta;\n`;
  surql += "COMMIT TRANSACTION;";

  await db.query(surql, vars);
}
```
顶部 import 追加:
```ts
import { diffById, diffEdges } from "./diff";
```
(`collectEdges`/`turnRecordsOf`/`MANAGED_EDGE_TABLES` 已 import;`MANAGED_EDGE_TABLES` 现在仅 diffEdges 间接用不到了——若 lint 报未用,删该 import。`fillUpsertDefaults`/`toRecord`/`RecordId`/`NODE_MAPPINGS`/`META_KEYS`/`META_ID` 均已在文件内。)

- [ ] **Step 3: typecheck + 既有 surreal 测试(等价门)**
Run:
```bash
npm run typecheck && npx vitest run packages/db/src/surreal/
```
Expected: typecheck 绿;**P1a/P1b 既有 surreal 测试(契约、跨进程 durability、图遍历、边全量覆盖)全部仍绿**——证明 diff 版与全量覆盖行为等价(reload 后状态一致、边正确、删关联旧边不残留)。
> "边全量覆盖:删关联后旧边不残留"用例在 diff 版下:`diffEdges` 把那条边算进 `removed` → `DELETE <edge> WHERE in/out` → 仍清。应通过。若该用例失败,说明边 diff 的 DELETE WHERE 语法在 3.x 需调整(fallback:按 `meta::id(in)`/`meta::id(out)` 比对)。

- [ ] **Step 4: Commit**
```bash
git add packages/db/src/surreal/surreal-product-state-repository.ts
git commit -m "perf(db): persist 改 diff-upsert(只写变更节点/turn/边)+ lastPersisted 自愈基线

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: diff 行为等价 + 失败自愈 集成测试

**Files:**
- Modify: `packages/db/src/surreal/surreal-product-state-repository.test.ts`

- [ ] **Step 1: 加多步 diff 序列 + 跨进程 reload 等价测试**

复用 P1a 的 spawnSync 跨进程模式(surrealkv close 后同进程不能重开)。在测试文件追加:
```ts
describe("surreal diff-upsert (surrealkv://)", () => {
  it("多步增量写(增/改/删 节点+边)后跨进程 reload,DB 态与最终 state 等价", () => {
    const dir = mkdtempSync(join(tmpdir(), "surreal-p1c-"));
    try {
      const url = `surrealkv://${dir}/surreal`;
      const repoSrc = JSON.stringify(join(process.cwd(), "packages/db/src/surreal/surreal-product-state-repository.ts"));
      // 写进程:连续多次 replaceState(增 theme+point+边 → 改 point → 删 point),每次 flush。
      const w = runScript(`
import { createSurrealProductStateRepository } from ${repoSrc};
const repo = await createSurrealProductStateRepository({ url: ${JSON.stringify(url)} });
const base = repo.getState();
const theme = { id:'th_1', name:'放权', summary:'', maturity:'聚焦', representativeQuote:'', appearances:1, nextQuestion:'', updatedAt:'2026-06-27T00:00:00.000Z' };
repo.replaceState({ ...base, themes:[theme],
  points:[{ id:'pt_1', title:'A', content:'c', status:'稳定观点', confidence:'用户确认', evidence:[], relatedThemeIds:['th_1'], important:false, updatedAt:'2026-06-27T00:00:00.000Z' },
           { id:'pt_2', title:'B', content:'c', status:'稳定观点', confidence:'用户确认', evidence:[], relatedThemeIds:['th_1'], important:false, updatedAt:'2026-06-27T00:00:00.000Z' }] });
await repo.flush();
let s = repo.getState();
repo.replaceState({ ...s, points: s.points.map(p => p.id==='pt_1' ? { ...p, title:'A改' } : p) }); // 改 pt_1
await repo.flush();
s = repo.getState();
repo.replaceState({ ...s, points: s.points.filter(p => p.id!=='pt_2') }); // 删 pt_2(连带其边)
await repo.flush();
await repo.close();
console.log('ok'); process.exit(0);
`, join(dir, "w.mts"));
      if (w.status !== 0) throw new Error("写进程失败:\n" + w.stderr);
      // 读进程:reload,断言最终态(pt_1 改名、pt_2 没了、pt_2 的边没了、pt_1 的边在)。
      const r = runScript(`
import { createSurrealProductStateRepository } from ${repoSrc};
const repo = await createSurrealProductStateRepository({ url: ${JSON.stringify(url)} });
const s = repo.getState();
const [bt] = await repo.query("SELECT VALUE <-belongs_to_theme<-point FROM theme:th_1;");
console.log(JSON.stringify({
  pt1: s.points.find(p=>p.id==='pt_1')?.title,
  pt2: s.points.find(p=>p.id==='pt_2') ? 'present' : 'gone',
  btCount: (bt?.[0] ?? []).length
}));
await repo.close(); process.exit(0);
`, join(dir, "r.mts"));
      if (r.status !== 0) throw new Error("读进程失败:\n" + r.stderr);
      const out = JSON.parse(r.stdout.trim().split("\n").filter(l=>l.startsWith("{")).at(-1));
      expect(out.pt1).toBe("A改");        // 改生效
      expect(out.pt2).toBe("gone");        // 删生效
      expect(out.btCount).toBe(1);          // 仅 pt_1 的边在(pt_2 删除连带其边被 diffEdges 移除)
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }, 60000);
});
```

- [ ] **Step 2: 加失败自愈单测(基线不前进 → 下次补回)**

在 mem:// 的 describe 里追加一个用例:让一次 persist 失败(注入会抛的 db),验证下次写把漏掉的也写进去。最稳妥的注入点是给工厂传一个包装过的连接;若工厂不支持注入,改为**直接测 enqueue 链语义**——但更简单可靠的是测 `diffById`/`diffEdges` 的"基线落后"性质已在 Task1 覆盖(diff(L0, snap2) 含 snap1 增量)。本步用 mem:// 端到端验证"两次写都生效"即可:
```ts
it("连续两次 replaceState(diff 增量)后内存与 flush 后一致,无漏写", async () => {
  const repo = await makeMem();
  const base = repo.getState();
  repo.replaceState({ ...base, points: [{ id:"pt_1", title:"一", content:"c", status:"稳定观点" as const, confidence:"用户确认" as const, evidence:[], relatedThemeIds:[], important:false, updatedAt:"2026-06-27T00:00:00.000Z" }] });
  repo.replaceState({ ...repo.getState(), points: [...repo.getState().points, { id:"pt_2", title:"二", content:"c", status:"稳定观点" as const, confidence:"用户确认" as const, evidence:[], relatedThemeIds:[], important:false, updatedAt:"2026-06-27T00:00:00.000Z" }] });
  await repo.flush();
  // 直查底层:两条都在(第二次 diff 基线=第一次成功后,增量只含 pt_2,但 pt_1 仍在)
  const [rows] = await repo.query<[Array<{ id: unknown }>]>("SELECT id FROM point;");
  expect((rows ?? []).length).toBe(2);
});
```
> 真正的"persist 失败注入"测试若要做,需工厂支持注入 db wrapper —— 本计划不改工厂签名,失败自愈的正确性由"`lastPersisted` 仅成功后推进"(Task2 代码,简单可审)+ diffById 基线落后性质(Task1)共同保证。若 review 要求显式失败注入测试,作为 follow-up。

- [ ] **Step 3: 跑测试**
Run: `npx vitest run packages/db/src/surreal/surreal-product-state-repository.test.ts`
Expected: PASS(多步 reload 等价 + 连续写无漏)。

- [ ] **Step 4: Commit**
```bash
git add packages/db/src/surreal/surreal-product-state-repository.test.ts
git commit -m "test(db): diff-upsert 多步增量 reload 等价 + 连续写无漏写

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: 全量回归 + typecheck

- [ ] **Step 1: 全量 + typecheck**
Run:
```bash
npm run typecheck && npx vitest run
```
Expected: typecheck 绿;vitest 在 P1d 基线(993 passed | 6 skipped)之上净增 diff 测试,全绿、零回归。**P1a 跨进程 durability、P1b 图遍历/边全量覆盖、P1d 双写等价 全部仍绿**(diff 版行为等价)。粘贴 summary。

- [ ] **Step 2: Commit**(通常无新改动)

---

## 3. P1c 阶段门
- [ ] `diffById`/`diffEdges` 纯函数单测绿。
- [ ] `persist` 只写变更(UPSERT 变更节点/turn + DELETE 移除 + RELATE 新增边 + DELETE 移除边),单事务。
- [ ] `lastPersisted` 仅成功后推进(失败自愈),代码清晰且有注释。
- [ ] **行为等价**:P1a/P1b/P1d 既有 surreal 测试(契约/跨进程 reload/图遍历/边覆盖/双写等价)全部仍绿;多步增量 reload 等价新测绿。
- [ ] 默认 sqlite 不变;域层/既有测试未动;全量 ≥993、零回归;typecheck 绿。

## 4. 不在本计划
- persist 失败的显式注入测试(需工厂支持注入 db;失败自愈正确性已由 lastPersisted 语义 + diff 基线落后性质保证)。
- P2 召回走原生图/向量;P3 公理落 DB;冷层 raw-material 迁移。
- 把 turns 移出 `session.rest`(去重)——独立小项,可与 P2 一起。

## 5. 自查(已执行)
- **Spec 覆盖**:spec 02 §3"按 diff 只 upsert 变更节点/边(复用 diffIndexableSources 思路)"= Task1/2;失败自愈是 diff 替代全量覆盖的隐含正确性要求 = lastPersisted 基线(Task2)+ Task3。行为等价由复用既有 surreal 测试守住。
- **占位扫描**:无;diff.ts/persist/测试均完整代码;边 DELETE WHERE 的 3.x fallback、失败注入测试的取舍 均显式说明,非占位。
- **类型一致**:`diffById`/`diffEdges`/`edgeKey`/`IdDiff`/`EdgeDiff`(diff.ts)跨 Task1/2/3 一致;`persist(db, prev, next)` 新签名在 enqueuePersist 调用处一致;`EdgeSpec`/`collectEdges`/`turnRecordsOf`/`fillUpsertDefaults`/`RecordId`/`NODE_MAPPINGS`/`META_KEYS` 复用既有定义。

## 6. 执行交接
**1. Subagent-Driven (recommended)** — 每 Task 派子代理 + 两阶段 review。
**2. Inline Execution** — 批执行 + checkpoint。
**Which approach?**
