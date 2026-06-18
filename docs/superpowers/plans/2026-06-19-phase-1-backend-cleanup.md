# 阶段 1 · 后端清账 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development。每 Task 派 fresh subagent,TDD(先失败测试→实现→绿)。Steps 用 checkbox。

**Goal:** 让"代码=实际能力":补回真实可达的数据治理端点、扩全 LLM 预算守卫、决策日志落库、删净已确认死代码,并诚实核销已被前序重构解决的条目。

**Architecture:** 主在 `apps/api/src/`(Fastify 路由注册)+ `src/domain/`(已存在但未接线的 privacy/backup 逻辑)。多数 P0 端点的**业务逻辑已存在**(privacy.ts/backup.ts),阶段 1 是**接线 + 测试**。

**Tech Stack:** TypeScript, Fastify, Vitest。验证:`npm run typecheck` / `npx vitest run`。

主设计:`docs/superpowers/specs/2026-06-18-notebook-paradigm-refactor-design.md` 第 4 节阶段 1 表。探查基准:当前已注册路由见该 spec 调查(`GET/PUT /api/state`、`/api/state/reset` 等约 50 条;**缺** export/import/purge/privacy-report)。

---

## 调查结论:21 条的真实状态(写计划前已用 grep 核实)

**已被前序重构解决、本阶段零代码改动(仅核销):** P0-6(nextInterviewInstruction 由 strategy 填充非恒空)、P0-13(search.ts 已降级到本地 buildSearchBrief)、P1-1(interview-turn-runner 已 warn+aiRunEvent degraded)、P1-20(engine.ts 是 barrel re-export,strategy 不反向 import,无循环)、P2-2(external-search 顶层不存在)、P2-4(guidanceEngine 顶层不存在)、P2-7(mastra adapter 已清,仅迁移注释残留)。→ **Task 7 统一核销**。

**真接线(业务逻辑已存在):** P0-1/2/3(privacy.ts 有 `buildPrivacyReport`/`createPurgedProductState`;backup.ts 有导出构建器;均未注册路由)。

**真改动:** P0-4(Dockerfile 设 `PRODUCT_STATIC_DIR=/app/dist` 但 server 未托管静态)、P1-13(llm-budget 仅覆盖 interview-sessions)、P2-22(/decisions 仅 console.info)。

**死代码删除(已确认零外部引用):** P2-3(`apps/api/src/interview-turn-runner.ts` 零路由引用)、P2-5/P2-9(报告函数/contracts 接口,Task 5 内 grep 确认后删)。

**小清理:** P1-2(workflow-runtime 未用 env 参数 + PRODUCT_STATIC_DIR 未读已并入 T2)、P1-16(质量评分内联确定性,标注为启发式)、P2-21(`src/capabilities/search.ts` 的 `example.local` 占位 URL)、P1-4(docs 死链)。

**范围边界:** P0-2/P0-3 设计含"前端入口"——前端入口归**阶段 2**(信息架构前端重构)统一做,本阶段只接后端端点 + 测试,并在 commit message 注明前端入口待阶段 2。

---

## 通用约束(每 Task 适用)

- 真实代码在顶层 `src/`/`apps/`/`packages/`,**不是** zhuanfang/。grep 一律排除 zhuanfang/。
- 提交**只 `git add` 本 Task 改动的具体文件**,严禁 `git add -A/.`(仓库有大量无关未提交改动:zhuanfang/、CLAUDE.md、memory/、.claude/)。
- 每 Task 结束:`npm run typecheck` PASS + `npx vitest run` 全绿(无新增失败)+ `git status --short` 确认无关文件未暂存,再提交。
- TDD:先写失败测试→跑确认失败→最小实现→跑确认通过。

---

## Task 1: P0-1/2/3 — 接线数据治理端点(privacy-report / export / purge)

**Files:** Modify `apps/api/src/routes/state.ts`;Test 对应 state 路由测试(`apps/api/src/routes/state.test.ts` 或 server 级)。

- [ ] **Step 1:** 读 `apps/api/src/routes/state.ts` 现有注册(GET/PUT /api/state、/reset)的写法与 `repository` 接口(getState/replaceState)。读 `src/domain/privacy.ts` 的 `buildPrivacyReport(state)`、`createPurgedProductState(state)` 签名。读 `src/domain/backup.ts` 的导出构建器签名(grep export)。确认 import 已存在于 `apps/api/src/routes/import.ts`(`POST /api/import/documents`)——**不重复造**。
- [ ] **Step 2:** 写失败测试:
  - `GET /api/state/privacy-report` → 200,body 含 `buildPrivacyReport` 的结构(如 inventory 数组)。
  - `GET /api/state/export` → 200,body 是 backup 导出结构(含 state 快照/版本)。
  - `POST /api/state/purge` → 200,且之后 `GET /api/state` 反映已清空(用 `createPurgedProductState` 的语义断言,如资产数组清零、profile 保留与否依该函数实现)。
- [ ] **Step 3:** 跑确认失败(404 未注册)。
- [ ] **Step 4:** 实现:在 state.ts 注册三个路由,handler 调对应 domain 函数;purge 后 `repository.replaceState(purged)` 持久化。沿用现有路由的错误处理风格。
- [ ] **Step 5:** 跑确认通过 + 全量 typecheck/vitest。
- [ ] **Step 6:** 提交:只 add state.ts + 其测试,`git commit -m "feat(api): wire privacy-report/export/purge endpoints (P0-1, P0-2, P0-3)"`(注:前端入口待阶段 2)。

---

## Task 2: P0-4 + P1-2 — @fastify/static 托管前端 + 读取 PRODUCT_STATIC_DIR;清理未用 env 参数

**Files:** Modify `apps/api/src/server.ts`、`apps/api/src/workflow-runtime.ts`、`package.json`(加 @fastify/static);Test server 级测试。

- [ ] **Step 1:** 读 `apps/api/src/server.ts` 的插件注册区与 env 读取(`options.env ?? process.env`)。读 `apps/api/src/workflow-runtime.ts` 的 `createWorkflowRuntimeFromEnv(_env, _fetchImpl)`(参数声明未用)。确认 Dockerfile 用 `PRODUCT_STATIC_DIR=/app/dist`。
- [ ] **Step 2:** 装依赖:`npm config set strict-ssl false`(本机 TLS 拦截,见 [[npm-tls-strict-ssl]])后 `npm install @fastify/static@^8`(与 fastify 5 匹配的版本;装完 `npm config set strict-ssl true` 复原)。确认 package.json/lock 更新。
- [ ] **Step 3:** 写失败测试:当 env 含 `PRODUCT_STATIC_DIR` 指向一个含 `index.html` 的临时目录时,`GET /`(或非 /api 路径)返回该静态内容;未设时不影响现有 /api 路由。
- [ ] **Step 4:** 跑确认失败。
- [ ] **Step 5:** 实现:server.ts 在 env 有 `PRODUCT_STATIC_DIR` 时 `register(fastifyStatic, { root: PRODUCT_STATIC_DIR })`(放在 API 路由注册之后/或用 prefix 避免吞掉 /api);workflow-runtime.ts 删除未使用的 `_env`/`_fetchImpl` 参数(或若有实际用途则接上——以最小为准,删未用)。
- [ ] **Step 6:** 跑通过 + 全量 typecheck/vitest。
- [ ] **Step 7:** 提交:只 add server.ts + workflow-runtime.ts + 测试 + package.json + package-lock.json,`git commit -m "feat(api): serve PRODUCT_STATIC_DIR via @fastify/static; drop unused workflow-runtime env params (P0-4, P1-2)"`。

---

## Task 3: P1-13 — llm-budget 守卫覆盖全部 LLM 入口

**Files:** Modify 各 LLM 入口路由(`apps/api/src/routes/search.ts`、`corpus.ts`、`reviews.ts` 等实际调 LLM 的);Test 对应路由测试。

- [ ] **Step 1:** 读 `apps/api/src/llm-budget.ts` 的 `budget.tryConsume(key)` 用法,以及 `apps/api/src/routes/interview-sessions.ts` 现有接入点(:101/:165)。grep 全 `apps/api/src/routes` 找**所有实际触发 LLM 调用**的端点(search briefs/auto-briefs、corpus insights、reviews 等),列出当前**未**经 budget 的。
- [ ] **Step 2:** 写失败测试:对一个未覆盖的 LLM 端点,预算耗尽时应被拒(429 或既有约定状态),当前会放行 → FAIL。
- [ ] **Step 3:** 跑确认失败。
- [ ] **Step 4:** 实现:在每个 LLM 入口加 `budget.tryConsume` 守卫,复用 interview-sessions 的既有模式与错误响应形状。**仅加在真正调 LLM 的端点**,不误伤纯本地端点。
- [ ] **Step 5:** 跑通过 + 全量 typecheck/vitest。
- [ ] **Step 6:** 提交:只 add 改动的路由文件 + 测试,`git commit -m "fix(api): extend llm-budget guard to all LLM entry points (P1-13)"`。

---

## Task 4: P2-22 — /decisions 决策日志落库(写入 auditEvents)

**Files:** Modify `apps/api/src/routes/interview-sessions.ts`(:206-223 /decisions);可能 `src/domain/types.ts`(`AuditEvent` 形状确认);Test 对应测试。

- [ ] **Step 1:** 读 `apps/api/src/routes/interview-sessions.ts` 的 `/decisions`(当前仅 `console.info`)。读 `src/domain/types.ts` 的 `auditEvents: AuditEvent[]` 与 `AuditEvent` 结构,确认如何 append 一条审计事件并持久化(参考其它路由 append auditEvents 的写法,grep `auditEvents`)。
- [ ] **Step 2:** 写失败测试:POST `/api/interview-sessions/:id/decisions` 后,`GET /api/state` 的 `auditEvents` 含一条对应决策记录(当前只 stdout → FAIL)。
- [ ] **Step 3:** 跑确认失败。
- [ ] **Step 4:** 实现:handler 把决策构造为 `AuditEvent` append 进 state 并 `replaceState` 持久化(保留原 console.info 或替换,以落库为准)。
- [ ] **Step 5:** 跑通过 + 全量 typecheck/vitest。
- [ ] **Step 6:** 提交:只 add 改动文件 + 测试,`git commit -m "fix(api): persist /decisions to auditEvents instead of stdout-only (P2-22)"`。

---

## Task 5: P2-3 + P2-5 + P2-9 — 删除已确认死代码

**Files:** Delete `apps/api/src/interview-turn-runner.ts`(+其测试若有);P2-5/P2-9 视 grep 结论。

- [ ] **Step 1(P2-3):** `grep -rn "interview-turn-runner\|interviewTurnRunner\|runInterviewTurn" apps/ src/ --include="*.ts"`(排除 zhuanfang + 排除该文件自身)。**预期零外部引用**。若有引用 → BLOCKED 报告(说明它其实被接线)。确认 `/turns` 路由如何不依赖它而工作。
- [ ] **Step 2(P2-5):** grep 主设计提到的"孤儿报告函数"(grep `buildReport`/`buildInterviewReport`/`buildSessionReport` 等),逐个 grep 引用确认零生产引用才算死。列出确认死的。
- [ ] **Step 3(P2-9):** grep `contracts`(`src/**/contracts*.ts` 或死 interface),逐个确认零引用。列出确认死的。
- [ ] **Step 4:** 对**确认零引用**的删除(`git rm` 文件 / 删死函数死接口)。**任一项若引用面不明或删除会触及 ≥3 处其它文件,跳过该项并 DONE_WITH_CONCERNS 报告,不硬删。**
- [ ] **Step 5:** 全量 typecheck(exit 0,确认无残留导入)+ vitest 全绿。
- [ ] **Step 6:** 提交:只 add 实际删除/改动文件,`git commit -m "refactor: remove confirmed dead code (P2-3, P2-5, P2-9)"`。

---

## Task 6: P1-16 + P2-21 + P1-4 — 小清理与诚实标注

**Files:** Modify 质量评分文件(`apps/api/src/routes/quality.ts` 或内联处)、`src/capabilities/search.ts`(:175 example.local)、相关 docs。

- [ ] **Step 1(P1-16):** 读质量评分实现(spec 指 `apps/api/src/routes/quality.ts:4` 内联确定性评分;项目无 `src/domain/quality.ts`)。在函数上方加注释 `// ponytail: 启发式确定性评分,非 LLM 真评分;需要真评分再升级` 明确其性质(诚实标注而非伪装精确)。
- [ ] **Step 2(P2-21):** 读 `src/capabilities/search.ts:172-182` 的 `createProviderSources`,`example.local` 占位 URL。改为**明确标注为模板/本地降级**:url 改为可辨识的形式(如保留 example.local 但加注释说明这是本地降级占位、非真实来源),或在结构上标 `isPlaceholder: true`(若该类型支持)——**最小落地:加注释 + 不冒充真实 URL**。不引入新依赖。
- [ ] **Step 3(P1-4):** 修 `docs/superpowers/plans/2026-06-16-interviewer-craft-unification.md` 对不存在文件的死链(删引用或指向真实文件)。
- [ ] **Step 4:** `npm run typecheck` + `npx vitest run` 全绿(本 Task 多为注释/文案,应零行为变更)。
- [ ] **Step 5:** 提交:只 add 改动文件,`git commit -m "chore: annotate heuristic quality scoring + placeholder source URLs; fix doc dead link (P1-16, P2-21, P1-4)"`。

---

## Task 7: 核销已被前序重构解决的条目(零代码改动)

**目的:** 诚实记账。以下条目 spec 列入阶段 1,但 grep 证实已满足,**不写代码**,只在本计划留证据。

- [ ] **Step 1:** 逐条用一条 grep/读取确认证据并记录(不改代码):
  - P0-6:`src/domain/strategy.ts` 多处填充 `nextInterviewInstruction`(非恒空);engine.ts 仅初始化空串。
  - P0-13:`apps/api/src/routes/search.ts` 失败时 `buildSearchBrief` 本地降级 + console.warn。
  - P1-1:`apps/api/src/interview-turn-runner.ts` catch 走 degraded + aiRunEvent(注:此文件可能已被 Task 5 删;若删了,P1-1 随之消解,记录之)。
  - P1-20:`src/domain/engine.ts` 为 barrel re-export,`strategy.ts` 不反向 import,无循环。
  - P2-2/P2-4/P2-7:external-search / guidanceEngine 顶层不存在;mastra adapter 已清。
- [ ] **Step 2:** 本 Task 无提交(无代码改动)。在最终阶段 1 汇报里列出这些"已满足"条目及证据。

---

## Self-Review

**1. Spec 覆盖:** 21 条全覆盖——真接线 P0-1/2/3(T1)、真改动 P0-4/P1-2(T2)/P1-13(T3)/P2-22(T4)、死代码 P2-3/5/9(T5)、小清理 P1-16/P2-21/P1-4(T6)、已解决核销 P0-6/P0-13/P1-1/P1-20/P2-2/P2-4/P2-7(T7)。

**2. 占位扫描:** 无 TBD。死代码/类型面不确定处用 grep-确认→超阈值则 DONE_WITH_CONCERNS,非占位。

**3. 一致性:** 命令统一;提交禁 git add -A;前端入口明确归阶段 2;新依赖 @fastify/static 因 Docker 部署模型确需而非图方便。

**4. 风险:** T2 加依赖(注意本机 TLS strict-ssl);T1/T3/T4 改后端行为,靠 TDD + 全量回归兜底。
