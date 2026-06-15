# Phase 6: 结构清理 + 测试 + 成本护栏 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** 删掉死代码 mastra；给"产品价值所在却几乎没测"的 LLM 层补关键单测；给 per-turn LLM 调用加 token 上限与每会话预算护栏。

**Architecture:** (1) 物理删除 `packages/mastra` 并清掉残留的 `mastra-runtime` 分支/字符串；(2) 为 `llm-json` 解析器、7 个 intelligence 解析器、若干 LLM 路由补测试（mock chatClient / search client）；(3) `createBailianChatClient.complete` 加默认 `max_tokens`，`createAssistantTurn` 显式传 maxTokens，并加一个每会话 LLM 调用计数的软预算。

**Tech Stack:** TypeScript, vitest, Fastify。

---

### Task 1: 删除 packages/mastra 死代码

**Files:**
- Delete: `packages/mastra/`（整目录，2438 行）
- Modify: `apps/api/src/workflow-runtime.ts`（去掉 `mastra` 分支）、`src/domain/types.ts` / `src/domain/privacy.ts`（`"mastra-runtime"` 字面量）、`apps/api/src/routes/quality.ts`（注释）

- [ ] **Step 1: 确认零引用**
Run: `grep -rn "packages/mastra\|from \"mastra\|@mastra\|mastra-runtime" src apps --include=*.ts | grep -v "test"`
确认只剩 `workflow-runtime.ts` 的分支判断、`types.ts`/`privacy.ts` 的 providerId 字符串、`quality.ts` 注释——没有真正的 import。

- [ ] **Step 2: 删除目录 + 清理残留**
```bash
git rm -r packages/mastra
```
- `workflow-runtime.ts`：删掉 `WORKFLOW_RUNTIME_PROVIDER === "mastra"` 的分支（保留 `deterministic-engine` 等真实分支）。
- `types.ts`/`privacy.ts`：把 `"mastra-runtime"` 从 providerId 联合/默认值里移除（若它是某 union 成员，确认无运行时数据依赖它；改为 `"deterministic-engine"`）。
- `quality.ts:4` 注释更新为"内联自原 scorers（mastra 已删除）"。

- [ ] **Step 3: 全量回归**
Run: `npx tsc -b` → 0；`npm run typecheck:api`（Phase 3 后）→ 0；`npx vitest run` → 全绿；`npx vite build` → OK。

- [ ] **Step 4: 提交**
```bash
git add -A
git commit -m "chore: delete dead packages/mastra (2438 LOC) and the vestigial mastra-runtime branch"
```

---

### Task 2: 给 LLM 层补关键单测

**Files:**
- Create: `apps/api/src/intelligence/llm-json.test.ts`
- Create: `apps/api/src/intelligence/finalize-llm.test.ts`、`corpus-llm.test.ts`、`memory-extraction-llm.test.ts`、`intel-triage-llm.test.ts`、`search-synthesis-llm.test.ts`、`pre-signals-llm.test.ts`
- Create: `apps/api/src/routes/llm-routes.test.ts`

- [ ] **Step 1: 测 `llm-json`（所有解析器的地基）**
`llm-json.test.ts`：
```ts
import { describe, expect, it } from "vitest";
import { asArray, asObject, asString, asStringArray, parseJsonObject, stripCodeFences } from "./llm-json";

describe("llm-json", () => {
  it("strips ```json fences before parsing", () => {
    expect(parseJsonObject("```json\n{\"a\":1}\n```")).toEqual({ a: 1 });
  });
  it("throws on a non-object top level", () => {
    expect(() => parseJsonObject("[1,2]")).toThrow();
    expect(() => parseJsonObject("not json")).toThrow();
  });
  it("coerces defensively", () => {
    expect(asString(7)).toBe("");
    expect(asStringArray(["a", 1, " b "], ["x"])).toEqual(["a", "b"]);
    expect(asStringArray("nope", ["x"])).toEqual(["x"]);
    expect(asArray("nope")).toEqual([]);
    expect(asObject(null)).toEqual({});
  });
});
```

- [ ] **Step 2: 每个 intelligence 模块一个 mock-client 测试**
模式（以 finalize-llm 为例，其余照搬结构）：mock `BailianChatClient.complete` 返回**畸形/缺字段** JSON，断言要么抛错（让路由回退）、要么按既有 coercion 产出安全结果。重点覆盖 **prompt 注入净化已在 Phase 1 测**，这里测**解析健壮性**：空数组、缺字段、`relevance` 非数字（intel-triage 的 `clampRelevance`）、`maturity` 非法值（finalize 的 `clampMaturity`）、`reviewAt` 格式错（finalize 的 `normalizeReviewAt`）。每个文件至少 2 个用例。

- [ ] **Step 3: 关键 LLM 路由测试（无 key → 走 fallback；mock client → 走 LLM）**
`llm-routes.test.ts`：用 `buildApiServer({ env: {} })`（无 key）打 `/api/interview-sessions/:id/end`、`/api/corpus/insights`、`/api/reviews`、`/api/import/documents`、`/api/intel/tasks` + `/run`，断言**全部 200 且走确定性 fallback 不报错**；再用注入的 mock chatClient 断言 LLM 路径产出结构正确。

- [ ] **Step 4: 跑全部新测试**
Run: `npx vitest run apps/api/src/intelligence apps/api/src/routes/llm-routes.test.ts` → 全绿。

- [ ] **Step 5: 提交**
```bash
git add apps/api/src/intelligence/*.test.ts apps/api/src/routes/llm-routes.test.ts
git commit -m "test(llm): cover llm-json, all intelligence parsers, and LLM-route fallbacks"
```

---

### Task 3: token 上限 + 每会话 LLM 预算护栏

**Files:**
- Modify: `apps/api/src/providers/bailian.ts`（`complete` 默认 max_tokens；`createAssistantTurn` 传 maxTokens）
- Create: `apps/api/src/llm-budget.ts`（每 session 调用计数）
- Modify: `apps/api/src/routes/interview-sessions.ts`（turn + pre-signals 走预算）
- Test: `apps/api/src/llm-budget.test.ts`

- [ ] **Step 1: 写失败测试** — 超预算的会话拒绝继续 LLM 调用
```ts
import { describe, expect, it } from "vitest";
import { createLlmBudget } from "./llm-budget";

describe("llm budget", () => {
  it("allows up to N calls per session then blocks", () => {
    const b = createLlmBudget({ maxCallsPerSession: 2 });
    expect(b.tryConsume("s1")).toBe(true);
    expect(b.tryConsume("s1")).toBe(true);
    expect(b.tryConsume("s1")).toBe(false); // 第 3 次被拦
    expect(b.tryConsume("s2")).toBe(true);  // 另一会话独立
  });
});
```

- [ ] **Step 2: 跑测试确认失败**（模块不存在）。

- [ ] **Step 3: 实现 `createLlmBudget`**
`apps/api/src/llm-budget.ts`：内存 `Map<sessionId, count>`，`tryConsume(sessionId): boolean`（< max 则 +1 返回 true，否则 false），`reset(sessionId)`。默认 `maxCallsPerSession` 从 env `LLM_MAX_CALLS_PER_SESSION ?? 200`。

- [ ] **Step 4: 接线 + token 上限**
- `bailian.ts` `complete`：`max_tokens` 默认（input.maxTokens ?? 2048），仍允许调用方覆盖。
- `createAssistantTurn`：传 `maxTokens: 800`（一句追问够用）。
- `interview-sessions.ts` 的 `/turns` 与 `/pre-signals`：调用前 `if (!budget.tryConsume(session.id)) { /* 跳过 LLM，走确定性 + 结构化日志 */ }`；session `/end` 时 `budget.reset(session.id)`。

- [ ] **Step 5: 跑测试 + 全量**，提交：
```bash
git add apps/api/src/providers/bailian.ts apps/api/src/llm-budget.ts apps/api/src/llm-budget.test.ts apps/api/src/routes/interview-sessions.ts
git commit -m "feat(cost): default max_tokens + per-session LLM call budget guard"
```

---

## Self-Review
- **Spec coverage**：审计 G（mastra 死代码 → Task 1；LLM 层 1/8 测试 → Task 2；per-turn 无 token/预算上限 → Task 3）。
- **Placeholder 扫描**：Task 2 Step 2 用"模式 + 至少 2 用例/文件"描述而非逐文件抄完整代码——给了具体覆盖点（clampRelevance/clampMaturity/normalizeReviewAt/空数组/缺字段）和可验证标准（全绿）。这是测试任务的合理粒度；执行者照 finalize 样例套用。
- **类型一致性**：`createLlmBudget({maxCallsPerSession}).tryConsume(sessionId)` 签名贯穿测试与接线。
- **顺序建议**：本 Phase 放最后；Task 1（删 mastra）依赖 Phase 3 的后端类型检查已能验证删除无遗漏。
