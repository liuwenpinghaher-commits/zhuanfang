# 语料学习功能优化 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development。domain/后端 TDD;UI 按结构+验收 + Playwright。Steps 用 checkbox。

**Goal:** 把"真功能但黑箱+弱反馈+不能调+不能上传音频"的语料学习,改造成**可感知效果 + 透明 + 可调 + 可上传 + 有进度**。基于本会话深度调查(做实度 72/100,两大缺口:零可观察反馈、进行中会话 enginePolicy 不刷新)。

**Architecture:** 前端展示/可调 + 后端 enginePolicy 重盖 + 分析侧重透传 + 文件上传(诚实降级)。React+Vite+TS,深色主题,样式 `src/styles.css`,lucide,U1 已有 `.form-card`/`.form-row`/`.char-count`。

**Tech Stack:** TS/React, Fastify, Vitest, Playwright。验证:`npm run typecheck` / `npx vitest run --exclude "**/*.real.test.ts"` / `npx playwright test`。

## 已核实(调查结论,避免走偏)
- 分析:`apps/api/src/intelligence/corpus-llm.ts`(LLM,`SYSTEM_PROMPT` 私有 const :13)+ `src/domain/corpus.ts analyzeImportedInterview`(确定性兜底,维度模板硬编码)。`POST /api/corpus/insights`(corpus.ts:79)。
- patch 消费:approve(`corpus.ts:221 approvePlaybookPatch`)→ `collectAppliedPlaybookRules/RuleTypes`(`context-pack.ts:799/810`)→ `buildInterviewEnginePolicy`(`strategy.ts:23`)→ `session.enginePolicy`。**enginePolicy 只在 `createSessionDraft`(context-pack.ts:868)建会话时盖一次**——进行中 approve 不生效(staleness bug)。
- rules 进专访 LLM:`bailian.ts:874 buildCharacterSystemPrompt` 读 `enginePolicy.appliedPlaybookRules`(软提示,取前 3)。ruleType 硬触发策略:`strategy.ts:484/492`。`turn.strategy` 已写入数据(turn-builder.ts:191)但 **UI 不渲染**。
- 音频:`CorpusLearningView.tsx:66-86` 只填 URL,无文件上传;后端 `corpus.ts:121` 只收 URL,交百炼 SenseVoice(`bailian.ts:578` 录音文件识别,需 `file_urls` 公网 URL)。**SenseVoice 不能直接转本地文件**(架构约束)。
- 进度:转写仅 `corpusTranscribing` 布尔(App.tsx:170);分析**无 loading**。
- 可调:全仓无自定义 prompt/维度入口。

## 通用约束
- 顶层 `src/`/`apps/`(忽略 zhuanfang)。提交只 `git add` 本 Task 文件,禁 `git add -A/.`。每 Task:typecheck + vitest 全绿 + git status 核无关文件未暂存。组件用 Write 避免弯引号。

---

## C1: 效果可感知 + 修进行中会话不刷新(P0,最解疑)

**Files:** Modify `apps/api/src/routes/interview-sessions.ts`(receiveTurn 重盖 enginePolicy)、`src/domain/strategy.ts` 或 turn-builder(strategy→标签)、`src/features/interview/*`(渲染已应用技法)、`src/styles.css`;测试。

- [ ] **Step 1:** 读 `interview-sessions.ts` 的 `receiveTurn`/`/turns`(:106/333)、`buildInterviewEnginePolicy`(strategy.ts:23)、`createSessionDraft`(context-pack.ts:868)、专访视图(实时/文本)如何渲染 turns、`turn.strategy` 字段。
- [ ] **Step 2(修 staleness,TDD)**:`receiveTurn` 在生成 assistant turn **前**,用 `buildInterviewEnginePolicy(repository.getState())` 重盖 `session.enginePolicy`(让进行中 approve 的 patch 下一轮生效)。测试:建会话→apply 新 patch→下一 `/turns`→assistant 的 system prompt(或 session.enginePolicy.appliedPlaybookRules)含新 rule。
- [ ] **Step 3(效果可感知)**:专访视图加一个**"本场已应用的学习技法"**面板/小标签——从 `session.enginePolicy.appliedPlaybookRules`(诚实:这些确实在 prompt 里)展示前几条;若为空不显示。**对确定性 strategy 触发的 assistant turn**,在该轮加小徽章(如"应用技法:索要具体时刻")——用 `turn.strategy` + 一个 strategy→中文标签映射(部分映射在 turn-builder 已有,复用/补全并导出)。
- [ ] **Step 4:** `npm run typecheck` + 全量 vitest 全绿。
- [ ] **Step 5:** 提交:`git add` 改动文件+测试,`git commit -m "feat(corpus): re-stamp enginePolicy per turn (fix mid-session staleness) + surface applied techniques in interview (observable effect)"`。

---

## C2: 分析 prompt + 维度透明化(P0,只读展示)

**Files:** Modify `apps/api/src/intelligence/corpus-llm.ts`(export prompt)、`src/domain/corpus.ts`(export 维度定义)、`src/features/corpus/CorpusLearningView.tsx`(只读披露)、`src/api/productApi.ts`(若需取 prompt)、`src/styles.css`;测试。

- [ ] **Step 1:** 读 corpus-llm.ts 的 SYSTEM_PROMPT + corpus.ts 的维度名/定义,决定怎样把它们暴露给前端(最简:在前端定义一份"分析方法说明"常量镜像该 prompt 要点 + 维度名;或后端加 `GET /api/corpus/method` 返回 prompt 文本与维度定义。**择简:前端常量镜像 + 注释指明源在 corpus-llm.ts,避免新端点**)。
- [ ] **Step 2:** CorpusLearningView 加一个可折叠的**「分析方法 / 它怎么读你的样本」**披露区(`<details>` 或展开面板):展示——分析关注的维度(追问动作/节奏/反方推动…)、产出结构(维度评分+改进计划+可应用规则)、铁律(只基于样本、给原话、不编造)。让用户知道黑箱里是什么。
- [ ] **Step 3:** `npm run typecheck` + 全量 vitest 全绿。
- [ ] **Step 4:** 提交:`git add` 改动文件+测试,`git commit -m "feat(corpus): expose analysis method/dimensions (read-only transparency)"`。

---

## C3: 可调——分析侧重 + patch 规则可编辑再应用(P1)

**Files:** Modify `src/features/corpus/CorpusLearningView.tsx`、`src/App.tsx`、`src/api/productApi.ts`、`apps/api/src/routes/corpus.ts`、`apps/api/src/intelligence/corpus-llm.ts`、`src/domain/corpus.ts`;测试。

- [ ] **Step 1:** 读 corpus 分析入参链路(CorpusLearningView 提交 → App `analyzeCorpus` → productApi → `/api/corpus/insights` → `analyzeCorpus`/`analyzeCorpusWithLlm`)+ insight 卡如何展示 patch.rules + approve 路径(`approvePlaybookPatch`)。
- [ ] **Step 2(分析侧重)**:CorpusLearningView 加可选「分析侧重(可选)」输入(如"重点学习如何追问失败经历");透传到 `/api/corpus/insights` body → `analyzeCorpusWithLlm` 把它拼进 user 消息("用户特别希望你关注:…");确定性路可忽略或附注。TDD:带 focus 的请求,LLM user 消息含该文本(可测 prompt 构造函数)。
- [ ] **Step 3(patch 可编辑)**:insight 卡的推荐 PlaybookPatch 规则改为**可编辑**(每条 rule 可改/删 + 可加一条),用户编辑后点"确认影响引擎"时用**编辑后的 rules** 调 approve。需:`approvePlaybookPatch` 支持传入覆盖的 rules(或先 `editPlaybookPatch` 再 approve);ruleTypes 对编辑后的 rules 重新 `inferPlaybookRuleType`。TDD:编辑 rules 后 approve,applied patch 的 rules/ruleTypes 是编辑后的。
- [ ] **Step 4:** `npm run typecheck` + 全量 vitest 全绿。
- [ ] **Step 5:** 提交:`git add` 改动文件+测试,`git commit -m "feat(corpus): custom analysis focus + editable patch rules before apply (user tunability)"`。

---

## C4: 音频本地文件上传(P1,诚实处理架构约束)

**Files:** Modify `src/features/corpus/CorpusLearningView.tsx`、`src/App.tsx`、`src/api/productApi.ts`、`apps/api/src/routes/corpus.ts`、可能 `apps/api/src/providers/bailian.ts`;测试。

- [ ] **Step 1:** 读 voice 克隆的文件上传(`App.tsx:418 uploadVoice` base64 路径)作参考;确认 SenseVoice 需公网 URL(本地文件无法直接转)、以及百炼是否有**内联音频(base64/data-uri)**的 chat/omni 转写能力(qwen-audio/omni)。**调查后决定转写策略**。
- [ ] **Step 2(上传 UI)**:CorpusLearningView 音频区加**本地文件选择/拖拽**(`<input type="file" accept="audio/*">` + FileReader→base64),与现有"粘 URL"并存(两种来源任选)。显示已选文件名/大小。
- [ ] **Step 3(转写)**:`POST /api/corpus/transcriptions` 支持接收 base64 音频(除 URL 外):
   - **若百炼有内联音频转写能力** → 用它真转写。
   - **否则诚实降级**:接收并暂存文件(或仅前端持有),返回 `status:"degraded"` + 明确提示"已上传 <文件名>,当前转写后端需公网 URL/内联音频能力;请粘贴或编辑转写稿",把文件名带入文本框上下文。**不假装转写了**。DONE_WITH_CONCERNS 说明约束。
- [ ] **Step 4:** TDD:上传 base64 → 端点接收不崩、按能力真转写或诚实降级(注入 fake client 两种分支)。
- [ ] **Step 5:** `npm run typecheck` + 全量 vitest 全绿。
- [ ] **Step 6:** 提交:`git add` 改动文件+测试,`git commit -m "feat(corpus): local audio file upload (inline transcription or honest degradation)"`。

---

## C5: 分析/转写进度反馈(P2)

**Files:** Modify `src/features/corpus/CorpusLearningView.tsx`、`src/App.tsx`、`src/styles.css`。

- [ ] **Step 1:** 加 `corpusAnalyzing` 布尔(App.tsx):点"分析并生成建议"→ 按钮 `.btn-loading` + 禁用 + 文案"分析中…";完成恢复 + 现有 success notice。
- [ ] **Step 2:** 分析为多步(转写→分析)时显示阶段提示文字("正在提炼提问技法…");转写 loading 文案更明确(含文件名/URL)。复用 `.spinner`/`.btn-loading`。
- [ ] **Step 3:** `npm run typecheck` + 全量 vitest 全绿。
- [ ] **Step 4:** 提交:`git add` 改动文件,`git commit -m "feat(corpus): analysis/transcription progress feedback (loading + stage hints)"`。

---

## C6: 验证 + 视觉自审 + 推送

- [ ] **Step 1:** 停 dev(`lsof -ti :5173 :8787|xargs kill -9`),跑 `npx playwright test`;修因 corpus UI 变化失效的 spec(corpus-podcast 等)。
- [ ] **Step 2:** 视觉自审:专访里能看到"已应用技法"?进行中 approve 下一轮生效?prompt/维度可见?分析侧重 + patch 可编辑可用?音频能选文件?分析有 loading?
- [ ] **Step 3:** 全量 typecheck + vitest + playwright 全绿;推送 origin/main。

---

## Self-Review
**1. 覆盖:** 7 质疑 → C1(效果可感知+staleness)、C2(prompt 透明=为什么没透露)、C3(可调=为什么不能优化)、C4(音频上传)、C5(进度)。"如何分析"已由调查回答 + C2 透明化落地。
**2. 占位扫描:** 无 TBD;C4 转写受架构约束,设诚实降级闸门,不假装。
**3. 一致性:** 复用 U1 表单类、已有 setNotice、buildInterviewEnginePolicy;strategy→标签映射统一导出。
**4. 风险:** C1 改 receiveTurn 每轮重盖 enginePolicy(轻量纯函数,全回归);C3 改 approve 签名(向后兼容:不传 rules 则用原 patch);C4 老实降级。
