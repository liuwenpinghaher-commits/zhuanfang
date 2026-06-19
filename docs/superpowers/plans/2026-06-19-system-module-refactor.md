# 系统模块第一性重构 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development。domain/后端 TDD;UI 按结构+验收 + Playwright。Steps 用 checkbox。

**Goal:** 打通系统模块(配置/语料/档案)的四层断点(路由↔前端API↔UI↔引擎消费),收敛 ConfigView 冗余,删死代码;并交付真实业务多重测试套件 + 预期质量/检验标准文档 + 全系统验证。

**Architecture:** 前端接线 + ConfigView 收敛 + 引擎消费打通 + 数据治理 UI,零新依赖。

**Tech Stack:** TS/React, Fastify, Vitest, Playwright。验证:`npm run typecheck` / `npx vitest run --exclude "**/*.real.test.ts"` / `npx playwright test`。

设计:`docs/superpowers/specs/2026-06-19-system-module-consolidation-design.md`。

## 通用约束
- 顶层 `src/`/`apps/`(忽略 zhuanfang)。提交只 `git add` 本 Task 文件,禁 `git add -A/.`(zhuanfang/CLAUDE.md/memory/.claude 零误吞)。
- 每 Task:`npm run typecheck` PASS + `npx vitest run --exclude "**/*.real.test.ts"` 全绿 + git status 核无关文件未暂存。

## 已核实(断点)
- 数据治理 `GET /api/state/export`、`GET /api/state/privacy-report`、`POST /api/state/purge` 后端完整(`apps/api/src/routes/state.ts`),**前端 productApi.ts 无方法、无 UI**。
- `ProfileView`(`src/features/profile/ProfileView.tsx`)有"清空示例"(reset)按钮;无导出/隐私/purge。
- playbook:`collectAppliedPlaybookRules` 写入 `enginePolicy.appliedPlaybookRules`(realtime-voice.ts),但 `src/realtime/voice-instructions.ts buildRealtimeVoiceInstructions` 不读;`strategy.ts` 用中文关键词匹配触发策略(脆弱)。
- `memoryCorrections`:ProfileView 写,`context-pack.ts buildInterviewContextPack` 不注入 LLM 上下文。
- ConfigView:providers 双显(capabilities + buildSystemStatus.providers);patches tab 与 CorpusLearningView 重复;product-config rollback 死路由。

---

## S1: 数据治理打通(productApi 方法 + ProfileView UI)

**Files:** Modify `src/api/productApi.ts`、`src/App.tsx`、`src/features/profile/ProfileView.tsx`、`src/styles.css`;Test productApi/组件。

- [ ] **Step 1:** 读 `apps/api/src/routes/state.ts` 的 export/privacy-report/purge 返回结构;`src/api/productApi.ts` 现有方法风格;`ProfileView.tsx` 现有结构 + "清空示例" reset 接线(App.tsx)。
- [ ] **Step 2:** `productApi.ts` 加三方法:`exportState(): Promise<BackupReport>`(GET /api/state/export)、`getPrivacyReport(): Promise<PrivacyReport>`(GET /api/state/privacy-report)、`purgeState(): Promise<ProductState>`(POST /api/state/purge)。类型从 domain 复用。TDD:客户端方法测试(fake fetch,断言 method/path/解析)。
- [ ] **Step 3:** `ProfileView` 加「数据治理」分区(panel + 三动作,uiux 闭环:loading/成功/失败):
  - **导出数据**:调 exportState → 把报告 JSON 触发浏览器下载(Blob + a[download]);成功 toast。
  - **隐私报告**:调 getPrivacyReport → 内联展示 inventory 分类清单(类别+计数)。
  - **清空个人数据**:window.confirm(措辞区别于"清空示例":"将永久删除你的所有专访、笔记、资产、记忆等个人数据")→ purgeState → setProductState → 成功提示。
  - 复用 B1 的 `.empty-state`/`.spinner`/`.btn-loading`/`.secondary-action`;破坏性按钮用 danger 语义色。
- [ ] **Step 4:** App.tsx 接线三回调,传 ProfileView。
- [ ] **Step 5:** `npm run typecheck` + 全量 vitest 全绿(扩 productApi.test + ProfileView 组件测试:三动作存在、purge 有确认)。
- [ ] **Step 6:** 提交:`git add` 改动文件 + 测试,`git commit -m "feat(governance): wire export/privacy-report/purge to ProfileView (S1)"`。

---

## S2: ConfigView 收敛(4 tab → 2 tab + 去 provider 双显 + patch 单一真源)

**Files:** Modify `src/features/config/ConfigView.tsx`、`src/ui.ts`(configSectionOptions)、`src/App.tsx`;可能删 `apps/api/src/routes/product-config.ts` 的 rollback(或加 UI)。

- [ ] **Step 1:** 读 `ConfigView.tsx`(overview/providers/policies/patches 四区渲染)、`src/ui.ts` `configSectionOptions`、`src/domain/engine.ts buildSystemStatus`(本地 providers 快照)、`App.tsx` 给 ConfigView 的 props。
- [ ] **Step 2:** `configSectionOptions` 收为 2:**状态**(`status`:合并 overview + capabilities;**移除 buildSystemStatus.providers 的本地占位重复展示**,只用 capabilities 真实状态 + 引擎版本/生成物计数)、**参数**(`settings`:runtime env 可编辑区 + 产品策略可编辑区,两栏清晰标注"服务端配置/产品策略";只读快照去除或明确标只读)。
- [ ] **Step 3:** patch 单一真源:**删除 ConfigView 的 patches tab**(patch 的"确认影响引擎"只在语料学习页保留),或反之(择一,确保只在一处)。
- [ ] **Step 4:** product-config rollback 死路由:本期**删除**该后端路由 + 任何残留(若无 UI 价值;configVersions 保留作审计),或加最小 rollback UI(择简——倾向删路由消除死代码,在 commit 说明)。
- [ ] **Step 5:** `npm run typecheck` + 全量 vitest 全绿(ConfigView.test/ui.test 同步 4→2 区)。
- [ ] **Step 6:** 提交:`git add` 改动文件 + 测试,`git commit -m "refactor(config): 4 tabs → 2 (状态/参数), drop redundant provider snapshot + duplicate patch tab (S2)"`。

---

## S3: 语料 playbook 做实 + memoryCorrections 喂上下文

**Files:** Modify `src/realtime/voice-instructions.ts`、`src/domain/strategy.ts`、`src/domain/corpus.ts`+`apps/api/src/intelligence/corpus-llm.ts`(patch.ruleType)、`src/domain/context-pack.ts`、`src/domain/types.ts`;测试。

- [ ] **Step 1:** 读 `voice-instructions.ts buildRealtimeVoiceInstructions`(它用 card/guide;enginePolicy 怎么传入)、`strategy.ts` 的 `hasConcreteMomentPlaybookRule`/`hasMechanismReversalPlaybookRule`(关键词匹配)、`context-pack.ts buildInterviewContextPack`(memory 注入处)、`PlaybookPatch` 类型。
- [ ] **Step 2(realtime 生效)**:`buildRealtimeVoiceInstructions` 读 `enginePolicy.appliedPlaybookRules`,把前 N 条规则注入实时语音 instructions(一段"已应用的提问技法:…")。TDD:有 applied rules 的 session → instructions 含规则文本。
- [ ] **Step 3(type 驱动)**:`PlaybookPatch` 加 `ruleType?: "concrete-moment" | "mechanism-reversal" | string`;corpus 分析(LLM `corpus-llm.ts` + 确定性 `corpus.ts`)产出 patch 时填 ruleType;`strategy.ts` 的两个 `has*PlaybookRule` 改为优先按 `ruleType` 匹配,历史无 ruleType 回退现有关键词。TDD:带 ruleType 的 patch 触发对应策略。
- [ ] **Step 4(corrections 喂上下文)**:`buildInterviewContextPack` 把最近 ≤10 条 `memoryCorrections` 注入 contextPack(新增字段或并入 corrections 输出),使其进入专访 LLM 上下文。TDD:有 corrections → contextPack 含之(有界)。
- [ ] **Step 5:** `npm run typecheck` + 全量 vitest 全绿。**任一项波及 ≥4 文件或改可观察契约且风险高 → DONE_WITH_CONCERNS 诚实降级(如只做 realtime 注入 + corrections,ruleType 留关键词+标注)。**
- [ ] **Step 6:** 提交:`git add` 改动文件 + 测试,`git commit -m "feat(engine): playbook rules reach realtime + type-driven strategy + corrections feed context (S3)"`。

---

## S4: 死代码/死字段清理

**Files:** Modify types/engine/ConfigView/ProfileView/相关路由;测试。

- [ ] **Step 1:** grep 复核各死项的引用面:`realtimeEnabled`、`buildSystemStatus().providers`、`InterviewContext.activeStrategies`、`memory-corrections` 路由、`product-config rollback`(S2 若已删则跳过)。
- [ ] **Step 2:** 逐项择简处理(每项:做实 or 删,消除"有路由无调用/有字段无效果"):
  - `realtimeEnabled`:关闭时真禁用实时语音入口(做实)或删字段+UI(择简)。
  - `memory-corrections` 路由:ProfileView 保存修正改走它(打通)或删路由(择简;若 S1 数据流已够则删)。
  - `InterviewContext.activeStrategies`:进 prompt(若 S3 已覆盖则跳)或删。
  - `buildSystemStatus.providers` 冗余字段:S2 去展示后评估删该 domain 字段。
- [ ] **Step 3:** `npm run typecheck` + 全量 vitest 全绿;相关死项 grep 归零或被真实使用。
- [ ] **Step 4:** 提交:`git add` 改动文件,`git commit -m "refactor(system): remove/wire dead routes/fields (realtimeEnabled, corrections route, activeStrategies) (S4)"`。

---

## S5: 真实业务多重测试套件 + 预期质量/检验标准文档

**Files:** Create `docs/superpowers/2026-06-19-system-verification-criteria.md`;扩/新增 `apps/api/src/e2e/*.test.ts` + `tests/e2e/*.spec.ts`。

- [ ] **Step 1:** 写**预期质量/检验标准文档**:列出**所有功能**(专访/笔记/资产/主题线/外部调研自动化/记忆HITL/RAG/配置/语料/档案/数据治理/播客),每条给:真实业务路径、步骤、**预期输出**(具体断言)、**质量标准**(可观测、无 5xx/无数据丢失、离线 fallback 不崩、闭环)、**检验方式**(自动断言 / 人工确认项)。
- [ ] **Step 2:** 落地多层测试:① 扩 `apps/api/src/e2e/full-business-journey.test.ts` 覆盖系统模块(导出/隐私报告/purge/配置保存/语料分析→应用→影响);② 新增系统模块业务旅程(server.inject);③ Playwright e2e(数据治理 UI 旅程、ConfigView 2-tab 旅程)。每条对齐标准文档的预期。
- [ ] **Step 3:** 跑全量 vitest + playwright 全绿。
- [ ] **Step 4:** 提交:`git add` 文档 + 测试,`git commit -m "test(system): real-business multi-layer test suite + verification criteria doc (S5)"`。

---

## S6: 全系统验证 + 对抗审查 + 推送

- [ ] **Step 1:** 全量:`npm run typecheck`(0)+ `npx vitest run --exclude "**/*.real.test.ts"`(全绿)+ `npx playwright test`(全绿)。
- [ ] **Step 2:** 运行态 curl 验证系统模块新端点可达 + 数据治理闭环(export 有内容、privacy 无 intel、purge 生效)。
- [ ] **Step 3:** 对照 S5 标准文档逐条核验(自动项跑测试,人工项记录)。
- [ ] **Step 4:** 派独立对抗审查(2 份:S1-S2 接线/收敛 + S3-S4 引擎打通/删除)审实现质量,整改真缺陷(像认知资产那轮)。
- [ ] **Step 5:** 写系统模块质量分析报告;推送 origin/main。

---

## Self-Review
**1. Spec 覆盖:** 数据治理(S1)、ConfigView 收敛(S2)、playbook/corrections 做实(S3)、死代码(S4)、测试套件+标准(S5)、全系统验证+审查(S6)。
**2. 占位扫描:** 无 TBD;断点逐条"打通 or 删",做实风险高处设 DONE_WITH_CONCERNS 闸门。
**3. 一致性:** 命令统一;提交禁 git add -A;数据治理 purge 二次确认。
**4. 风险:** S3 改引擎消费靠全量回归 + 真测试断言"真生效";破坏性 purge 有确认;每阶段独立可回滚。
