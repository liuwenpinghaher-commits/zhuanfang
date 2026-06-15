# Phase 2: 状态一致性 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** 消除"在线↔离线切换处丢 turn / 整份 god-object 无版本号互相覆盖"的数据正确性问题。

**Architecture:** (1) 给 `ProductState` 加单调递增 `revision`，每次服务端写入 +1；(2) 整份 PUT (`/api/state`) 加乐观并发检查（旧版本拒绝）并在前端 debounce；(3) 专访 turn 流改为 API 权威 —— 在线时 API 失败不再本地分叉（文字），语音 turn 通过新增 `record-turn` 端点写回服务端 session。

**Tech Stack:** TypeScript, Fastify, vitest, React。

---

### Task 1: ProductState.revision 基础设施

**Files:**
- Modify: `src/domain/types.ts` (ProductState 加 `revision: number`)
- Modify: `src/domain/seed.ts` (加 `revision: 0`)
- Modify: `src/domain/storage.ts` (normalize 加一行)
- Modify: `apps/api/src/product-state-repository.ts` + `packages/db/src/sqlite-product-state-repository.ts` (replaceState 时 +1)
- Test: `src/domain/storage.test.ts` (新增 revision normalize 用例) + `apps/api/src/product-state-repository.test.ts`

- [ ] **Step 1: 写失败测试** — normalize 默认补 0、repo 写入 +1

`src/domain/storage.test.ts` 追加：
```ts
it("defaults revision to 0 when missing and preserves a numeric revision", () => {
  expect(normalizeProductState({}).revision).toBe(0);
  expect(normalizeProductState({ revision: 7 }).revision).toBe(7);
});
```
`apps/api/src/product-state-repository.test.ts` 追加（若文件不存在则新建，import `createInMemoryProductStateRepository`）：
```ts
it("bumps revision on every replaceState", () => {
  const repo = createInMemoryProductStateRepository();
  const r0 = repo.getState().revision;
  const next = repo.replaceState(repo.getState());
  expect(next.revision).toBe(r0 + 1);
});
```

- [ ] **Step 2: 跑测试确认失败** — `npx vitest run src/domain/storage.test.ts apps/api/src/product-state-repository.test.ts` → FAIL（revision 不存在）。

- [ ] **Step 3: 加字段**
- `types.ts` ProductState 末尾加 `revision: number;`
- `seed.ts` initialProductState 加 `revision: 0,`
- `storage.ts` normalize 返回对象里加：`revision: typeof candidate.revision === "number" ? candidate.revision : fallback.revision,`
- `src/domain/types.test.ts` 的全量 ProductState 字面量加 `revision: 0,`（否则 Phase 3 后 tsc 会报缺字段）

- [ ] **Step 4: repos 写入 +1**

`apps/api/src/product-state-repository.ts` 的 `replaceState`：写入前 `const next = { ...state, revision: (current?.revision ?? 0) + 1 }`（保留其余逻辑，存 `next`，返回 `next`）。
`packages/db/src/sqlite-product-state-repository.ts` 的 `persistState`（replace 分支）同理：持久化前把 `normalizedState.revision = (readPersistedState()?.revision ?? 0) + 1`。
> `resetState`/`seed` 把 revision 设 0。

- [ ] **Step 5: 跑测试确认通过** — `npx vitest run` → 期望全绿（含新用例）。`npx tsc -b` → 0。

- [ ] **Step 6: 提交**
```bash
git add src/domain/types.ts src/domain/seed.ts src/domain/storage.ts src/domain/storage.test.ts src/domain/types.test.ts apps/api/src/product-state-repository.ts apps/api/src/product-state-repository.test.ts packages/db/src/sqlite-product-state-repository.ts
git commit -m "feat(state): add monotonic ProductState.revision, bumped on every server write"
```

---

### Task 2: 整份 PUT 乐观并发 + 前端 debounce

**Files:**
- Modify: `apps/api/src/routes/state.ts` (PUT /api/state 加版本检查)
- Modify: `src/api/productApi.ts` (`saveState` 处理 409)
- Modify: `src/App.tsx` (lines 168-183 的 PUT effect 加 debounce)
- Test: `apps/api/src/routes/state.test.ts`（或 new-routes.test.ts 追加）

- [ ] **Step 1: 写失败测试** — 旧 revision 的 PUT 被 409 拒绝

```ts
it("rejects a stale whole-state PUT with 409", async () => {
  const server = buildApiServer();
  const cur = (await server.inject({ method: "GET", url: "/api/state" })).json();
  // 先用更高 revision 写一次（模拟另一端推进）
  await server.inject({ method: "PUT", url: "/api/state", payload: { ...cur, revision: cur.revision + 5 } });
  // 再用旧 revision 写 —— 应被拒
  const stale = await server.inject({ method: "PUT", url: "/api/state", payload: { ...cur, revision: cur.revision } });
  expect(stale.statusCode).toBe(409);
  await server.close();
});
```

- [ ] **Step 2: 跑测试确认失败**（当前 PUT 永远 200）。

- [ ] **Step 3: PUT 加版本检查**

`apps/api/src/routes/state.ts` 的 PUT handler：读取 `const stored = repository.getState()`；若 `typeof body.revision === "number" && body.revision < stored.revision` → `reply.code(409).send({ error: "stale revision", current: stored })`；否则照常 `replaceState`（Task 1 会把 revision +1）。

- [ ] **Step 4: 前端处理 409 + debounce PUT**

`productApi.ts` `saveState`：若 response.status === 409 → 取响应里的 `current`，`return normalizeProductState(current)`（即采用服务端较新状态，放弃本次覆盖）。
`App.tsx` 的 `[apiPersistenceEnabled, productState]` PUT effect：用 300ms debounce 包一层（`setTimeout` + cleanup 清除），避免每次 keystroke 级 mutation 都 PUT。

- [ ] **Step 5: 跑测试确认通过** — `npx vitest run`，后端 tsc 自查。

- [ ] **Step 6: 提交**
```bash
git add apps/api/src/routes/state.ts src/api/productApi.ts src/App.tsx apps/api/src/routes/state.test.ts
git commit -m "fix(state): optimistic-concurrency guard on whole-state PUT + debounce client push"
```

---

### Task 3: 专访 turn API 权威化（消除分叉）

**Files:**
- Create: `POST /api/interview-sessions/:id/record-turn`（in `apps/api/src/routes/interview-sessions.ts`）— 仅追加 turn，不触发 LLM
- Modify: `src/api/productApi.ts` (`recordInterviewTurn`)
- Modify: `src/App.tsx` (`submitTurn` 在线失败不分叉；语音两处 `onUserTranscript` 改调 record-turn)
- Test: `apps/api/src/routes/interview-sessions.test.ts`（record-turn 行为）

- [ ] **Step 1: 写失败测试** — record-turn 把 turn 写进服务端 session 且不生成 assistant turn

```ts
it("record-turn appends a turn to the server session without generating an assistant reply", async () => {
  const server = buildApiServer({ env: {} }); // 无 key，确保不会有真实 LLM
  const created = (await server.inject({ method: "POST", url: "/api/interview-sessions", payload: { mode: "decision" } })).json();
  const id = created.session.id;
  const res = await server.inject({ method: "POST", url: `/api/interview-sessions/${id}/record-turn`, payload: { role: "user", content: "语音转写的一句话" } });
  const session = res.json().session;
  expect(session.turns.at(-1).role).toBe("user");
  expect(session.turns.at(-1).content).toBe("语音转写的一句话");
  // 不应自动追加 assistant turn
  expect(session.turns.filter((t: any) => t.role === "assistant").length).toBe(created.session.turns.filter((t: any) => t.role === "assistant").length);
  await server.close();
});
```

- [ ] **Step 2: 跑测试确认失败**（端点不存在 → 404）。

- [ ] **Step 3: 实现 record-turn 端点**

在 `registerInterviewSessionRoutes` 内加：
```ts
server.post("/api/interview-sessions/:id/record-turn", async (request, reply) => {
  const state = repository.getState();
  const session = findSession(state, getSessionId(request.params));
  if (!session) return reply.code(404).send({ error: "Interview session not found." });
  const body = normalizeObject<{ role?: unknown; content?: unknown }>(request.body);
  const role = body.role === "assistant" ? "assistant" : "user";
  const content = normalizeOptionalString(body.content);
  if (!content) return reply.code(422).send({ error: "content is required." });
  const turn = { id: makeId("turn"), role, content, intent: role === "user" ? "语音用户输入" : "语音助手回应", timestamp: nowIso() } as InterviewSession["turns"][number];
  const nextSession = { ...session, turns: [...session.turns, turn] };
  const nextState = upsertSession(state, nextSession);
  repository.replaceState(nextState);
  return { session: nextSession, state: nextState };
});
```
（`makeId`/`nowIso` 从 `../../../../src/domain/engine` import。）

- [ ] **Step 4: 前端接线**

`productApi.ts` 加 `recordInterviewTurn(sessionId, { role, content })` → POST 上述端点，返回 `{ session, state: normalize(state) }`。
`App.tsx`：
- `submitTurn`：在 `apiPersistenceEnabled` 为 true（在线）时，API 失败**不再** `setSession(receiveUserTurn(...))`；改为 `setNotice(buildNotice("warning","未送达","本轮未送到服务端，请重试"))` 并保留 `interviewInput`（不清空），return。仅当 `!apiPersistenceEnabled`（纯离线）才走本地 `receiveUserTurn`。
- 语音两处 `onUserTranscript`（LiveKit ~948 / Bailian WS ~1033）：把 `setSession(prev => receiveUserTurn(prev, text))` 改为 `productApiClient.recordInterviewTurn(sessionId, { role: "user", content: text }).then(r => setSession(r.session)).catch(() => setSession(prev => prev ? receiveUserTurn(prev, text) : prev))`（在线写服务端，失败才本地兜底）。

- [ ] **Step 5: 跑测试 + 全量** — `npx vitest run`、后端 tsc 自查、`npx tsc -b`。

- [ ] **Step 6: 提交**
```bash
git add apps/api/src/routes/interview-sessions.ts apps/api/src/routes/interview-sessions.test.ts src/api/productApi.ts src/App.tsx
git commit -m "fix(state): API-authoritative interview turns; record-turn endpoint keeps voice transcripts on the server session"
```

---

## Self-Review

- **Spec coverage**：审计 B 的三条（turn 丢失 C1/C2 → Task 3；整份 clobber C3/C4 → Task 2；无版本 → Task 1）全覆盖。
- **类型一致性**：`revision: number` 贯穿 types/seed/normalize/types.test/repos；`recordInterviewTurn` 返回 `{session,state}` 与既有 `InterviewSessionResponse` 同形。
- **Placeholder 扫描**：无；端点与前端改动都给了完整代码。
- **遗留**：本 Phase 不重写每个本地 mutation 为独立端点（YAGNI）——靠 Task 2 的 debounce + 乐观并发把整份 PUT 的风险压到可接受；彻底的 per-resource 端点化留作未来。
