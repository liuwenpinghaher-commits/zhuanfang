# 素材库 + 统一知识索引 + 资产对话 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development（推荐）或 executing-plans。Steps 用 `- [ ]`。

**Goal:** 加「素材库」与「资产对话」两个认知资产视图：导入个人资料 → 统一知识索引（knowledge_chunks）→ 基于全部认知资产的通用 AI 助手 chat（带引用）。

**Architecture:** 维持 node:sqlite + 整状态范式。新独立 SQLite 仓 `KnowledgeIndexRepository`（不进 ProductState blob）存切块+嵌入；chat 会话整合进 ProductState（封顶）；增量索引在持久化边界 diff 新旧 state。复用现有 embeddingClient/cosineSimilarity/BailianChatClient/import 管线。

**Tech Stack:** TypeScript、Fastify、node:sqlite（DatabaseSync）、React+Vite、vitest。纯函数 domain + 仓储双实现。

参考设计：`docs/superpowers/specs/2026-06-22-knowledge-base-and-asset-chat-design.md`

---

## 文件结构
**新建：**
- `src/domain/knowledge.ts` + `.test.ts` — 纯函数：`buildKnowledgeChunks`、`rankKnowledgeChunks`、`diffIndexableSources`、chat 域函数（createChatSession/appendChatMessage/renameChatSession/deleteChatSession/capChatSessions）、`buildChatPrompt`。
- `apps/api/src/knowledge-index-repository.ts` + `.test.ts` — 内存 KnowledgeIndexRepository。
- `packages/db/src/sqlite-knowledge-index-repository.ts` + `.test.ts` — sqlite 实现。
- `apps/api/src/routes/knowledge.ts` + `.test.ts` — `POST /api/knowledge/rebuild`、`reindexOnStateChange` helper。
- `apps/api/src/routes/chat.ts` + `.test.ts` — `POST /api/chat`。
- `src/features/material/MaterialLibraryView.tsx` — 素材库 UI。
- `src/features/chat/AssetChatView.tsx` — 资产对话 UI。

**修改：** `src/domain/types.ts`、`seed.ts`、`engine.ts`、`storage.ts`、`privacy.ts`、`migration.ts`、`ui.ts`（导航+View）、`apps/api/src/server.ts`（装配）、`apps/api/src/routes/state.ts`（持久化边界 reindex + purge 清索引）、`apps/api/src/routes/import.ts`（导入后补索引）、`apps/api/src/routes/interview-sessions.ts`（/end 后补 transcript 索引）、`src/api/productApi.ts`、`src/App.tsx`、`src/ui.test.ts`。

里程碑：M1 类型+仓储+chat 管道 → M2 切块+嵌入+重建 → M3 增量 diff → M4 chat 端点 → M5 素材库 UI → M6 对话 UI → M7 治理+回归。

---

## M1 — 类型 + 知识索引仓储 + chat 管道

### Task 1: 类型 + ProductState.chatSessions
**Files:** Modify `src/domain/types.ts`

- [ ] **Step 1: 加类型**（放 ProductState 接口之前）
```ts
export type KnowledgeSourceType =
  | "note" | "memory" | "theme" | "point" | "decision" | "debt" | "transcript" | "material";

export interface KnowledgeChunk {
  id: string;
  sourceType: KnowledgeSourceType;
  sourceId: string;
  title: string;
  text: string;
  keywords: string[];
  embedding?: number[];
  createdAt: string;
}

export interface ChatCitation { sourceType: KnowledgeSourceType; sourceId: string; title: string; snippet: string; }
export interface ChatMessage { id: string; role: "user" | "assistant"; content: string; citations?: ChatCitation[]; createdAt: string; }
export interface ChatSession { id: string; title: string; messages: ChatMessage[]; createdAt: string; updatedAt: string; }
```
- [ ] **Step 2:** ProductState 加 `chatSessions: ChatSession[];`（紧跟 `interviewAnnotations` 之后）。
- [ ] **Step 3:** AuditEvent.type union 加 `"chat_session_created"` 与 `"knowledge_index_rebuilt"`；entityType 加 `"chat_session"` 与 `"knowledge_index"`。
- [ ] **Step 4: tsc** Run: `npx tsc -p tsconfig.json --noEmit`；Expected: 仅下游缺 `chatSessions` 报错（seed/empty/test），新类型本身无错。
- [ ] **Step 5: Commit** `git add src/domain/types.ts && git commit -m "feat(knowledge): KnowledgeChunk/ChatSession 类型 + chatSessions 字段"`

### Task 2: chatSessions 状态管道
**Files:** Modify `src/domain/seed.ts`、`engine.ts`、`storage.ts`、`privacy.ts`、`migration.ts`（+ 修测试夹具）

- [ ] **Step 1: seed.ts** `interviewAnnotations: []` 之后加 `chatSessions: [],`。
- [ ] **Step 2: engine.ts** createEmptyProductState 同加 `chatSessions: [],`。
- [ ] **Step 3: storage.ts** 顶部加 `const MAX_CHAT_SESSIONS = 50;`；normalize 在 interviewAnnotations 之后加：
```ts
    chatSessions: Array.isArray(candidate.chatSessions)
      ? candidate.chatSessions.slice(0, MAX_CHAT_SESSIONS)
      : fallback.chatSessions,
```
- [ ] **Step 4: privacy.ts** createPurgedProductState 加 `chatSessions: [],`；scoped purge `case "interviews"` 不动（chat 属个人，all 才清——createPurgedProductState 已覆盖 all）。
- [ ] **Step 5: migration.ts** 在 `assets`/合适条目 count 加 `+ (state.chatSessions ?? []).length`（或新条目；保持现有风格）。
- [ ] **Step 6: tsc + 修夹具** Run: `npx tsc -p tsconfig.json --noEmit && npx tsc -p apps/api/tsconfig.json`；给所有报缺 `chatSessions` 的 ProductState 字面量（types.test.ts/session-archive.test.ts 等）补 `chatSessions: [],` 直到干净。
- [ ] **Step 7: Commit** 逐个 file add 上述源文件 + 改的测试夹具；`git commit -m "feat: chatSessions 接入 seed/empty/normalize(封顶)/purge/migration"`

### Task 3: KnowledgeIndexRepository 内存实现（TDD）
**Files:** Create `apps/api/src/knowledge-index-repository.ts` + `.test.ts`

- [ ] **Step 1: 失败测试**
```ts
import { describe, it, expect } from "vitest";
import { createInMemoryKnowledgeIndexRepository } from "./knowledge-index-repository";
import type { KnowledgeChunk } from "../../../src/domain/types";
const mk = (id: string, sourceType: KnowledgeChunk["sourceType"], sourceId: string): KnowledgeChunk => ({
  id, sourceType, sourceId, title: "t", text: "x", keywords: [], createdAt: "2026-06-22T00:00:00.000Z"
});
describe("in-memory KnowledgeIndexRepository", () => {
  it("put/listAll, deleteBySource 删该来源全部块, deleteAll", () => {
    const r = createInMemoryKnowledgeIndexRepository();
    r.put(mk("c1", "note", "s1")); r.put(mk("c2", "note", "s1")); r.put(mk("c3", "memory", "m1"));
    expect(r.listAll()).toHaveLength(3);
    r.deleteBySource("note", "s1");
    expect(r.listAll().map((c) => c.id)).toEqual(["c3"]);
    r.deleteAll();
    expect(r.listAll()).toHaveLength(0);
  });
  it("replaceSource 原子替换某来源的块", () => {
    const r = createInMemoryKnowledgeIndexRepository();
    r.put(mk("c1", "note", "s1"));
    r.replaceSource("note", "s1", [mk("c2", "note", "s1"), mk("c3", "note", "s1")]);
    expect(r.listAll().map((c) => c.id).sort()).toEqual(["c2", "c3"]);
  });
});
```
- [ ] **Step 2: 失败** Run: `npx vitest run apps/api/src/knowledge-index-repository.test.ts`
- [ ] **Step 3: 实现**
```ts
import type { KnowledgeChunk, KnowledgeSourceType } from "../../../src/domain/types";

export interface KnowledgeIndexRepository {
  put(chunk: KnowledgeChunk): void;
  replaceSource(sourceType: KnowledgeSourceType, sourceId: string, chunks: KnowledgeChunk[]): void;
  deleteBySource(sourceType: KnowledgeSourceType, sourceId: string): void;
  deleteAll(): void;
  listAll(): KnowledgeChunk[];
}

export function createInMemoryKnowledgeIndexRepository(): KnowledgeIndexRepository {
  const store = new Map<string, KnowledgeChunk>();
  const keyOf = (t: KnowledgeSourceType, id: string) => `${t}::${id}`;
  return {
    put: (c) => { store.set(c.id, c); },
    replaceSource(t, id, chunks) {
      for (const [cid, c] of store) if (c.sourceType === t && c.sourceId === id) store.delete(cid);
      for (const c of chunks) store.set(c.id, c);
    },
    deleteBySource(t, id) {
      for (const [cid, c] of store) if (c.sourceType === t && c.sourceId === id) store.delete(cid);
    },
    deleteAll: () => store.clear(),
    listAll: () => [...store.values()]
  };
}
```
- [ ] **Step 4: 通过** Run: `npx vitest run apps/api/src/knowledge-index-repository.test.ts`
- [ ] **Step 5: Commit** `git commit -m "feat(knowledge): KnowledgeIndexRepository 内存实现(TDD)"`

### Task 4: SQLite KnowledgeIndexRepository（TDD）
**Files:** Create `packages/db/src/sqlite-knowledge-index-repository.ts` + `.test.ts`

- [ ] **Step 1: 失败测试**（:memory:，含 embedding number[] 往返）
```ts
import { describe, it, expect } from "vitest";
import { createSqliteKnowledgeIndexRepository } from "./sqlite-knowledge-index-repository";
import type { KnowledgeChunk } from "../../../src/domain/types";
const mk = (id: string, src: string, emb?: number[]): KnowledgeChunk => ({
  id, sourceType: "note", sourceId: src, title: "t", text: "原文", keywords: ["a", "b"],
  ...(emb ? { embedding: emb } : {}), createdAt: "2026-06-22T00:00:00.000Z"
});
describe("sqlite KnowledgeIndexRepository", () => {
  it("put→listAll 往返(含 embedding/keywords), replaceSource, deleteBySource/All", () => {
    const r = createSqliteKnowledgeIndexRepository({ dbPath: ":memory:" });
    r.put(mk("c1", "s1", [0.1, 0.2, 0.3]));
    const all = r.listAll();
    expect(all[0].embedding).toEqual([0.1, 0.2, 0.3]);
    expect(all[0].keywords).toEqual(["a", "b"]);
    r.replaceSource("note", "s1", [mk("c2", "s1")]);
    expect(r.listAll().map((c) => c.id)).toEqual(["c2"]);
    r.deleteBySource("note", "s1"); expect(r.listAll()).toHaveLength(0);
  });
});
```
- [ ] **Step 2: 失败** Run: `npx vitest run packages/db/src/sqlite-knowledge-index-repository.test.ts`
- [ ] **Step 3: 实现** 镜像 `packages/db/src/sqlite-raw-material-repository.ts`（`import { DatabaseSync } from "node:sqlite"`、:memory: 守卫、`as unknown as Row[]` cast）。表：
```sql
CREATE TABLE IF NOT EXISTS knowledge_chunks (
  id TEXT PRIMARY KEY, source_type TEXT NOT NULL, source_id TEXT NOT NULL,
  title TEXT, text TEXT NOT NULL, keywords_json TEXT, embedding_json TEXT, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_kc_source ON knowledge_chunks(source_type, source_id);
```
`put` 写 `JSON.stringify(keywords)`/`embedding?JSON.stringify(embedding):null`；`listAll`/映射时 `JSON.parse`，embedding 为 null 不挂字段；`replaceSource` 用事务：`DELETE WHERE source_type=? AND source_id=?` 再逐条 INSERT；`deleteBySource`/`deleteAll` 对应 DELETE。**先读 raw-material sqlite 实现确认 node:sqlite API。**
- [ ] **Step 4: 通过** Run: `npx vitest run packages/db/src/sqlite-knowledge-index-repository.test.ts`
- [ ] **Step 5: Commit** `git commit -m "feat(db): SQLite KnowledgeIndexRepository + knowledge_chunks 表(TDD)"`

---

## M2 — 切块 + 嵌入 + 重建索引端点

### Task 5: buildKnowledgeChunks（纯函数，TDD）
**Files:** Create `src/domain/knowledge.ts` + `src/domain/knowledge.test.ts`

- [ ] **Step 1: 失败测试**
```ts
import { describe, it, expect } from "vitest";
import { buildKnowledgeChunks } from "./knowledge";
import { createInitialProductState } from "./engine";
import type { InterviewTurn } from "./types";

describe("buildKnowledgeChunks", () => {
  it("把蒸馏资产各切成块,带 sourceType/sourceId,离线无嵌入", () => {
    const state = createInitialProductState(); // seed 含 themes/points/memory 等
    const chunks = buildKnowledgeChunks(state, new Map());
    const types = new Set(chunks.map((c) => c.sourceType));
    expect(chunks.length).toBeGreaterThan(0);
    expect([...types].some((t) => ["memory", "theme", "point", "note"].includes(t))).toBe(true);
    expect(chunks.every((c) => c.id && c.sourceId && c.text)).toBe(true);
    expect(chunks.every((c) => c.embedding === undefined)).toBe(true); // 纯函数不嵌入
  });
  it("transcript 按 user 轮切块(来自冷层 map)", () => {
    const state = createInitialProductState();
    const sid = state.sessions[0]?.id ?? "s1";
    const turns: InterviewTurn[] = [
      { id: "t1", role: "user", content: "我担心放权失控。", intent: "", timestamp: "2026-06-22T00:00:00.000Z" },
      { id: "t2", role: "assistant", content: "为什么?", intent: "", timestamp: "2026-06-22T00:00:00.000Z" }
    ];
    const chunks = buildKnowledgeChunks({ ...state, sessions: [{ ...(state.sessions[0] ?? {}), id: sid } as any] }, new Map([[sid, turns]]));
    const t = chunks.filter((c) => c.sourceType === "transcript");
    expect(t.length).toBe(1); // 只 user 轮
    expect(t[0].sourceId).toContain(sid);
    expect(t[0].text).toContain("放权");
  });
});
```
- [ ] **Step 2: 失败** Run: `npx vitest run src/domain/knowledge.test.ts`
- [ ] **Step 3: 实现** `buildKnowledgeChunks(state, rawTurnsBySession: Map<string, InterviewTurn[]>): KnowledgeChunk[]`：
  - 遍历 memoryRecords/themes/points/decisions/debts/notes → 每条一块（`text = 标题/正文拼接`，`keywords = tokenizeMemoryGraphText(text)` 复用），`id = makeId("kc")`，`sourceType`/`sourceId` 对应，`title` 取条目标题/名称/概念，无嵌入。
  - transcript：对每个 session，从 rawTurnsBySession 取 turns，filter role==="user"，每条 user 轮一块（sourceId = `${sessionId}#${turnId}`，title = session.title）。
  - material：遍历 importSources → 每个 source 一块或按现有 ragChunks 拆（v1：每 importSource 一块，text 取 content 截断；sourceType="material", sourceId=importSource.id）。
  - 纯函数、不嵌入、不可变。复用 `tokenizeMemoryGraphText`(from engine/context-pack)、`makeId`/`nowIso`(utils)。
- [ ] **Step 4: 通过** Run: `npx vitest run src/domain/knowledge.test.ts`
- [ ] **Step 5: Commit** `git commit -m "feat(knowledge): buildKnowledgeChunks 跨源切块(纯函数 TDD)"`

### Task 6: 重建索引端点 + 嵌入补全
**Files:** Create `apps/api/src/routes/knowledge.ts` + `.test.ts`；Modify `apps/api/src/server.ts`

- [ ] **Step 1: 失败测试**（buildApiServer({env:{}}) + 注入内存 knowledgeIndexRepository + rawMaterialRepository）
```ts
// POST /api/knowledge/rebuild → 200 {chunkCount>=1};
// 之后 knowledgeIndexRepository.listAll() 非空、含来自 seed 资产的块;
// 注入一个 completed 会话+冷层 turns → rebuild 后含 transcript 块。
```
- [ ] **Step 2: 失败** Run: `npx vitest run apps/api/src/routes/knowledge.test.ts`
- [ ] **Step 3: 实现** `registerKnowledgeRoutes(server, productRepo, rawMaterialRepo, knowledgeRepo, { embeddingClient, budget })`：
  - `POST /api/knowledge/rebuild`：取 state；从 rawMaterialRepo 取所有 completed 会话的 turns 组 Map；`chunks = buildKnowledgeChunks(state, map)`；**批量嵌入**（embeddingClient 可用且预算允许 → `embed(chunks.map(c=>c.text))` 分批，回填 embedding；失败/无 client → 留空走关键词）；`knowledgeRepo.deleteAll()` + 逐条 `put`；记 audit `knowledge_index_rebuilt`；返回 `{ chunkCount }`。
  - 导出 helper `embedChunks(chunks, embeddingClient, budget): Promise<KnowledgeChunk[]>`（离线安全）。
- [ ] **Step 4: server.ts 装配** 同 rawMaterial 模式：`createDefaultKnowledgeIndexRepository`（sqlite 同目录 `knowledge.sqlite` / 内存）、`BuildApiServerOptions.knowledgeIndexRepository?`、注册 `registerKnowledgeRoutes(...)`。
- [ ] **Step 5: 通过 + tsc** Run: `npx vitest run apps/api/src/routes/knowledge.test.ts && npx tsc -p apps/api/tsconfig.json`
- [ ] **Step 6: Commit** `git commit -m "feat(api): 知识索引重建端点 + 批量嵌入(离线安全) + 装配"`

---

## M3 — 增量索引（持久化边界 diff）

### Task 7: diffIndexableSources + reindexOnStateChange
**Files:** Modify `src/domain/knowledge.ts` + `.test.ts`；Create reindex helper in `apps/api/src/routes/knowledge.ts`；Modify `apps/api/src/routes/state.ts`、`import.ts`、`interview-sessions.ts`

- [ ] **Step 1: diffIndexableSources 失败测试**（src/domain/knowledge.test.ts）
```ts
import { diffIndexableSources } from "./knowledge";
// 给 prev/next 两个 state(memoryRecords 增一条/改一条/删一条)→ 返回 {changed:[{sourceType,sourceId}], removed:[...]}
```
- [ ] **Step 2-4: 实现 diffIndexableSources(prev, next)**：对 note/memory/theme/point/decision/debt 各数组按 id 比对：next 有 prev 无或内容变 → changed；prev 有 next 无 → removed。返回 `{ changed: {sourceType,sourceId,...}[], removed: {sourceType,sourceId}[] }`。纯函数。跑测试红→绿。
- [ ] **Step 5: reindexOnStateChange helper**（knowledge.ts route）：`async reindexOnStateChange(prev, next, rawTurnsBySession, knowledgeRepo, embeddingClient, budget)`：用 diffIndexableSources；对 removed → `deleteBySource`；对 changed → 重建该来源的块（buildKnowledgeChunks 对单源的子集 + 嵌入）→ `replaceSource`。失败只 warn。
- [ ] **Step 6: 接持久化边界**（state.ts 的 PUT /api/state、各写状态端点的 replaceState 处——**集中在 repository.replaceState 的调用包装**或 state.ts PUT）：拿到 prev=stored、next=incoming，replaceState 后 `void reindexOnStateChange(prev, next, ...)`（异步、不阻塞响应）。/end 后补该会话 transcript 索引；import 后补该 importSource material 索引。
- [ ] **Step 7: 端点测试** state.test.ts/import.test.ts 加：改一条 memory PUT 后该 source 的块被更新；导入文档后 material 块入索引。
- [ ] **Step 8: tsc + 通过 + Commit** `git commit -m "feat(knowledge): 持久化边界 diff 增量索引 + /end·import 补点"`

---

## M4 — 资产对话端点

### Task 8: chat 域函数（TDD）
**Files:** Modify `src/domain/knowledge.ts` + `.test.ts`

- [ ] **Step 1: 失败测试** createChatSession/appendChatMessage/renameChatSession/deleteChatSession/capChatSessions：新建空会话；追加消息（user/assistant，updatedAt 更新）；改标题；删；超 50 会话按 updatedAt 淘汰旧的；单会话超 200 条截断旧消息；不可变 + 审计 chat_session_created。
- [ ] **Step 2-4: 实现** 纯函数（cloneState/makeId/nowIso/withAuditEvent，封顶常量 MAX_CHAT_SESSIONS=50/MAX_CHAT_MESSAGES=200）。红→绿。
- [ ] **Step 5: Commit** `git commit -m "feat(knowledge): chat 会话域函数(新建/追加/封顶/删 TDD)"`

### Task 9: POST /api/chat（检索 + 通用接地 prompt + 引用）
**Files:** Create `apps/api/src/routes/chat.ts` + `.test.ts`；Modify `src/domain/knowledge.ts`（rankKnowledgeChunks + buildChatPrompt）、`server.ts`

- [ ] **Step 1: rankKnowledgeChunks + buildChatPrompt 失败测试**（knowledge.ts）：rankKnowledgeChunks(chunks, queryEmbedding?, queryText, topK) → 有 queryEmbedding 走余弦、否则关键词重叠，返回 topK；buildChatPrompt(retrieved, history, message) → 含通用助手指令 + 编号片段 + "区分资料与推断"。红→绿。
- [ ] **Step 2: chat 端点失败测试**（buildApiServer + 注入内存 knowledgeRepo（put 几块）+ mock bailianChatClient 返回固定答案）：POST /api/chat {message:"我担心什么?"} → 200，返回 state.chatSessions 多一个会话含 user+assistant 两条、assistant.citations 来自命中块；再 POST 带 sessionId 追加；无 chatClient/超预算 → 降级消息不报错。
- [ ] **Step 3: 实现** `registerChatRoutes(server, productRepo, knowledgeRepo, { embeddingClient, bailianChatClient, budget })`：
  - 读 state；embed message（可选）→ `rankKnowledgeChunks` topK；`buildChatPrompt`；`bailianChatClient.complete(...)`（预算门）→ answer；映射命中块为 citations；用域函数 createChatSession(若无 sessionId)/appendChatMessage 追加 user+assistant；`replaceState`；返回 `{ session, answer, citations }`。离线/超预算 → appendChatMessage 一条诚实降级 assistant 文案。
- [ ] **Step 4: server.ts** 注册 registerChatRoutes（传 knowledgeIndexRepository + bailianChatClient + embeddingClient + budget）。
- [ ] **Step 5: 通过 + tsc + Commit** `git commit -m "feat(api): POST /api/chat 通用助手(检索+接地+引用+离线降级)"`

---

## M5 — 素材库 UI

### Task 10: productApi + 素材库视图 + 导航
**Files:** Modify `src/api/productApi.ts`、`src/ui.ts`、`src/ui.test.ts`、`src/App.tsx`；Create `src/features/material/MaterialLibraryView.tsx`

- [ ] **Step 1: productApi** 加 `importDocument(title, content, sourceType?)`（POST /api/import/documents）、`rebuildKnowledgeIndex()`（POST /api/knowledge/rebuild）。
- [ ] **Step 2: 导航** ui.ts 「认知资产」组加 `{ id: "material", label: "素材库" }`（放 notes 之后）；View 类型 + navIconByView 补 material（lucide 如 `Library`）；ui.test.ts 对应 flat id 列表加 "material"。
- [ ] **Step 3: MaterialLibraryView** 行为：导入框（textarea 粘贴 + `<input type=file accept=".txt,.md">` 读为文本）→ importDocument → 刷新；列表渲染 `state.importSources`（标题/sourceType/createdAt/chunkIds.length/sensitivity）+ 删除（复用现有删除 importSource 的域函数/端点，若无则加最小 `deleteImportSource` 域函数 + 连带 knowledge deleteBySource("material",id)）；「重建知识索引」按钮 → rebuildKnowledgeIndex → 进度/结果提示。App.tsx `view==="material"` 渲染并透传 state + productApiClient。
- [ ] **Step 4: tsc + 手测占位 + Commit** `git commit -m "feat(web): 素材库视图(导入/列表/删除/重建索引)+ 导航"`

---

## M6 — 资产对话 UI

### Task 11: 资产对话视图 + 导航 + 引用跳源
**Files:** Modify `src/api/productApi.ts`、`src/ui.ts`、`src/ui.test.ts`、`src/App.tsx`；Create `src/features/chat/AssetChatView.tsx`

- [ ] **Step 1: productApi** 加 `sendChatMessage(sessionId | null, message)`（POST /api/chat → 返回 {state/session, answer, citations}，前端 adoptServerState）。
- [ ] **Step 2: 导航** ui.ts 加 `{ id: "asset-chat", label: "资产对话" }`；View + navIcon（lucide `MessagesSquare`）；ui.test.ts flat 列表加 "asset-chat"。
- [ ] **Step 3: AssetChatView** 行为：左列会话列表（state.chatSessions，新建/选中/删除[域函数 deleteChatSession+autosave]）+ 右列消息流（user/assistant 气泡，assistant 引用条可点）+ 输入框（sendChatMessage，发送时乐观加 user 气泡 + loading）。引用点击：transcript→打开证据链查看器（复用 RawMaterialViewer，sourceId 拆 sessionId#turnId 定位）、memory/asset→切到对应视图并高亮（最小：切 view + notice）。加载/空/离线降级态。App.tsx `view==="asset-chat"` 渲染透传。
- [ ] **Step 4: tsc + 手测占位 + Commit** `git commit -m "feat(web): 资产对话视图(会话/消息流/引用跳源)+ 导航"`

---

## M7 — 治理 + 回归

### Task 12: purge 清索引 + 删素材连带 + 全量回归
**Files:** Modify `apps/api/src/routes/state.ts`、`server.ts`、`apps/api/src/routes/state.test.ts`

- [ ] **Step 1: 失败测试** purge(all) 后 `knowledgeIndexRepository.listAll()` 为空（state 路由 options 注入 knowledgeIndexRepository；purge all → `knowledgeIndexRepository?.deleteAll()`）。删 importSource → 其 material 块从索引删（已在 Task 10 域/端点处理，补一条断言）。
- [ ] **Step 2-4: 实现** state 路由 options 加 `knowledgeIndexRepository?`；purge all 调 deleteAll；server.ts 传入。红→绿。
- [ ] **Step 5: 双 tsc + 全量** Run: `npx tsc -p tsconfig.json --noEmit && npx tsc -p apps/api/tsconfig.json && npx vitest run`；Expected: 全绿（当前 95 文件不破 + 新增）。
- [ ] **Step 6: 端到端手测**（需服务）：素材库导入一段文本 → 重建索引 → 资产对话提问 → 得到带引用的答案、点引用跳源 → 改一条记忆后该来源块增量更新（看 listAll）。**chat 真实 LLM 链需手测**（mock 已覆盖逻辑）。
- [ ] **Step 7: Commit** `git commit -m "feat(governance): purge 清知识索引 + 删素材连带删块 + 回归"`

---

## 自审记录
- **spec 覆盖**：§3.1 索引仓→T3/T4；§3.2 chatSessions→T1/T2；§4 切块嵌入→T5/T6；§5 增量 diff→T7；§6 chat→T8/T9；§7 UI→T10/T11；§8 治理→T12；§9 测试散各 Task + T12 手测；§10 YAGNI（无 PDF/向量库/agent）贯穿。
- **命名一致**：`KnowledgeChunk`/`KnowledgeSourceType`/`ChatSession`/`KnowledgeIndexRepository`(put/replaceSource/deleteBySource/deleteAll/listAll)/`buildKnowledgeChunks`/`diffIndexableSources`/`reindexOnStateChange`/`rankKnowledgeChunks`/`buildChatPrompt`/`createChatSession`/`appendChatMessage`/`sendChatMessage`/`rebuildKnowledgeIndex` 全程一致。
- **已知不可 headless 验证**：真实嵌入/LLM chat 链（T9/T12 用 mock 覆盖逻辑，真实链手测）。
- **留白（执行者决策）**：material 切块粒度（v1 每 importSource 一块 vs 复用 ragChunks 多块）——T5 注明可二选一；引用跳转 memory/asset 的高亮深度——T11 最小实现（切 view+notice）。
