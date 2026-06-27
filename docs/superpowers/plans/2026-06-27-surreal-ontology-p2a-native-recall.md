# SurrealDB × 本体论 · P2a 原生召回方法 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 SurrealStore 上新增**原生召回方法**——图遍历(主题聚合"谁指向某主题"含 decisions、溯源 derived_from→turn)+ 记忆 HNSW 向量召回(带 A4 敏感/状态门控)——把 spec 04 的原生召回能力做成可测的一等方法;**additive、域层纯函数与既有测试不动**,接线进 context-pack/路由留 P2b。

**Architecture:** 召回当前是域层纯函数(`collectRelevantMemories` @ `src/domain/context-pack.ts:757`,内存 `ProductState` 上手工列举 25 数组 + JS 余弦)。P2a **不改它**——而是在 `SurrealRepoHandle`(surreal 专属句柄,非基础接口)上加异步方法 `recallThemeAssets`/`recallProvenanceTurns`/`recallMemoriesByVector`,直接查 SurrealDB 的边(P1b 已落)与 HNSW 索引(P0 已建)。这些方法是"原生召回工具箱",P2b 再让 context-pack/路由在 surreal 权威时改用它(域层保留为 sqlite 回落)。

**Tech Stack:** 同前;复用 P1b 落的边(belongs_to_theme/about_theme/derived_from)、P0 的 HNSW 索引(memory_emb,DIMENSION 1024)+ `EMBEDDING_DIMENSION`(constants.ts)。

---

## 0. 上下文与护栏
- **域层纯函数与既有测试不动**:`collectRelevantMemories`/context-pack/`src/domain/vector.ts` 保持原样(它们是 sqlite/默认路径的召回)。P2a 只在 surreal repo 加新方法。
- **默认存储不变(sqlite)**;新方法仅 `SurrealRepoHandle` 暴露(基础 `ProductStateRepository` 无),按基础接口写的生产代码看不到、不受影响。
- **只读**:新方法都是查询,不写库。
- 隔离 worktree 执行;绝不 `git add -A`。
- A4 门控(spec 04 §3):向量召回默认只返回 `status='confirmed'` 且 `sensitivity='normal'` 的记忆;`includeSensitive` 开时才含 sensitive(对齐 context-pack 现行过滤)。

### 关键事实(承接前阶段)
- 边已在库(P1b persist):`belongs_to_theme`(各资产→theme)、`about_theme`(memory→theme)、`derived_from`(资产→turn,带 provenance)。图遍历查这些边即可。
- `memory` 表有 `embedding`(core 字段,P1a)+ HNSW 索引 `memory_emb`(003,DIMENSION 1024,COSINE)。记忆带 embedding 时 persist 会落,KNN 可查。**P2a 是首个对真实持久化 embedding 跑 HNSW KNN 的测试**(S0 只在 dim3 throwaway 验过)。
- record id:领域 id 是 ASCII(makeId);`recordIdToDomainId` 已能从 RecordId 对象取 id。
- 3.x 校正点(实现时按真实引擎坐实,给 fallback):① KNN 算子 `embedding <|K,EF|> $q` 与 `WHERE status=... AND ...` 布尔条件组合的写法;② `vector::similarity::cosine(embedding,$q)` 排序;③ 图遍历 `SELECT VALUE <-belongs_to_theme<-point FROM theme:⟨id⟩` 的返回形状(P1b 已用 `const [rows]=...`)。

---

## 1. 文件结构
```
packages/db/src/surreal/
  surreal-product-state-repository.ts        # 改:SurrealRepoHandle 加 3 个召回方法 + 实现
  surreal-recall.test.ts                     # 新:图遍历召回 + 溯源 + 向量召回 + A4 门控 测试
```

---

## 2. 任务

### Task 1: `recallThemeAssets` + `recallProvenanceTurns`(图遍历)+ 测试

**Files:**
- Modify: `packages/db/src/surreal/surreal-product-state-repository.ts`（`SurrealRepoHandle` 接口 + 返回对象)
- Create: `packages/db/src/surreal/surreal-recall.test.ts`

- [ ] **Step 1: 写失败测试(RED)**

`packages/db/src/surreal/surreal-recall.test.ts`:
```ts
import { describe, it, expect, afterEach } from "vitest";
import { createInitialProductState } from "../../../../src/domain/engine";
import { createSurrealProductStateRepository, type SurrealRepoHandle } from "./surreal-product-state-repository";

const open: SurrealRepoHandle[] = [];
afterEach(async () => { for (const r of open) await r.close(); open.length = 0; });
async function makeMem(): Promise<SurrealRepoHandle> {
  const r = await createSurrealProductStateRepository({ url: "mem://" }); open.push(r); return r;
}

function linkedState() {
  const base = createInitialProductState();
  return { ...base,
    themes: [{ id: "th_1", name: "放权", summary: "", maturity: "聚焦" as const, representativeQuote: "", appearances: 1, nextQuestion: "", updatedAt: "2026-06-27T00:00:00.000Z" }],
    sessions: [{ ...base.sessions[0], id: "se_1", turns: [{ id: "tu_1", role: "user" as const, content: "原话", intent: "", timestamp: "2026-06-27T00:00:00.000Z" }] }],
    points: [{ id: "pt_1", title: "观点", content: "c", status: "稳定观点" as const, confidence: "用户确认" as const, evidence: [], relatedThemeIds: ["th_1"], important: false, updatedAt: "2026-06-27T00:00:00.000Z", evidenceAnchors: [{ sessionId: "se_1", turnId: "tu_1" }] }],
    decisions: [{ id: "de_1", title: "决策", decisionKind: "用户决策" as const, confirmationStatus: "用户确认" as const, choice: "c", tradeOff: "", riskHypothesis: "", reviewAt: "", status: "待复盘" as const, updatedAt: "2026-06-27T00:00:00.000Z", relatedThemeIds: ["th_1"] }],
    questions: [{ id: "qu_1", question: "q", whyImportant: "", status: "开放" as const, appearances: 1, relatedThemeIds: ["th_1"], nextPrompt: "", important: false, updatedAt: "2026-06-27T00:00:00.000Z" }],
    memoryRecords: [{ id: "me_1", text: "记忆", status: "confirmed" as const, sourceType: "profile" as const, sourceId: "p", evidenceQuote: "", sensitivity: "normal" as const, createdAt: "2026-06-27T00:00:00.000Z", updatedAt: "2026-06-27T00:00:00.000Z" }],
    memoryEdges: [{ fromMemoryRecordId: "me_1", themeId: "th_1" }]
  };
}

describe("surreal native recall: 图遍历", () => {
  it("recallThemeAssets:一次拿全 point+decision+question+memory(含曾漏 decisions)", async () => {
    const repo = await makeMem();
    repo.replaceState(linkedState());
    await repo.flush();
    const r = await repo.recallThemeAssets("th_1");
    expect(r.points).toContain("pt_1");
    expect(r.decisions).toContain("de_1");   // 曾漏 decisions:图模型下天然覆盖
    expect(r.questions).toContain("qu_1");
    expect(r.memories).toContain("me_1");     // about_theme
  });

  it("recallProvenanceTurns:沿 derived_from 取证据 turn", async () => {
    const repo = await makeMem();
    repo.replaceState(linkedState());
    await repo.flush();
    const turns = await repo.recallProvenanceTurns("point", "pt_1");
    expect(turns.map((t) => t.id)).toContain("tu_1");
    expect(turns[0]?.content).toBe("原话");
  });
});
```

- [ ] **Step 2: 跑确认 RED**
Run: `npx vitest run packages/db/src/surreal/surreal-recall.test.ts`
Expected: FAIL（`recallThemeAssets` 不存在）。

- [ ] **Step 3: 实现(接口 + 方法)**

在 `surreal-product-state-repository.ts` 的 `SurrealRepoHandle` 接口加:
```ts
  /** 主题聚合:指向该 theme 的所有资产 id(图入边,含曾漏 decisions)。仅 surreal。 */
  recallThemeAssets(themeId: string): Promise<{ points: string[]; decisions: string[]; questions: string[]; memories: string[] }>;
  /** 溯源:沿 derived_from 取某资产的证据 turn。 */
  recallProvenanceTurns(table: string, id: string): Promise<Array<{ id: string; content: string; sessionId: string; role: string }>>;
```
在返回对象里(`query` 方法附近)加实现:
```ts
    async recallThemeAssets(themeId: string) {
      const t = new RecordId("theme", themeId);
      const pick = async (sql: string): Promise<string[]> => {
        const [rows] = await db.query<[unknown[]]>(sql, { t });
        const arr = (rows?.[0] as Array<unknown> | undefined) ?? [];
        return arr.map((r) => recordIdToDomainId((r as { id?: unknown })?.id ?? r));
      };
      const [points, decisions, questions, memories] = await Promise.all([
        pick("SELECT VALUE <-belongs_to_theme<-point FROM $t;"),
        pick("SELECT VALUE <-belongs_to_theme<-decision FROM $t;"),
        pick("SELECT VALUE <-belongs_to_theme<-question FROM $t;"),
        pick("SELECT VALUE <-about_theme<-memory FROM $t;")
      ]);
      return { points, decisions, questions, memories };
    },
    async recallProvenanceTurns(table: string, id: string) {
      const from = new RecordId(table, id);
      const [rows] = await db.query<[Array<Record<string, unknown>>]>(
        "SELECT VALUE ->derived_from->turn.* FROM $from;", { from }
      );
      const turns = (rows?.[0] as Array<Record<string, unknown>> | undefined) ?? [];
      return turns.map((t) => ({
        id: recordIdToDomainId(t.id), content: String(t.content ?? ""),
        sessionId: String(t.sessionId ?? ""), role: String(t.role ?? "")
      }));
    },
```
> 校正点:`SELECT VALUE <-belongs_to_theme<-point FROM $t` 的返回——P1b 集成测试已用同形 traversal(`const [rows]=...`,`rows[0]` 是数组),沿用;若 `$t`(RecordId 参数)在 FROM 位置不被接受,fallback 用 `type::record('theme',$id)`。`->derived_from->turn.*` 取 turn 全字段。

- [ ] **Step 4: 跑确认 GREEN**
Run: `npx vitest run packages/db/src/surreal/surreal-recall.test.ts`
Expected: PASS。

- [ ] **Step 5: Commit**
```bash
git add packages/db/src/surreal/surreal-product-state-repository.ts packages/db/src/surreal/surreal-recall.test.ts
git commit -m "feat(db): SurrealStore 原生图遍历召回(主题聚合含 decisions + derived_from 溯源)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: `recallMemoriesByVector`(HNSW)+ A4 门控 + 测试

**Files:**
- Modify: `packages/db/src/surreal/surreal-product-state-repository.ts`
- Modify: `packages/db/src/surreal/surreal-recall.test.ts`

- [ ] **Step 1: 写失败测试(RED)**

在 `surreal-recall.test.ts` 追加:
```ts
import { EMBEDDING_DIMENSION } from "./constants";

function memWithEmbedding(id: string, text: string, vec: number[], opts: { sensitivity?: "normal" | "sensitive"; status?: "confirmed" | "deprecated" } = {}) {
  return { id, text, status: (opts.status ?? "confirmed") as const, sourceType: "profile" as const, sourceId: "p",
    evidenceQuote: "", sensitivity: (opts.sensitivity ?? "normal") as const, embedding: vec,
    createdAt: "2026-06-27T00:00:00.000Z", updatedAt: "2026-06-27T00:00:00.000Z" };
}
// 造 DIMENSION 维向量:第 0 位置不同以区分方向。
function vec(seed: number): number[] { const v = new Array(EMBEDDING_DIMENSION).fill(0); v[0] = seed; v[1] = 1; return v; }

describe("surreal native recall: 向量 HNSW + A4 门控", () => {
  it("recallMemoriesByVector:返回余弦最近的 confirmed/normal 记忆", async () => {
    const repo = await makeMem();
    const base = createInitialProductState();
    repo.replaceState({ ...base, memoryRecords: [
      memWithEmbedding("me_near", "近", vec(1)),
      memWithEmbedding("me_far", "远", vec(-1))
    ] });
    await repo.flush();
    const hits = await repo.recallMemoriesByVector(vec(1), 1);
    expect(hits.map((h) => h.id)).toEqual(["me_near"]);
  });

  it("A4 门控:默认不返回 sensitive / 非 confirmed;includeSensitive 才含 sensitive", async () => {
    const repo = await makeMem();
    const base = createInitialProductState();
    repo.replaceState({ ...base, memoryRecords: [
      memWithEmbedding("me_norm", "普通", vec(1)),
      memWithEmbedding("me_sens", "敏感", vec(1), { sensitivity: "sensitive" }),
      memWithEmbedding("me_dep", "弃用", vec(1), { status: "deprecated" })
    ] });
    await repo.flush();
    const def = await repo.recallMemoriesByVector(vec(1), 10);
    expect(def.map((h) => h.id).sort()).toEqual(["me_norm"]);           // 仅 confirmed+normal
    const withSens = await repo.recallMemoriesByVector(vec(1), 10, { includeSensitive: true });
    expect(withSens.map((h) => h.id).sort()).toEqual(["me_norm", "me_sens"]); // 含 sensitive,仍不含 deprecated
  });
});
```

- [ ] **Step 2: 跑确认 RED**
Run: `npx vitest run packages/db/src/surreal/surreal-recall.test.ts`
Expected: FAIL（`recallMemoriesByVector` 不存在）。

- [ ] **Step 3: 实现**

`SurrealRepoHandle` 接口加:
```ts
  /** 记忆向量召回(HNSW KNN + 余弦)。A4 门控:默认仅 confirmed+normal;includeSensitive 含 sensitive。 */
  recallMemoriesByVector(embedding: number[], k: number, opts?: { includeSensitive?: boolean }): Promise<Array<{ id: string; text: string }>>;
```
返回对象里加:
```ts
    async recallMemoriesByVector(embedding: number[], k: number, recallOpts?: { includeSensitive?: boolean }) {
      const includeSensitive = recallOpts?.includeSensitive ?? false;
      // A4:status='confirmed' 必须;sensitivity 默认仅 normal。KNN <|k,ef|>,余弦降序。
      const ef = Math.max(k * 4, 40);
      const [rows] = await db.query<[Array<Record<string, unknown>>]>(
        `SELECT id, text FROM memory
           WHERE status = 'confirmed'
             AND (sensitivity = 'normal' OR $includeSensitive)
             AND embedding <|${k},${ef}|> $q
           ORDER BY vector::similarity::cosine(embedding, $q) DESC;`,
        { q: embedding, includeSensitive }
      );
      const hits = (rows ?? []) as Array<{ id: unknown; text: unknown }>;
      return hits.map((h) => ({ id: recordIdToDomainId(h.id), text: String(h.text ?? "") }));
    },
```
> 校正点(按真实 3.x 引擎坐实,给 fallback):① `<|k,ef|>` 与 `WHERE status=... AND (...)` 组合——若引擎要求 KNN 算子单独/特定位置,改为先 KNN 子查询再过滤,或用 `WHERE ... AND embedding <|k,ef|> $q`(spec 04 §3 形态);② `<|${k},${ef}|>` 用字面量插值(k/ef 是内部整数,非用户输入,无注入面);③ 若 `vector::similarity::cosine` 排序与 KNN 重复/报错,去掉 ORDER BY(KNN 已近似有序)。② A4 的 `status` 还有 'deleted',默认 WHERE 已排除(只取 confirmed)。

- [ ] **Step 4: 跑确认 GREEN**
Run: `npx vitest run packages/db/src/surreal/surreal-recall.test.ts`
Expected: PASS(向量最近邻 + A4 门控)。
> 若 HNSW 对真实 1024 维持久化 embedding 行为与 throwaway 不同(如需 reindex、或 option 字段未入索引),按引擎实测调整;这是 P2a 要验证的真问题之一。

- [ ] **Step 5: Commit**
```bash
git add packages/db/src/surreal/surreal-product-state-repository.ts packages/db/src/surreal/surreal-recall.test.ts
git commit -m "feat(db): SurrealStore 记忆 HNSW 向量召回 + A4 敏感/状态门控

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: 全量回归 + typecheck

- [ ] **Step 1: 全量 + typecheck**
Run:
```bash
npm run typecheck && npx vitest run
```
Expected: typecheck 绿;vitest 在 P1c 基线(1000 passed | 6 skipped)之上净增召回测试,全绿、零回归。粘贴 summary。

- [ ] **Step 2: 确认域层未动**
Run: `git diff e9191199..HEAD --stat`
Expected: 仅 `packages/db/src/surreal/` 两文件改动;`src/domain/**`、既有测试、默认路径零改动。

- [ ] **Step 3: Commit**（通常无新改动）

---

## 3. P2a 阶段门
- [ ] `recallThemeAssets` 一次拿全 point/decision/question/memory(含 decisions 回归);`recallProvenanceTurns` 沿 derived_from 取 turn。
- [ ] `recallMemoriesByVector` HNSW 返回余弦最近;A4 门控(默认 confirmed+normal,includeSensitive 含 sensitive,永不含 deprecated/deleted)。
- [ ] 域层纯函数 / 既有测试 / 默认 sqlite 路径未动;全量 ≥1000、零回归;typecheck 绿。

## 4. 不在本计划(P2b/后续)
- 把 context-pack 的 `collectRelevantMemories` / 路由召回在 **surreal 权威时**改用这些原生方法(域层保留为 sqlite 回落)——需路由分支 + 可能的 async 化,是 P2 的"消费"阶段。
- chat/RAG 混合检索(rag_chunk 向量 + BM25 + `search::rrf()`)——需 rag_chunk embedding 落地 + RRF,单独排。
- `evolves_into` 主题演化时间线(新能力)。
- P3 公理落 DB。

## 5. 自查(已执行)
- **Spec 覆盖**:spec 04 §2(图遍历主题聚合"谁指向放权"含 decisions = recallThemeAssets;溯源 ->derived_from->turn = recallProvenanceTurns)、§3(记忆 HNSW + A4 门控 = recallMemoriesByVector)。§4 RAG 混合、§5 下线手工列举(消费侧)显式划到 P2b。
- **占位扫描**:无;方法实现/测试/命令均完整;3.x KNN 组合与 traversal 返回形状的 fallback 是实测项,非占位。
- **类型一致**:`recallThemeAssets`/`recallProvenanceTurns`/`recallMemoriesByVector` 接口签名与实现/测试一致;`recordIdToDomainId`/`RecordId`/`EMBEDDING_DIMENSION` 复用既有;A4 门控参数 `includeSensitive` 三处一致。

## 6. 执行交接
**1. Subagent-Driven (recommended)** — 每 Task 派子代理 + 两阶段 review。
**2. Inline Execution** — 批执行 + checkpoint。
**Which approach?**
