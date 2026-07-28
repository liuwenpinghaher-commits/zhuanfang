# 全量验收缺陷修复 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Every behavior change must use superpowers:test-driven-development; every unexpected failure must use superpowers:systematic-debugging.

**Goal:** 修复真人全链路验收发现的 20 项缺陷，使数据恢复、能力状态、专访质量、引用、实时语音和“不保存”边界都能以服务端真值通过自动化与真实运行复验。

**Architecture:** 保留现有 React + Fastify + ProductState + Surreal/SQLite 双层架构，在现有边界补齐原子导入、显式写确认、结构化访谈状态与引用、实时 turn assembler 和结构化结束 receipt。前端只消费服务端确认结果，不复制第二套业务真值。

**Tech Stack:** React 19、TypeScript、Vite、Fastify、Vitest、Playwright、SurrealDB、LiveKit、Bailian/AnySearch provider。

## Global Constraints

- 所有改动只在 `codex/fix-all-acceptance-findings` 隔离工作树完成，不覆盖原工作区改动。
- 严格执行 red → green → refactor；先证明测试会因目标缺陷失败，再写生产代码。
- 不通过删除测试、放宽外部输入校验、伪造 provider ready、吞掉错误或写死测试数据来“修复”。
- 公共路由与导出格式保持向后兼容；新增字段优先可选，并在服务端规范化默认值。
- 每批完成后运行聚焦测试和受影响的上层测试，再提交一个可回滚 commit；不 push。
- 涉及数据库的验证使用独立 namespace/database；不得对现有业务库做 reset/drop/delete。
- 真实第三方不可用时，修复目标是状态、错误、重试与 fallback 真值，不把外部 5xx 伪装为成功。

---

## Task 1：P0 导入恢复 provenance 与图审计真值

**Files:**

- Modify: `packages/db/src/surreal/surreal-product-state-repository.ts`
- Modify: `packages/db/src/surreal/surreal-governance-tx.test.ts`
- Modify: `packages/db/src/surreal/surreal-product-state-repository.test.ts`
- Modify: `apps/api/src/routes/state.ts`
- Modify: `apps/api/src/routes/state.governance.test.ts`
- Modify: `apps/api/src/routes/state.governance.real.test.ts`

### Steps

- [x] 添加失败测试：完整 export/import 后 hot `session.turns` 仍为空，但 cold raw turns 被原子投影为 turn 节点、`part_of`/`derived_from` 边且可反向召回。
- [x] 添加失败测试：同一 turn ID 在 hot/cold 中内容冲突时导入返回 4xx/结构化失败，数据库保持导入前状态。
- [x] 添加失败测试：存在 dangling provenance 时 `GraphConsistencyReport.ok === false`。
- [x] 运行：`npx vitest run packages/db/src/surreal/surreal-governance-tx.test.ts packages/db/src/surreal/surreal-product-state-repository.test.ts apps/api/src/routes/state.governance.test.ts`，确认新增断言红。
- [x] 在 governance replace 内构造仅用于持久化投影的完整 turn 集；先校验冲突，再在同一事务写节点和边，不把冷 turns 重新留在 hot ProductState。
- [x] 将 dangling provenance 纳入 `ok`，并让导入 receipt/错误暴露失败步骤；保留补偿回滚。
- [x] 运行上述聚焦测试；再运行 `npx vitest run apps/api/src/routes/state.test.ts apps/api/src/routes/state.governance.real.test.ts packages/db/src/surreal/surreal-recall.test.ts`。
- [x] 检查 diff 与事务边界，提交：`fix(storage): restore provenance graph atomically`。

---

## Task 2：Provider 真值、LLM 超时退出与合法 E2E 夹具

**Files:**

- Modify: `apps/api/src/routes/health.ts`
- Modify: `apps/api/src/routes/health.test.ts`
- Modify: `apps/api/src/providers/*`（仅实际 provider/探测实现涉及的文件）
- Modify: `src/App.tsx`
- Modify: `src/features/interview/InterviewView.tsx`
- Add/Modify: 对应 `*.test.ts(x)`
- Modify: `tests/e2e/real-assets.spec.ts`

### Steps

- [x] 添加失败测试：AnySearch 只有 credential 时为 `configured=true, available=false|unknown`；真实请求成功后才为 available，失败时保留最近错误/探测时间。
- [x] 核对搜索失败路径：联网 provider 失败直接返回结构化 502 且不落简报，不存在把本地 fallback 继续标成 AnySearch 的路径。
- [x] 添加前端失败测试：turn 请求 timeout 后客户端主动中止、输入保留、出现“重试本轮”；路由不落半轮数据且释放锁允许重试。
- [ ] 添加 fixture 合同测试或直接运行目标 E2E，证明旧 `mode:text`/缺 `startedAt` 被 422 拒绝。
- [x] 实现 provider configured/available 双状态；实际业务请求更新可用性快照，保持兼容字段但不把 configured 映射成 ready。
- [x] 为文本轮增加路由级硬截止、客户端 AbortController 截止与明确重试态；失败请求原子不落库，原样重试安全。
- [x] 更新 7 个共享同一种子的真实资产用例：fixture 改为合法 mode 与 ISO `startedAt`，不改生产校验。
- [ ] 运行：`npx vitest run apps/api/src/routes/health.test.ts apps/api/src/routes/chat.test.ts` 及新增前端测试；再运行 `npx playwright test tests/e2e/real-assets.spec.ts --project=chromium`（外部环境不齐时如实记录具体跳过/失败）。
- [ ] 提交：`fix(runtime): expose provider truth and recover timed out turns`。

---

## Task 3：LiveKit 按需加载与构建边界

**Files:**

- Modify: `src/realtime/livekitVoice.ts`
- Modify: `src/realtime/livekitVoice.test.ts`
- Modify: `src/App.tsx`（仅调用点需要时）
- Modify: `vite.config.ts`

### Steps

- [x] 添加失败测试/构建断言：非 LiveKit 模式不触发 `livekit-client` import，进入 LiveKit 模式才加载。
- [x] 运行聚焦测试并记录红；运行一次 `npm run build` 保存现有 `vendor-livekit 504.52kB` 告警证据。
- [x] 将 LiveKit SDK 改为动态 import，移除强制首屏共享 manual chunk；保持公开 API 与错误处理不变。
- [x] 运行 `npx vitest run src/realtime/livekitVoice.test.ts`（9 tests passed）。
- [x] 运行 `npm run build`：首屏 HTML 只预载 React，LiveKit 懒包降至 478.50kB，构建无大包告警；未调高 warning 上限。
- [ ] 提交：`perf(voice): load livekit only when selected`。

---

## Task 4：档案写确认、主题创建与 active 会话恢复

**Files:**

- Modify: `src/features/profile/ProfileView.tsx`
- Add/Modify: `src/features/profile/ProfileView.test.tsx`
- Modify: `src/App.tsx`
- Modify: `src/features/interview/InterviewView.tsx`
- Modify: `src/domain/interviewSession.test.ts`
- Modify: `apps/api/src/routes/interview-sessions.ts`
- Modify: `apps/api/src/routes/interview-sessions.test.ts`

### Steps

- [x] 添加 Profile 组件失败测试：保存中禁用；只有 Promise 成功后显示“已保存”；冲突/网络失败显示错误并保留草稿。
- [x] 添加会话创建失败测试：具体 topic 进入标题、开场和首条主题参照；空 topic 才使用通用文案。
- [x] 添加模式测试：长期主题一键开始显示推荐 mode/原因，请求携带可见 mode，不静默改为 decision。
- [x] 添加 active 会话测试：多个 active 全部可见且可选择恢复；已有 active 时新建必须经过明确确认；同一创建命令重试保持幂等。
- [x] 将 profile 保存从同步 state setter 改为显式 async command，服务端 revision 确认后才更新 UI。
- [x] 统一 topic 规范化与会话文案构建；新增 active session picker、自定义主题入口和明确新建分支。
- [x] 运行 Profile/Home、context-pack、interview routes 聚焦测试（71 tests passed）并通过全量 typecheck。
- [ ] 运行相关生命周期 E2E：`npx playwright test tests/e2e/interview-lifecycle.spec.ts --project=chromium`。
- [ ] 提交：`fix(sessions): confirm profile saves and make resumes explicit`。

---

## Task 5：访谈主线、修正一致性、跳过与反重复

**Files:**

- Modify: `src/domain/turn-builder.ts`
- Modify: `src/domain/interviewer-craft.ts`
- Modify: `src/domain/interviewer-craft.test.ts`
- Add/Modify: `src/domain/turn-builder.test.ts`
- Modify: `apps/api/src/routes/memory-candidates.ts`
- Modify: `apps/api/src/routes/memory-candidates.test.ts`
- Modify: `src/domain/memoryReview.ts`
- Modify: `src/domain/memoryReview.test.ts`

### Steps

- [ ] 添加失败测试：阶段总结不能把最近一句的局部时间片当主线；主线至少由两个不同回合支持。
- [ ] 添加失败测试：用户显式修正后的旧观点不能重新成为 confirmed candidate；冲突候选进入 `needs-review` 并包含依据。
- [ ] 添加失败测试：skip 摘要来自当前 assistant 问题；无法抽取时使用完整“当前问题”，不截上一条用户回答。
- [ ] 添加失败测试：最近问题语义高相似时切换量化/反例/机制/时间线/边界策略，不能继续统一“复述 + 阻力”。
- [ ] 引入结构化会话策略状态：核心命题、confirmed/corrected、未解决问题、最近策略及语义指纹；保持旧 session 数据可加载。
- [ ] 用确定性后处理约束总结与 memory candidate，不只依赖 prompt。
- [ ] 让策略选择消费未解决问题和最近指纹，记录实际策略理由，避免所有 followup history 同文案。
- [ ] 运行：`npx vitest run src/domain/interviewer-craft.test.ts src/domain/turn-builder.test.ts src/domain/memoryReview.test.ts apps/api/src/routes/memory-candidates.test.ts`。
- [ ] 运行访谈回归：`npx vitest run apps/api/src/routes/interview-sessions.test.ts tests` 中可由 Vitest 执行的相关测试。
- [ ] 提交：`fix(interview): preserve corrections and diversify followups`。

---

## Task 6：统一每轮引用与前端展示

**Files:**

- Modify: `src/domain/turn-builder.ts`
- Modify: `src/domain/turn-builder.test.ts`
- Modify: `apps/api/src/routes/interview-sessions.ts`
- Modify: `apps/api/src/routes/interview-sessions.test.ts`
- Modify: `src/features/interview/InterviewView.tsx`
- Add/Modify: 对应组件测试
- Modify: 共享 domain type 文件（以 CodeGraph 调用链确认的权威定义为准）

### Steps

- [ ] 添加失败测试：一轮响应中的 `references[]`、策略轨迹 reference IDs/text 和 UI 展示完全一致。
- [ ] 添加失败测试：confirmed memory 被本轮使用时，UI 不得回退显示 card theme/history 第一项。
- [ ] 定义向后兼容的结构化 reference：稳定 ID、type、text、source entity、evidence turn。
- [ ] 服务端在选择上下文时一次性生成 references，并把同一对象传给模型、轨迹和响应。
- [ ] 删除前端从 `referencedMemory ?? historyReferences[0]` 自行猜引用的路径；旧响应无 references 时只显示“未提供结构化引用”，不伪造来源。
- [ ] 运行 turn builder、interview route、组件测试和 `tests/e2e/interview-turn.spec.ts`。
- [ ] 提交：`fix(references): render the exact evidence used by each turn`。

---

## Task 7：资产对话 citation 编号、类型与来源断言

**Files:**

- Modify: `apps/api/src/routes/chat.ts`
- Modify: `apps/api/src/routes/chat.test.ts`
- Modify: `src/features/assets/AssetsView.tsx`
- Add/Modify: 对应组件测试
- Modify: 共享 citation type（若已有则复用）

### Steps

- [ ] 添加失败测试：模型输出越界编号、重复错误编号、引用类型与措辞不一致时，响应不得保存错误引用。
- [ ] 添加失败测试：只有 transcript 可称“原始记录/用户原话”；memory/point/note/theme 使用准确标签；无 citation 时禁止来源断言。
- [ ] 在 prompt 前确定允许 citation 数组和编号；模型后增加结构化 validator，返回规范化 citations 或可诊断 422/502，不静默拼错。
- [ ] 前端按服务端 citation metadata 渲染编号和类型，不从文本猜类型。
- [ ] 运行 `npx vitest run apps/api/src/routes/chat.test.ts` 及组件测试；运行 `tests/e2e/my-assets.spec.ts`、`tests/e2e/real-assets.spec.ts`。
- [ ] 提交：`fix(chat): validate citation numbers and source labels`。

---

## Task 8：实时 WS 基址、ASR turn assembler 与回灌隔离

**Files:**

- Modify: `src/App.tsx`
- Add: `src/realtime/turnAssembler.ts`
- Add: `src/realtime/turnAssembler.test.ts`
- Modify: `src/realtime/cascadedAsrSource.ts`
- Modify: `src/realtime/cascadedAsrSource.test.ts`
- Modify: `src/realtime/cascadeTurnDecision.ts`
- Modify: `src/realtime/cascadeTurnDecision.test.ts`
- Modify: `src/realtime/turnCompleteness.ts`
- Modify: `src/features/interview/InterviewView.tsx`
- Modify: `tests/e2e/voice-cascade.spec.ts`
- Modify: `tests/e2e/voice-fakemic-mechanism.spec.ts`

### Steps

- [ ] 添加失败测试：API base `http://host:3310/api` 派生 `ws://host:3310`，HTTPS 派生 WSS，同源生产 URL 保持同源；无 `3210` 常量。
- [ ] 添加失败测试：partial 不提交；多个 final 在稳定窗口合并；悬挂尾句继续等待；完整回合只提交一次。
- [ ] 添加失败测试：与最近 TTS 高相似、发生于播放区间且无独立用户能量证据的 transcript 进入 quarantine，不生成用户 turn。
- [ ] 添加失败测试：极短但语义完整的“对/不是”在有用户能量和问答语境时保留。
- [ ] 实现 URL 派生 helper 和 turn assembler；让 completeness、时序、能量、TTS 相似度共同决定 commit/wait/quarantine。
- [ ] 在 UI 提供“等待确认”队列，可确认、编辑、丢弃；只有确认/可信 final 进入权威会话。
- [ ] 运行所有 `src/realtime/*.test.ts` 与 API realtime voice tests。
- [ ] 运行非默认端口 fake mic/voice E2E，确认 WebSocket 实际连向 API 端口且没有 phantom turn。
- [ ] 提交：`fix(voice): assemble trustworthy user turns before persistence`。

---

## Task 9：“本次不保存”receipt 与会话收尾真值

**Files:**

- Modify: `apps/api/src/routes/interview-sessions.ts`
- Modify: `apps/api/src/routes/interview-sessions.test.ts`
- Modify: `src/domain/session-archive.ts`
- Modify: `src/domain/session-archive.test.ts`
- Modify: `src/App.tsx`
- Modify: `src/features/interview/InterviewView.tsx`
- Modify: `tests/e2e/interview-lifecycle.spec.ts`

### Steps

- [ ] 添加失败测试：no-save 结束响应含 `sessionDeleted/rawMaterialDeleted/audioDeleted/assetsCreated`；任一层失败返回 partial failure，不显示成功。
- [ ] 添加失败测试：no-save 后长期资产、raw material、audio 和 active session 均无残留；普通保存路径行为不变。
- [ ] 添加前端失败测试：receipt 成功时显示“未写入长期资产”；不得显示“档案已生成/资产已更新”。
- [ ] 把 no-save 作为会话级策略贯穿结束命令，服务端返回结构化 receipt；前端逐项消费真实结果。
- [ ] 与 Task 4 的 active picker 联动：结束成功后立即移出 active；失败则保留并标记需处理，避免重复幽灵会话。
- [ ] 运行 session archive、interview route、lifecycle E2E。
- [ ] 提交：`fix(retention): report and enforce no-save cleanup`。

---

## Task 10：全量验证、真实恢复演练与报告闭环

**Files:**

- Modify: `docs/superpowers/2026-07-16-真人业务全链路验收报告.md`（从原验收报告复制到分支后追加复验结果，不篡改原始发现）
- Add: `docs/superpowers/2026-07-17-全量修复复验记录.md`

### Steps

- [ ] 运行 `npm run typecheck`。
- [ ] 运行 `npx vitest run --reporter=verbose`，记录文件数、测试数、skip 和耗时。
- [ ] 运行 `npm run build`，记录产物与 chunk 警告；确认 LiveKit 不在首屏请求。
- [ ] 启动隔离 API/Web 服务，使用独立 SQLite/Surreal namespace；确认运行代码来自当前 worktree/branch。
- [ ] 执行真实 export → import → graph audit → reverse recall 演练，保存 receipt 和计数；不得使用现有业务库。
- [ ] 运行 `E2E_REAL=1 npx playwright test --project=chromium`；逐项记录外部服务可用性和真实失败，不把 skip 当 pass。
- [ ] 在浏览器完成：档案保存失败/成功、具体主题长访谈、显式修正、跨会话引用、多个 active 恢复、非默认端口语音、TTS 回灌隔离、no-save 收尾。
- [ ] 对照 20 项缺陷建立“缺陷 → 代码 → 测试 → 运行证据”矩阵；只有证据完整才能标记 closed，外部 provider 故障标为“产品侧已正确降级/外部仍不可用”。
- [ ] 运行 `git diff --check`、检查 `git status --short`、复核未触碰原工作区。
- [ ] 使用 `superpowers:requesting-code-review` 做最终审查，修复 P0/P1/P2 审查问题并重跑相关验证。
- [ ] 提交文档闭环：`docs: record full acceptance repair verification`。
- [ ] 不 push；向用户交付分支、commit 列表、验证结果、尚受外部环境约束的项目和工作树路径。

## Defect Coverage Matrix

| 验收缺陷 | 修复任务 |
|---|---|
| P0 restore provenance / graph audit false green | Task 1 |
| AnySearch configured/ready 假绿 | Task 2 |
| LLM timeout 卡“思考中” | Task 2 |
| 7 个 real-assets fixture 过期 | Task 2 |
| vendor-livekit 大 chunk | Task 3 |
| 档案未确认即“已保存” | Task 4 |
| 具体主题落成泛化标题/开场/历史 | Task 4 |
| 阶段总结抓错局部时间片 | Task 5 |
| 修正观点被 memory candidate 重新引入 | Task 5 |
| skip 摘要截断 | Task 5 |
| followup history 全相同 | Task 5 |
| 后半程机械重复 | Task 5 |
| 后端引用与 UI 引用不一致 | Task 6 |
| 资产对话 citation 编号/类型/来源错误 | Task 7 |
| 一键主题静默转 decision mode | Task 4 |
| realtime WS 写死 3210 | Task 8 |
| 无真实输入却落 phantom user turn | Task 8 |
| 语音尾句截断/背景污染 | Task 8 |
| no-save UI 仍称生成档案/资产 | Task 9 |
| active 会话难恢复/重复 | Task 4 + Task 9 |
