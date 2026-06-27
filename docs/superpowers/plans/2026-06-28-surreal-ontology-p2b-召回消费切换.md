# SurrealDB × 本体论 · P2b 召回消费切换 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** surreal 权威(`surreal`/`dual-surreal`)时,专访召回真正消费 P2a 原生方法(图遍历主题资产 + HNSW 记忆 + 溯源 turn),sqlite/默认/前端回落到现有域层纯函数、行为零变化。

**Architecture:** server route(已 async)在调用域函数前 `await` 原生召回、组装成纯数据 `RecallResult` 传入;域函数**保持同步签名**、加可选 `recall?` 参数(有则用、无则回落)。域层不依赖 repo(只读数据契约),前端 `useMemo`/离线 fallback 零改动。详见 [P2b 设计](../specs/2026-06-28-surreal-ontology-p2b-召回消费切换-design.md)。

**Tech Stack:** TypeScript;复用 P2a 的 `SurrealRepoHandle.recall*`、域层 `scoreMemoryForRetrieval` 三因子评分、`DualWriteRepository`。测试 vitest。

---

## 0. 上下文与护栏

- **域函数必须保持同步**:`buildInterviewCard` 在前端 `src/App.tsx:341` 的 `useMemo` 中同步调用(不能 async);`createSessionDraft` 在 `App.tsx:672` 离线 fallback 与 `src/features/empty-state-render.test.tsx` 中同步调用。**绝不把域函数改 async。**
- **可选参数,默认回落**:所有 `recall?` 参数不传时,行为逐字节不变(sqlite/默认/前端/既有测试)。
- **只读**:原生召回都是查询,不写库;`asNativeRecall` 只读 authoritative,不碰 shadow。
- **fail-safe**:`prefetchRecall` 内 per-call try/catch,任一子召回抛错 → 该字段 undefined → 域函数回落;绝不阻断 session 创建。
- 隔离 worktree 执行;**绝不 `git add -A`**(项目根有隐私文件/gitlink),每个 commit 精确 `git add` 列出的文件。
- 基线:P2a 后 vitest 1004 passed | 6 skipped,typecheck 绿。

### 关键事实(承接 P2a / 现状)
- `SurrealRepoHandle extends ProductStateRepository`(packages/db/src/surreal/surreal-product-state-repository.ts:62),含 `recallThemeAssets(themeId)` / `recallMemoriesByVector(emb,k,{includeSensitive?})` / `recallProvenanceTurns(table,id)`。
- 两处记忆语义召回:`buildInterviewContextPack.confirmedMemories`(context-pack.ts:298)、`collectRelevantMemories` 记忆段(context-pack.ts:768)。
- 主题资产现状:`collectRelevantMemories` 的 `otherCandidates`(notes/points/questions/decisions/themes 全量 + 子串 `rankMemoryTexts`)。
- 三因子评分:`scoreMemoryForRetrieval(record, { topicTokens, queryEmbedding?, now, alpha?, beta?, gamma? })`(context-pack.ts:1015,权重 0.6/0.25/0.15)。
- `DualWriteRepository`(apps/api/src/dual-write-repository.ts:48)返回 `ProductStateRepository`,读走 `authoritative`。
- 注入矩阵:`surreal`=repo 自身;`dual-surreal`=DualWrite 转发 authoritative;`dual`(auth=sqlite)/`sqlite`/默认=undefined。

---

## 1. 文件结构

```
src/domain/
  recall.ts                            # 新:RecallResult / RecallProvenanceEntry(纯类型契约)
  context-pack.ts                      # 改:resolveInterviewTopicHint 导出 + 5 域函数加 recall? + 三块分支 + provenanceTurns
  types.ts                             # 改:InterviewContextPack += provenanceTurns?
  context-pack-recall.test.ts          # 新:域层原生分支/回落等价/精排/溯源/topicHint
apps/api/src/
  recall/native-recall-port.ts         # 新:NativeRecallPort 接口 + hasNativeRecall 守卫
  recall/native-recall-capability.ts   # 新:asNativeRecall(矩阵探测)
  recall/native-recall-capability.test.ts # 新:四模式矩阵
  recall/prefetch-recall.ts            # 新:prefetchRecall(并行召回 + fail-safe 组装)
  recall/prefetch-recall.test.ts       # 新:组装/fail-safe
  dual-write-repository.ts             # 改:返回对象加 getAuthoritative()
  routes/interview-sessions.ts         # 改:探测→预召回→传 recall
  routes/realtime-voice.ts             # 改:guide 调用点(:348)探测→预召回→传 recall
```

每个 Task 自包含、可独立测试与提交。

---

## 2. 任务

### Task 1: 数据契约 + `resolveInterviewTopicHint`(无行为变化)

**Files:**
- Create: `src/domain/recall.ts`
- Modify: `src/domain/types.ts`（`InterviewContextPack` 加字段)
- Modify: `src/domain/context-pack.ts`（导出 `resolveInterviewTopicHint`，`buildInterviewGuide` 改用它)
- Test: `src/domain/context-pack-recall.test.ts`（新建,先放 topicHint 用例)

- [ ] **Step 1: 写数据契约类型**

`src/domain/recall.ts`:
```ts
/** P2b:server 预召回组装、域函数消费的纯数据契约(无 repo/Promise 依赖)。 */
export interface RecallProvenanceEntry {
  assetTable: string;
  assetId: string;
  turns: Array<{ id: string; content: string; sessionId: string; role: string }>;
}
export interface RecallResult {
  /** 主题资产 id(图遍历 recallThemeAssets);键对齐原生返回。 */
  themeAssets?: { points: string[]; decisions: string[]; questions: string[]; memories: string[] };
  /** 记忆向量召回命中(HNSW recallMemoriesByVector),按相似度近似序。 */
  memoryHits?: Array<{ id: string; text: string }>;
  /** 溯源:资产→证据 turn(recallProvenanceTurns)。 */
  provenance?: RecallProvenanceEntry[];
}
```

- [ ] **Step 2: `InterviewContextPack` 加字段**

`src/domain/types.ts`,在 `InterviewContextPack`(:914)的 `graphReferences` 行后加:
```ts
  /** P2b:surreal 权威时,召回出的资产沿 derived_from 取到的证据 turn;回落时 undefined。 */
  provenanceTurns?: RecallProvenanceEntry[];
```
并在文件顶部 import 区加 `RecallProvenanceEntry`(若 types.ts 不便循环 import,可将上述两个接口直接定义在 types.ts 并由 recall.ts re-export;本计划采用:类型定义在 `recall.ts`,`types.ts` 用 `import type { RecallProvenanceEntry } from "./recall";`)。

- [ ] **Step 3: 写失败测试(RED)— topicHint 解析**

`src/domain/context-pack-recall.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { createInitialProductState } from "./engine";
import { resolveInterviewTopicHint } from "./context-pack";

function stateWith(over: Partial<ReturnType<typeof createInitialProductState>> = {}) {
  return { ...createInitialProductState(), ...over };
}

describe("resolveInterviewTopicHint", () => {
  it("显式 topicHint 优先", () => {
    const s = stateWith({ themes: [{ id: "th_1", name: "放权", summary: "", maturity: "聚焦", representativeQuote: "", appearances: 5, nextQuestion: "", updatedAt: "2026-06-27T00:00:00.000Z" }] });
    expect(resolveInterviewTopicHint(s, { topicHint: "  授权边界 " })).toBe("授权边界");
  });
  it("无显式时回退到出现次数最高的主题名", () => {
    const s = stateWith({ themes: [
      { id: "th_1", name: "放权", summary: "", maturity: "聚焦", representativeQuote: "", appearances: 2, nextQuestion: "", updatedAt: "2026-06-27T00:00:00.000Z" },
      { id: "th_2", name: "复盘", summary: "", maturity: "聚焦", representativeQuote: "", appearances: 9, nextQuestion: "", updatedAt: "2026-06-27T00:00:00.000Z" }
    ] });
    expect(resolveInterviewTopicHint(s, {})).toBe("复盘");
  });
  it("空状态回退到 profile.currentFocus", () => {
    const s = stateWith();
    expect(resolveInterviewTopicHint(s, {})).toBe(s.profile.currentFocus);
  });
});
```

- [ ] **Step 4: 跑确认 RED**

Run: `npx vitest run src/domain/context-pack-recall.test.ts`
Expected: FAIL（`resolveInterviewTopicHint` 未导出)。

- [ ] **Step 5: 实现 `resolveInterviewTopicHint` 并让 guide 复用**

`src/domain/context-pack.ts`:新增导出函数(放在 `buildInterviewGuide` 之前),逻辑 = 现 `buildInterviewGuide:385` 的 topicHint 表达式:
```ts
export function resolveInterviewTopicHint(state: ProductState, options: InterviewGuideOptions = {}): string {
  const explicitTopicHint = options.topicHint?.trim();
  const searchBrief = resolveInterviewContextSearchBrief(state, options);
  const topTheme = [...state.themes].sort((a, b) => b.appearances - a.appearances)[0];
  const focusQuestion = searchBrief || explicitTopicHint ? undefined : findNextInterviewFocusQuestion(state);
  return explicitTopicHint || searchBrief?.topic || focusQuestion?.question || topTheme?.name || state.profile.currentFocus;
}
```
把 `buildInterviewGuide` 内 `:385` 那行替换为:
```ts
  const topicHint = resolveInterviewTopicHint(state, options);
```
(guide 局部的 `explicitTopicHint`/`searchBrief`/`topTheme`/`focusQuestion` 保留,后续逻辑仍用。)
顶部 import 加:`import type { RecallResult, RecallProvenanceEntry } from "./recall";`(为后续 Task 备用)。

- [ ] **Step 6: 跑确认 GREEN + 全量域层不回归**

Run: `npx vitest run src/domain/context-pack-recall.test.ts src/domain/context-pack.test.ts`
Expected: PASS（topicHint 用例 + 既有 context-pack 测试全绿,证明 guide 重构未改行为)。

- [ ] **Step 7: typecheck**

Run: `npm run typecheck`
Expected: 绿。

- [ ] **Step 8: Commit**
```bash
git add src/domain/recall.ts src/domain/types.ts src/domain/context-pack.ts src/domain/context-pack-recall.test.ts
git commit -m "feat(domain): P2b 召回数据契约 RecallResult + resolveInterviewTopicHint(无行为变化)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: `collectRelevantMemories` 消费 `recall`(themeAssets + memoryHits)

**Files:**
- Modify: `src/domain/context-pack.ts`（`collectRelevantMemories` + 新 helper）
- Test: `src/domain/context-pack-recall.test.ts`

- [ ] **Step 1: 写失败测试(RED)**

追加到 `context-pack-recall.test.ts`:
```ts
import { buildInterviewContextPack } from "./context-pack";
import type { RecallResult } from "./recall";

// 经 buildInterviewGuide 间接覆盖 collectRelevantMemories(它是 module-private)。
import { buildInterviewGuide } from "./context-pack";

function linkedRecallState() {
  const base = createInitialProductState();
  return { ...base,
    themes: [{ id: "th_1", name: "放权", summary: "", maturity: "聚焦" as const, representativeQuote: "", appearances: 9, nextQuestion: "", updatedAt: "2026-06-27T00:00:00.000Z" }],
    points: [
      { id: "pt_1", title: "挂主题观点", content: "c1", status: "稳定观点" as const, confidence: "用户确认" as const, evidence: [], relatedThemeIds: ["th_1"], important: false, updatedAt: "2026-06-27T00:00:00.000Z" },
      { id: "pt_off", title: "不挂主题观点", content: "c2", status: "稳定观点" as const, confidence: "用户确认" as const, evidence: [], relatedThemeIds: [], important: false, updatedAt: "2026-06-27T00:00:00.000Z" }
    ],
    decisions: [{ id: "de_1", title: "挂主题决策", decisionKind: "用户决策" as const, confirmationStatus: "用户确认" as const, choice: "ch", tradeOff: "", riskHypothesis: "", reviewAt: "", status: "待复盘" as const, updatedAt: "2026-06-27T00:00:00.000Z", relatedThemeIds: ["th_1"] }],
    memoryRecords: [
      { id: "me_a", text: "记忆A", status: "confirmed" as const, sourceType: "profile" as const, sourceId: "p", evidenceQuote: "", sensitivity: "normal" as const, createdAt: "2026-06-27T00:00:00.000Z", updatedAt: "2026-06-27T00:00:00.000Z" },
      { id: "me_b", text: "记忆B", status: "confirmed" as const, sourceType: "profile" as const, sourceId: "p", evidenceQuote: "", sensitivity: "normal" as const, createdAt: "2026-06-27T00:00:00.000Z", updatedAt: "2026-06-27T00:00:00.000Z" }
    ]
  };
}

describe("collectRelevantMemories: recall 消费(经 guide)", () => {
  it("有 themeAssets:主题资产精确召回(含 decisions),不混入未挂主题资产", () => {
    const s = linkedRecallState();
    const recall: RecallResult = { themeAssets: { points: ["pt_1"], decisions: ["de_1"], questions: [], memories: [] } };
    const guide = buildInterviewGuide(s, { topicHint: "放权" }, recall);
    const joined = guide.relevantMemories.join(" | ");
    expect(joined).toContain("挂主题决策");      // decisions 召回
    expect(joined).toContain("挂主题观点");
    expect(joined).not.toContain("不挂主题观点"); // 精确按边,不混入
  });

  it("有 memoryHits:仅候选 id 进入记忆池", () => {
    const s = linkedRecallState();
    const recall: RecallResult = { memoryHits: [{ id: "me_b", text: "记忆B" }] };
    const guide = buildInterviewGuide(s, { topicHint: "放权" }, recall);
    expect(guide.relevantMemories).toContain("记忆B");
    expect(guide.relevantMemories).not.toContain("记忆A"); // 未命中不进池
  });

  it("无 recall:回落等价(两条记忆都在候选)", () => {
    const s = linkedRecallState();
    const guide = buildInterviewGuide(s, { topicHint: "放权" });
    const joined = guide.relevantMemories.join(" | ");
    expect(joined).toContain("记忆A");
    expect(joined).toContain("记忆B");
  });
});
```

- [ ] **Step 2: 跑确认 RED**

Run: `npx vitest run src/domain/context-pack-recall.test.ts`
Expected: FAIL（`buildInterviewGuide` 尚不接受第 3 参数 / 不消费 recall）。

- [ ] **Step 3: 实现 — helper + `collectRelevantMemories` 分支**

`src/domain/context-pack.ts`,新增 helper(放在 `collectRelevantMemories` 上方):
```ts
/** P2b:按 recall.themeAssets 的 id 从内存 state 取资产文本(格式与现状 otherCandidates 一致)。 */
function collectThemeAssetTexts(state: ProductState, assets: NonNullable<RecallResult["themeAssets"]>): string[] {
  const pointById = new Map(state.points.map((p) => [p.id, p]));
  const decisionById = new Map(state.decisions.map((d) => [d.id, d]));
  const questionById = new Map(state.questions.map((q) => [q.id, q]));
  const texts: string[] = [];
  for (const id of assets.points) { const p = pointById.get(id); if (p) texts.push(`${p.title}：${p.content}`); }
  for (const id of assets.decisions) { const d = decisionById.get(id); if (d) texts.push(`${d.title}：${d.choice}`); }
  for (const id of assets.questions) { const q = questionById.get(id); if (q) texts.push(`${q.question}：${q.whyImportant}`); }
  return texts;
}
```
把 `collectRelevantMemories` 签名与前两段改为(保留第 3 段 merge/dedupe/slice(0,5) 不变):
```ts
function collectRelevantMemories(
  state: ProductState,
  topicHint: string,
  contextPack: InterviewContextPack,
  queryEmbedding?: number[],
  now: string = nowIso(),
  recall?: RecallResult
) {
  const topicTokens = splitTopicTokens(topicHint);

  // 1) 记忆:有 memoryHits → 候选(memoryHits ∪ themeAssets.memories)按 id 取 record,三因子精排;否则现状全量。
  const recalledIds = recall?.memoryHits || recall?.themeAssets?.memories
    ? new Set<string>([...(recall?.memoryHits?.map((h) => h.id) ?? []), ...(recall?.themeAssets?.memories ?? [])])
    : undefined;
  const memoryPool = recalledIds
    ? contextPack.memoryRecords.filter((r) => recalledIds.has(r.id))
    : contextPack.memoryRecords;
  const rankedMemoryTexts = [...memoryPool]
    .map((record) => ({
      text: record.text,
      score: scoreMemoryForRetrieval(record, { topicTokens, ...(queryEmbedding ? { queryEmbedding } : {}), now })
    }))
    .sort((a, b) => b.score - a.score)
    .map((item) => item.text);

  // 2) 其余资产:有 themeAssets → 精确按主题(point/decision/question)+ 不挂边的 notes/themes 现状子串补充;否则现状全量。
  const otherCandidates = recall?.themeAssets
    ? [
        ...collectThemeAssetTexts(state, recall.themeAssets),
        ...state.notes.map((note) => `${note.title}：${note.summary}`),
        ...state.themes.map((theme) => `${theme.name}：${theme.summary}`)
      ]
    : [
        ...state.notes.map((note) => `${note.title}：${note.summary}`),
        ...state.points.map((point) => `${point.title}：${point.content}`),
        ...state.questions.map((question) => `${question.question}：${question.whyImportant}`),
        ...state.decisions.map((decision) => `${decision.title}：${decision.choice}`),
        ...state.themes.map((theme) => `${theme.name}：${theme.summary}`)
      ];
  // themeAssets 已精确归属(图序),不再子串重排;回落分支沿用 rankMemoryTexts。
  const rankedOthers = recall?.themeAssets ? otherCandidates : rankMemoryTexts(otherCandidates, topicHint);

  const seen = new Set<string>();
  const merged: string[] = [];
  for (const text of [...rankedMemoryTexts, ...rankedOthers]) {
    if (!seen.has(text)) { seen.add(text); merged.push(text); }
  }
  return merged.slice(0, 5);
}
```

- [ ] **Step 4: 让 `buildInterviewGuide` 接收并透传 recall(本 Task 仅 collectRelevantMemories 路径)**

`buildInterviewGuide` 签名加第 3 参 `recall?: RecallResult`,把 `:397` 的 `collectRelevantMemories(...)` 调用末尾加 `recall`:
```ts
export function buildInterviewGuide(state: ProductState, options: InterviewGuideOptions = {}, recall?: RecallResult): InterviewGuide {
  ...
  const relevantMemories = collectRelevantMemories(state, topicHint, contextPack, options.queryEmbedding, nowIso(), recall);
  ...
}
```
(buildInterviewContextPack 的 recall 透传在 Task 3 接。)

- [ ] **Step 5: 跑确认 GREEN + 域层不回归**

Run: `npx vitest run src/domain/context-pack-recall.test.ts src/domain/context-pack.test.ts`
Expected: PASS（recall 分支 + 回落等价 + 既有测试全绿)。

- [ ] **Step 6: Commit**
```bash
git add src/domain/context-pack.ts src/domain/context-pack-recall.test.ts
git commit -m "feat(domain): collectRelevantMemories 消费 recall(themeAssets 图召回 + memoryHits 精排,回落不变)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: `buildInterviewContextPack` 消费 recall(confirmedMemories 精排 + provenanceTurns)

**Files:**
- Modify: `src/domain/context-pack.ts`（`buildInterviewContextPack`)
- Test: `src/domain/context-pack-recall.test.ts`

- [ ] **Step 1: 写失败测试(RED)**

追加:
```ts
describe("buildInterviewContextPack: recall 消费", () => {
  it("有 memoryHits:confirmedMemories 仅含候选并三因子精排", () => {
    const s = linkedRecallState();
    const pack = buildInterviewContextPack(s, { topicHint: "放权" }, { memoryHits: [{ id: "me_b", text: "记忆B" }] });
    expect(pack.confirmedMemories).toContain("记忆B");
    expect(pack.confirmedMemories).not.toContain("记忆A");
  });
  it("有 provenance:provenanceTurns 透出;无则 undefined", () => {
    const s = linkedRecallState();
    const prov = [{ assetTable: "point", assetId: "pt_1", turns: [{ id: "tu_1", content: "原话", sessionId: "se_1", role: "user" }] }];
    const pack = buildInterviewContextPack(s, { topicHint: "放权" }, { provenance: prov });
    expect(pack.provenanceTurns?.[0]?.turns[0]?.content).toBe("原话");
    const bare = buildInterviewContextPack(s, { topicHint: "放权" });
    expect(bare.provenanceTurns).toBeUndefined();
  });
});
```

- [ ] **Step 2: 跑确认 RED**

Run: `npx vitest run src/domain/context-pack-recall.test.ts`
Expected: FAIL（pack 不接受 recall / 无 provenanceTurns)。

- [ ] **Step 3: 实现**

`buildInterviewContextPack` 签名加第 3 参,`confirmedMemories` 段(:298-300)与 return 改:
```ts
export function buildInterviewContextPack(state: ProductState, options: InterviewGuideOptions = {}, recall?: RecallResult): InterviewContextPack {
  ...
  // M3c + P2b:有 recall.memoryHits → 候选 record 三因子精排;否则现状。
  const confirmedMemories = recall?.memoryHits
    ? rankMemoryRecordsBySemantics(
        memoryRecords.filter((r) => new Set(recall.memoryHits!.map((h) => h.id)).has(r.id)),
        topicHint,
        options.queryEmbedding ?? []
      )
    : options.queryEmbedding
      ? rankMemoryRecordsBySemantics(memoryRecords, topicHint, options.queryEmbedding)
      : rankMemoryTexts(memoryRecords.map((record) => record.text), topicHint);
  ...
  return {
    ...
    graphReferences,
    ...(recall?.provenance ? { provenanceTurns: recall.provenance } : {}),
    ...
  };
}
```
> 注:`rankMemoryRecordsBySemantics`(context-pack.ts:978)当 `queryEmbedding=[]` 时三因子里 relevance 退子串,行为与无 embedding 一致——安全。

- [ ] **Step 4: 跑确认 GREEN + 不回归**

Run: `npx vitest run src/domain/context-pack-recall.test.ts src/domain/context-pack.test.ts`
Expected: PASS。

- [ ] **Step 5: Commit**
```bash
git add src/domain/context-pack.ts src/domain/context-pack-recall.test.ts
git commit -m "feat(domain): buildInterviewContextPack 消费 recall(confirmedMemories 精排 + provenanceTurns)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: `buildInterviewCard` / `createSessionDraft` 透传 recall + 溯源进 card

**Files:**
- Modify: `src/domain/context-pack.ts`（`buildInterviewCard`、`createSessionDraft`、`CreateSessionOptions`)
- Test: `src/domain/context-pack-recall.test.ts`

- [ ] **Step 1: 写失败测试(RED)**

追加:
```ts
import { buildInterviewCard, createSessionDraft } from "./context-pack";

describe("card / createSessionDraft 透传 recall + 溯源", () => {
  it("buildInterviewCard:provenance 原话进入 historyReferences", () => {
    const s = linkedRecallState();
    const recall: RecallResult = { provenance: [{ assetTable: "point", assetId: "pt_1", turns: [{ id: "tu_1", content: "受访者原话XYZ", sessionId: "se_1", role: "user" }] }] };
    const card = buildInterviewCard(s, undefined, "放权", undefined, recall);
    expect(card.historyReferences.some((h) => h.includes("受访者原话XYZ"))).toBe(true);
  });
  it("createSessionDraft:recall 透传到 guide(themeAssets 决策可见)", () => {
    const s = linkedRecallState();
    const recall: RecallResult = { themeAssets: { points: ["pt_1"], decisions: ["de_1"], questions: [], memories: [] } };
    const session = createSessionDraft(s, "daily", s.profile.preferredStrength, { topicHint: "放权", recall });
    expect(session.guide.relevantMemories.join(" | ")).toContain("挂主题决策");
  });
  it("不传 recall:行为不变(card 同步可用)", () => {
    const s = linkedRecallState();
    const card = buildInterviewCard(s, undefined, "放权");
    expect(typeof card.title).toBe("string");
  });
});
```

- [ ] **Step 2: 跑确认 RED**

Run: `npx vitest run src/domain/context-pack-recall.test.ts`
Expected: FAIL（card/createSessionDraft 不接受 recall)。

- [ ] **Step 3: 实现 — `buildInterviewCard`**

签名加末参 `recall?: RecallResult`;把 `:199` 与 `:218` 的调用透传 recall;`:199` 后用 `contextPack.provenanceTurns` 拼证据原话并入 `historyReferences` 候选:
```ts
export function buildInterviewCard(state: ProductState, searchBriefId?: string, topicHint?: string, queryEmbedding?: number[], recall?: RecallResult): InterviewCard {
  ...
  const contextPack = buildInterviewContextPack(state, contextOptions, recall);
  ...
  const guide = buildInterviewGuide(state, contextOptions, recall);
  ...
  const evidenceQuotes = (contextPack.provenanceTurns ?? [])
    .flatMap((entry) => entry.turns.map((t) => `证据原话（${entry.assetTable}）：${t.content}`))
    .slice(0, 2);
  return {
    ...
    historyReferences: Array.from(new Set([...(agendaContext ? [agendaContext] : []), ...sourceReferences, reference, ...evidenceQuotes, ...confirmedMemoryTexts])).slice(0, 4),
    ...
  };
}
```
> `contextOptions` 在 `:193` 已构造;确保 `queryEmbedding` 仍按现状条件并入,recall 作独立末参传 pack/guide。

- [ ] **Step 4: 实现 — `CreateSessionOptions` + `createSessionDraft`**

`CreateSessionOptions`(:258)加:
```ts
  /** P2b:server 预召回数据;前端/sqlite 不传,走回落。 */
  recall?: RecallResult;
```
`createSessionDraft`(:801)把 `:807` guide、`:812` card 调用透传 recall:
```ts
  const guide = buildInterviewGuide(state, { ...(options.searchBriefId ? { searchBriefId: options.searchBriefId } : {}), ...(options.topicHint ? { topicHint: options.topicHint } : {}), ...(options.queryEmbedding ? { queryEmbedding: options.queryEmbedding } : {}) }, options.recall);
  const card = buildInterviewCard(state, options.searchBriefId, options.topicHint, options.queryEmbedding, options.recall);
```

- [ ] **Step 5: 跑确认 GREEN + 全量域层不回归**

Run: `npx vitest run src/domain/context-pack-recall.test.ts src/domain/context-pack.test.ts`
Expected: PASS。

- [ ] **Step 6: 前端编译确认(域函数仍同步)**

Run: `npm run typecheck`
Expected: 绿(App.tsx:341 useMemo 调 `buildInterviewCard(productState, activeSearchBriefId)` 仍合法——recall 为可选末参)。

- [ ] **Step 7: Commit**
```bash
git add src/domain/context-pack.ts src/domain/context-pack-recall.test.ts
git commit -m "feat(domain): card/createSessionDraft 透传 recall + 溯源原话进 historyReferences

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: `NativeRecallPort` + `asNativeRecall`(能力探测 + DualWrite 转发)

**Files:**
- Create: `apps/api/src/recall/native-recall-port.ts`
- Create: `apps/api/src/recall/native-recall-capability.ts`
- Modify: `apps/api/src/dual-write-repository.ts`（加 `getAuthoritative`)
- Test: `apps/api/src/recall/native-recall-capability.test.ts`

- [ ] **Step 1: 端口接口 + 守卫**

`apps/api/src/recall/native-recall-port.ts`:
```ts
/** P2b:server 层使用的原生召回端口;SurrealRepoHandle 结构兼容。 */
export interface NativeRecallPort {
  recallThemeAssets(themeId: string): Promise<{ points: string[]; decisions: string[]; questions: string[]; memories: string[] }>;
  recallMemoriesByVector(embedding: number[], k: number, opts?: { includeSensitive?: boolean }): Promise<Array<{ id: string; text: string }>>;
  recallProvenanceTurns(table: string, id: string): Promise<Array<{ id: string; content: string; sessionId: string; role: string }>>;
}
export function hasNativeRecall(x: unknown): x is NativeRecallPort {
  const r = x as Partial<NativeRecallPort> | null;
  return !!r && typeof r.recallThemeAssets === "function" && typeof r.recallMemoriesByVector === "function" && typeof r.recallProvenanceTurns === "function";
}
```

- [ ] **Step 2: DualWrite 暴露 authoritative**

`apps/api/src/dual-write-repository.ts`:返回类型与对象加 `getAuthoritative`:
```ts
export function createDualWriteRepository(opts: DualWriteOptions): ProductStateRepository & { getAuthoritative(): ProductStateRepository } {
  ...
  return {
    getState: () => authoritative.getState(),
    getAuthoritative: () => authoritative,
    getInterviewSession: (id) => authoritative.getInterviewSession(id),
    ...
  };
}
```

- [ ] **Step 3: 写失败测试(RED)— 矩阵**

`apps/api/src/recall/native-recall-capability.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { asNativeRecall } from "./native-recall-capability";
import { createDualWriteRepository } from "../dual-write-repository";
import { createSqliteProductStateRepository } from "../../../../packages/db/src/sqlite-product-state-repository";

const fakeSurreal = () => {
  const sqlite = createSqliteProductStateRepository({ dbPath: ":memory:" });
  return Object.assign(sqlite, {
    recallThemeAssets: async () => ({ points: [], decisions: [], questions: [], memories: [] }),
    recallMemoriesByVector: async () => [],
    recallProvenanceTurns: async () => []
  });
};

describe("asNativeRecall 矩阵", () => {
  it("surreal:repo 自身可召回", () => {
    expect(asNativeRecall(fakeSurreal())).not.toBeUndefined();
  });
  it("sqlite:undefined", () => {
    expect(asNativeRecall(createSqliteProductStateRepository({ dbPath: ":memory:" }))).toBeUndefined();
  });
  it("dual(auth=sqlite):undefined", () => {
    const repo = createDualWriteRepository({ authoritative: createSqliteProductStateRepository({ dbPath: ":memory:" }), shadow: createSqliteProductStateRepository({ dbPath: ":memory:" }) });
    expect(asNativeRecall(repo)).toBeUndefined();
  });
  it("dual-surreal(auth=surreal):转发", () => {
    const repo = createDualWriteRepository({ authoritative: fakeSurreal(), shadow: createSqliteProductStateRepository({ dbPath: ":memory:" }) });
    expect(asNativeRecall(repo)).not.toBeUndefined();
  });
});
```

- [ ] **Step 4: 跑确认 RED**

Run: `npx vitest run apps/api/src/recall/native-recall-capability.test.ts`
Expected: FAIL（`asNativeRecall` 不存在)。

- [ ] **Step 5: 实现 `asNativeRecall`**

`apps/api/src/recall/native-recall-capability.ts`:
```ts
import { hasNativeRecall, type NativeRecallPort } from "./native-recall-port";

/** 按注入矩阵探测原生召回:repo 自身(surreal)→ authoritative(dual-surreal)→ undefined(dual/sqlite)。 */
export function asNativeRecall(repo: unknown): NativeRecallPort | undefined {
  if (hasNativeRecall(repo)) return repo;
  const auth = (repo as { getAuthoritative?: () => unknown } | null)?.getAuthoritative?.();
  if (hasNativeRecall(auth)) return auth;
  return undefined;
}
```

- [ ] **Step 6: 跑确认 GREEN + typecheck**

Run: `npx vitest run apps/api/src/recall/native-recall-capability.test.ts && npm run typecheck`
Expected: PASS + 绿。

- [ ] **Step 7: Commit**
```bash
git add apps/api/src/recall/native-recall-port.ts apps/api/src/recall/native-recall-capability.ts apps/api/src/recall/native-recall-capability.test.ts apps/api/src/dual-write-repository.ts
git commit -m "feat(api): NativeRecallPort + asNativeRecall 注入矩阵(surreal/dual-surreal 透出,dual/sqlite 回落)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: `prefetchRecall`(并行召回 + fail-safe 组装)

**Files:**
- Create: `apps/api/src/recall/prefetch-recall.ts`
- Test: `apps/api/src/recall/prefetch-recall.test.ts`

- [ ] **Step 1: 写失败测试(RED)**

`apps/api/src/recall/prefetch-recall.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { prefetchRecall } from "./prefetch-recall";
import { createInitialProductState } from "../../../../src/domain/engine";
import type { NativeRecallPort } from "./native-recall-port";

function stateWithTheme() {
  const base = createInitialProductState();
  return { ...base, themes: [{ id: "th_1", name: "放权", summary: "", maturity: "聚焦" as const, representativeQuote: "", appearances: 9, nextQuestion: "", updatedAt: "2026-06-27T00:00:00.000Z" }],
    points: [{ id: "pt_1", title: "p", content: "c", status: "稳定观点" as const, confidence: "用户确认" as const, evidence: [], relatedThemeIds: ["th_1"], important: false, updatedAt: "2026-06-27T00:00:00.000Z" }] };
}
const okPort = (): NativeRecallPort => ({
  recallThemeAssets: async () => ({ points: ["pt_1"], decisions: ["de_1"], questions: [], memories: ["me_1"] }),
  recallMemoriesByVector: async () => [{ id: "me_1", text: "记忆" }],
  recallProvenanceTurns: async (table, id) => [{ id: "tu_1", content: `原话:${table}:${id}`, sessionId: "se_1", role: "user" }]
});

describe("prefetchRecall", () => {
  it("组装 themeAssets + memoryHits + provenance", async () => {
    const r = await prefetchRecall(okPort(), stateWithTheme(), "放权", [0.1, 0.2], { includeSensitive: false, topN: 5 });
    expect(r.themeAssets?.points).toContain("pt_1");
    expect(r.memoryHits?.[0]?.id).toBe("me_1");
    expect(r.provenance?.some((p) => p.assetId === "pt_1")).toBe(true);
  });
  it("无 queryEmbedding:不召回向量,memoryHits undefined", async () => {
    const r = await prefetchRecall(okPort(), stateWithTheme(), "放权", undefined, { includeSensitive: false, topN: 5 });
    expect(r.memoryHits).toBeUndefined();
    expect(r.themeAssets?.points).toContain("pt_1");
  });
  it("fail-safe:某子召回抛错 → 该字段 undefined,整体不抛", async () => {
    const port: NativeRecallPort = { ...okPort(), recallMemoriesByVector: async () => { throw new Error("boom"); } };
    const r = await prefetchRecall(port, stateWithTheme(), "放权", [0.1], { includeSensitive: false, topN: 5 });
    expect(r.memoryHits).toBeUndefined();
    expect(r.themeAssets?.points).toContain("pt_1"); // 其它字段仍在
  });
});
```

- [ ] **Step 2: 跑确认 RED**

Run: `npx vitest run apps/api/src/recall/prefetch-recall.test.ts`
Expected: FAIL（`prefetchRecall` 不存在)。

- [ ] **Step 3: 实现**

`apps/api/src/recall/prefetch-recall.ts`:
```ts
import type { ProductState } from "../../../../src/domain/types";
import type { RecallResult, RecallProvenanceEntry } from "../../../../src/domain/recall";
import type { NativeRecallPort } from "./native-recall-port";

const PROVENANCE_MAX_ASSETS = 6;
const PROVENANCE_MAX_TURNS = 3;

async function safe<T>(label: string, fn: () => Promise<T>): Promise<T | undefined> {
  try { return await fn(); }
  catch (error) {
    console.warn(JSON.stringify({ event: "prefetch_recall_degraded", label, error: error instanceof Error ? error.message : String(error) }));
    return undefined;
  }
}

/** surreal 权威时 server 侧预召回:并行图遍历 + HNSW + 溯源,组装 RecallResult(纯数据)。每路 fail-safe。 */
export async function prefetchRecall(
  port: NativeRecallPort,
  state: ProductState,
  topicHint: string,
  queryEmbedding: number[] | undefined,
  opts: { includeSensitive: boolean; topN: number }
): Promise<RecallResult> {
  const theme = state.themes.find((t) => t.name === topicHint) ?? [...state.themes].sort((a, b) => b.appearances - a.appearances)[0];
  const themeId = theme?.id;

  const [themeAssets, memoryHits] = await Promise.all([
    themeId ? safe("themeAssets", () => port.recallThemeAssets(themeId)) : Promise.resolve(undefined),
    queryEmbedding && queryEmbedding.length > 0
      ? safe("memoryHits", () => port.recallMemoriesByVector(queryEmbedding, Math.max(opts.topN, 5) * 4, { includeSensitive: opts.includeSensitive }))
      : Promise.resolve(undefined)
  ]);

  // 溯源:对召回出的 point/decision(有界)取证据 turn。
  let provenance: RecallProvenanceEntry[] | undefined;
  if (themeAssets) {
    const targets: Array<{ table: string; id: string }> = [
      ...themeAssets.points.map((id) => ({ table: "point", id })),
      ...themeAssets.decisions.map((id) => ({ table: "decision", id }))
    ].slice(0, PROVENANCE_MAX_ASSETS);
    const entries = await Promise.all(
      targets.map(async (t) => {
        const turns = (await safe("provenance", () => port.recallProvenanceTurns(t.table, t.id))) ?? [];
        return turns.length > 0 ? { assetTable: t.table, assetId: t.id, turns: turns.slice(0, PROVENANCE_MAX_TURNS) } : undefined;
      })
    );
    const filtered = entries.filter((e): e is RecallProvenanceEntry => Boolean(e));
    provenance = filtered.length > 0 ? filtered : undefined;
  }

  return {
    ...(themeAssets ? { themeAssets } : {}),
    ...(memoryHits ? { memoryHits } : {}),
    ...(provenance ? { provenance } : {})
  };
}
```

- [ ] **Step 4: 跑确认 GREEN + typecheck**

Run: `npx vitest run apps/api/src/recall/prefetch-recall.test.ts && npm run typecheck`
Expected: PASS + 绿。

- [ ] **Step 5: Commit**
```bash
git add apps/api/src/recall/prefetch-recall.ts apps/api/src/recall/prefetch-recall.test.ts
git commit -m "feat(api): prefetchRecall 并行原生召回 + per-call fail-safe 组装 RecallResult

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: 接线 routes(interview-sessions + realtime-voice)

**Files:**
- Modify: `apps/api/src/routes/interview-sessions.ts`（session 创建路径)
- Modify: `apps/api/src/routes/realtime-voice.ts`（:348 guide 调用点)
- Test: `apps/api/src/routes/interview-sessions.test.ts`（若存在则追加;否则在该目录建最小集成测试)

- [ ] **Step 1: 写集成测试(RED)**

在 `apps/api/src/routes/interview-sessions.test.ts` 追加(用注入了 `recall*` 的 fake surreal repo 构 server;断言 surreal 模式下创建的 session.guide 反映原生 themeAssets)。最小骨架:
```ts
it("P2b:surreal 权威 repo 时,创建 session 走原生召回(决策可见)", async () => {
  // 1) 用 fake surreal repo(在 sqlite 上挂 recall*),seed 一个挂主题的决策。
  // 2) buildApiServer({ productStateRepository: fakeSurrealRepo }) 注入。
  // 3) POST /api/interview-sessions { mode:"daily" }。
  // 4) expect(res.json().session.guide.relevantMemories.join("|")).toContain("挂主题决策")。
  // recall* 由 fake 返回该决策 id;asNativeRecall 命中 → prefetchRecall → createSessionDraft(recall)。
});
```
> 参照 `dual-write-surreal.test.ts` 构 repo 的方式与本仓既有 route 测试的 `buildApiServer` 用法,补全断言。

- [ ] **Step 2: 跑确认 RED**

Run: `npx vitest run apps/api/src/routes/interview-sessions.test.ts`
Expected: FAIL（guide 未含原生召回的决策)。

- [ ] **Step 3: 实现 — interview-sessions.ts**

在 `POST /api/interview-sessions`(:104)与其它走 `createSessionDraft` 的 handler 中,创建 session 前:
```ts
import { asNativeRecall } from "../recall/native-recall-capability";
import { prefetchRecall } from "../recall/prefetch-recall";
import { resolveInterviewTopicHint } from "../../../../src/domain/context-pack";
...
const state = repository.getState();
const port = asNativeRecall(repository);
const topic = resolveInterviewTopicHint(state, { ...(topicHint ? { topicHint } : {}), ...(payload.searchBriefId != null ? { searchBriefId: normalizeOptionalString(payload.searchBriefId) } : {}) });
const queryEmbedding = await embedQueryText(topic, options.embeddingClient);
const recall = port
  ? await prefetchRecall(port, state, topic, queryEmbedding, { includeSensitive: state.systemConfig.memory.includeSensitiveMemoriesInContext, topN: state.systemConfig.search.maxSources })
  : undefined;
const session = createSessionDraft(state, normalizeMode(payload.mode), normalizeStrength(payload.strength, state), {
  ...(payload.searchBriefId != null ? { searchBriefId: normalizeOptionalString(payload.searchBriefId) } : {}),
  ...(topicHint ? { topicHint } : {}),
  ...(queryEmbedding ? { queryEmbedding } : {}),
  ...(recall ? { recall } : {})
});
```
> 用 `resolveInterviewTopicHint` 取代原 `recallTopic`(:113)以与域内 topicHint 对齐;`embedQueryText` 的 fail-safe 不变。

- [ ] **Step 4: 实现 — realtime-voice.ts(:348)**

该处 `buildInterviewGuide(state, {...})` 改为先探测+预召回(handler 已 async):
```ts
const port = asNativeRecall(/* 该 route 持有的 productStateRepository */);
const topic = resolveInterviewTopicHint(state, { /* 现有 topicHint/searchBriefId */ });
const recall = port ? await prefetchRecall(port, state, topic, /* queryEmbedding 若有 */ undefined, { includeSensitive: state.systemConfig.memory.includeSensitiveMemoriesInContext, topN: state.systemConfig.search.maxSources }) : undefined;
const guide = /* 现有条件 */ ? buildInterviewGuide(state, { /* 现有 opts */ }, recall) : /* 原分支 */;
```
> 按该文件实际持有的 repo 变量名与现有 guide 构造条件落地;import `asNativeRecall`/`prefetchRecall`/`resolveInterviewTopicHint`。voice 路径无 queryEmbedding 时 memoryHits 自然为空、其余原生召回仍生效。

- [ ] **Step 5: 跑确认 GREEN**

Run: `npx vitest run apps/api/src/routes/interview-sessions.test.ts`
Expected: PASS。

- [ ] **Step 6: Commit**
```bash
git add apps/api/src/routes/interview-sessions.ts apps/api/src/routes/realtime-voice.ts apps/api/src/routes/interview-sessions.test.ts
git commit -m "feat(api): 接线 surreal 权威召回——routes 探测+预召回+传 recall 进 createSessionDraft/guide

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: 全量回归 + typecheck + 漂移确认

- [ ] **Step 1: 全量 + typecheck**

Run:
```bash
npm run typecheck && npx vitest run
```
Expected: typecheck 绿(含 apps/api);vitest 在基线 1004 passed | 6 skipped 之上净增 P2b 测试、全绿、零回归。粘贴 summary。

- [ ] **Step 2: 前端约束确认(域函数仍同步)**

Run: `git diff --stat` 检查 `src/App.tsx` 未被改动;确认 `buildInterviewCard`/`createSessionDraft`/`buildInterviewGuide` 签名仍为同步(返回非 Promise)。
Expected: App.tsx 零改动;域函数同步。

- [ ] **Step 3: Commit**(通常无新改动)

---

## 3. P2b 阶段门
- [ ] surreal 权威:图遍历主题资产(含 decisions)、HNSW+三因子精排两处统一、溯源原话进 card/contextPack。
- [ ] 域函数同步签名不变;`src/App.tsx` 零改动;前端 `useMemo`/离线 fallback / `empty-state-render` 不回归。
- [ ] sqlite/默认/`dual` 行为逐字节不变(回落等价);原生抛错 fail-safe 回落、session 仍创建。
- [ ] `asNativeRecall` 四模式矩阵正确;DualWrite 仅 auth=surreal 透出、只读 authoritative。
- [ ] 全量 ≥1004 + 净增、零回归;typecheck 绿。

## 4. 不在本计划(后续)
- chat/RAG 混合检索(向量+BM25+`search::rrf()`)——需 rag_chunk embedding 落地,单独排。
- `evolves_into` 主题演化时间线。
- 删除域层手工列举(保留为回落,sqlite/前端必须)。
- P3 公理落 DB。

## 5. 自查(已执行)
- **Spec 覆盖**:§4.1 图遍历=Task 2;§4.2 HNSW+三因子=Task 2(collect)+Task 3(pack);§4.3 溯源=Task 3(字段)+Task 4(card 消费);端口/矩阵=Task 5;预召回=Task 6;接线=Task 7;回归=Task 8。
- **占位扫描**:Task 7 测试为骨架 + 明确断言指引(依赖本仓既有 route 测试/`dual-write-surreal.test.ts` 构造方式),非 TBD;`PROVENANCE_MAX_*`/`topN*4` 为有界常量。
- **类型一致**:`RecallResult{themeAssets,memoryHits,provenance}`(Task1)↔ `prefetchRecall` 组装(Task6)↔ 域函数消费(Task2/3/4)↔ 测试注入,字段名贯穿一致;`NativeRecallPort` 三方法签名 = `SurrealRepoHandle` 子集;`resolveInterviewTopicHint` 三处共用(guide/Task1、interview-sessions/Task7、prefetchRecall 主题解析对齐)。
- **同步约束**:全部 `recall?` 为可选末参,域函数返回类型不变(非 Promise),App.tsx:341 useMemo 调用合法。
