# 阶段 4 · 语音健壮性 + 安全 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development。每 Task 派 fresh subagent,TDD(浏览器侧逻辑尽量抽出可测,无法单测的做代码级修复 + 诚实标注)。Steps 用 checkbox。

**Goal:** 消解阶段 4 的语音健壮性与安全债(22 条,含阶段 1 延来的 P2-4)。

**Architecture:** 后端安全(鉴权/CORS)、domain(去种子化/enginePolicy)、provider(轮询总超时)、前端 realtime(ASR 失败停麦+重连、打断、schema 校验)、死代码删除。已被前序解决的诚实核销。

**Tech Stack:** TypeScript, Fastify, Vitest。验证:`npm run typecheck` / `npx vitest run --exclude "**/*.real.test.ts"`。

主设计:第 4 节阶段 4 表(21 条)+ 阶段 1 延来 P2-4。

---

## 调查结论(写计划前已 grep 核实)

**已满足、零代码改动(核销于 Task 9):** P1-12(`request-timeout.ts` 的 `fetchWithTimeout` 默认 30s)、P1-14/15(`utils.ts` `sanitizeExternalMaterial*` 单一真源)、P2-12(`cascadedAsrSource.ts` partial=replace/final=commit,非覆盖丢失)、P2-15(`expressionStateDetector.ts` baseline 3 样本后冻结)、P0-8(`productApi.ts` classifyTurnComplete 透传 signal)、P1-8(`signals.ts` buildInterruptionContext 完整)、P1-9/10(`bailianWebsocket.ts` close() 关 AudioContext+WS)。

**真改动:** P0-5(鉴权)、P1-3(CORS)、P0-12(turn-builder 去种子化)、P1-21(realtime enginePolicy)、P1-11(ASR 轮询总超时)、P0-9(ASR delta schema 校验+空转录告警)、P0-7(ASR 失败 stopMic+重连)、P1-7(livekit interrupt)。

**死代码:** P2-4(`guidanceEngine.ts` 孤儿,realtime 已用 `evaluateIntent` 替代 → 删)、P2-6(`turnDetectors` 在 bailianWebrtc import 未用 → 接线或删)。

**需核实存废(Task 9):** P2-10(Python agent tool)、P2-14(echo guard;memory 称 cascade 有 echo guard,可能命名不同需细查)、P2-17(语音降级假波形)。

---

## 通用约束(每 Task 适用)

- 真实代码在顶层 `src/`/`apps/`,**不是** zhuanfang/。grep 排除 zhuanfang。
- 提交**只 `git add` 本 Task 改动的具体文件**,严禁 `git add -A/.`。
- 每 Task 结束:`npm run typecheck` PASS + `npx vitest run --exclude "**/*.real.test.ts"` 全绿 + `git status --short` 确认无关文件未暂存,再提交。
- TDD;浏览器 API 调用用注入/mock;实在无法单测的逻辑做代码级修复并在报告说明、加 `// ponytail:` 标注限制。

---

## Task 1: P0-5 + P1-3 — 鉴权(production profile token)+ CORS 读 env

**Files:** Modify `apps/api/src/server.ts`(全局 hook/CORS);可能新增 `apps/api/src/auth.ts`;Test server 级测试。

- [ ] **Step 1:** 读 `apps/api/src/server.ts`(启动、env 读取、是否已有任何 CORS/hook)。确认 env 里 `DEPLOYMENT_PROFILE`(docker 设 `production`)、`PRODUCT_WEB_ORIGINS`(docker 设逗号分隔 origins)、以及是否有 token env(如无,新增约定 `PRODUCT_API_TOKEN`)。grep 现有 `onRequest`/`addHook`/`@fastify/cors`。
- [ ] **Step 2:** 写失败测试:
  - 鉴权:当 `DEPLOYMENT_PROFILE==="production"` 且设了 `PRODUCT_API_TOKEN` 时,`GET /api/state` 无 `Authorization: Bearer <token>` → 401;带正确 token → 200;非 production profile(默认本地)→ 不要求 token(现有行为不变)。`/api/health` 始终豁免(healthcheck 用)。
  - CORS:设 `PRODUCT_WEB_ORIGINS` 时响应带对应 `Access-Control-Allow-Origin`;未设时维持现状(不破坏本地)。
- [ ] **Step 3:** 跑确认失败。
- [ ] **Step 4:** 实现:
  - CORS:读 `PRODUCT_WEB_ORIGINS`(逗号分隔)设置允许的 origin(用 `@fastify/cors` 若已装;否则手动在 onSend/onRequest 设 header——优先复用已有依赖,避免新增。若需 @fastify/cors,按 [[npm-tls-strict-ssl]] strict-ssl=false 装)。
  - 鉴权:`onRequest` 全局 hook——仅当 production profile + token 配置时,对非 `/api/health`(及静态资源)请求校验 `Authorization: Bearer`。本地默认 profile 不启用,零摩擦。
- [ ] **Step 5:** 跑通过 + 全量 typecheck/vitest。
- [ ] **Step 6:** 提交:只 add 改动文件 + 测试(+package.json/lock 若装了 cors),`git commit -m "feat(security): production-profile bearer auth + CORS from PRODUCT_WEB_ORIGINS (P0-5, P1-3)"`。

---

## Task 2: P1-21 — realtime voice session 带 enginePolicy

**Files:** Modify `apps/api/src/routes/realtime-voice.ts`(session 创建/record);Test 对应测试。

- [ ] **Step 1:** 读 `apps/api/src/routes/realtime-voice.ts:51-82`(`RealtimeVoiceSessionPayload`/`RealtimeVoiceSessionRecord`)、`:565-605`(`createRealtimeVoiceSession`)。读 `src/domain/types.ts` 的 `InterviewEnginePolicy` 结构与专访 session 上 enginePolicy 怎么取的(grep `enginePolicy`)。
- [ ] **Step 2:** 写失败测试:创建 realtime voice session(关联某 interview session 或带 policy 输入)→ 断言 record 含 enginePolicy(当前缺 → FAIL)。
- [ ] **Step 3:** 跑确认失败。
- [ ] **Step 4:** 实现:session 创建时从关联 interview session(或 payload/默认)取 `enginePolicy` 存入 record,并在需要处透传。沿用 domain 既有 enginePolicy 默认值,不新造语义。
- [ ] **Step 5:** 跑通过 + 全量 typecheck/vitest。
- [ ] **Step 6:** 提交:只 add 改动文件 + 测试,`git commit -m "fix(voice): carry enginePolicy on realtime voice session (P1-21)"`。

---

## Task 3: P0-12 — turn-builder 去种子化(scenario-agnostic)

**Files:** Modify `src/domain/turn-builder.ts`(:18-89 硬编码场景);Test `src/domain/turn-builder` 相关测试。

- [ ] **Step 1:** 读 `src/domain/turn-builder.ts:18-89` 的 `buildAssistantTurn`,定位 L27-64 硬编码场景关键词("兜底"/"救火"/"失控"等)的判定分支。理解这些分支如何影响生成,以及通用路径。grep 这些硬编码词的来源是否本应来自 guide/state 而非写死。
- [ ] **Step 2:** 写失败测试:给一个**不含**这些硬编码场景词的输入,断言 turn-builder 仍能产出合理追问(不依赖特定场景词);给含这些词的输入,行为不退化。即:断言 scenario-agnostic——不因缺少种子词而走空/退化分支。
- [ ] **Step 3:** 跑确认失败(若当前强依赖种子词)。
- [ ] **Step 4:** 实现:把硬编码场景判定参数化——改为基于通用信号(如 strategy/锚点/用户内容特征)驱动,而非写死的中文场景词。**保留现有有效行为**,只去除对特定种子场景的硬绑定。**若去种子化会大改生成逻辑、波及 ≥4 处或改变现有 e2e 可见输出,DONE_WITH_CONCERNS 说明,采用最小参数化。**
- [ ] **Step 5:** 跑通过 + 全量 typecheck/vitest(现有 turn-builder/engine 测试零破坏)。
- [ ] **Step 6:** 提交:只 add 改动文件 + 测试,`git commit -m "refactor(domain): make turn-builder scenario-agnostic (P0-12)"`。

---

## Task 4: P1-11 — ASR 轮询加总时长上限

**Files:** Modify `apps/api/src/providers/bailian.ts`(:741 轮询);Test bailian 相关测试。

- [ ] **Step 1:** 读 `apps/api/src/providers/bailian.ts` 的转录轮询(`pollAttempts:20, pollIntervalMs:500`,约 :741)。确认当前无全局总超时(只有单次 fetchWithTimeout)。
- [ ] **Step 2:** 写失败测试:用 fake fetchImpl 模拟轮询始终 pending,断言轮询在总时长上限(如 `ASR_POLL_TIMEOUT_MS` 默认 60s,测试注入小值)内终止并返回明确超时(而非无限/仅靠 attempts)。
- [ ] **Step 3:** 跑确认失败。
- [ ] **Step 4:** 实现:轮询循环加总时长上限(记录起始时间,超过 `maxTotalMs` 即停并报超时),常量可注入便于测试;默认 60s。加注释。
- [ ] **Step 5:** 跑通过 + 全量 typecheck/vitest。
- [ ] **Step 6:** 提交:只 add 改动文件 + 测试,`git commit -m "fix(asr): add total timeout to transcription polling (P1-11)"`。

---

## Task 5: P0-9 — ASR delta schema 校验 + 空转录告警

**Files:** Modify `src/realtime/cascadedAsrSource.ts`(:242 delta 解析);Test `src/realtime/cascadedAsrSource` 相关测试。

- [ ] **Step 1:** 读 `src/realtime/cascadedAsrSource.ts:198-279`(消息解析、:242-243 `msg.text + msg.stash`)。理解 ASR delta 消息形状与当前裸 `?? ""` 断言。看现有该文件测试如何注入 fake 消息。
- [ ] **Step 2:** 写失败测试:喂入**结构不符**的 ASR 消息(缺字段/类型错)→ 断言被 schema/类型守卫安全处理(不崩、记录告警),而非盲拼 undefined;喂入空转录 → 断言触发空转录告警路径。
- [ ] **Step 3:** 跑确认失败。
- [ ] **Step 4:** 实现:加轻量 schema/类型守卫(校验 `text`/`stash` 字段类型),非法消息走告警 + 安全跳过;空转录(全空)记录告警。不引依赖,手写守卫即可。
- [ ] **Step 5:** 跑通过 + 全量 typecheck/vitest。
- [ ] **Step 6:** 提交:只 add 改动文件 + 测试,`git commit -m "fix(asr): validate delta message schema + warn on empty transcript (P0-9)"`。

---

## Task 6: P0-7 + P1-7 — ASR 失败停麦+重连;livekit interrupt 真打断或标注

**Files:** Modify `src/realtime/cascadedAsrSource.ts`(ASR 失败)、`src/realtime/livekitVoice.ts`(:114 interrupt);Test 可测部分。

- [ ] **Step 1:** 读 `src/realtime/cascadedAsrSource.ts:111-132`(stopMic)、`:198-279`(start/失败 reject 路径);`src/realtime/livekitVoice.ts:114-120`(interrupt 现为只重启麦)。
- [ ] **Step 2(P0-7):** 写测试(可测部分):ASR start 失败时调用 stopMic(注入 fake 媒体/ASR,断言 stopMic 被调);最小重连——失败后按上限重试 N 次(可注入),超限放弃并报错。**麦克风泄漏修复优先**(失败必停麦)。
- [ ] **Step 3:** 实现 P0-7:ASR 失败路径先 `stopMic()` 再 reject;加最小重连(有限次重试 + 退避,可注入次数/延迟)。
- [ ] **Step 4(P1-7):** 实现 livekit interrupt:若能真打断(停止远端音轨播放/取消合成)则实现;**若 LiveKit 当前架构下无法真打断**,则把方法体改为诚实标注限制(`// ponytail: LiveKit 模式下 interrupt 仅停本地麦,真打断受 SDK 限制;cascade 模式才有完整打断`)并保留现有最小行为,不留"假装打断"的空操作。
- [ ] **Step 5:** 全量 typecheck/vitest 全绿。
- [ ] **Step 6:** 提交:只 add 改动文件 + 测试,`git commit -m "fix(voice): stopMic+reconnect on ASR failure; honest livekit interrupt (P0-7, P1-7)"`。

---

## Task 7: P2-4 + P2-6 — 删除/收敛死代码

**Files:** Delete `src/domain/guidanceEngine.ts`(+test);`src/realtime/turnDetectors/` 接线或删 + `src/realtime/bailianWebrtc.ts` 清理未用 import。

- [ ] **Step 1(P2-4):** `grep -rn "guidanceEngine\|evaluateGuidance\|GuidanceEvalContext" src/ apps/ --include="*.ts" --include="*.tsx" | grep -v zhuanfang`。确认仅 `guidanceEngine.ts` 自身 + `guidanceEngine.test.ts` 引用(realtime 已用 `evaluateIntent`/`interactionIntentEngine` 替代)。若确认孤儿 → `git rm src/domain/guidanceEngine.ts src/domain/guidanceEngine.test.ts`。
- [ ] **Step 2(P2-6):** `grep -rn "turnDetector\|TurnDetector\|createTurnStateMachine" src/ apps/ --include="*.ts" | grep -v zhuanfang`。判断:`turnDetectors` 是否仅被 `bailianWebrtc.ts` import 但 evaluate 从不调用(死)。
   - 若确为 import-未用的死代码且无接线价值 → 删 `src/realtime/turnDetectors/` 目录(及其测试)+ 清理 bailianWebrtc.ts 的未用 import。
   - 若它本应接线(有明确用处)→ 不删,DONE_WITH_CONCERNS 说明接线属更大改动,留作后续。
- [ ] **Step 3:** `npm run typecheck` exit 0(删后无残留导入)+ `npx vitest run --exclude "**/*.real.test.ts"` 全绿。
- [ ] **Step 4:** 提交:只 add 删除/改动文件,`git commit -m "refactor: remove orphan guidanceEngine + dead turnDetectors (P2-4, P2-6)"`(按实际做的项调整 message)。

---

## Task 8: 核销已满足 + 核实存废(零或极小改动)

- [ ] **Step 1(核销已满足,仅证据):** 逐条 grep 确认并记录,不改代码:P1-12(`request-timeout.ts`)、P1-14/15(`utils.ts` sanitize)、P2-12(`cascadedAsrSource.ts` partial/final)、P2-15(`expressionStateDetector.ts` 冻结)、P0-8(`productApi.ts` signal 透传)、P1-8(`signals.ts` buildInterruptionContext)、P1-9/10(`bailianWebsocket.ts` close)。
- [ ] **Step 2(核实存废):**
  - P2-14 echo guard:细查 cascade(grep `echo`、`suppress`、`micSuppress`、`selfHeard` 等于 `src/realtime/cascadedPipeline.ts` 等)。若已有等价守卫 → 核销;若确有竞态可改进且小 → 在本 Task 修(守卫加 micSuppressed 之类),否则 DONE_WITH_CONCERNS。
  - P2-17 假波形:grep `waveform`、`fakeWave`、录音态可视化。若不存在(无假波形)→ 已满足(无需"去掉");若存在 → 删假录音态。
  - P2-10 Python agent tool:grep `python`、`registerTool`、agent tool。若不存在 → 该问题在当前顶层不适用(已无),核销;若存在未注册 → 删死代码或注册(取最小)。
- [ ] **Step 3:** 若 Step 2 有小改动则 TDD + 提交;纯核销则不提交。本 Task 结论写入最终阶段 4 汇报。

---

## Self-Review

**1. Spec 覆盖:** 22 条全覆盖——真改动 P0-5/P1-3(T1)、P1-21(T2)、P0-12(T3)、P1-11(T4)、P0-9(T5)、P0-7/P1-7(T6)、死代码 P2-4/P2-6(T7)、已满足核销 7 条 + 存废核实 P2-10/14/17(T8)。

**2. 占位扫描:** 无 TBD。浏览器侧不可单测处做代码级修复 + `// ponytail:` 标注 + DONE_WITH_CONCERNS 闸门。

**3. 一致性:** 命令统一;提交禁 git add -A;鉴权默认本地零摩擦、仅 production profile 启用(不破坏开发流)。

**4. 风险:** T1 改安全行为(默认 profile 不启用兜底)、T3 改生成逻辑(全量回归 + DONE_WITH_CONCERNS 闸门)、T6 浏览器侧靠代码审查 + 诚实标注。
