# Phase 3: 后端类型安全网 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** 让 `apps/api/` 被 TypeScript 真正类型检查并纳入构建；修掉一直裸奔的 ~6–9 个潜在后端类型错误。

**Architecture:** 新增 `apps/api/tsconfig.json`（Node 侧配置，`noEmit`，排除 `zhuanfang/`），把它接进 `build`/`typecheck` 脚本；然后逐一修复 `tsc` 报出的真实错误直到归零。

**Tech Stack:** TypeScript, tsc。

---

### Task 1: 新增后端 tsconfig 并接进构建

**Files:**
- Create: `apps/api/tsconfig.json`
- Modify: `package.json` (`build` / 新增 `typecheck:api`)

- [ ] **Step 1: 创建 `apps/api/tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "moduleResolution": "Node",
    "strict": true,
    "skipLibCheck": true,
    "esModuleInterop": true,
    "allowSyntheticDefaultImports": true,
    "resolveJsonModule": true,
    "forceConsistentCasingInFileNames": true,
    "isolatedModules": true,
    "noEmit": true,
    "jsx": "react-jsx"
  },
  "include": ["src"],
  "exclude": ["node_modules", "../../node_modules", "../../zhuanfang", "../../dist"]
}
```
> `include:["src"]` = `apps/api/src`；tsc 会顺 import 检查到 `../../../../src/domain/*`。`exclude` 必须含 `../../zhuanfang`，否则旧副本会制造 ProductState 类型冲突的假错误。

- [ ] **Step 2: 接进 npm scripts**

`package.json`：
- `"build": "tsc -b && tsc -p apps/api/tsconfig.json && vite build"`
- 新增 `"typecheck:api": "tsc -p apps/api/tsconfig.json"`
- 新增 `"typecheck": "tsc -b && tsc -p apps/api/tsconfig.json"`

- [ ] **Step 3: 跑后端类型检查，记录真实错误清单**

Run: `npm run typecheck:api 2>&1 | grep "error TS"`
把输出的每条 `file:line: error TS...` 抄到一张清单（这是 Task 2 的待办）。确认 **没有任何 `zhuanfang/` 路径**出现（出现说明 exclude 没生效，回 Step 1 修）。

- [ ] **Step 4: 提交（此时后端可能仍报错，但 tsconfig 已就位）**
```bash
git add apps/api/tsconfig.json package.json
git commit -m "build(types): add apps/api tsconfig and wire backend type-checking into build"
```

---

### Task 2: 修复后端潜在类型错误（逐条归零）

**Files:** 按 Task 1 Step 3 清单。已知项及修法如下（以 `npm run typecheck:api` 实际输出为准）：

- [ ] **Step 1: `realtime-voice.ts:244` —— 与 `"mature"` 比较（主题成熟度无此值）**
读该行上下文。`LongTermTheme["maturity"]` 合法值是 `萌芽|重复|聚焦|成型|变化|关闭`，`"mature"` 永远 false（死分支）。判断意图：若是"主题已成熟"，改为 `=== "成型"`；若分支本就无用，删除。改完该行有真实语义。

- [ ] **Step 2: `system.ts:338` —— RuntimeSettingDefinition 缺 `description`**
给该 settings 对象补一行 `description: "<这一项的说明>"`（参考同文件其它 settings 的 description 写法）。

- [ ] **Step 3: `search.ts:68` —— `SearchBriefInput | undefined` 传给非空形参**
在 `createSearchBriefFromInput(state, enriched)` 之前加守卫：
```ts
if (!run.result) {
  return reply.code(502).send({ task: run.task });
}
const enriched = await enrichBriefInput(run.result, options.bailianChatClient);
```
（`run.result` 在 `task.status === "failed"` 时为 undefined，这里显式收窄。）

- [ ] **Step 4: `bailian.ts:862` —— `string | false` 赋给 `boolean`**
该处把表达式用 `Boolean(...)` 包一层（或 `!!`），确保是 `boolean`。

- [ ] **Step 5: `quality.ts:143` —— `{}` 不满足 `Record<string, unknown>`**
给该空对象显式标注类型或改为 `{} as Record<string, unknown>`（先确认它确实应是可空 Record；否则补上应有字段）。

- [ ] **Step 6: `server.ts:185/226`、`sqlite-product-state-repository.ts:64` 等剩余项**
逐条按 tsc 提示修：
- 隐式 any 的 `request/reply`：补 Fastify 类型或确认是否随 tsconfig 正确解析后消失（很可能消失）。
- `string | undefined` → `string`：加 `?? ""` 或显式守卫。
- repo 缺 `getInterviewSession`：若 `ProductStateRepository` 接口确有此方法，给 sqlite repo 补实现（委托给内存逻辑）；若该方法实际无人用，从接口移除。

- [ ] **Step 7: 归零 + 全量回归**
Run: `npm run typecheck:api 2>&1 | grep -c "error TS"` → 期望 `0`。
Run: `npx tsc -b` → 0（前端）。
Run: `npx vitest run` → 全绿。

- [ ] **Step 8: 提交**
```bash
git add -A
git commit -m "fix(types): resolve latent backend type errors now that apps/api is type-checked"
```

---

## Self-Review
- **Spec coverage**：审计 A（后端不被检查 + 潜在错误）→ Task 1（接进构建）+ Task 2（逐条修）。
- **Placeholder 风险**：Task 2 是"按真实 tsc 输出修"，每条已知项给了具体修法；剩余项给了判定规则 + 验证（tsc 归零）。这是修 latent error 的合理形态——清单来自工具，不是凭空。
- **依赖**：本 Phase 与 1、2 独立，但**建议在 Phase 2 之后做**（Phase 2 给 ProductState 加了 `revision`，`types.test.ts` 字面量已同步；否则后端 tsc 会新报缺 `revision`）。若先做本 Phase，需把"补 revision"也算进 Task 2。
