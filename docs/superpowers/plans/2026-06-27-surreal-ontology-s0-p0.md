# SurrealDB × 本体论 · S0 spike + P0 schema 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 验证嵌入式 SurrealDB 在本机能跑通（向量/全文/级联），并把本体目标 schema 落成幂等的 SurrealQL migrations + 自测——为后续绞杀者迁移（P1+）铺好零~低风险的地基。

**Architecture:** 这是整套迁移（[spec 00–06](../specs/)）的**第一阶段**：S0 是一次性 spike（探针），P0 是纯建库（DDL migrations + applySchema + 自测）。两者都**不接入运行中的应用**、**不碰域层 148 个纯函数、不碰 960 个测试**。新代码全部落在 `packages/db/src/surreal/` 与 `scripts/`，通过 vitest 既有 `packages/**/*.test.ts` glob 被收集。S0 的结论（包/引擎是否可用、确切 init API、向量/全文/级联是否支持）**门控** P0 的 schema 决策。

**Tech Stack:** `surrealdb`(JS SDK, v2.0.4) + `@surrealdb/node`(嵌入式引擎, v3.0.3, peer `surrealdb@^2.0.1`) · 连接串 `surrealkv://`(持久)/`mem://`(测试) · Node 25.7（本机实测，engines 声明 `>=22.5`）· TypeScript 5.9 · Vitest 4 · SurrealQL（SCHEMAFULL + `RELATE` + `ASSERT` + HNSW + BM25）。

---

## 0. 上下文与护栏（动手前必读）

### 0.1 不可触碰（绞杀者纪律）
- **不改** `src/domain/**`（148 纯函数）、不改既有 960 测试、不改 `apps/api/src/server.ts` 的注入。S0/P0 阶段 SurrealDB **不接入运行时**——它只被 spike 脚本和新 schema 测试用到。
- **不动**任何与本任务无关的已修改文件（`git status` 里现有的 `zhuanfang`、`.truthtracker-*`、`findings.json`、`report.md` 等一律不碰）。
- **不进** `.claude/worktrees/`（有并发 agent 的工作树，属于别的任务）。

### 0.2 本机环境陷阱（已核实）
- **共享 checkout 风险**：主 checkout 与并发 agent 共享，可能 hard-reset 并把未提交改动吞进它们的 commit。**对策：每个 Task 末尾立即 commit**（本计划已内置 commit 步骤），并在 commit 后 `git log --oneline -1` 复核。
- **npm TLS 拦截**：本机 `npm install` 可能报 `UNABLE_TO_GET_ISSUER_CERT_LOCALLY`（系统级 TLS 拦截）。若发生，临时绕过：`npm config set strict-ssl false` 装完后 `npm config set strict-ssl true` 还原。git 不受影响。
- **`@surrealdb/node` 体量**：主包把各平台原生二进制直接内置（解包 ~161MB），无 postinstall 下载、无 per-platform 分包。装包就是一次普通（但较大）的 npm 下载。它是**服务端 Node 运行时**依赖，Vite 只打包 `src/`，**不会进浏览器 bundle**。
- **原生 addon × Node 25**：`@surrealdb/node` 是 N-API addon（ABI 跨 Node 大版本稳定），Node 25.7 **大概率**直接加载预编译二进制，但**必须由 S0/S1 实测确认**——这是本阶段头号风险。

### 0.3 与 spec 的差异（本计划据 `src/domain/types.ts` 对 spec 示意值的**纠正**，执行时以本计划为准）
| spec 01 写法（示意） | types.ts 真值（本计划采用） | 影响 |
|---|---|---|
| `point.status IN ['待验证','已验证','已修正']` | `PointStatus = 临时想法\|稳定观点\|被挑战中\|已修正\|已放弃` | 照抄 spec 会让 P1 真实写入被 ASSERT 全拒 |
| `memory.status IN ['candidate','confirmed','deprecated']` | `MemoryRecordStatus = confirmed\|deprecated\|deleted`（候选是独立表 `memory_candidate`：`pending\|approved\|rejected`） | 同上 |
| `material` 有 `embedding` + `material_emb` HNSW 索引 | `ImportSource` **无 embedding**（向量只在 `memory`/`rag_chunk`） | 删除 `material_emb` 索引，否则索引指向不存在字段 |
| `turn` 字段 `createdAt` | `InterviewTurn.timestamp` | 字段名对齐 |
| `question` 字段 `text` | `QuestionAsset.question` | 字段名对齐 |
| `theme.maturity`（未列枚举） | `萌芽\|重复\|聚焦\|成型\|变化\|关闭` | 写进 ASSERT |

> 真实枚举来源：`src/domain/types.ts:89-93`（资产 status）、`:251-268`（turn）、`:586-613`（session）、`:697-771`（point/question/decision/debt/theme）、`:837-887`（memory/candidate）、`:1006-1042`（material/rag_chunk）、`:955-980`（search_brief）。

### 0.4 本阶段范围边界
- **做**：S0 五项 spike + P0 三个 migration（节点/边/索引）+ 幂等 `applySchema` + schema 自测 + 维度对齐守卫 + 边语义冒烟。
- **不做（留给后续 plan）**：`SurrealStore` 实现（P1/spec 02）、`state_meta`/revision 表（P1）、`audit` 表与 `DEFINE EVENT`/级联落 DB（P3/spec 03）、召回改造（P2/spec 04）、数据迁移脚本（spec 06）。SCHEMAFULL 表此阶段只声明**核心字段**（枚举/关键标量/数组）；P1 落 `toRecord` 时以增量 migration `004_*.surql` 补齐其余字段（migrations 只增不改）。

---

## 1. 文件结构（本阶段新增；均为新文件，无改写既有文件）

```
scripts/
  spike-surreal.mjs                       # S0:一次性能力探针(沿用 scripts/spike-*.mjs 约定),自测 S1–S5,任一硬检查失败退出非零
packages/db/src/surreal/
  constants.ts                            # EMBEDDING_DIMENSION 等共享常量
  connect.ts                              # createSurrealConnection():嵌入式连接 + use(ns/db)
  apply-schema.ts                         # applySchema():按 _migration 账本幂等应用 migrations/*.surql
  apply-schema.test.ts                    # P0 自测:幂等 / INFO 齐全 / ASSERT 拒非法 / 维度守卫 / 边语义冒烟
  migrations/
    001_nodes.surql                       # 13 节点表 + entity_kind 元表(+ kind→parent 种子)
    002_relations.surql                   # 8 条 RELATE 边表 + derived_from.provenance ASSERT
    003_index.surql                       # HNSW(memory/rag_chunk) + 中文 analyzer + BM25(memory/rag_chunk)
```

- 职责边界：`.surql` 是声明式 schema 真相；`apply-schema.ts` 只负责"读文件 + 账本去重 + 顺序执行"；`connect.ts` 只负责连接；`constants.ts` 防 TS 常量与 DDL 字面量漂移（被测试守卫）。
- 包内引用沿用本仓相对路径风格（`packages/db` 与 `apps/api`/`src` 之间用相对路径互引，无 npm workspaces 软链 / 无 paths 映射）。

---

# 阶段 S0 · Spike（嵌入式 SurrealDB 能力探针）

> 目的：用最小可运行代码**实测**——而非假设——以下事实，并把"确切可用的 init/查询 API"锁进 spike 脚本注释，供 P0/P1 直接照抄。任一硬检查失败 → 停下，回到 [spec 00 §6 风险](../specs/2026-06-27-surreal-ontology-00-总纲与决策.md) 评估降级（先只迁节点/边、向量暂留 JS，或暂缓）。

### Task S0.1: 安装 `surrealdb` + `@surrealdb/node`

**Files:**
- Modify: `package.json`（`dependencies` 增两项）
- Modify: `package-lock.json`（npm 自动）

- [ ] **Step 1: 装包（服务端运行时依赖）**

Run:
```bash
npm install --save surrealdb@^2.0.4 @surrealdb/node@^3.0.3
```
Expected: 成功，`package.json` 的 `dependencies` 出现两项，版本满足 peer（`@surrealdb/node` 需 `surrealdb@^2.0.1`）。
若报 `UNABLE_TO_GET_ISSUER_CERT_LOCALLY`：
```bash
npm config set strict-ssl false && npm install --save surrealdb@^2.0.4 @surrealdb/node@^3.0.3 && npm config set strict-ssl true
```

- [ ] **Step 2: 确认已落地**

Run:
```bash
node -e "console.log(require('surrealdb/package.json').version, require('@surrealdb/node/package.json').version)"
```
Expected: 打印两个版本号（形如 `2.0.4 3.0.3`），无报错。

- [ ] **Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore(db): add surrealdb + @surrealdb/node for embedded SurrealDB spike

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task S0.2: 写 spike 脚本骨架 + S1（addon 加载 / 连接 / 基本读写）

**Files:**
- Create: `scripts/spike-surreal.mjs`

- [ ] **Step 1: 写 spike 脚本（含 S1–S5 全部检查；先跑 S1）**

写入 `scripts/spike-surreal.mjs`：

```js
// 一次性 spike:实测嵌入式 SurrealDB(@surrealdb/node)在本机的能力。
// 用法:  node scripts/spike-surreal.mjs
// 退出码:任一“硬检查”失败 → 1;全部通过 → 0。S5(维度)为软检查,缺 API key 时跳过。
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { Surreal, createRemoteEngines } from "surrealdb";
import { createNodeEngines } from "@surrealdb/node";

let hardFail = false;
const ok = (m) => console.log(`  ✅ ${m}`);
const bad = (m) => { console.error(`  ❌ ${m}`); hardFail = true; };
const soft = (m) => console.warn(`  ⚠️  ${m}`);
const section = (m) => console.log(`\n=== ${m} ===`);

// 锁定确切的 init API:embedded-only 用 createNodeEngines();spread createRemoteEngines() 与官方文档一致(无远程引擎也无害)。
async function open(url) {
  const db = new Surreal({ engines: { ...createRemoteEngines(), ...createNodeEngines() } });
  await db.connect(url);
  await db.use({ namespace: "interview", database: "main" });
  return db;
}

async function main() {
  section(`环境`);
  console.log(`  node ${process.version} · platform ${process.platform}/${process.arch}`);

  // ---------- S1: addon 加载 + mem:// + surrealkv:// + 基本读写 ----------
  section(`S1 addon 加载 / 连接 / 基本读写`);
  let db;
  try {
    db = await open("mem://");
    ok("createNodeEngines() 未抛错;mem:// 连接 + use() 成功");
  } catch (e) {
    bad(`addon 加载或 mem:// 连接失败: ${e?.message ?? e}`);
    console.error(e);
    return; // S1 不过,后续无意义
  }
  try {
    await db.query("DEFINE TABLE IF NOT EXISTS probe SCHEMAFULL; DEFINE FIELD IF NOT EXISTS n ON probe TYPE int;");
    await db.query("CREATE probe:a SET n = 1;");
    const [rows] = await db.query("SELECT n FROM probe:a;");
    if (rows?.[0]?.n === 1) ok("DEFINE/CREATE/SELECT 往返正确"); else bad(`SELECT 返回异常: ${JSON.stringify(rows)}`);
  } catch (e) { bad(`基本读写失败: ${e?.message ?? e}`); }
  await db.close();

  // surrealkv:// 持久化协议(生产用)
  const dir = mkdtempSync(join(tmpdir(), "surreal-spike-"));
  try {
    const pdb = await open(`surrealkv://${dir}/surreal`);
    await pdb.query("DEFINE TABLE IF NOT EXISTS probe SCHEMAFULL;");
    await pdb.query("CREATE probe:b SET label = 'persist';");
    await pdb.close();
    const pdb2 = await open(`surrealkv://${dir}/surreal`);
    const [rows] = await pdb2.query("SELECT label FROM probe:b;");
    if (rows?.[0]?.label === "persist") ok("surrealkv:// 重开后数据仍在(持久化 OK)"); else bad(`surrealkv:// 持久化异常: ${JSON.stringify(rows)}`);
    await pdb2.close();
  } catch (e) { bad(`surrealkv:// 失败: ${e?.message ?? e}`); }
  finally { rmSync(dir, { recursive: true, force: true }); }

  await runVector();
  await runFulltext();
  await runCascade();
  await runDimension();

  section(`结论`);
  if (hardFail) { console.error("SPIKE FAILED — 见上方 ❌;回 spec 00 §6 评估降级。"); process.exit(1); }
  console.log("SPIKE PASSED — 嵌入式 SurrealDB 在本机可用,P0 可落 schema。");
}

// ---------- S2: 向量 HNSW ----------
async function runVector() {
  section(`S2 向量 HNSW + KNN`);
  const db = await open("mem://");
  try {
    await db.query("DEFINE TABLE IF NOT EXISTS v SCHEMAFULL; DEFINE FIELD IF NOT EXISTS e ON v TYPE array<float>;");
    await db.query("DEFINE INDEX IF NOT EXISTS v_emb ON v FIELDS e HNSW DIMENSION 3 DIST COSINE;");
    await db.query("CREATE v:a SET e=[1,0,0]; CREATE v:b SET e=[0,1,0]; CREATE v:c SET e=[0.9,0.1,0];");
    const [rows] = await db.query("SELECT id FROM v WHERE e <|2,40|> [1,0,0];");
    const ids = (rows ?? []).map((r) => String(r.id));
    if (ids.length === 2 && ids.some((s) => s.endsWith("a")) && ids.some((s) => s.endsWith("c")))
      ok(`HNSW KNN 返回最近邻: ${ids.join(", ")}`);
    else bad(`KNN 结果异常(期望 a,c): ${ids.join(", ")}`);
  } catch (e) { bad(`HNSW 不支持/失败: ${e?.message ?? e}`); }
  finally { await db.close(); }
}

// ---------- S3: 全文 BM25 + 中文 analyzer ----------
async function runFulltext() {
  section(`S3 全文 BM25 + analyzer`);
  const db = await open("mem://");
  try {
    await db.query("DEFINE TABLE IF NOT EXISTS d SCHEMAFULL; DEFINE FIELD IF NOT EXISTS t ON d TYPE string;");
    await db.query("DEFINE ANALYZER IF NOT EXISTS zh TOKENIZERS class FILTERS lowercase;");
    await db.query("DEFINE INDEX IF NOT EXISTS d_ft ON d FIELDS t SEARCH ANALYZER zh BM25;");
    await db.query("CREATE d:a SET t='放权与组织设计的权衡'; CREATE d:b SET t='今天的天气很好';");
    const [rows] = await db.query("SELECT id FROM d WHERE t @@ '放权';");
    const ids = (rows ?? []).map((r) => String(r.id));
    if (ids.length >= 1 && ids.some((s) => s.endsWith("a"))) ok(`BM25 @@ 命中: ${ids.join(", ")}`);
    else bad(`全文检索异常(期望命中 a): ${ids.join(", ")}`);
    // search::rrf 是否可用(spec 04 混合检索依赖);不可用则 P2 用应用层 RRF。
    try {
      await db.query("LET $a = (SELECT id FROM d WHERE t @@ '放权'); LET $b = (SELECT id FROM d WHERE t @@ '组织'); SELECT * FROM d WHERE id IN search::rrf($a,$b);");
      ok("search::rrf() 可用");
    } catch (e) { soft(`search::rrf() 不可用(P2 改用应用层 RRF): ${e?.message ?? e}`); }
  } catch (e) { bad(`全文/analyzer 不支持/失败: ${e?.message ?? e}`); }
  finally { await db.close(); }
}

// ---------- S4: 级联(A5 机制:DEFINE EVENT on DELETE) ----------
async function runCascade() {
  section(`S4 级联删除(A5 机制)`);
  const db = await open("mem://");
  try {
    await db.query("DEFINE TABLE IF NOT EXISTS session SCHEMAFULL; DEFINE TABLE IF NOT EXISTS turn SCHEMAFULL; DEFINE FIELD IF NOT EXISTS sessionId ON turn TYPE string;");
    // 删 session → 自动清其 turn(确定性、不调 LLM)
    await db.query(`DEFINE EVENT IF NOT EXISTS cascade_session ON session WHEN $event='DELETE' THEN { DELETE turn WHERE sessionId = meta::id($before.id); };`);
    await db.query("CREATE session:s1 SET title='t'; CREATE turn:t1 SET sessionId='s1'; CREATE turn:t2 SET sessionId='s1';");
    await db.query("DELETE session:s1;");
    const [rows] = await db.query("SELECT id FROM turn WHERE sessionId='s1';");
    if ((rows ?? []).length === 0) ok("DEFINE EVENT on DELETE 级联清子记录成功(A5 可由 DB 强制)");
    else bad(`级联失败,残留 turn: ${JSON.stringify(rows)}`);
  } catch (e) { bad(`DEFINE EVENT 级联不支持/失败(若失败,A5 回退应用层兜底): ${e?.message ?? e}`); }
  finally { await db.close(); }
}

// ---------- S5(软): 确认 bailian text-embedding-v3 真实维度 ----------
async function runDimension() {
  section(`S5 嵌入维度确认(软,需 DASHSCOPE_API_KEY)`);
  const key = process.env.DASHSCOPE_API_KEY || process.env.BAILIAN_API_KEY;
  if (!key) { soft("无 DASHSCOPE/BAILIAN API key,跳过;沿用 text-embedding-v3 默认维度 1024(见 constants.ts)"); return; }
  try {
    const base = process.env.BAILIAN_BASE_URL || "https://dashscope.aliyuncs.com/compatible-mode/v1";
    const res = await fetch(`${base}/embeddings`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({ model: "text-embedding-v3", input: ["维度探针"] }),
    });
    const json = await res.json();
    const len = json?.data?.[0]?.embedding?.length;
    if (len) { console.log(`  text-embedding-v3 实际维度 = ${len}`); if (len !== 1024) soft(`与默认 1024 不符! 更新 003_index.surql 与 constants.ts 为 ${len}`); else ok("维度 = 1024,与 schema 一致"); }
    else soft(`未取到维度: ${JSON.stringify(json).slice(0, 200)}`);
  } catch (e) { soft(`维度探测失败(不阻塞): ${e?.message ?? e}`); }
}

main().catch((e) => { console.error(e); process.exit(1); });
```

- [ ] **Step 2: 跑 spike（S1 是硬门，必须先过）**

Run:
```bash
node scripts/spike-surreal.mjs
```
Expected（S1 段）：打印 `node v25.x`，且 S1 出现 `✅ createNodeEngines() 未抛错`、`✅ DEFINE/CREATE/SELECT 往返正确`、`✅ surrealkv:// 重开后数据仍在`。
- 若 S1 报 addon 加载失败（Node 25 无兼容二进制）：**停**——记录确切报错，回 [spec 00 §6](../specs/2026-06-27-surreal-ontology-00-总纲与决策.md)/[spec 05 §3](../specs/2026-06-27-surreal-ontology-05-嵌入式部署与运维.md)，评估“降到 engines floor Node 22 验证”或暂缓。
- 若 `db.query` 返回结构与脚本里的解构（`const [rows] = ...`）不符：以实测为准修正脚本，并在脚本顶部注释记录 surrealdb@2.x 的确切返回形状（供 P0 `apply-schema.ts` 照抄）。

- [ ] **Step 3: Commit**

```bash
git add scripts/spike-surreal.mjs
git commit -m "spike(db): embedded SurrealDB capability probe (S1 load/connect/rw green)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task S0.3: 跑通 S2–S5 并记录结论

- [ ] **Step 1: 全量跑 spike**

Run:
```bash
node scripts/spike-surreal.mjs; echo "exit=$?"
```
Expected: `exit=0`，且：
- S2 `✅ HNSW KNN 返回最近邻: ...a, ...c`
- S3 `✅ BM25 @@ 命中: ...a`（`search::rrf()` 可用则 ✅，否则 ⚠️ 软告警——P2 改应用层 RRF）
- S4 `✅ DEFINE EVENT on DELETE 级联清子记录成功`
- S5 有 API key 则打印实际维度（确认 1024），否则 ⚠️ 跳过

- [ ] **Step 2: 把结论写进 spec 06 的阶段表（勾掉 S0）**

打开 [spec 06 §1](../specs/2026-06-27-surreal-ontology-06-迁移阶段与回滚.md)，把 “S0 spike … 5 个 spike 全过” 一行的状态更新为已通过（注明 Node 版本、各能力实测结果、`search::rrf` 是否可用、确认的嵌入维度）。这是文档勾稽，不改代码。
- 任一 S2/S3/S4 **硬失败** → 不进 P0，按 spec 00 §6 降级（例如：HNSW 不支持 → 003_index 暂不建向量索引、向量留 `src/domain/vector.ts` JS 余弦；全文不支持 → 暂不建 BM25）。本计划假设三项均过（嵌入式 v2.x 标配）；若降级，对应删减 003_index 的相应 `DEFINE INDEX` 并在 P0.5 测试里同步移除断言。

- [ ] **Step 3: Commit**

```bash
git add docs/superpowers/specs/2026-06-27-surreal-ontology-06-迁移阶段与回滚.md
git commit -m "docs(ontology): record S0 spike results (embedded SurrealDB capabilities verified)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

# 阶段 P0 · 目标 Schema（DDL migrations + 幂等 apply + 自测）

> 纯建库、零运行时风险（不接入 server）。每个 Task 走 RED→GREEN→commit。所有 `.surql` 用 `IF NOT EXISTS` 保证可重复 apply；`applySchema` 再用 `_migration` 账本跳过已应用文件（双层幂等）。

### Task P0.1: 常量 + 连接助手 + 失败测试（RED）

**Files:**
- Create: `packages/db/src/surreal/constants.ts`
- Create: `packages/db/src/surreal/connect.ts`
- Create: `packages/db/src/surreal/apply-schema.test.ts`（先放一个会失败的最小测试）

- [ ] **Step 1: 写常量**

`packages/db/src/surreal/constants.ts`：
```ts
/** DashScope text-embedding-v3 默认输出维度。S0/S5 用真实向量确认;
 *  003_index.surql 的 HNSW DIMENSION 必须与此一致(apply-schema.test.ts 守卫,防漂移)。 */
export const EMBEDDING_DIMENSION = 1024;

/** SurrealDB 命名空间/库(与任何其他用途隔离,spec 01 §1)。 */
export const SURREAL_NS = "interview";
export const SURREAL_DB = "main";
```

- [ ] **Step 2: 写连接助手**

`packages/db/src/surreal/connect.ts`（init API 以 S0 spike 锁定的为准；下为官方文档形态）：
```ts
import { Surreal, createRemoteEngines } from "surrealdb";
import { createNodeEngines } from "@surrealdb/node";
import { SURREAL_NS, SURREAL_DB } from "./constants";

export interface SurrealConnectionOptions {
  /** surrealkv://<dir>/surreal(持久) | mem://(测试) */
  url: string;
  namespace?: string;
  database?: string;
}

/** 打开一个嵌入式 SurrealDB 连接并选好 ns/db。调用方负责 close()。 */
export async function createSurrealConnection(opts: SurrealConnectionOptions): Promise<Surreal> {
  const db = new Surreal({ engines: { ...createRemoteEngines(), ...createNodeEngines() } });
  await db.connect(opts.url);
  await db.use({ namespace: opts.namespace ?? SURREAL_NS, database: opts.database ?? SURREAL_DB });
  return db;
}
```

- [ ] **Step 3: 写一个会失败的占位测试**

`packages/db/src/surreal/apply-schema.test.ts`：
```ts
import { describe, it, expect, afterEach } from "vitest";
import type { Surreal } from "surrealdb";
import { createSurrealConnection } from "./connect";
import { applySchema } from "./apply-schema";
import { EMBEDDING_DIMENSION } from "./constants";

let db: Surreal | undefined;
afterEach(async () => { await db?.close(); db = undefined; });

async function freshDb(): Promise<Surreal> {
  db = await createSurrealConnection({ url: "mem://" });
  return db;
}

describe("applySchema", () => {
  it("在空库上应用全部 migrations(返回已应用文件名)", async () => {
    const d = await freshDb();
    const applied = await applySchema(d);
    expect(applied).toEqual(["001_nodes.surql", "002_relations.surql", "003_index.surql"]);
  });
});
```

- [ ] **Step 4: 跑测试确认 RED**

Run:
```bash
npx vitest run packages/db/src/surreal/apply-schema.test.ts
```
Expected: FAIL，报无法解析 `./apply-schema`（模块还不存在）。

- [ ] **Step 5: Commit**

```bash
git add packages/db/src/surreal/constants.ts packages/db/src/surreal/connect.ts packages/db/src/surreal/apply-schema.test.ts
git commit -m "test(db): surreal connect + constants + failing applySchema test (RED)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task P0.2: 写 `001_nodes.surql`（节点表 + entity_kind）

**Files:**
- Create: `packages/db/src/surreal/migrations/001_nodes.surql`

- [ ] **Step 1: 写节点表 DDL**（字段以 `src/domain/types.ts` 真值为准，见 §0.3）

`packages/db/src/surreal/migrations/001_nodes.surql`：
```surql
-- P0 · 节点表(= EntityNode,spec 01 §2)。SCHEMAFULL,仅声明 P0 核心字段(枚举/关键标量/数组);
-- 其余领域字段在 P1(toRecord 落地)以增量 migration 004_* 补齐。所有 DEFINE 用 IF NOT EXISTS,可重复 apply。
-- 约定:领域实体的 string id 映射为 SurrealDB 记录 id(如 point:⟨id⟩),不单独声明 id 字段。

-- 元表:kind → 父类(治理/召回按父类批量遍历)
DEFINE TABLE IF NOT EXISTS entity_kind SCHEMAFULL;
DEFINE FIELD IF NOT EXISTS parent ON entity_kind TYPE string;

-- session(容器) — types.ts:586
DEFINE TABLE IF NOT EXISTS session SCHEMAFULL;
DEFINE FIELD IF NOT EXISTS title       ON session TYPE string;
DEFINE FIELD IF NOT EXISTS mode        ON session TYPE string ASSERT $value IN ['daily','decision','point','learning','organization','long-term'];
DEFINE FIELD IF NOT EXISTS strength    ON session TYPE string ASSERT $value IN ['gentle','standard','sharp'];
DEFINE FIELD IF NOT EXISTS status      ON session TYPE string ASSERT $value IN ['active','completed'];
DEFINE FIELD IF NOT EXISTS startedAt   ON session TYPE datetime DEFAULT time::now();
DEFINE FIELD IF NOT EXISTS completedAt ON session TYPE option<datetime>;

-- turn(Utterance,occurrent:只追加;冷层) — types.ts:251(字段名 timestamp,非 createdAt)
DEFINE TABLE IF NOT EXISTS turn SCHEMAFULL;
DEFINE FIELD IF NOT EXISTS sessionId ON turn TYPE string;
DEFINE FIELD IF NOT EXISTS role      ON turn TYPE string ASSERT $value IN ['user','assistant'];
DEFINE FIELD IF NOT EXISTS content   ON turn TYPE string;
DEFINE FIELD IF NOT EXISTS intent    ON turn TYPE option<string>;
DEFINE FIELD IF NOT EXISTS timestamp ON turn TYPE datetime DEFAULT time::now();

-- note(Distillation:DualTrackNote) — types.ts:657
DEFINE TABLE IF NOT EXISTS note SCHEMAFULL;
DEFINE FIELD IF NOT EXISTS sessionId    ON note TYPE string;
DEFINE FIELD IF NOT EXISTS title        ON note TYPE string;
DEFINE FIELD IF NOT EXISTS summary      ON note TYPE string;
DEFINE FIELD IF NOT EXISTS keyQuote     ON note TYPE string DEFAULT '';
DEFINE FIELD IF NOT EXISTS saidTrack    ON note TYPE array<string> DEFAULT [];
DEFINE FIELD IF NOT EXISTS learnedTrack ON note TYPE array<string> DEFAULT [];
DEFINE FIELD IF NOT EXISTS createdAt    ON note TYPE datetime DEFAULT time::now();

-- point(Distillation:PointAsset) — types.ts:697
DEFINE TABLE IF NOT EXISTS point SCHEMAFULL;
DEFINE FIELD IF NOT EXISTS title      ON point TYPE string;
DEFINE FIELD IF NOT EXISTS content    ON point TYPE string;
DEFINE FIELD IF NOT EXISTS status     ON point TYPE string ASSERT $value IN ['临时想法','稳定观点','被挑战中','已修正','已放弃'];
DEFINE FIELD IF NOT EXISTS confidence ON point TYPE string ASSERT $value IN ['用户确认','AI 推断','待验证'];
DEFINE FIELD IF NOT EXISTS important  ON point TYPE bool DEFAULT false;
DEFINE FIELD IF NOT EXISTS updatedAt  ON point TYPE datetime DEFAULT time::now();

-- decision(Distillation:DecisionAsset) — types.ts:726
DEFINE TABLE IF NOT EXISTS decision SCHEMAFULL;
DEFINE FIELD IF NOT EXISTS title              ON decision TYPE string;
DEFINE FIELD IF NOT EXISTS decisionKind       ON decision TYPE string ASSERT $value IN ['候选决策','用户决策'];
DEFINE FIELD IF NOT EXISTS confirmationStatus ON decision TYPE string ASSERT $value IN ['待用户确认','用户确认'];
DEFINE FIELD IF NOT EXISTS choice             ON decision TYPE string;
DEFINE FIELD IF NOT EXISTS status             ON decision TYPE string ASSERT $value IN ['待复盘','已复盘'];
DEFINE FIELD IF NOT EXISTS updatedAt          ON decision TYPE datetime DEFAULT time::now();

-- debt(Distillation:KnowledgeDebt) — types.ts:743
DEFINE TABLE IF NOT EXISTS debt SCHEMAFULL;
DEFINE FIELD IF NOT EXISTS concept   ON debt TYPE string;
DEFINE FIELD IF NOT EXISTS context   ON debt TYPE string DEFAULT '';
DEFINE FIELD IF NOT EXISTS status    ON debt TYPE string ASSERT $value IN ['待了解','能复述','已应用','不相关'];
DEFINE FIELD IF NOT EXISTS updatedAt ON debt TYPE datetime DEFAULT time::now();

-- question(Inquiry:QuestionAsset) — types.ts:712(字段名 question,非 text)
DEFINE TABLE IF NOT EXISTS question SCHEMAFULL;
DEFINE FIELD IF NOT EXISTS question     ON question TYPE string;
DEFINE FIELD IF NOT EXISTS whyImportant ON question TYPE string DEFAULT '';
DEFINE FIELD IF NOT EXISTS status       ON question TYPE string ASSERT $value IN ['开放','反复出现','正在聚焦','阶段性回答'];
DEFINE FIELD IF NOT EXISTS appearances  ON question TYPE int DEFAULT 0;
DEFINE FIELD IF NOT EXISTS updatedAt    ON question TYPE datetime DEFAULT time::now();

-- theme(Axis:LongTermTheme,反刚性聚合) — types.ts:758
DEFINE TABLE IF NOT EXISTS theme SCHEMAFULL;
DEFINE FIELD IF NOT EXISTS name                ON theme TYPE string;
DEFINE FIELD IF NOT EXISTS summary             ON theme TYPE string DEFAULT '';
DEFINE FIELD IF NOT EXISTS maturity            ON theme TYPE string ASSERT $value IN ['萌芽','重复','聚焦','成型','变化','关闭'];
DEFINE FIELD IF NOT EXISTS representativeQuote ON theme TYPE string DEFAULT '';
DEFINE FIELD IF NOT EXISTS appearances         ON theme TYPE int DEFAULT 0;
DEFINE FIELD IF NOT EXISTS updatedAt           ON theme TYPE datetime DEFAULT time::now();

-- memory(Memory:MemoryRecord) — types.ts:841(status=confirmed|deprecated|deleted;候选在 memory_candidate)
DEFINE TABLE IF NOT EXISTS memory SCHEMAFULL;
DEFINE FIELD IF NOT EXISTS text          ON memory TYPE string;
DEFINE FIELD IF NOT EXISTS status        ON memory TYPE string ASSERT $value IN ['confirmed','deprecated','deleted'];
DEFINE FIELD IF NOT EXISTS sourceType    ON memory TYPE string;
DEFINE FIELD IF NOT EXISTS sourceId      ON memory TYPE string;
DEFINE FIELD IF NOT EXISTS evidenceQuote ON memory TYPE string DEFAULT '';
DEFINE FIELD IF NOT EXISTS sensitivity   ON memory TYPE string DEFAULT 'normal' ASSERT $value IN ['normal','sensitive'];
DEFINE FIELD IF NOT EXISTS importance    ON memory TYPE option<int>;
DEFINE FIELD IF NOT EXISTS embedding     ON memory TYPE option<array<float>>;
DEFINE FIELD IF NOT EXISTS createdAt     ON memory TYPE datetime DEFAULT time::now();
DEFINE FIELD IF NOT EXISTS updatedAt     ON memory TYPE datetime DEFAULT time::now();

-- memory_candidate(Memory:MemoryCandidate) — types.ts:863
DEFINE TABLE IF NOT EXISTS memory_candidate SCHEMAFULL;
DEFINE FIELD IF NOT EXISTS text        ON memory_candidate TYPE string;
DEFINE FIELD IF NOT EXISTS status      ON memory_candidate TYPE string ASSERT $value IN ['pending','approved','rejected'];
DEFINE FIELD IF NOT EXISTS sourceType  ON memory_candidate TYPE string;
DEFINE FIELD IF NOT EXISTS sourceId    ON memory_candidate TYPE string;
DEFINE FIELD IF NOT EXISTS sensitivity ON memory_candidate TYPE string DEFAULT 'normal' ASSERT $value IN ['normal','sensitive'];
DEFINE FIELD IF NOT EXISTS reviewScore ON memory_candidate TYPE float DEFAULT 0;
DEFINE FIELD IF NOT EXISTS createdAt   ON memory_candidate TYPE datetime DEFAULT time::now();

-- material(External:ImportSource) — types.ts:1014(无 embedding!向量在 rag_chunk)
DEFINE TABLE IF NOT EXISTS material SCHEMAFULL;
DEFINE FIELD IF NOT EXISTS title       ON material TYPE string;
DEFINE FIELD IF NOT EXISTS sourceType  ON material TYPE string ASSERT $value IN ['text','webpage'];
DEFINE FIELD IF NOT EXISTS sourceUrl   ON material TYPE option<string>;
DEFINE FIELD IF NOT EXISTS content     ON material TYPE string;
DEFINE FIELD IF NOT EXISTS status      ON material TYPE string DEFAULT 'chunked' ASSERT $value IN ['chunked'];
DEFINE FIELD IF NOT EXISTS sensitivity ON material TYPE string DEFAULT 'normal' ASSERT $value IN ['normal','sensitive'];
DEFINE FIELD IF NOT EXISTS createdAt   ON material TYPE datetime DEFAULT time::now();

-- rag_chunk(External:RagChunk,派生、可重建) — types.ts:1030
DEFINE TABLE IF NOT EXISTS rag_chunk SCHEMAFULL;
DEFINE FIELD IF NOT EXISTS sourceId  ON rag_chunk TYPE string;
DEFINE FIELD IF NOT EXISTS title     ON rag_chunk TYPE string DEFAULT '';
DEFINE FIELD IF NOT EXISTS text      ON rag_chunk TYPE string;
DEFINE FIELD IF NOT EXISTS keywords  ON rag_chunk TYPE array<string> DEFAULT [];
DEFINE FIELD IF NOT EXISTS usage     ON rag_chunk TYPE string ASSERT $value IN ['interview-context','memory-candidate'];
DEFINE FIELD IF NOT EXISTS embedding ON rag_chunk TYPE option<array<float>>;
DEFINE FIELD IF NOT EXISTS createdAt ON rag_chunk TYPE datetime DEFAULT time::now();

-- search_brief(External:SearchBrief) — types.ts:971
DEFINE TABLE IF NOT EXISTS search_brief SCHEMAFULL;
DEFINE FIELD IF NOT EXISTS topic     ON search_brief TYPE string;
DEFINE FIELD IF NOT EXISTS provider  ON search_brief TYPE string;
DEFINE FIELD IF NOT EXISTS status    ON search_brief TYPE string ASSERT $value IN ['ready','needs-review'];
DEFINE FIELD IF NOT EXISTS summary   ON search_brief TYPE string DEFAULT '';
DEFINE FIELD IF NOT EXISTS createdAt ON search_brief TYPE datetime DEFAULT time::now();

-- 种子:kind → 父类(UPSERT 幂等)
UPSERT entity_kind:session          SET parent = 'Container';
UPSERT entity_kind:turn             SET parent = 'Utterance';
UPSERT entity_kind:note             SET parent = 'Distillation';
UPSERT entity_kind:point            SET parent = 'Distillation';
UPSERT entity_kind:decision         SET parent = 'Distillation';
UPSERT entity_kind:debt             SET parent = 'Distillation';
UPSERT entity_kind:question         SET parent = 'Inquiry';
UPSERT entity_kind:theme            SET parent = 'Axis';
UPSERT entity_kind:memory           SET parent = 'Memory';
UPSERT entity_kind:memory_candidate SET parent = 'Memory';
UPSERT entity_kind:material         SET parent = 'External';
UPSERT entity_kind:rag_chunk        SET parent = 'External';
UPSERT entity_kind:search_brief     SET parent = 'External';
```

- [ ] **Step 2: 暂不跑测试**（`apply-schema.ts` 尚未写；下个 Task 写完一起 GREEN）。先肉眼核对每个 `ASSERT` 的枚举与 §0.3 一致。

- [ ] **Step 3: Commit**

```bash
git add packages/db/src/surreal/migrations/001_nodes.surql
git commit -m "feat(db): P0 node tables migration (13 EntityKind tables + entity_kind meta)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task P0.3: 写 `002_relations.surql`（RELATE 边表 + provenance）

**Files:**
- Create: `packages/db/src/surreal/migrations/002_relations.surql`

- [ ] **Step 1: 写边表 DDL**

`packages/db/src/surreal/migrations/002_relations.surql`：
```surql
-- P0 · 关系边(= Relation 三元组,spec 01 §3)。统一吞掉三套旧编码(EvidenceAnchor/relatedThemeIds/MemoryEdge)。
-- TYPE RELATION:边本身是记录、可带字段(= Provenance)。P0 不约束 IN/OUT 端类型(P1 视需要收紧)。

-- derived_from: CognitiveEntity → turn(PROV-O wasDerivedFrom),边上挂溯源
DEFINE TABLE IF NOT EXISTS derived_from SCHEMAFULL TYPE RELATION;
DEFINE FIELD IF NOT EXISTS provenance        ON derived_from FLEXIBLE TYPE object;
DEFINE FIELD IF NOT EXISTS provenance.origin ON derived_from TYPE string
  ASSERT $value IN ['llm_extracted','user_confirmed','heuristic','imported','seed'];

-- belongs_to_theme: Distillation/Inquiry → theme(RDFS domain/range)
DEFINE TABLE IF NOT EXISTS belongs_to_theme SCHEMAFULL TYPE RELATION;
DEFINE FIELD IF NOT EXISTS weight ON belongs_to_theme TYPE option<float>;

-- about_theme: memory → theme(统一掉 MemoryEdge 双轨)
DEFINE TABLE IF NOT EXISTS about_theme SCHEMAFULL TYPE RELATION;

-- promoted_from: question → note(functional)
DEFINE TABLE IF NOT EXISTS promoted_from SCHEMAFULL TYPE RELATION;

-- part_of: turn → session(Mereology)
DEFINE TABLE IF NOT EXISTS part_of SCHEMAFULL TYPE RELATION;

-- corrects: memory_correction → memory
DEFINE TABLE IF NOT EXISTS corrects SCHEMAFULL TYPE RELATION;

-- contradicts: point ↔ point(symmetric,推理层检出,新能力)
DEFINE TABLE IF NOT EXISTS contradicts SCHEMAFULL TYPE RELATION;

-- evolves_into: theme(t) → theme(t+1)(时序演化)
DEFINE TABLE IF NOT EXISTS evolves_into SCHEMAFULL TYPE RELATION;
```

- [ ] **Step 2: Commit**

```bash
git add packages/db/src/surreal/migrations/002_relations.surql
git commit -m "feat(db): P0 relation edges migration (8 RELATE tables + derived_from provenance)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task P0.4: 写 `003_index.surql`（HNSW + BM25）

**Files:**
- Create: `packages/db/src/surreal/migrations/003_index.surql`

- [ ] **Step 1: 写索引 DDL**（维度 = `EMBEDDING_DIMENSION` = 1024；仅 memory/rag_chunk 有 embedding）

`packages/db/src/surreal/migrations/003_index.surql`：
```surql
-- P0 · 向量(HNSW)+ 全文(BM25)索引(spec 01 §4)。
-- 维度 1024 = text-embedding-v3 默认(S0/S5 确认);必须与 constants.ts EMBEDDING_DIMENSION 一致(测试守卫)。
-- 仅 memory/rag_chunk 有 embedding(material 无 — 已据 types.ts 删除 spec 的 material_emb)。
-- 若 S0/S2 判定 HNSW 不可用 → 删本文件的 DEFINE INDEX ... HNSW 两行,向量留 JS 余弦;S0/S3 全文不可用同理删 BM25 两行。

DEFINE INDEX IF NOT EXISTS memory_emb ON memory    FIELDS embedding HNSW DIMENSION 1024 DIST COSINE;
DEFINE INDEX IF NOT EXISTS rag_emb    ON rag_chunk FIELDS embedding HNSW DIMENSION 1024 DIST COSINE;

DEFINE ANALYZER IF NOT EXISTS zh TOKENIZERS class FILTERS lowercase;
DEFINE INDEX IF NOT EXISTS memory_ft ON memory    FIELDS text SEARCH ANALYZER zh BM25;
DEFINE INDEX IF NOT EXISTS rag_ft    ON rag_chunk FIELDS text SEARCH ANALYZER zh BM25;
```
> 备注：`zh` 用 `class` tokenizer 对中文是字符类切分（非分词），BM25 召回质量在 P2 再评估（可能换 ngram）；P0 只需索引能 DEFINE 成功并建起来。

- [ ] **Step 2: Commit**

```bash
git add packages/db/src/surreal/migrations/003_index.surql
git commit -m "feat(db): P0 vector(HNSW) + fulltext(BM25) indexes migration

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task P0.5: 写 `applySchema()`（幂等账本）让首测 GREEN

**Files:**
- Create: `packages/db/src/surreal/apply-schema.ts`

- [ ] **Step 1: 实现 applySchema**（`db.query` 返回形状以 S0 spike 锁定的为准）

`packages/db/src/surreal/apply-schema.ts`：
```ts
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Surreal } from "surrealdb";

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "migrations");

interface MigrationRow { name: string; }

/**
 * 幂等应用 migrations/*.surql:用 _migration 账本表跳过已应用文件,
 * 文件内 DDL 自身也用 IF NOT EXISTS(双层幂等)。返回本次新应用的文件名(已应用则空数组)。
 */
export async function applySchema(db: Surreal): Promise<string[]> {
  await db.query(`
    DEFINE TABLE IF NOT EXISTS _migration SCHEMAFULL;
    DEFINE FIELD IF NOT EXISTS name      ON _migration TYPE string;
    DEFINE FIELD IF NOT EXISTS appliedAt ON _migration TYPE datetime DEFAULT time::now();
  `);

  const [appliedRows] = await db.query<[MigrationRow[]]>("SELECT name FROM _migration;");
  const applied = new Set((appliedRows ?? []).map((r) => r.name));

  const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".surql")).sort();
  const newlyApplied: string[] = [];
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = readFileSync(join(MIGRATIONS_DIR, file), "utf8");
    await db.query(sql);
    await db.query("CREATE _migration SET name = $name;", { name: file });
    newlyApplied.push(file);
  }
  return newlyApplied;
}
```

- [ ] **Step 2: 跑首测确认 GREEN**

Run:
```bash
npx vitest run packages/db/src/surreal/apply-schema.test.ts
```
Expected: PASS（`applied` == `["001_nodes.surql","002_relations.surql","003_index.surql"]`）。
- 若报 `db.query<...>` 泛型/解构与实际返回不符：按 S0 锁定的真实返回形状调整 `applySchema` 的解构（这正是 S0 先行的意义）。

- [ ] **Step 3: Commit**

```bash
git add packages/db/src/surreal/apply-schema.ts
git commit -m "feat(db): idempotent applySchema via _migration ledger (first test GREEN)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task P0.6: 自测——幂等 / INFO 齐全 / 维度守卫（RED→GREEN）

**Files:**
- Modify: `packages/db/src/surreal/apply-schema.test.ts`

- [ ] **Step 1: 追加测试（幂等、INFO 断言、维度守卫）**

在 `apply-schema.test.ts` 的 `describe` 内追加：
```ts
  it("二次 apply 幂等:不报错、不重复、INFO 不变", async () => {
    const d = await freshDb();
    await applySchema(d);
    const second = await applySchema(d);
    expect(second).toEqual([]); // 全部已应用
    const [ledger] = await d.query<[{ name: string }[]]>("SELECT name FROM _migration;");
    const names = (ledger ?? []).map((r) => r.name).sort();
    expect(names).toEqual(["001_nodes.surql", "002_relations.surql", "003_index.surql"]);
  });

  it("INFO FOR DB:13 节点表 + entity_kind + 8 边表齐全", async () => {
    const d = await freshDb();
    await applySchema(d);
    const [info] = await d.query<[{ tables: Record<string, unknown> }]>("INFO FOR DB;");
    const tables = Object.keys(info?.tables ?? {});
    for (const t of [
      "entity_kind","session","turn","note","point","decision","debt","question",
      "theme","memory","memory_candidate","material","rag_chunk","search_brief",
      "derived_from","belongs_to_theme","about_theme","promoted_from","part_of",
      "corrects","contradicts","evolves_into",
    ]) {
      expect(tables, `缺表 ${t}`).toContain(t);
    }
  });

  it("INFO FOR TABLE:关键字段与索引存在", async () => {
    const d = await freshDb();
    await applySchema(d);
    const [pointInfo] = await d.query<[{ fields: Record<string, string> }]>("INFO FOR TABLE point;");
    expect(Object.keys(pointInfo?.fields ?? {})).toContain("status");
    const [memInfo] = await d.query<[{ indexes: Record<string, string> }]>("INFO FOR TABLE memory;");
    const idxNames = Object.keys(memInfo?.indexes ?? {});
    expect(idxNames).toContain("memory_emb");
    expect(idxNames).toContain("memory_ft");
  });

  it("HNSW 维度 == EMBEDDING_DIMENSION(防 DDL 与常量漂移)", async () => {
    const d = await freshDb();
    await applySchema(d);
    const [memInfo] = await d.query<[{ indexes: Record<string, string> }]>("INFO FOR TABLE memory;");
    const def = String(memInfo?.indexes?.memory_emb ?? "");
    expect(def).toContain(`DIMENSION ${EMBEDDING_DIMENSION}`);
  });
```
> `INFO FOR DB/TABLE` 的返回字段名（`tables`/`fields`/`indexes`）以 SurrealDB v2.x 为准；若 S0 实测的键名不同，按实测调整断言取值路径（这也是 S0 的产物之一）。

- [ ] **Step 2: 跑测试**

Run:
```bash
npx vitest run packages/db/src/surreal/apply-schema.test.ts
```
Expected: 全部 PASS。若 INFO 结构键名不符 → 按 S0 实测修正断言路径后再跑。

- [ ] **Step 3: Commit**

```bash
git add packages/db/src/surreal/apply-schema.test.ts
git commit -m "test(db): schema self-checks — idempotency, INFO completeness, dimension guard

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task P0.7: 自测——ASSERT 拒非法 + 边语义冒烟（RED→GREEN）

**Files:**
- Modify: `packages/db/src/surreal/apply-schema.test.ts`

- [ ] **Step 1: 追加测试（非法枚举被拒、合法放行、RELATE 双向遍历、provenance 往返）**

在 `describe` 内追加：
```ts
  it("ASSERT 拒非法 status,放行合法值", async () => {
    const d = await freshDb();
    await applySchema(d);
    // 非法 point.status 被拒
    await expect(
      d.query("CREATE point:bad SET title='x', content='y', status='不存在的状态', confidence='待验证';")
    ).rejects.toThrow();
    // 合法值放行
    const [rows] = await d.query<[{ id: unknown }[]]>(
      "CREATE point:good SET title='x', content='y', status='稳定观点', confidence='用户确认';"
    );
    expect((rows ?? []).length).toBe(1);
  });

  it("derived_from.provenance.origin ASSERT 生效", async () => {
    const d = await freshDb();
    await applySchema(d);
    await d.query("CREATE point:p1 SET title='t', content='c', status='临时想法', confidence='待验证';");
    await d.query("CREATE turn:t1 SET sessionId='s1', role='user', content='原话';");
    // 非法 origin 被拒
    await expect(
      d.query("RELATE point:p1->derived_from->turn:t1 SET provenance = { origin: 'bogus' };")
    ).rejects.toThrow();
    // 合法 origin:边建成且可读回 provenance
    await d.query("RELATE point:p1->derived_from->turn:t1 SET provenance = { origin: 'llm_extracted', turnId: 't1', confidence: 0.9 };");
    const [prov] = await d.query<[{ provenance: { origin: string } }[]]>(
      "SELECT provenance FROM derived_from;"
    );
    expect(prov?.[0]?.provenance?.origin).toBe("llm_extracted");
  });

  it("belongs_to_theme 双向图遍历(根治“召回漏类”的图模型基础)", async () => {
    const d = await freshDb();
    await applySchema(d);
    await d.query("CREATE theme:放权 SET name='放权', maturity='聚焦';");
    await d.query("CREATE point:p2 SET title='t', content='c', status='稳定观点', confidence='用户确认';");
    await d.query("CREATE decision:d1 SET title='t', decisionKind='用户决策', confirmationStatus='用户确认', choice='c', status='待复盘';");
    await d.query("RELATE point:p2->belongs_to_theme->theme:放权;");
    await d.query("RELATE decision:d1->belongs_to_theme->theme:放权;");
    // 出边:point → theme
    const [out] = await d.query<[{ themes: unknown[] }[]]>(
      "SELECT ->belongs_to_theme->theme AS themes FROM point:p2;"
    );
    expect((out?.[0]?.themes ?? []).length).toBe(1);
    // 入边:theme ← (point + decision) 一次拿全
    const [pts] = await d.query<[unknown[]]>("SELECT VALUE <-belongs_to_theme<-point FROM theme:放权;");
    const [decs] = await d.query<[unknown[]]>("SELECT VALUE <-belongs_to_theme<-decision FROM theme:放权;");
    expect((pts?.[0] ?? []).length).toBe(1);
    expect((decs?.[0] ?? []).length).toBe(1);
  });
```
> RELATE/遍历的确切语法与 `SELECT VALUE <-edge<-tbl` 的返回形状以 S0 spike 锁定的为准；若 S0 记录的写法不同，按实测对齐。

- [ ] **Step 2: 跑全部 schema 测试**

Run:
```bash
npx vitest run packages/db/src/surreal/
```
Expected: 全部 PASS（幂等 / INFO / 维度 / ASSERT / provenance / 图遍历）。

- [ ] **Step 3: 回归——确认未碰既有测试与类型**

Run:
```bash
npx vitest run && npm run typecheck
```
Expected: 既有 960 测试仍全绿（新增 surreal 测试一并通过）；typecheck 无新错。
- 若 typecheck 因 `surrealdb` 类型在 `packages/db` 解析问题报错：确认两包已正确安装（S0.1）；`packages/db` 经相对路径被 `apps/api`/根编译收集，必要时按既有 sqlite repo 的 import 风格对齐。**不得**为消错改动域层或既有测试。

- [ ] **Step 4: Commit**

```bash
git add packages/db/src/surreal/apply-schema.test.ts
git commit -m "test(db): ASSERT rejection + RELATE edge-traversal + provenance smoke (P0 gate green)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## 2. P0 阶段门（spec 00 §5 / spec 06 §1）

P0 完成的判据（全部满足才算过门）：
- [ ] `npx vitest run packages/db/src/surreal/` 全绿：幂等、INFO 表/字段/索引齐全、维度守卫、ASSERT 拒非法、provenance 往返、图遍历双向。
- [ ] `npx vitest run`（全量）既有 960 测试不受影响、仍全绿。
- [ ] `npm run typecheck` 无新错。
- [ ] 三个 migration 文件存在且枚举值与 `src/domain/types.ts` 一致（§0.3 表已核对）。
- [ ] S0 五项 spike 结论已记录进 spec 06。
- [ ] SurrealDB **未**接入运行时（`server.ts` 未改）；域层 148 纯函数未改。

过门后即可开下一份 plan：**P1 / spec 02**（`SurrealStore` 实现 `ProductStateRepository` + 整状态 ⇄ 节点/边映射 + 双写/影子读）。

---

## 3. 自查（writing-plans Self-Review，已执行）

- **Spec 覆盖**：S0 ← spec 05 §3（S1–S5）；P0 ← spec 01 §6（T1 migrations / T2 幂等 / T3 自测 / T4 维度 / T5 边冒烟）。spec 02/03/04/06 的实施**显式划出本阶段范围**（§0.4），仅 spec 06 的 S0 勾稽在 S0.3 完成。
- **占位扫描**：无 TBD/“类似上文”；所有 DDL、TS、测试、命令均为完整内容。唯一“以实测为准”的点（`db.query` 返回形状、`INFO` 键名、RELATE 语法）已显式标注为 S0 的产物，并给出文档默认形态作为起点——这是 spike 的本质，非占位。
- **类型一致**：`EMBEDDING_DIMENSION`(constants.ts) ↔ `003_index.surql` 的 `DIMENSION 1024` 由 P0.6 维度守卫绑定；`createSurrealConnection`/`applySchema` 签名在 connect.ts/apply-schema.ts 定义、在 apply-schema.test.ts 一致调用；migration 文件名三处（测试断言、账本、目录）一致。
- **与 spec 的偏差**已在 §0.3 列明并说明理由（spec 示意枚举 vs types.ts 真值；material 无 embedding）。

---

## 4. 执行交接

**Plan complete and saved to `docs/superpowers/plans/2026-06-27-surreal-ontology-s0-p0.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — 每个 Task 派新 subagent，Task 间 review，快速迭代（REQUIRED SUB-SKILL: superpowers:subagent-driven-development）。

**2. Inline Execution** — 本会话内按批执行，带 checkpoint review（REQUIRED SUB-SKILL: superpowers:executing-plans）。

**Which approach?**
