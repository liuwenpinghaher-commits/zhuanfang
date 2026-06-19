# 系统模块第一性重构 设计文档

**Goal:** 系统模块(系统配置/语料学习/个人档案)第一性重构——核心问题不是"功能多",而是**断点多**:后端路由 ↔ 前端 API ↔ UI ↔ 引擎消费 四层里至少两层常是断的,导致"有设置却没效果"。重构方向是**逐条打通断点 + 收敛冗余 + 删死代码**,让每个功能真实可达、可用、可观测、闭环。

**Architecture:** 前端接线 + ConfigView 收敛 + 引擎消费打通 + 数据治理 UI,零新依赖。基于客观代码普查(本会话现状报告)。

**Tech Stack:** TS/React, Fastify, Vitest, Playwright。验证:`npm run typecheck` / `npx vitest run --exclude "**/*.real.test.ts"` / `npx playwright test`。

---

## 1. 第一性判断:断点地图

| 功能 | 断点(后端✓ → 前端✗ / 引擎✗) |
|---|---|
| 数据治理 导出/清空/隐私报告 | 3 个端点后端完整,**前端无 API 方法、无 UI 入口**(R1 只注册了路由) |
| 语料 playbookPatches | LLM 分析真,但 rules **对 realtime 语音完全无效**(cascade/WS 硬编码 guidanceEnabled);文本路径仅 ≤2 条软提示 + 脆弱关键词匹配;`activeStrategies` 透传却不进 prompt |
| memoryCorrections | ProfileView 可写,但 **context-pack 不消费**→ 修正不进 LLM 上下文(闭环断) |
| ConfigView providers | capabilities(真) 与 buildSystemStatus.providers(占位估算) **双重展示同一 provider** |
| ConfigView policies | runtime env(可编辑真生效) + 只读快照 + 产品策略(可编辑) **混在一个 tab**,用户分不清可改/只读 |
| ConfigView patches | 与 CorpusLearningView 的"确认影响引擎" **重复**两处 |
| product-config rollback | 后端路由有,**前端无 UI/方法**(死路由) |
| memory-corrections 路由 | 后端注册,前端**绕过**走 auto-save(死路由) |
| realtimeEnabled | 仅影响文字提示,**不守门**(死字段) |

## 2. 分阶段实施(每阶段独立可交付、可测、可回滚)

### S1 · 数据治理打通(最高价值,补最大缺口)
- `src/api/productApi.ts` 加 `exportState()`(GET /api/state/export)、`getPrivacyReport()`(GET /api/state/privacy-report)、`purgeState()`(POST /api/state/purge)。
- `ProfileView` 加「数据治理」分区:**导出数据**(取 export 报告→触发下载 JSON)、**隐私报告**(取 privacy-report→展示分类清单)、**清空个人数据**(purge,二次确认 window.confirm,与"清空示例"区分语义)。
- App.tsx 接线回调。TDD(客户端方法测试)+ 组件/e2e 验证入口可达。
- 验收:三端点前端可达且闭环(导出能下载、隐私报告能看、清空有确认且生效)。

### S2 · ConfigView 收敛(4 tab → 2 tab,去冗余)
- 合并为 **状态**(overview + 实时 capabilities;**删除 buildSystemStatus.providers 本地占位快照的重复展示**,只展示 capabilities 真实状态)+ **参数**(runtime env 可编辑 + 产品策略可编辑,清晰分两栏标注"服务端/产品",只读快照去掉或明确标只读)。
- **patch 管理单一真源**:删除 ConfigView 的 patches tab(patch 的"确认影响引擎"只在语料学习页一处),或反之——择一,消除重复。
- product-config:确认 `onSaveProductConfig` 是否该走 `PATCH /api/product-config`(现绕过走 auto-save);若 auto-save 已足够则删除/标注 product-config 路由(避免死路由),否则接上。**择简,消除"有路由无调用"**。
- 验收:tab 不重复、provider 不双显、可改/只读分明;无死分区。

### S3 · 语料 playbook 做实 + memoryCorrections 喂上下文
- **playbook 对 realtime 生效**:`src/realtime/voice-instructions.ts` 的 `buildRealtimeVoiceInstructions` 读取 `enginePolicy.appliedPlaybookRules`(realtime-voice.ts 已写入),把规则注入实时语音 instructions。
- **patch 触发改 type 驱动**:patch 结构加 `ruleType`(由 corpus 分析产出,如 `concrete-moment`/`mechanism-reversal`);`strategy.ts` 的 `hasConcreteMomentPlaybookRule`/`hasMechanismReversalPlaybookRule` 改用 `ruleType` 匹配(不再脆弱的中文关键词字符串匹配)。迁移:历史 patch 无 ruleType 时回退关键词。
- **memoryCorrections 喂上下文**:`context-pack.ts` 的 `buildInterviewContextPack` 把最近 N 条 memoryCorrections 注入(有界,如 ≤10),让"AI 说错了"的修正真正影响下次专访。
- 验收:realtime 语音 instructions 含 applied rules(测试断言);ruleType 驱动策略(测试);corrections 进 contextPack(测试)。
- **若某项做实波及过大(如改 patch 结构触发面广),DONE_WITH_CONCERNS 降级为诚实标注**,不假装。

### S4 · 死代码/死字段清理
- `product-config rollback` 路由:加最小 rollback UI(configVersions 已存)或删路由+客户端(择简,消除死路由)。
- `memory-corrections` 路由:前端 ProfileView 的"保存修正"改走该路由(打通)或删路由(择简)。
- `realtimeEnabled`:要么真守门(关闭时禁用实时语音入口)要么删字段+UI(择简,消除死字段)。
- `buildSystemStatus.providers` 本地快照:S2 已去重展示;此处评估是否删该 domain 死字段。
- `InterviewContext.activeStrategies`:进 prompt(做实)或删(择简)。
- 验收:死路由/死字段 grep 归零或被真实使用;typecheck/全测试绿。

## 3. 真实业务多重测试用例 + 预期质量/检验标准(独立交付物)

写一份**真实、复杂、覆盖所有功能**的多重测试套件 + 一份**预期输出质量与检验标准**文档:
- **测试层次**:① domain 单测(纯函数正确性)② 后端 server.inject 业务旅程(端点+数据流)③ 前端组件测试(交互闭环)④ Playwright e2e(真实用户旅程)。
- **业务覆盖**:专访闭环 + 认知资产(笔记/资产/主题线)+ 外部调研自动化 + 记忆 HITL + RAG + 系统(配置/语料/档案/数据治理)+ 播客。**每个功能至少一条真实业务路径**。
- **预期质量与检验标准文档**(`docs/superpowers/2026-06-19-system-verification-criteria.md`):对每条业务用例写明——前置、步骤、**预期输出**(具体断言:状态码/数据形态/可观测效果)、**质量标准**(如"专访结束必产出 note"、"导出含完整 state digest"、"隐私报告不含 intel"、"无 5xx/无数据丢失"、"离线 fallback 不崩")、**检验方式**(自动断言 vs 人工确认项)。
- 落地为可执行测试(扩 `full-business-journey.test.ts` + 新增系统模块业务旅程 + e2e)。

## 4. 全系统验证(系统模块完成后)
- 全量:`npm run typecheck`(0 错)+ `npx vitest run --exclude "**/*.real.test.ts"`(全绿)+ `npx playwright test`(全绿)。
- 运行态 curl 验证系统模块新端点可达 + 数据治理闭环。
- 对照"预期质量/检验标准"文档逐条核验。
- 独立对抗审查(像认知资产那轮)审 S1-S4 实现质量,整改真缺陷。
- 推送 main。

## 5. 风险与护栏
- S3 改引擎消费(playbook/corrections)有行为变更 → 全量回归 + 真测试断言"真生效";波及过大则 DONE_WITH_CONCERNS 诚实降级。
- 数据治理 purge 是破坏性 → 二次确认 + 与"清空示例"语义区分。
- 提交纪律:每阶段只 `git add` 该阶段文件,禁 `git add -A/.`(zhuanfang/CLAUDE.md/memory/.claude 零误吞)。

## 6. 非目标
- 不动专访引擎内核、追问技法算法。
- 不引新依赖。
- 不为"看起来全"而保留无效设置——宁可删/标注,也不留"有设置没效果"的假象。
