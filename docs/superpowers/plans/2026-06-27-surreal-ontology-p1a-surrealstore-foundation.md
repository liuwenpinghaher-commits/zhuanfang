# SurrealDB × 本体论 · P1a SurrealStore 地基 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 `ProductStateRepository` 接口后实现一个 SurrealDB 后端 `createSurrealProductStateRepository`,让整个 `ProductState` 在嵌入式 SurrealDB 上无损往返、通过统一仓库契约测试;**opt-in（env 切换）、默认仍 sqlite、不接入双写**——P1 绞杀者的第一块地基。

**Architecture:** 绞杀点是 [apps/api/src/product-state-repository.ts:29](../../../apps/api/src/product-state-repository.ts) 的同步接口（`getState/resetState/replaceState/getInterviewSession`）。SurrealDB SDK 是**异步**的,而接口是**同步**的——所以 SurrealStore 持有一份**内存 `ProductState` 工作副本**（同步读），写时同步更新内存 + **异步串行化落库**（沿用 server 现有 writeQueue 与 withKnowledgeReindex 的 fire-and-forget 模式），并暴露 `flush()` 供测试等待持久化。映射:12 个本体数组 → P0 节点表（核心字段保留 typed/ASSERT 列 + 一个 `rest` FLEXIBLE object 兜住其余字段,无损）；其余 ~15 项运维/配置/profile → `state_meta:main` 的 blob + revision。P1a **整状态覆盖写**（每次 delete-all+recreate,简单正确）；diff-upsert 是 P1c。

**Tech Stack:** `surrealdb`@2.0.4 + `@surrealdb/node`@3.0.3（内嵌 SurrealDB 3.0.2 核心 → 3.x SurrealQL）· Node 25.7 · TypeScript 5.9（packages/db 首次纳入 typecheck,`moduleResolution: bundler`）· Vitest 4。

---

## 0. 上下文与护栏

### 0.1 绞杀者纪律（不可触碰）
- **不改** `src/domain/**`（148 纯函数）、不改既有测试、**不改运行默认存储**（默认仍 sqlite）。
- `ProductStateRepository` 接口**签名不变**（同步 4 方法）。SurrealStore 的**工厂**是异步的（`createSurrealProductStateRepository(): Promise<...>`），但它**返回的对象**实现的是同步接口。
- `buildApiServer` 保持同步（已确认 `server.ts:106` 非 async）；surreal 仅在 `startServer`（已是 async）里按 env 构造后注入。
- 保护无关已改文件（`zhuanfang`、`.truthtracker-*`、`findings.json` 等不碰）；**绝不 `git add -A`**（仓库有 worktree gitlink + `.data/*.db`）。

### 0.2 承接 P0 的既有事实
- P0 已建好 13 节点表 + 8 边表 + 索引 + 幂等 `applySchema()`（`packages/db/src/surreal/`）。本计划复用 `createSurrealConnection`、`applySchema`、`constants`。
- **3.x SurrealQL 坑（P0 已踩，沿用）**:`FULLTEXT ANALYZER`（非 `SEARCH`）、`TYPE object FLEXIBLE`（非 `FLEXIBLE TYPE object`）、record id 含中文用反引号转义、`db.query` 解构 `const [rows]=...`、`INFO FOR DB.tables`/`INFO FOR TABLE.{fields,indexes}` 为 `Record<string,string>`。**领域 id 是 `makeId()` 生成的 ASCII**（不含中文），故 record id 一般无需转义;但映射层仍统一用 `type::thing(table,id)` 构造记录 id 以防特殊字符。
- 嵌入式 `@surrealdb/node` 持有 native 线程:独立脚本需 `process.exit(0)`;**vitest 用 `mem://` + `afterEach` close 即可**（P0 已验证不挂）。`surrealkv://` close 后立即重开需 ~150ms（重开类测试要加等待）。

### 0.3 映射决策（本计划采用，理由）
- **本体 12 数组 → 节点表**:`points→point, decisions→decision, debts→debt, questions→question, themes→theme, notes→note, memoryRecords→memory, memoryCandidates→memory_candidate, importSources→material, ragChunks→rag_chunk, searchBriefs→search_brief, sessions→session`。每条领域实体:**核心字段**（P0/001 已声明、带 ASSERT 的枚举与关键标量）落 typed 列;**其余字段**（含日期、可选、嵌套对象、`session.turns`）整体进该表的 `rest`（FLEXIBLE object）。无损往返靠 `rest`,ASSERT 约束靠核心列。
- **日期不进核心列**:核心列只放枚举/字符串/数组/数值,**所有日期字段进 `rest`（保留原 ISO 字符串）**——P1a 不做 datetime ↔ string 转换（P0 声明的 typed 日期列保留 `DEFAULT time::now()`,P1a 不写它们、读时从 `rest` 取真值）。P2 需要按日期查询时再把日期提升为 typed 列并加转换。
- **运维尾巴 → `state_meta:main` blob**:`profile, profileSuggestions, interviewAnnotations, chatSessions, memoryCorrections, memoryEdges, podcastEpisodes, corpusImports, corpusInsights, playbookPatches, configVersions, auditEvents, aiRunEvents, workflowRuns, operationalChecks, systemConfig, schemaVersion` + `revision`。审计/配置/会话进图无价值（YAGNI,契合 spec 冷热分层）。
- **不做（留 P1b/c/d）**:`reconcileEdges`（旧字段 → RELATE 边,P1b,供 P2 图召回）、`session.turns → turn 表`正规化（P1b）、diff-upsert 性能（P1c）、双写/影子读/切读到 Surreal 权威（P1d，接入运行 server 的高风险步）。P1a 的 `turn` 表保持空、`rest` 内含 turns。

### 0.4 环境（同 P0）
- 在隔离 worktree 执行（执行时由 `using-git-worktrees` 建,基于本地 HEAD）。worktree 无 node_modules → 先 `npm install`（P0 已加 surreal 两包,装得到）。
- baseline:`npx vitest run` 应 962 passed | 6 skipped。

---

## 1. 文件结构

```
packages/db/
  tsconfig.json                           # 新:packages/db 首次纳入 typecheck(moduleResolution=bundler,修 @surrealdb/node 解析)
  src/surreal/
    constants.ts                          # 改:加 SURREAL_STATE_DATA_DIR 默认等(可选);EMBEDDING_DIMENSION 已存在
    migrations/004_p1a_rest_meta.surql     # 新:12 表 + turn 加 rest FLEXIBLE object;新增 state_meta 表
    node-mapper.ts                         # 新:NODE_MAPPINGS 注册表 + 通用 toRecord/fromRecord
    node-mapper.test.ts                    # 新:每类型 fromRecord(toRecord(x))===x 往返
    surreal-product-state-repository.ts    # 新:createSurrealProductStateRepository(异步工厂→同步接口 + flush)
    surreal-product-state-repository.test.ts # 新:契约 + 持久化重载 + 乐观锁
  src/repository-contract.ts              # 新:runProductStateRepositoryContract(makeRepo) 共享契约,三实现共用
apps/api/src/
  product-state-repository.contract.test.ts # 新:对 in-memory 跑共享契约
  server.ts                               # 改:startServer 按 PRODUCT_STORE=surreal 异步构造并注入;createDefaultProductStateRepository 注释说明
package.json                              # 改:typecheck 脚本追加 tsc -p packages/db/tsconfig.json
```

- 职责:`node-mapper` 只管实体 ⇄ 记录的纯映射（无 IO,可单测）;`surreal-product-state-repository` 只管连接/内存副本/落库编排;`repository-contract` 是三实现共用的行为规范。

---

## 2. 任务

### Task 1: 前置——packages/db 纳入 typecheck + 修 `@surrealdb/node` 解析

**Files:**
- Create: `packages/db/tsconfig.json`
- Modify: `package.json`（`scripts.typecheck`）

- [ ] **Step 1: 写 packages/db 专用 tsconfig（bundler 解析）**

`packages/db/tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022"],
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "skipLibCheck": true,
    "esModuleInterop": true,
    "allowSyntheticDefaultImports": true,
    "resolveJsonModule": true,
    "forceConsistentCasingInFileNames": true,
    "isolatedModules": true,
    "noEmit": true,
    "types": ["node"]
  },
  "include": ["src"],
  "exclude": ["node_modules", "../../node_modules", "../../dist"]
}
```
> `moduleResolution: bundler` 让 `@surrealdb/node` 的 `exports`-条件类型可解析（P0 review 发现 `Node` 解析报 TS2307）。`types:["node"]` 给 `node:fs/path/url`。packages/db 对 `../../../src`、`../../../apps` 的相对导入在 bundler 下照常解析。

- [ ] **Step 2: typecheck 脚本纳入 packages/db**

把 `package.json` 的 typecheck 脚本：
```json
    "typecheck": "tsc -b && tsc -p apps/api/tsconfig.json",
```
改为：
```json
    "typecheck": "tsc -b && tsc -p apps/api/tsconfig.json && tsc -p packages/db/tsconfig.json",
```

- [ ] **Step 3: 跑 typecheck,修 packages/db 暴露的既有类型错**

Run:
```bash
npm run typecheck
```
Expected: 通过。`packages/db` 此前从未被类型检查（P0 review 证实），首次纳入**可能暴露 sqlite-* 文件里的潜伏类型错**。若有：只在 `packages/db/src/**` 内做最小修复（不碰 `src/domain`、不碰既有测试、不放宽 strict）。surreal 文件应已干净（P0 期用临时 tsconfig 验过）。把每个修复点记进 commit message。

- [ ] **Step 4: Commit**
```bash
git add packages/db/tsconfig.json package.json
git commit -m "build(db): bring packages/db into typecheck (moduleResolution=bundler for @surrealdb/node)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```
（若 Step 3 改了 packages/db/src 文件,一并 `git add` 那些具体文件后再提交。）

---

### Task 2: 前置——共享仓库契约测试

**Files:**
- Create: `packages/db/src/repository-contract.ts`
- Create: `apps/api/src/product-state-repository.contract.test.ts`

- [ ] **Step 1: 写共享契约（一套断言,跑任意实现）**

`packages/db/src/repository-contract.ts`:
```ts
import { expect } from "vitest";
import type { ProductStateRepository } from "../../../apps/api/src/product-state-repository";
import { StateRevisionConflictError } from "../../../apps/api/src/product-state-repository";

/** 三实现（in-memory/sqlite/surreal）共用的行为契约。makeRepo 每次返回一个全新空仓库。
 *  flush:surreal 这类异步落库实现传入,等待持久化;同步实现传 undefined。 */
export function runProductStateRepositoryContract(
  makeRepo: () => Promise<ProductStateRepository> | ProductStateRepository,
  flush?: (repo: ProductStateRepository) => Promise<void>
) {
  it("seed 后 getState 返回稳定初始态,revision 单调", async () => {
    const repo = await makeRepo();
    const s0 = repo.getState();
    expect(typeof s0.revision).toBe("number");
    const s1 = repo.replaceState(s0);
    expect(s1.revision).toBe((s0.revision ?? 0) + 1);
    const s2 = repo.replaceState(s1);
    expect(s2.revision).toBe(s1.revision + 1);
  });

  it("replaceState 写入的资产可被 getState 读回", async () => {
    const repo = await makeRepo();
    const base = repo.getState();
    const next = {
      ...base,
      points: [
        ...base.points,
        { id: "pt_contract_1", title: "标题", content: "内容", status: "稳定观点" as const,
          confidence: "用户确认" as const, evidence: ["e1"], relatedThemeIds: ["th_1"],
          important: true, updatedAt: "2026-06-27T00:00:00.000Z" }
      ]
    };
    repo.replaceState(next);
    const got = repo.getState().points.find((p) => p.id === "pt_contract_1");
    expect(got).toBeDefined();
    expect(got?.title).toBe("标题");
    expect(got?.relatedThemeIds).toEqual(["th_1"]); // rest 兜住的非核心字段也要无损
    expect(got?.evidence).toEqual(["e1"]);
  });

  it("expectedRevision 不符抛 StateRevisionConflictError", async () => {
    const repo = await makeRepo();
    const s = repo.getState();
    expect(() => repo.replaceState(s, { expectedRevision: (s.revision ?? 0) + 99 }))
      .toThrow(StateRevisionConflictError);
  });

  it("getInterviewSession 按 id 返回会话或 null", async () => {
    const repo = await makeRepo();
    const base = repo.getState();
    expect(repo.getInterviewSession("nope")).toBeNull();
    const session = base.sessions[0];
    if (session) expect(repo.getInterviewSession(session.id)?.id).toBe(session.id);
  });

  it("resetState 清空到空态", async () => {
    const repo = await makeRepo();
    const withData = { ...repo.getState(), points: [
      { id: "pt_x", title: "t", content: "c", status: "稳定观点" as const,
        confidence: "用户确认" as const, evidence: [], relatedThemeIds: [], important: false,
        updatedAt: "2026-06-27T00:00:00.000Z" }
    ] };
    repo.replaceState(withData);
    repo.resetState();
    expect(repo.getState().points).toHaveLength(0);
  });

  // 持久化重载（仅异步实现传 flush + reopenRepo;同步实现跳过）
  return { runReloadDurability(reopenRepo: () => Promise<ProductStateRepository>) {
    it("落库后重开仓库,状态无损重建", async () => {
      const repo = await makeRepo();
      const next = { ...repo.getState(), points: [
        { id: "pt_reload", title: "持久化", content: "c", status: "已修正" as const,
          confidence: "用户确认" as const, evidence: [], relatedThemeIds: ["th_r"], important: true,
          updatedAt: "2026-06-27T00:00:00.000Z" }
      ] };
      repo.replaceState(next);
      if (flush) await flush(repo);
      const reopened = await reopenRepo();
      const got = reopened.getState().points.find((p) => p.id === "pt_reload");
      expect(got?.relatedThemeIds).toEqual(["th_r"]);
    });
  } };
}
```
> `status` 用合法 `PointStatus`（如 `"已修正"`）。`evidence`/`relatedThemeIds` 是非核心字段,验证它们经 `rest` 无损往返。

- [ ] **Step 2: 对 in-memory 实现跑契约（RED→GREEN,验证契约自身正确）**

`apps/api/src/product-state-repository.contract.test.ts`:
```ts
import { describe } from "vitest";
import { runProductStateRepositoryContract } from "../../../packages/db/src/repository-contract";
import { createInMemoryProductStateRepository } from "./product-state-repository";

describe("contract: in-memory", () => {
  runProductStateRepositoryContract(() => createInMemoryProductStateRepository());
});
```

- [ ] **Step 3: 跑测试**

Run:
```bash
npx vitest run apps/api/src/product-state-repository.contract.test.ts
```
Expected: PASS（in-memory 满足契约;若某断言因 in-memory 不持久化而失败,说明断言越界——修正契约只断言同步语义,reload 部分仅 surreal 用）。

- [ ] **Step 4: Commit**
```bash
git add packages/db/src/repository-contract.ts apps/api/src/product-state-repository.contract.test.ts
git commit -m "test(db): shared ProductStateRepository contract (in-memory green)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: `004_p1a_rest_meta.surql`（rest 字段 + state_meta 表）

**Files:**
- Create: `packages/db/src/surreal/migrations/004_p1a_rest_meta.surql`

- [ ] **Step 1: 写迁移**

`packages/db/src/surreal/migrations/004_p1a_rest_meta.surql`:
```surql
-- P1a · 给 12 本体表 + turn 加 rest(FLEXIBLE object) 兜全字段(无损往返);新增 state_meta 存运维尾巴 + revision。
-- 3.x:object 字段写 `TYPE object FLEXIBLE`。applySchema 账本保证只跑一次。
DEFINE FIELD IF NOT EXISTS rest ON session          TYPE object FLEXIBLE;
DEFINE FIELD IF NOT EXISTS rest ON turn             TYPE object FLEXIBLE;
DEFINE FIELD IF NOT EXISTS rest ON note             TYPE object FLEXIBLE;
DEFINE FIELD IF NOT EXISTS rest ON point            TYPE object FLEXIBLE;
DEFINE FIELD IF NOT EXISTS rest ON decision         TYPE object FLEXIBLE;
DEFINE FIELD IF NOT EXISTS rest ON debt             TYPE object FLEXIBLE;
DEFINE FIELD IF NOT EXISTS rest ON question         TYPE object FLEXIBLE;
DEFINE FIELD IF NOT EXISTS rest ON theme            TYPE object FLEXIBLE;
DEFINE FIELD IF NOT EXISTS rest ON memory           TYPE object FLEXIBLE;
DEFINE FIELD IF NOT EXISTS rest ON memory_candidate TYPE object FLEXIBLE;
DEFINE FIELD IF NOT EXISTS rest ON material         TYPE object FLEXIBLE;
DEFINE FIELD IF NOT EXISTS rest ON rag_chunk        TYPE object FLEXIBLE;
DEFINE FIELD IF NOT EXISTS rest ON search_brief     TYPE object FLEXIBLE;

-- 整状态元:revision(乐观锁) + rest(运维尾巴:profile/systemConfig/审计/配置/chat/corpus/... + schemaVersion)
DEFINE TABLE IF NOT EXISTS state_meta SCHEMAFULL;
DEFINE FIELD IF NOT EXISTS revision ON state_meta TYPE int DEFAULT 0;
DEFINE FIELD IF NOT EXISTS rest     ON state_meta TYPE object FLEXIBLE;
```

- [ ] **Step 2: 验证迁移可应用（扩 P0 的 apply-schema 测试或临时跑）**

Run:
```bash
npx vitest run packages/db/src/surreal/apply-schema.test.ts
```
Expected: 仍 PASS（apply-schema 自动发现 004 并应用;P0 的 INFO 断言不变,004 只增字段/表）。若要显式断言 state_meta 存在,可在 apply-schema.test.ts 的 INFO FOR DB 表清单里加 `"state_meta"`（可选）。

- [ ] **Step 3: Commit**
```bash
git add packages/db/src/surreal/migrations/004_p1a_rest_meta.surql
git commit -m "feat(db): P1a migration — rest blob fields + state_meta table

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: `node-mapper.ts`（通用 toRecord/fromRecord）+ 往返测试

**Files:**
- Create: `packages/db/src/surreal/node-mapper.ts`
- Create: `packages/db/src/surreal/node-mapper.test.ts`

- [ ] **Step 1: 写失败测试（RED）**

`packages/db/src/surreal/node-mapper.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { NODE_MAPPINGS, toRecord, fromRecord, mappingFor } from "./node-mapper";

describe("node-mapper", () => {
  it("point 往返:核心字段 + rest 无损", () => {
    const m = mappingFor("points")!;
    const entity = {
      id: "pt_1", title: "标题", content: "内容", status: "稳定观点",
      confidence: "用户确认", evidence: ["e1"], relatedThemeIds: ["th_1"],
      important: true, updatedAt: "2026-06-27T00:00:00.000Z", sourceSessionId: "se_1"
    };
    const rec = toRecord(entity, m);
    expect(rec.status).toBe("稳定观点");            // 核心列(受 ASSERT)
    expect((rec.rest as Record<string, unknown>).evidence).toEqual(["e1"]); // 非核心进 rest
    expect((rec.rest as Record<string, unknown>).updatedAt).toBe("2026-06-27T00:00:00.000Z"); // 日期进 rest
    expect("id" in rec).toBe(false);               // id → 记录 id,不作字段
    const back = fromRecord("pt_1", rec);
    expect(back).toEqual(entity);                   // 完整无损
  });

  it("覆盖全部 12 本体映射", () => {
    expect(NODE_MAPPINGS.map((x) => x.stateKey).sort()).toEqual(
      ["debts","decisions","importSources","memoryCandidates","memoryRecords","notes","points","questions","ragChunks","searchBriefs","sessions","themes"].sort()
    );
  });
});
```

- [ ] **Step 2: 跑确认 RED**
Run: `npx vitest run packages/db/src/surreal/node-mapper.test.ts`
Expected: FAIL（`./node-mapper` 不存在）。

- [ ] **Step 3: 实现 mapper**

`packages/db/src/surreal/node-mapper.ts`:
```ts
import type { ProductState } from "../../../src/domain/types";

/** state 数组键 ↔ 节点表 + 核心字段(落 typed 列,与 001/004 DEFINE FIELD 对齐;日期不入核心)。
 *  非核心字段(含日期/可选/嵌套/session.turns)整体进 rest,无损。 */
export interface NodeMapping {
  stateKey: Extract<keyof ProductState,
    "points"|"decisions"|"debts"|"questions"|"themes"|"notes"
    |"memoryRecords"|"memoryCandidates"|"importSources"|"ragChunks"|"searchBriefs"|"sessions">;
  table: string;
  core: string[];
}

export const NODE_MAPPINGS: NodeMapping[] = [
  { stateKey: "points",           table: "point",            core: ["title","content","status","confidence","important"] },
  { stateKey: "decisions",        table: "decision",         core: ["title","decisionKind","confirmationStatus","choice","status"] },
  { stateKey: "debts",            table: "debt",             core: ["concept","context","status"] },
  { stateKey: "questions",        table: "question",         core: ["question","whyImportant","status","appearances"] },
  { stateKey: "themes",           table: "theme",            core: ["name","summary","maturity","representativeQuote","appearances"] },
  { stateKey: "notes",            table: "note",             core: ["sessionId","title","summary","keyQuote","saidTrack","learnedTrack"] },
  { stateKey: "memoryRecords",    table: "memory",           core: ["text","status","sourceType","sourceId","evidenceQuote","sensitivity","importance","embedding"] },
  { stateKey: "memoryCandidates", table: "memory_candidate", core: ["text","status","sourceType","sourceId","sensitivity","reviewScore"] },
  { stateKey: "importSources",    table: "material",         core: ["title","sourceType","sourceUrl","content","status","sensitivity"] },
  { stateKey: "ragChunks",        table: "rag_chunk",        core: ["sourceId","title","text","keywords","usage","embedding"] },
  { stateKey: "searchBriefs",     table: "search_brief",     core: ["topic","provider","status","summary"] },
  { stateKey: "sessions",         table: "session",          core: ["title","mode","strength","status"] },
];

const BY_KEY = new Map(NODE_MAPPINGS.map((m) => [m.stateKey, m] as const));
export function mappingFor(stateKey: string): NodeMapping | undefined { return BY_KEY.get(stateKey as NodeMapping["stateKey"]); }

/** 实体 → 记录:核心字段(存在的才落)作 typed 列,其余进 rest;id 不作字段(→ 记录 id)。 */
export function toRecord(entity: Record<string, unknown>, m: NodeMapping): Record<string, unknown> {
  const rec: Record<string, unknown> = {};
  const rest: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(entity)) {
    if (k === "id") continue;
    if (m.core.includes(k)) {
      if (v !== undefined) rec[k] = v;
    } else {
      rest[k] = v;
    }
  }
  rec.rest = rest;
  return rec;
}

/** 记录 → 实体:id(记录 id) + 核心列 + 展开 rest。核心列优先级低于 rest？不——核心列即真值,
 *  rest 不含核心键(toRecord 已分流),故合并无冲突。 */
export function fromRecord(id: string, rec: Record<string, unknown>): Record<string, unknown> {
  const { rest, ...core } = rec;
  const restObj = (rest && typeof rest === "object") ? rest as Record<string, unknown> : {};
  return { id, ...restObj, ...core };
}
```
> `fromRecord` 把 `rest` 先展开、核心列后覆盖——但二者键不相交,顺序只为稳妥。`embedding`/`importance`/`sourceUrl`/`completedAt` 等可选核心字段:实体没有时 `toRecord` 不落,`fromRecord` 也不会凭空造（SurrealDB option 列缺省不返回）。

- [ ] **Step 4: 跑确认 GREEN**
Run: `npx vitest run packages/db/src/surreal/node-mapper.test.ts`
Expected: PASS。

- [ ] **Step 5: Commit**
```bash
git add packages/db/src/surreal/node-mapper.ts packages/db/src/surreal/node-mapper.test.ts
git commit -m "feat(db): generic node mapper (core columns + rest blob, lossless round-trip)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: `createSurrealProductStateRepository` — 异步工厂 + 同步读

**Files:**
- Create: `packages/db/src/surreal/surreal-product-state-repository.ts`

- [ ] **Step 1: 实现工厂 + 加载 + 同步读方法**

`packages/db/src/surreal/surreal-product-state-repository.ts`:
```ts
import type { Surreal } from "surrealdb";
import type { ProductStateRepository, ReplaceStateOptions } from "../../../apps/api/src/product-state-repository";
import { StateRevisionConflictError } from "../../../apps/api/src/product-state-repository";
import { createInitialProductState, createEmptyProductState } from "../../../src/domain/engine";
import { normalizeProductState } from "../../../src/domain/storage";
import type { ProductState } from "../../../src/domain/types";
import { createSurrealConnection, type SurrealConnectionOptions } from "./connect";
import { applySchema } from "./apply-schema";
import { NODE_MAPPINGS, toRecord, fromRecord } from "./node-mapper";

const META_ID = "state_meta:main";
/** 运维尾巴:不进节点表、整体存 state_meta.rest 的 ProductState 键。 */
const META_KEYS = [
  "profile","profileSuggestions","interviewAnnotations","chatSessions","memoryCorrections",
  "memoryEdges","podcastEpisodes","corpusImports","corpusInsights","playbookPatches",
  "configVersions","auditEvents","aiRunEvents","workflowRuns","operationalChecks",
  "systemConfig","schemaVersion"
] as const;

export interface SurrealRepoHandle extends ProductStateRepository {
  /** 等待所有挂起的异步落库完成(测试/优雅关闭用)。 */
  flush(): Promise<void>;
  /** 关闭底层连接(测试/关闭用)。 */
  close(): Promise<void>;
}

export interface SurrealRepoOptions extends SurrealConnectionOptions {}

export async function createSurrealProductStateRepository(opts: SurrealRepoOptions): Promise<SurrealRepoHandle> {
  const db = await createSurrealConnection(opts);
  await applySchema(db);

  // 内存工作副本:同步接口的真相源。
  let state: ProductState = await loadState(db);
  // 串行化落库队列(防并发 replaceState 的全量覆盖写交错);flush 等待它。
  let persistQueue: Promise<void> = Promise.resolve();

  function enqueuePersist(snapshot: ProductState) {
    persistQueue = persistQueue.then(() => persist(db, snapshot)).catch((err) => {
      // fail-loud:落库失败不静默(内存已前进,DB 落后——记录以便排查/告警)。
      console.error(JSON.stringify({ event: "surreal_persist_failed", error: String(err) }));
    });
  }

  return {
    getState() { return structuredClone(state); },
    resetState() {
      state = createEmptyProductState();
      enqueuePersist(state);
      return structuredClone(state);
    },
    replaceState(next: ProductState, replaceOpts?: ReplaceStateOptions) {
      const currentRevision = state.revision ?? 0;
      if (replaceOpts?.expectedRevision !== undefined && replaceOpts.expectedRevision !== currentRevision) {
        throw new StateRevisionConflictError(replaceOpts.expectedRevision, currentRevision);
      }
      state = normalizeProductState({ ...next, revision: currentRevision + 1 });
      enqueuePersist(state);
      return structuredClone(state);
    },
    getInterviewSession(id: string) {
      return state.sessions.find((s) => s.id === id) ?? null;
    },
    async flush() { await persistQueue; },
    async close() { await persistQueue; await db.close(); }
  };
}

/** 从 SurrealDB 读全部节点表 + state_meta,重建 ProductState(规范化)。空库 → 初始态。 */
async function loadState(db: Surreal): Promise<ProductState> {
  const [metaRows] = await db.query<[Array<{ revision: number; rest: Record<string, unknown> }>]>(
    "SELECT revision, rest FROM state_meta:main;"
  );
  const meta = metaRows?.[0];
  if (!meta) return createInitialProductState();

  const assembled: Record<string, unknown> = { ...(meta.rest ?? {}), revision: meta.revision };
  for (const m of NODE_MAPPINGS) {
    const [rows] = await db.query<[Array<Record<string, unknown>>]>(`SELECT * FROM ${m.table};`);
    assembled[m.stateKey] = (rows ?? []).map((r) => {
      const { id, ...rec } = r;
      return fromRecord(recordIdToDomainId(id), rec);
    });
  }
  return normalizeProductState(assembled);
}

/** SurrealDB 记录 id(形如 `point:pt_1` 或 {tb,id}) → 领域 id 字符串。 */
function recordIdToDomainId(id: unknown): string {
  if (typeof id === "string") return id.includes(":") ? id.slice(id.indexOf(":") + 1) : id;
  // SDK 可能返回 RecordId 对象 {tb, id};取其 id 段。
  const anyId = id as { id?: unknown } | undefined;
  return anyId?.id !== undefined ? String(anyId.id) : String(id);
}
```
> `structuredClone` 是 Node 18+ 全局(本机 25.7 有),与 sqlite repo 的深拷贝语义一致(防外部改内存副本)。`loadState` 的 record id 解析在 Task 7 用真实 SDK 返回值校正(3.x 的 `id` 可能是 `RecordId` 对象;`recordIdToDomainId` 已两路兼容)。

- [ ] **Step 2: 先不单测**（持久化逻辑 Task 6 补；本步只让文件存在、可编译）。
Run: `npx tsc -p packages/db/tsconfig.json --noEmit`
Expected: 通过（`persist` 尚未定义会报错 → 本步把 `persist` 先写成下方 Task 6 的实现，二者同一文件、一起提交）。**实现顺序:Task 5 与 Task 6 同一文件,合并为一次编写、Task 6 末统一提交。**

> 说明:Task 5/6 是同一文件的两半（读 + 写），为保持文件聚焦合并实现；下面 Task 6 给出 `persist`。

---

### Task 6: 落库（全量覆盖写 + 乐观锁 + 事务）

**Files:**
- Modify: `packages/db/src/surreal/surreal-product-state-repository.ts`（追加 `persist`）

- [ ] **Step 1: 实现 persist（事务内全量覆盖）**

在 `surreal-product-state-repository.ts` 追加：
```ts
/** 全量覆盖落库:事务内,每张本体表 delete-all + 重建;state_meta upsert(revision + 运维尾巴)。
 *  P1a 取最简正确(每写全表重写);diff-upsert 是 P1c。单用户小规模可接受。 */
async function persist(db: Surreal, snapshot: ProductState): Promise<void> {
  const meta: Record<string, unknown> = {};
  for (const k of META_KEYS) meta[k] = (snapshot as Record<string, unknown>)[k];

  // 组装事务:BEGIN → 各表 DELETE + CREATE → state_meta UPSERT → COMMIT。
  // 用参数化 query 传记录内容(避免手拼 SurrealQL 注入/转义问题)。
  let surql = "BEGIN TRANSACTION;\n";
  const vars: Record<string, unknown> = {};
  let i = 0;
  for (const m of NODE_MAPPINGS) {
    surql += `DELETE ${m.table};\n`;
    const arr = ((snapshot as Record<string, unknown>)[m.stateKey] as Array<{ id: string }>) ?? [];
    for (const entity of arr) {
      const recVar = `r${i++}`;
      vars[recVar] = toRecord(entity as Record<string, unknown>, m);
      // 用 type::thing 构造记录 id,安全处理任意 id 字符串。
      surql += `CREATE type::thing('${m.table}', $${recVar}_id) CONTENT $${recVar};\n`;
      vars[`${recVar}_id`] = entity.id;
    }
  }
  vars.meta = meta;
  vars.rev = snapshot.revision ?? 0;
  surql += `UPSERT state_meta:main SET revision = $rev, rest = $meta;\n`;
  surql += "COMMIT TRANSACTION;";

  await db.query(surql, vars);
}
```
> `CREATE type::thing('point', $id) CONTENT $rec`:`CONTENT` 用对象整体赋值(rest 是嵌套 object,CONTENT 直接落)。`type::thing` 安全构造记录 id。事务保证一次 replaceState 的整图覆盖原子可见。

- [ ] **Step 2: 编译**
Run: `npx tsc -p packages/db/tsconfig.json --noEmit`
Expected: 通过（`persist` 已定义,Task 5 的引用解析）。

- [ ] **Step 3: Commit（Task 5+6 同一文件一起提交）**
```bash
git add packages/db/src/surreal/surreal-product-state-repository.ts
git commit -m "feat(db): SurrealStore repository — async factory, in-memory sync reads, serialized overwrite persist + flush

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: 契约 + 持久化重载 + 乐观锁测试（对 surreal 实现）

**Files:**
- Create: `packages/db/src/surreal/surreal-product-state-repository.test.ts`

- [ ] **Step 1: 写测试（mem:// 跑契约 + surrealkv:// 跑重载）**

`packages/db/src/surreal/surreal-product-state-repository.test.ts`:
```ts
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runProductStateRepositoryContract } from "../repository-contract";
import { createSurrealProductStateRepository, type SurrealRepoHandle } from "./surreal-product-state-repository";

const open = new Set<SurrealRepoHandle>();
async function makeMem(): Promise<SurrealRepoHandle> {
  const repo = await createSurrealProductStateRepository({ url: "mem://" });
  open.add(repo);
  return repo;
}
afterEach(async () => { for (const r of open) await r.close(); open.clear(); });

describe("contract: surreal (mem://)", () => {
  runProductStateRepositoryContract(
    makeMem,
    (repo) => (repo as SurrealRepoHandle).flush()
  );
});

describe("surreal persistence (surrealkv://)", () => {
  it("replaceState→flush→重开,资产无损重建", async () => {
    const dir = mkdtempSync(join(tmpdir(), "surreal-p1a-"));
    try {
      const url = `surrealkv://${dir}/surreal`;
      const repo = await createSurrealProductStateRepository({ url });
      const next = { ...repo.getState(), points: [
        { id: "pt_kv", title: "持久化", content: "c", status: "已修正" as const,
          confidence: "用户确认" as const, evidence: ["x"], relatedThemeIds: ["th_kv"],
          important: true, updatedAt: "2026-06-27T00:00:00.000Z" }
      ] };
      repo.replaceState(next);
      await repo.flush();
      await repo.close();
      await new Promise((r) => setTimeout(r, 200)); // surrealkv close 后重开需 ~150ms(P0 实测)

      const reopened = await createSurrealProductStateRepository({ url });
      const got = reopened.getState().points.find((p) => p.id === "pt_kv");
      expect(got?.title).toBe("持久化");
      expect(got?.relatedThemeIds).toEqual(["th_kv"]); // rest 无损
      expect(got?.evidence).toEqual(["x"]);
      await reopened.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
```
> 契约里的 reload 部分需要 surrealkv（mem:// 重开是新库）；故 reload 单独用 surrealkv 测，契约对 mem:// 只跑同步语义部分。若 `runProductStateRepositoryContract` 的返回 `runReloadDurability` 要用,在 surrealkv 段调用;否则如上独立写 reload 测试。

- [ ] **Step 2: 跑测试（关键校正点）**
Run: `npx vitest run packages/db/src/surreal/surreal-product-state-repository.test.ts`
Expected: PASS。**易踩点（按真实 SDK 返回校正）**:
- `SELECT * FROM point` 返回的 `id` 是 `RecordId` 对象还是字符串 → `recordIdToDomainId` 已两路兼容,若仍不符按实测调整。
- `CONTENT $rec` 里 `rest` 嵌套 object 能否整体落 → P0 已证 FLEXIBLE object 可存;若 CONTENT 对 rest 报错,改用 `SET rest = $rec_rest, ...`。
- 事务多语句 `db.query(surql, vars)` 一次提交 → 若 3.x 对 `BEGIN/COMMIT` 包裹的参数作用域有要求,改为分条 `db.query` 包在 JS 层 try/catch（P1a 单用户可接受非严格原子,但优先事务）。

- [ ] **Step 3: Commit**
```bash
git add packages/db/src/surreal/surreal-product-state-repository.test.ts
git commit -m "test(db): SurrealStore passes repo contract (mem) + surrealkv reload durability

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: env opt-in 接线（startServer）+ 全量回归

**Files:**
- Modify: `apps/api/src/server.ts`（`startServer` 加 PRODUCT_STORE 分支）

- [ ] **Step 1: 在 startServer 按 env 异步构造 surreal repo 并注入**

在 `server.ts` 的 `startServer`（约 579+），把 `const repository = createSqliteProductStateRepository({ dbPath: productStateDbPath });` 改为按 env 选择：
```ts
  const productStore = (process.env.PRODUCT_STORE ?? "sqlite").trim().toLowerCase();
  let repository: ProductStateRepository;
  if (productStore === "surreal") {
    // 嵌入式 SurrealDB(绞杀者 P1a:opt-in,默认仍 sqlite)。异步构造在此 await,buildApiServer 保持同步。
    const { createSurrealProductStateRepository } =
      await import("../../../packages/db/src/surreal/surreal-product-state-repository");
    const dataDir = join(dirname(productStateDbPath), "surreal");
    repository = await createSurrealProductStateRepository({ url: `surrealkv://${dataDir}/surreal` });
    console.warn(JSON.stringify({ event: "product_store_surreal", detail: `嵌入式 SurrealDB @ ${dataDir}（P1a opt-in）` }));
  } else {
    repository = createSqliteProductStateRepository({ dbPath: productStateDbPath });
  }
```
然后把现有 `buildApiServer({ productStateDbPath, ... })` 调用加上注入 `productStateRepository: repository`（若当前未注入则补；buildApiServer 已支持 `options.productStateRepository`）。
> 默认分支不变(sqlite)；`createDefaultProductStateRepository`（buildApiServer 内,测试用）保持不动——surreal 只在持久化进程(startServer)启用。

- [ ] **Step 2: typecheck + 全量回归**
Run:
```bash
npm run typecheck && npx vitest run
```
Expected: typecheck 通过（现含 packages/db）；vitest 在 baseline 962 之上**净增**本计划新测（node-mapper/contract/surreal repo），全绿、零回归。粘贴 summary 行。

- [ ] **Step 3: 冒烟 opt-in（可选但推荐）**
Run:
```bash
PRODUCT_STORE=surreal PRODUCT_STATE_DB_PATH="$(pwd)/.data/product-state.db" node -e "import('./apps/api/src/server.ts').catch(e=>{console.error(e);process.exit(1)})" 2>&1 | head -5 || true
```
> 仅验证 surreal 分支能构造不抛（不必长跑）。若用 tsx 更稳:`PRODUCT_STORE=surreal npx tsx -e "import('./apps/api/src/server.js')"`。无法在本环境长跑则跳过并说明。

- [ ] **Step 4: Commit**
```bash
git add apps/api/src/server.ts
git commit -m "feat(api): opt-in PRODUCT_STORE=surreal wiring in startServer (default stays sqlite)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## 3. P1a 阶段门
- [ ] `npm run typecheck` 通过且**现已覆盖 packages/db**（P0 遗留盲区闭合）。
- [ ] `npx vitest run` 全绿:in-memory + surreal 同过统一契约;surrealkv 重载无损;乐观锁冲突抛错;node-mapper 往返无损。零回归（≥962 基线）。
- [ ] 默认存储仍 sqlite;`PRODUCT_STORE=surreal` 可切到嵌入式 SurrealDB,整 `ProductState` 无损往返。
- [ ] 域层 148 纯函数、既有测试、运行默认路径未改。

## 4. 不在本计划（后续）
- **P1b**:`reconcileEdges`（relatedThemeIds/evidenceAnchors/memoryEdges → RELATE 边,双向）+ `session.turns → turn 表`正规化（供 P2 图召回）。
- **P1c**:diff-upsert（只改变更节点,替代全量覆盖）——复用 `diffIndexableSources`（`src/domain/knowledge.ts:159`）思路。
- **P1d（高风险,接入运行 server）**:双写 + 影子读等价比对 + 切读 Surreal 权威 + 收旧（spec 02 §4 / spec 06 P1a→P1c）。
- **数据迁移脚本** `scripts/migrate-sqlite-to-surreal.mjs`（spec 06 §2）。

---

## 5. 自查（writing-plans Self-Review，已执行）
- **Spec 覆盖**:spec 02 §1 绞杀点（Task 8 注入,接口不变）、§2 映射（Task 4/5/6,本体表+rest+state_meta）、§5 T1 契约测试（Task 2,三实现共用）、T2 toRecord/fromRecord 往返（Task 4）、T5 乐观锁（Task 7）。**显式划出**的 §3 diff-upsert→P1c、§4 双写→P1d、reconcileEdges→P1b（§4 已列）。
- **占位扫描**:无 TBD/占位;所有 migration/TS/测试/命令为完整内容,枚举值均用 types.ts 合法值（契约与 Task 7 用例 status 用 `"已修正"`/`"稳定观点"`）。
- **类型一致**:`createSurrealProductStateRepository`/`SurrealRepoHandle`（flush/close）/`toRecord`/`fromRecord`/`NODE_MAPPINGS`/`mappingFor` 跨 Task 4/5/6/7 一致;`META_KEYS` 与 §0.3 运维尾巴一致;`recordIdToDomainId` 两路兼容 string/RecordId。
- **已知校正点**（Task 7 Step 2 列出,均为 3.x SDK 实测项,非占位）:record id 形态、CONTENT 落 rest、事务参数作用域——给了 fallback。

---

## 6. 执行交接
**Plan complete and saved to `docs/superpowers/plans/2026-06-27-surreal-ontology-p1a-surrealstore-foundation.md`.**

**1. Subagent-Driven (recommended)** — 每 Task 派新 subagent + 两阶段 review（REQUIRED SUB-SKILL: superpowers:subagent-driven-development）。
**2. Inline Execution** — 本会话批执行 + checkpoint（REQUIRED SUB-SKILL: superpowers:executing-plans）。

**Which approach?**
