# SurrealDB × 本体论 · P1d 双写 / 影子读 / 切换工具 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 构建"双写 + 影子读等价比对 + sqlite→surreal 迁移脚本"的**切换工具**,让 SurrealDB 可以安全地、可观测地、可回退地接管线上存储——但**默认仍 sqlite**,真正切换由运维设 `PRODUCT_STORE` env + soak 期决定,代码不擅自改默认。

**Architecture:** 新增 `createDualWriteRepository({authoritative, shadow, onDivergence})`(组合两个现成的 `ProductStateRepository`):读/乐观锁/revision 走 `authoritative`,写同时落 `authoritative`+`shadow`(shadow 尽力而为、其错误不破坏主写),每次写后用 `buildStableDigest({...state,revision:0})`(stateDigest.ts,排序键稳定 + 忽略 revision)比对两边 `getState`,发散则 `onDivergence`(默认结构化告警,**不抛**)。`startServer` 增 `PRODUCT_STORE` 模式:`sqlite`(默认)/`surreal`(P1a)/`dual`(sqlite 权威 + surreal 影子)/`dual-surreal`(surreal 权威 + sqlite 备份)。迁移脚本把现有 sqlite 整状态种进 surreal,使影子起点相等。

**Tech Stack:** 同前(`surrealdb`@2.0.4 + `@surrealdb/node`@3.0.3)+ 现有 `buildStableDigest`/`normalizeProductState`/`createSqliteProductStateRepository`/`createSurrealProductStateRepository`。

---

## 0. 上下文与护栏（高风险阶段,务必读）

### 0.1 风险纪律
- **默认存储不变(sqlite)**。P1d 只新增 opt-in 的 `dual`/`dual-surreal` 模式;`else` 分支永远是 sqlite。代码层不切换默认——切换是运维设 env 的决定。
- **shadow 写与影子读绝不破坏主写路径**:shadow 的任何异常被捕获 + 告警,主写(authoritative)照常返回。影子读发散只告警、不抛、不阻塞。
- **可回退**:任意时刻 `PRODUCT_STORE=sqlite` 秒回纯 sqlite;`dual` 期 sqlite 仍是权威 + 完整数据,surreal 出问题零影响。
- 不改 `src/domain/**`、不改既有测试、不改 `ProductStateRepository` 接口、不改 `buildApiServer`(同步)。绝不 `git add -A`;隔离 worktree 执行。
- **不在本计划做"真正切换"**:不把默认改成 dual/surreal、不删 sqlite 写。那是 soak 验证后运维的操作(§5 运维序列)。

### 0.2 切换的运维序列（本计划交付工具,不代替运维执行）
1. 跑迁移脚本 `node scripts/migrate-sqlite-to-surreal.mjs`(把现有 sqlite 整状态种进 surreal,起点相等)。
2. 设 `PRODUCT_STORE=dual`(sqlite 权威、surreal 影子)运行 → 观察日志**无 `dual_write_divergence`** 持续 N 天。
3. 无发散 → `PRODUCT_STORE=dual-surreal`(surreal 权威、sqlite 仍写作冷备)→ 继续观察。
4. 稳定 → `PRODUCT_STORE=surreal`(纯 surreal,P1a 已有)。任一步出问题 → 设回 `sqlite`/`dual`。

### 0.3 关键事实
- 等价比对:`buildStableDigest({ ...state, revision: 0 })`(`src/domain/stateDigest.ts`)——排序键、忽略 `revision`(两库 revision 各自 bump、内容相等即可)。发散时附两边 digest + 首个不等的顶层数组名,便于定位。
- surreal `getState` 走内存工作副本(P1a),`replaceState` 同步更内存 + 异步落库;故 `dual` 下写后立即比对的是 sqlite(已落盘)vs surreal(内存),都为当前态,可比。surreal 的异步落库 durability 由其自身队列/flush 保证(P1a)。
- surreal 的 `turn` 表/边是只写不读(P1b),不影响 `getState` 等价(等价只比 ProductState 内容)。
- 注入点:`apps/api/src/server.ts` 的 `startServer`(P1a 已有 `PRODUCT_STORE` 分支,约 593-610);dual 模式在此构造两 repo + 包 `createDualWriteRepository`,再交给 `buildApiServer`(其内会再包 `withKnowledgeReindex`)。

---

## 1. 文件结构
```
apps/api/src/
  dual-write-repository.ts        # 新:createDualWriteRepository(组合两 repo:读走权威、写双落、影子读比对)
  dual-write-repository.test.ts   # 新:双写/发散检测/影子错误不伤主写/等价
  server.ts                       # 改:startServer 增 dual / dual-surreal 模式
scripts/
  migrate-sqlite-to-surreal.mjs   # 新:sqlite 整状态 → surreal 种子(--dry-run/幂等/迁后等价校验)
```

---

## 2. 任务

### Task 1: `createDualWriteRepository` + 测试

**Files:**
- Create: `apps/api/src/dual-write-repository.ts`
- Create: `apps/api/src/dual-write-repository.test.ts`

- [ ] **Step 1: 写失败测试(RED)**

`apps/api/src/dual-write-repository.test.ts`:
```ts
import { describe, it, expect, vi } from "vitest";
import { createInMemoryProductStateRepository } from "./product-state-repository";
import { createDualWriteRepository } from "./dual-write-repository";
import { createInitialProductState } from "../../../src/domain/engine";

function pointState(id: string, title: string) {
  const base = createInitialProductState();
  return { ...base, points: [{ id, title, content: "c", status: "稳定观点" as const,
    confidence: "用户确认" as const, evidence: [], relatedThemeIds: [], important: false,
    updatedAt: "2026-06-27T00:00:00.000Z" }] };
}

describe("dual-write repository", () => {
  it("写入同时落 authoritative + shadow;读走 authoritative", () => {
    const auth = createInMemoryProductStateRepository();
    const shadow = createInMemoryProductStateRepository();
    const repo = createDualWriteRepository({ authoritative: auth, shadow });
    repo.replaceState(pointState("pt_1", "标题"));
    expect(auth.getState().points[0]?.id).toBe("pt_1");
    expect(shadow.getState().points[0]?.id).toBe("pt_1");   // shadow 也写了
    expect(repo.getState().points[0]?.id).toBe("pt_1");     // 读走权威
  });

  it("两边内容一致时不报发散", () => {
    const onDivergence = vi.fn();
    const repo = createDualWriteRepository({
      authoritative: createInMemoryProductStateRepository(),
      shadow: createInMemoryProductStateRepository(),
      onDivergence
    });
    repo.replaceState(pointState("pt_1", "标题"));
    expect(onDivergence).not.toHaveBeenCalled();
  });

  it("shadow 内容偏离 → onDivergence 被调用(但不抛)", () => {
    const onDivergence = vi.fn();
    const auth = createInMemoryProductStateRepository();
    // shadow 用一个被污染的实现:replaceState 故意丢掉 points
    const shadowInner = createInMemoryProductStateRepository();
    const shadow = {
      ...shadowInner,
      replaceState: (s: ReturnType<typeof createInitialProductState>) =>
        shadowInner.replaceState({ ...s, points: [] })
    };
    const repo = createDualWriteRepository({ authoritative: auth, shadow, onDivergence });
    expect(() => repo.replaceState(pointState("pt_1", "标题"))).not.toThrow();
    expect(onDivergence).toHaveBeenCalledTimes(1);
    expect(auth.getState().points[0]?.id).toBe("pt_1");     // 主写不受影响
  });

  it("shadow 写抛错 → 主写仍成功、不抛", () => {
    const auth = createInMemoryProductStateRepository();
    const shadow = {
      ...createInMemoryProductStateRepository(),
      replaceState: () => { throw new Error("shadow boom"); }
    };
    const onShadowError = vi.fn();
    const repo = createDualWriteRepository({ authoritative: auth, shadow, onShadowError });
    const result = repo.replaceState(pointState("pt_1", "标题"));
    expect(result.points[0]?.id).toBe("pt_1");
    expect(onShadowError).toHaveBeenCalledTimes(1);
  });

  it("乐观锁 + revision 走 authoritative", () => {
    const auth = createInMemoryProductStateRepository();
    const repo = createDualWriteRepository({ authoritative: auth, shadow: createInMemoryProductStateRepository() });
    const s0 = repo.getState();
    const s1 = repo.replaceState(s0);
    expect(s1.revision).toBe((s0.revision ?? 0) + 1);
  });
});
```

- [ ] **Step 2: 跑确认 RED**
Run: `npx vitest run apps/api/src/dual-write-repository.test.ts`
Expected: FAIL（`./dual-write-repository` 不存在）。

- [ ] **Step 3: 实现**

`apps/api/src/dual-write-repository.ts`:
```ts
import type { ProductState } from "../../../src/domain/types";
import { buildStableDigest } from "../../../src/domain/stateDigest";
import type { ProductStateRepository, ReplaceStateOptions } from "./product-state-repository";

export interface DualWriteOptions {
  /** 权威库:读/乐观锁/revision/返回值的来源。 */
  authoritative: ProductStateRepository;
  /** 影子库:镜像所有写;其错误与发散不影响主写。 */
  shadow: ProductStateRepository;
  /** 影子内容与权威不一致时回调(默认结构化告警,不抛)。 */
  onDivergence?: (info: { op: string; authDigest: string; shadowDigest: string; firstDiffKey?: string }) => void;
  /** 影子写抛错时回调(默认结构化告警,不抛)。 */
  onShadowError?: (err: unknown, op: string) => void;
}

const DIFF_KEYS: Array<keyof ProductState> = [
  "points","decisions","debts","questions","themes","notes","memoryRecords",
  "memoryCandidates","importSources","ragChunks","searchBriefs","sessions",
  "memoryEdges","chatSessions","profile","systemConfig"
];

/** 内容等价签名:排序键 + 忽略 revision(两库 revision 各自 bump)。 */
function contentDigest(state: ProductState): string {
  return buildStableDigest({ ...state, revision: 0 });
}

function firstDivergentKey(a: ProductState, b: ProductState): string | undefined {
  for (const k of DIFF_KEYS) {
    if (buildStableDigest(a[k]) !== buildStableDigest(b[k])) return String(k);
  }
  return undefined;
}

const defaultOnDivergence: NonNullable<DualWriteOptions["onDivergence"]> = (info) =>
  console.warn(JSON.stringify({ event: "dual_write_divergence", ...info }));
const defaultOnShadowError: NonNullable<DualWriteOptions["onShadowError"]> = (err, op) =>
  console.warn(JSON.stringify({ event: "dual_write_shadow_error", op, error: String(err) }));

/** 双写仓库:读走 authoritative,写双落 + 影子读等价比对。shadow 的错误/发散绝不破坏主写。 */
export function createDualWriteRepository(opts: DualWriteOptions): ProductStateRepository {
  const { authoritative, shadow } = opts;
  const onDivergence = opts.onDivergence ?? defaultOnDivergence;
  const onShadowError = opts.onShadowError ?? defaultOnShadowError;

  function mirrorAndCompare(op: string, next: ProductState) {
    // 影子写不带 expectedRevision(只镜像内容,不参与乐观锁);错误吞掉只告警。
    try {
      if (op === "reset") shadow.resetState();
      else shadow.replaceState(next);
    } catch (err) {
      onShadowError(err, op);
      return;
    }
    try {
      const authState = authoritative.getState();
      const shadowState = shadow.getState();
      if (contentDigest(authState) !== contentDigest(shadowState)) {
        onDivergence({
          op,
          authDigest: contentDigest(authState),
          shadowDigest: contentDigest(shadowState),
          firstDiffKey: firstDivergentKey(authState, shadowState)
        });
      }
    } catch (err) {
      onShadowError(err, `${op}:compare`);
    }
  }

  return {
    getState: () => authoritative.getState(),
    getInterviewSession: (id) => authoritative.getInterviewSession(id),
    resetState() {
      const result = authoritative.resetState();
      mirrorAndCompare("reset", result);
      return result;
    },
    replaceState(next: ProductState, replaceOpts?: ReplaceStateOptions) {
      // 权威先写(乐观锁在此判定,冲突会抛——这是期望行为,主路径语义不变)。
      const result = authoritative.replaceState(next, replaceOpts);
      // 影子镜像权威写出的结果(已 bump revision),再比对。
      mirrorAndCompare("replace", result);
      return result;
    }
  };
}
```
> 设计要点:① 影子写用**权威写出的 `result`**(已 bump revision、已 normalize),保证两边内容同源;② 影子写不传 `expectedRevision`(不参与乐观锁,避免影子 revision 漂移导致误冲突);③ 比对忽略 revision(`contentDigest`);④ `firstDivergentKey` 给出首个不等的顶层键,便于定位 surreal 映射 bug。

- [ ] **Step 4: 跑确认 GREEN**
Run: `npx vitest run apps/api/src/dual-write-repository.test.ts`
Expected: PASS。

- [ ] **Step 5: Commit**
```bash
git add apps/api/src/dual-write-repository.ts apps/api/src/dual-write-repository.test.ts
git commit -m "feat(api): 双写仓库(读走权威+写双落+影子读等价比对,影子错误不伤主写)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: sqlite→surreal 迁移脚本

**Files:**
- Create: `scripts/migrate-sqlite-to-surreal.mjs`

- [ ] **Step 1: 写脚本**(`.mjs`,沿用 `scripts/*.mjs` 约定;用 tsx 不可,故走 import .ts via tsx 运行——见用法)

实际上脚本需要 import 仓库 TS 源,故用 `tsx` 运行。写 `scripts/migrate-sqlite-to-surreal.mjs`:
```js
// 把现有 sqlite 整 ProductState 种进嵌入式 SurrealDB,使双写影子起点相等。
// 用法(经 tsx,因要 import TS 源):
//   npx tsx scripts/migrate-sqlite-to-surreal.mjs --src .data/product-state.db --dst .data/surreal [--dry-run]
// 幂等:surreal 用稳定 id UPSERT 覆盖(P1b persist),重复跑结果一致。
import process from "node:process";
import { dirname, join } from "node:path";
import { createSqliteProductStateRepository } from "../packages/db/src/sqlite-product-state-repository.ts";
import { createSurrealProductStateRepository } from "../packages/db/src/surreal/surreal-product-state-repository.ts";
import { buildStableDigest } from "../src/domain/stateDigest.ts";

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--") ? process.argv[i + 1] : def;
}
const dryRun = process.argv.includes("--dry-run");
const src = arg("src", join(process.cwd(), ".data", "product-state.db"));
const dst = arg("dst", join(dirname(src), "surreal"));

const sqlite = createSqliteProductStateRepository({ dbPath: src });
const state = sqlite.getState();
const counts = {
  points: state.points.length, decisions: state.decisions.length, themes: state.themes.length,
  notes: state.notes.length, memoryRecords: state.memoryRecords.length, sessions: state.sessions.length
};
console.log(JSON.stringify({ event: "migrate_plan", src, dst, revision: state.revision, counts }));

if (dryRun) { console.log(JSON.stringify({ event: "migrate_dry_run_done" })); process.exit(0); }

const surreal = await createSurrealProductStateRepository({ url: `surrealkv://${dst}/surreal` });
surreal.replaceState(state);
await surreal.flush();

// 迁后等价校验(忽略 revision)
const back = surreal.getState();
const eq = buildStableDigest({ ...state, revision: 0 }) === buildStableDigest({ ...back, revision: 0 });
await surreal.close();
console.log(JSON.stringify({ event: "migrate_done", equivalent: eq }));
if (!eq) { console.error("迁移后 surreal getState 与 sqlite 不等价 —— 排查 surreal 映射"); process.exit(1); }
process.exit(0);
```
> 校正点:`createSurrealProductStateRepository` 在同进程对 surrealkv 建索引后,close 再开有锁问题(P1b 发现);本脚本是**一次性进程**(种完即 exit),不重开,故无碍。`process.exit(0)` 必须显式(native 线程)。冷层 raw-material(已 offload 的逐字稿)不在本脚本——属后续(turns 在 session.turns 内的随整状态迁;rawMaterialOffloaded 的会话其 turns 在 raw-material.sqlite,迁移留作 follow-up,本脚本迁热状态)。

- [ ] **Step 2: 干跑验证(不落库)**
Run:
```bash
npx tsx scripts/migrate-sqlite-to-surreal.mjs --src .data/product-state.db --dst /tmp/surreal-migrate-test --dry-run
```
Expected: 打印 `migrate_plan`(含各数组计数 + revision)+ `migrate_dry_run_done`,不创建 `/tmp/surreal-migrate-test`。
> 若本机 `.data/product-state.db` 不存在或为空,计数为 0 也算通过(脚本逻辑正确即可)。

- [ ] **Step 3: 实跑到临时目录 + 幂等验证**
Run:
```bash
npx tsx scripts/migrate-sqlite-to-surreal.mjs --src .data/product-state.db --dst /tmp/surreal-migrate-test
npx tsx scripts/migrate-sqlite-to-surreal.mjs --src .data/product-state.db --dst /tmp/surreal-migrate-test
rm -rf /tmp/surreal-migrate-test
```
Expected: 两次都 `migrate_done` 且 `"equivalent":true`(幂等:第二次覆盖同 id,结果一致)。

- [ ] **Step 4: Commit**
```bash
git add scripts/migrate-sqlite-to-surreal.mjs
git commit -m "feat(scripts): sqlite→surreal 整状态迁移脚本(--dry-run/幂等/迁后等价校验)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: `startServer` 接入 dual / dual-surreal 模式

**Files:**
- Modify: `apps/api/src/server.ts`（`startServer` 的 `PRODUCT_STORE` 分支）

- [ ] **Step 1: 扩 PRODUCT_STORE 分支**

把 `startServer` 里现有的 surreal 分支(P1a)所在的 if/else 改为支持 dual 模式。先把"构造 surreal repo"抽成局部 async 函数复用,再加分支:
```ts
  const productStore = (process.env.PRODUCT_STORE ?? "sqlite").trim().toLowerCase();

  // P1a:动态 import surreal 工厂(避开 apps/api 的 Node 解析对 @surrealdb/node 的类型检查)。
  const loadSurreal = async () => {
    const mod = await (Function("p", "return import(p)") as (p: string) => Promise<{
      createSurrealProductStateRepository: (opts: { url: string }) => Promise<ProductStateRepository>;
    }>)(new URL("../../../packages/db/src/surreal/surreal-product-state-repository.ts", import.meta.url).pathname);
    const dataDir = join(dirname(productStateDbPath), "surreal");
    return mod.createSurrealProductStateRepository({ url: `surrealkv://${dataDir}/surreal` });
  };

  let repository: ProductStateRepository;
  if (productStore === "surreal") {
    repository = await loadSurreal();
    console.warn(JSON.stringify({ event: "product_store", mode: "surreal" }));
  } else if (productStore === "dual") {
    // sqlite 权威 + surreal 影子:观察等价,sqlite 仍是真相、零风险。
    const sqlite = createSqliteProductStateRepository({ dbPath: productStateDbPath });
    const surreal = await loadSurreal();
    const { createDualWriteRepository } = await import("./dual-write-repository");
    repository = createDualWriteRepository({ authoritative: sqlite, shadow: surreal });
    console.warn(JSON.stringify({ event: "product_store", mode: "dual", detail: "sqlite 权威 / surreal 影子" }));
  } else if (productStore === "dual-surreal") {
    // surreal 权威 + sqlite 冷备:切读 surreal,sqlite 仍写以便回退。
    const sqlite = createSqliteProductStateRepository({ dbPath: productStateDbPath });
    const surreal = await loadSurreal();
    const { createDualWriteRepository } = await import("./dual-write-repository");
    repository = createDualWriteRepository({ authoritative: surreal, shadow: sqlite });
    console.warn(JSON.stringify({ event: "product_store", mode: "dual-surreal", detail: "surreal 权威 / sqlite 冷备" }));
  } else {
    repository = createSqliteProductStateRepository({ dbPath: productStateDbPath });  // 默认
  }
```
然后把现有 `buildApiServer({ ... })` 调用补上 `productStateRepository: repository`(P1a 已加则不动)。
> `createDualWriteRepository` 是 `apps/api` 本地模块,用普通 `await import("./dual-write-repository")`(不需 Function 绕,它不 import @surrealdb/node)。`dual` 模式下 surreal 影子若构造失败会抛——可接受(opt-in,运维显式开;若要"影子构造失败也不阻断启动",P2 再加容错)。

- [ ] **Step 2: typecheck**
Run: `npm run typecheck`
Expected: 通过。

- [ ] **Step 3: Commit**
```bash
git add apps/api/src/server.ts
git commit -m "feat(api): startServer 增 dual/dual-surreal 模式(默认仍 sqlite,opt-in 切换工具)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: 全量回归 + dual 模式冒烟

**Files:**（无新增,验证）

- [ ] **Step 1: 全量 + typecheck**
Run:
```bash
npm run typecheck && npx vitest run
```
Expected: typecheck 绿;vitest 在 P1b 基线(985 passed | 6 skipped)之上净增双写测试,全绿、零回归。粘贴 summary。

- [ ] **Step 2: dual 模式冒烟(端到端,确认双写不破坏主路径)**
用 in-memory + surreal(mem://)构造一个 dual repo,跑一遍写读,确认等价无告警:
```bash
npx tsx -e "
import { createInMemoryProductStateRepository } from './apps/api/src/product-state-repository.ts';
import { createSurrealProductStateRepository } from './packages/db/src/surreal/surreal-product-state-repository.ts';
import { createDualWriteRepository } from './apps/api/src/dual-write-repository.ts';
import { createInitialProductState } from './src/domain/engine.ts';
const auth = createInMemoryProductStateRepository();
const shadow = await createSurrealProductStateRepository({ url: 'mem://' });
let diverged = false;
const repo = createDualWriteRepository({ authoritative: auth, shadow, onDivergence: () => { diverged = true; } });
const base = createInitialProductState();
repo.replaceState({ ...base, points: [{ id:'pt_1', title:'t', content:'c', status:'稳定观点', confidence:'用户确认', evidence:[], relatedThemeIds:[], important:false, updatedAt:'2026-06-27T00:00:00.000Z' }] });
await shadow.flush();
console.log(JSON.stringify({ authPt: auth.getState().points[0]?.id, shadowPt: shadow.getState().points[0]?.id, diverged }));
await shadow.close();
process.exit(0);
"
```
Expected: 打印 `{"authPt":"pt_1","shadowPt":"pt_1","diverged":false}`——双写两边一致、无发散。
> 若 `diverged:true`,说明 surreal 映射与 in-memory(=sqlite 语义)有差异,按 `firstDiffKey` 排查(这正是影子读要在生产前抓的)。

- [ ] **Step 3: Commit**（若冒烟暴露并修了问题;否则无新提交）

---

## 3. P1d 阶段门
- [ ] `createDualWriteRepository`:读走权威、写双落、影子读发散→告警(不抛)、影子错误不伤主写、乐观锁走权威——单测全绿。
- [ ] 迁移脚本:`--dry-run` 报计数;实跑迁后 `equivalent:true`;幂等(两次一致)。
- [ ] `startServer` 四模式;**默认仍 sqlite**;dual/dual-surreal opt-in。
- [ ] 全量 ≥985、零回归;typecheck 绿;dual 冒烟 `diverged:false`。
- [ ] 域层/既有测试/默认路径未动;真正切换未做(留运维按 §0.2 序列)。

## 4. 不在本计划（后续）
- 真正切换(改默认 / 删 sqlite 写)= 运维按 §0.2 soak 后决定,非代码。
- 冷层 raw-material(已 offload 逐字稿)迁移 = follow-up。
- P1c diff-upsert(perf);P2 召回走原生图/向量;P3 公理落 DB。
- dual 模式下 surreal 影子构造失败的"降级启动"容错(当前失败即抛,opt-in 可接受)。

## 5. 自查（已执行）
- **Spec 覆盖**:spec 02 §4(双写/影子读/切读三子阶段 = dual/dual-surreal/surreal 三模式 + 运维序列)、spec 06 §2(迁移脚本 --dry-run/幂等/迁后等价)、§4(回退 = 设回 env)。等价比对用现成 `buildStableDigest`(stateDigest.ts)。真正切换、冷层迁移显式划到 §4。
- **占位扫描**:无;dual-write/迁移脚本/server 分支/测试均完整代码;校正点(surrealkv 一次性进程/process.exit/动态 import)为实测约束,非占位。
- **类型一致**:`createDualWriteRepository`/`DualWriteOptions`(authoritative/shadow/onDivergence/onShadowError)跨 Task 1/3 一致;`contentDigest`/`firstDivergentKey` 用 `buildStableDigest`(stateDigest.ts 真实导出);`PRODUCT_STORE` 四值(sqlite/surreal/dual/dual-surreal)Task 3 一致;迁移脚本 import 路径(`../packages/db/...`/`../src/domain/...`)从 `scripts/` 上溯正确。

## 6. 执行交接
**1. Subagent-Driven (recommended)** — 每 Task 派子代理 + 两阶段 review。
**2. Inline Execution** — 批执行 + checkpoint。
**Which approach?**
