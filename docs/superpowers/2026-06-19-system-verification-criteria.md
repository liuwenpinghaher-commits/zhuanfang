# 专访 1.0 系统验证：预期质量与检验标准

> 生成日期：2026-06-19
> 适用范围：顶层项目 `src/` + `apps/api/`（不含 `zhuanfang/` 旧实现）
> 技术栈：Fastify（API）+ Vite/React（前端）+ Vitest（单测/业务旅程）+ Playwright（端到端 UI）

本文件定义"系统做对了什么样才算对"的可执行标准。它把**真实业务用例**、**预期输出**、**质量标准**和**检验方式**绑定在一起，使每条业务能力都有一条可自动断言（或明确标注人工确认）的验收线。能力判断以 `apps/api/src/routes/*` 实际注册的端点为准，而非文档声称。

---

## 0. 测试四层次与通用质量红线

### 测试四层次

| 层 | 目标 | 工具 | 入口 | 不依赖网络/Key |
|----|------|------|------|----------------|
| ① domain 单测 | 纯函数逻辑：策略路由、归一化、隐私/备份报告、语料分析 | Vitest | 直接 import `src/domain/*` | 是 |
| ② 后端业务旅程 | 跨路由、对同一持久化状态的多步真实业务流 | Vitest + `buildApiServer().inject` | `apps/api/src/e2e/*.test.ts` | 是（`env={}` 走确定性 fallback） |
| ③ 前端组件 | 组件渲染、空/加载/错误态、交互 | Vitest + jsdom | `src/**/*.test.tsx` | 是 |
| ④ Playwright e2e | 真实浏览器驱动整套前后端，验证用户旅程闭环 | Playwright | `tests/e2e/*.spec.ts` | 启动真实 API（无 key 时走 fallback） |

### 通用质量红线（每条业务用例都必须满足）

1. **无 5xx**：happy path 与降级路径都不得返回 500；缺 key/外部失败必须被捕获并降级为 200 + fallback 内容。
2. **无数据丢失**：写操作后 `GET /api/state` 必须能查回该对象；`revision` 单调递增。
3. **离线可用**：无 `DASHSCOPE_API_KEY`/`BAILIAN_API_KEY` 时，所有能力走确定性本地 fallback，不崩溃、不挂起、不依赖外网。
4. **操作闭环有反馈**：每个用户动作都返回明确的状态变更或可观测产物（笔记、资产、简报、记录、报告）。
5. **乐观并发安全**：`PUT /api/state` 要求 `revision` 精确等于服务端值，否则 409（杜绝零成本绕过乐观锁）。
6. **密钥边界**：导出包/隐私报告不得包含 provider secret 或 env 值；隐私清空保留运行配置。

### 验证命令

```bash
npm run typecheck                                   # tsc -b + apps/api：exit 0
npx vitest run --exclude "**/*.real.test.ts"        # 层 ①②③（确定性，无网络）
# Playwright（层 ④）先停占用端口，再跑：
lsof -ti :5173 :8787 | xargs kill -9
npx playwright test
```

> `*.real.test.ts` 是需要真实 LLM key 的契约测试，**默认排除**；CI/离线环境不应将其计入回归基线。

---

## 1. 专访闭环（session → turns → finish → 双轨笔记 + 资产）

| 项 | 内容 |
|----|------|
| 业务场景 | 产品经理就"团队授权与控制感"做一次决策专访：创建会话 → 提交 3 轮真实表达 → 结束 → 系统产出双轨笔记，并沉淀观点/问题/决策/知识债。 |
| 前置 / 步骤 | 1) `POST /api/state/reset` 清空；2) `POST /api/interview-sessions {mode:"decision", strength:"standard"}`；3) 对 `/turns` 提交 3 段关于授权/控制感的真实内容；4) `POST /api/interview-sessions/:id/end`。 |
| 预期输出 | 创建返回 `session.status="active"`、`session.card.title` 非空、`session.guide` 存在。每轮 `turns` 中 user 轮次递增。结束返回 `note.sessionId===id`、`note.title` 非空、`note.summary` 存在，`saidTrack`/`learnedTrack`/`nextQuestions` 均为数组；`state.sessions` 中该 session `status="completed"`；`revision` 严格大于创建后。 |
| 质量标准 | 笔记区分"我说了什么"(saidTrack) 与"我学到了什么"(learnedTrack)；会话生命周期 active→completed 完整；无 key 时双轨字段为合法数组（可空），但 note 标题/摘要必须有内容。 |
| 检验方式 | 自动断言：`apps/api/src/e2e/business-journeys.test.ts` Journey 1；`apps/api/src/e2e/full-business-journey.test.ts` Step 2。 |

---

## 2. 认知资产（档案归档 / 资产库检索 / 主题线聚合 + 资料↔主题打标）

| 项 | 内容 |
|----|------|
| 业务场景 | 一次专访结束后，用户想按场次回看这次专访的全部产出（档案），并跨场次检索所有观点/问题/决策（资产库），同时把这次专访挂到一条长期主题线下聚合。 |
| 前置 / 步骤 | 完成 §1 专访后：1) `buildSessionArchive(state)` 归档；2) `buildTrackWorkspace(state, themeId)` 聚合主题线产出。 |
| 预期输出 | `buildSessionArchive` 返回含该 `sessionId` 的 entry，其 `session.id===sessionId`，`points/questions/decisions/debts` 均为数组。`buildTrackWorkspace` 返回 `outputs.points/questions/decisions/debts` 均为数组；有主题时 `theme.id===themeId`，无主题时 `theme===undefined`（边界路径不崩）。 |
| 质量标准 | 档案以 note 为锚关联回 session 与资产；主题线把多场次产出聚合为单一工作区；空主题返回结构化空对象而非抛错。 |
| 检验方式 | 自动断言：`full-business-journey.test.ts` Step 3（archive）与 Step 7（track workspace）。 |

---

## 3. 外部调研自动化（auto-run：议程 → 生成/刷新简报 → 去重；tracked 喂专访；新鲜度）

| 项 | 内容 |
|----|------|
| 业务场景 | 用户为"团队授权"建一条简报并标记追踪，让系统自动盯梢：每天生成新议题简报、刷新过期的 tracked 简报、跨简报去重来源；随后用这条 tracked 简报作为下一次专访的上下文。 |
| 前置 / 步骤 | 1) `POST /api/search/briefs {topic, providerId:"local-demo"}`；2) `POST /api/search/briefs/:id/track {tracked:true}`；3) `POST /api/research/auto-run`；4) 用 `searchBriefId` 创建专访。 |
| 预期输出 | 建简报返回 `brief.sources.length>0`、`tracked` 初始 falsy。track 后 `brief.tracked===true`。auto-run 返回 `summary.generated`/`refreshed`/`dedupedSources` 三个数字字段（均 ≥0），刷新会更新 tracked 简报内容；`finalState` 持久化。带 `searchBriefId` 创建的 session `card.title` 非空（简报已进入上下文）。 |
| 质量标准 | auto-run 必返回三段计数汇总；tracked 简报参与刷新；无 key 时 `local-demo` 走确定性来源；`isSearchBriefStale` 决定刷新对象（行为通过 auto-run 的 refreshed 计数间接验证）。 |
| 检验方式 | 自动断言：`full-business-journey.test.ts` Step 1；`system-module-journey.test.ts` 调研自动盯梢段（auto-run summary 形态 + 简报刷新）。 |

---

## 4. 记忆 HITL（导入 → 候选 → approve/reject/edit → confirmed；corrections）

| 项 | 内容 |
|----|------|
| 业务场景 | 用户导入一段授权研究摘录，系统抽取记忆候选；用户审批通过后，候选进入长期记忆库（confirmed record），并在后续专访上下文中可被引用。 |
| 前置 / 步骤 | 1) `POST /api/import/documents {title, content, sourceType:"text"}`；2) 若有 `pending` 候选，`POST /api/memory-candidates/:id/approve`。 |
| 预期输出 | 导入返回 `sourceId` 非空、`candidateCount` 为数字（无 key 可为 0）、`ragChunks.length>0`、`importSources` 含该源。审批返回 `candidate.status="approved"`、`record.sourceCandidateId===候选id`；`GET /api/state` 的 `memoryRecords` 持久化该 record。 |
| 质量标准 | 候选必须经人工 approve 才进入长期记忆（HITL 闭环）；无 key 时 candidateCount=0 是合理路径，不阻断其他流程；mock LLM 路径下 approve→record 完整。 |
| 检验方式 | 自动断言：`business-journeys.test.ts` Journey 3（含 mock LLM）；`full-business-journey.test.ts` Step 5。 |

---

## 5. RAG（导入资料 → embed/chunk → query 召回 + citations）

| 项 | 内容 |
|----|------|
| 业务场景 | 用户导入授权与控制感研究摘录后，就"团队授权"提问，系统基于已导入资料给出答案并附带可追溯引用。 |
| 前置 / 步骤 | 导入文档后 `POST /api/rag/query {question:"团队授权"}`。 |
| 预期输出 | `answer` 为非空字符串；`citations` 为数组且非空，每条含 `id`(string) 与 `title`(string)；答案或引用标题包含主题词（授权/控制感/团队）。 |
| 质量标准 | 已导入资料后必须能被召回（citations 非空）；fallback keyword 路径也要返回基于真实内容的摘要，而非空答案或编造来源。 |
| 检验方式 | 自动断言：`full-business-journey.test.ts` Step 6；`routes/rag.test.ts`。 |

---

## 6. 系统配置（capabilities 健康 / config env / 产品策略保存影响引擎）

| 项 | 内容 |
|----|------|
| 业务场景 | 运维查看真实能力健康，确认无 key 时各 provider 显示 needs-key/降级而非假装就绪；并通过参数页保存服务端 env 配置（如调研最大来源、播客音色），保存即在内存生效。 |
| 前置 / 步骤 | 1) `GET /api/system/capabilities`；2) `PATCH /api/system/config {updates:{...}}`（注入 `env={}` 时写入注入对象）；3) 重新 `GET /api/system/config` 复核。 |
| 预期输出 | capabilities 返回 `capabilities[]`，每项含 `id/kind/status/active/requiredEnv`；无 key 时 `bailian-*` 状态为 `needs-key`，`product-api`/`state-store` 为 `ready`。PATCH 仅接受白名单 key（未知 key 被丢弃）；空 updates → 422；合法 PATCH 返回 `settingsUpdated` 含被改 key，且复核时该 setting `configured=true`/`value` 反映新值（secret 不回显明文，仅 maskedValue）。 |
| 质量标准 | 能力健康必须反映真实运行态（诚实降级，不谎报 ready）；config PATCH 校验输入、过滤非白名单、secret 不泄露明文；保存后 in-memory env 立即可读。 |
| 检验方式 | 自动断言：`system-module-journey.test.ts` 配置段；`routes/new-routes.test.ts`（capabilities/config 既有覆盖）。 |

---

## 7. 语料学习（corpus/insights 分析 → playbook patch → apply → 影响引擎 + realtime instructions）

| 项 | 内容 |
|----|------|
| 业务场景 | 用户导入一段优秀专访样本做"语料学习"。系统分析出访谈技法维度并生成一条 PlaybookPatch（含具体追问规则）。用户应用该 patch 后，**新创建的专访会话的引擎策略**纳入这些规则，并且这些规则进入**实时语音主持指令**——形成"学习→引擎→语音"闭环。 |
| 前置 / 步骤 | 1) `POST /api/corpus/insights {title, content}`（含"具体时刻/机制反转"技法的真实样本）；2) 取 `proposed` patch，`POST /api/playbook-patches/:id/apply`；3) `POST /api/interview-sessions` 建新会话；4) `GET /api/realtime-voice/agent-context/:sessionId` 读主持指令。 |
| 预期输出 | insights 返回 `insight.recommendedPatches[0]` 为 `proposed`，patch `rules.length>0`、`ruleTypes` 与 rules 位置对齐（如 `concrete-moment`/`mechanism-reversal`/`follow-up`）。apply 返回 `patch.status="applied"`，`systemConfig.version` 追加补丁后缀。新会话 `enginePolicy.appliedPlaybookRules` 包含该 patch 的规则文本，`enginePolicy.appliedPlaybookRuleTypes` 包含其 ruleType。agent-context 返回的 `instructions` 字符串包含已应用规则文本（"已应用的提问技法"段）。 |
| 质量标准 | ruleType 由文本分类得出，使策略路由不再依赖脆弱的运行时关键词匹配；apply 是 HITL（只有 proposed 可 apply，只有 applied 可 revert）；规则真正穿透到引擎策略与语音指令，而非仅落库。 |
| 检验方式 | 自动断言：`system-module-journey.test.ts` 语料学习闭环段（insights→apply→enginePolicy→agent-context instructions）；`src/domain/corpus.test.ts`（既有 ruleType 单测）。 |

---

## 8. 个人档案 + 数据治理（profile / corrections / export / privacy-report / purge）

| 项 | 内容 |
|----|------|
| 业务场景 | 用户在个人档案页查看 AI 记忆与边界、导出数据备份、查看隐私库存、彻底清空个人数据。清空后个人数据归零但状态结构完整、provider 配置保留。 |
| 前置 / 步骤 | 1) `GET /api/state/export`；2) `GET /api/state/privacy-report`；3) `POST /api/state/purge`；4) purge 后再 `GET /api/state` 与 `privacy-report` 复核。 |
| 预期输出 | export 返回备份演练报告：`schemaVersion=1`、`package.stateDigest`/`restoredDigest`（恢复后摘要一致）、`package.providerSecretsExcluded=true`、`summary` 含 passed/warning/failed 计数、`privacyReport` 内嵌、`checks` 数组、`runbook` 数组。privacy-report 返回 `inventory` 非空，含 `profile/interviews/assets/memory/external_knowledge/corpus_learning/generated_media/operations` 类目，**不含已删除的 `intel` 类目**，`totalRecords` 为数字。purge 后：`profile.name=""`、`sessions/notes/points/...=[]`、`hasPersonalData=false`、保留一条 `privacy_data_purged` 审计事件、`systemConfig` 保留；privacy-report `totalRecords` 仅剩运营类（operations）的审计计数。 |
| 质量标准 | 导出可序列化且恢复摘要一致（备份可信）；隐私库存分类齐全且与状态计数一致；purge 是真删除（个人数据归零）但结构与配置保留（不破坏可启动性）；密钥永不进入导出包。 |
| 检验方式 | 自动断言：`system-module-journey.test.ts` 导出/隐私/purge 段；`full-business-journey.test.ts` Step 8；Playwright `tests/e2e/data-governance.spec.ts`（导出/隐私报告/清空 UI 闭环）。 |

---

## 9. 播客（episodes 创建 → script → synthesize；无 TTS 降级）

| 项 | 内容 |
|----|------|
| 业务场景 | 用户把一篇专访笔记一键转成单人播客：系统生成脚本与 shownotes，并尝试合成音频；无 TTS key 或 TTS 失败时保留脚本并降级，不报错。 |
| 前置 / 步骤 | 1) `POST /api/podcast/episodes {noteId, format:"solo"}`；2) `POST /api/podcast/episodes/:id/synthesize`。 |
| 预期输出 | 创建返回 `episode.noteId===noteId`、`episode.script` 非空；无 TTS client 时 `audioRenderStatus="pending"`。synthesize 在无 TTS/TTS 失败时返回 200，`audioRenderStatus="fallback"`，script 保留；episode 持久化到 `podcastEpisodes`。 |
| 质量标准 | 脚本生成与音频渲染解耦：脚本永远先有；TTS 失败只降级 audio 状态，绝不丢脚本、绝不 5xx。 |
| 检验方式 | 自动断言：`business-journeys.test.ts` Journey 2；`full-business-journey.test.ts` Step 9；`routes/podcast.test.ts`。 |

---

## 覆盖矩阵

| # | 功能 | 真实业务用例数 | 主要检验文件 |
|---|------|----------------|--------------|
| 1 | 专访闭环 | 2 | business-journeys / full-business-journey |
| 2 | 认知资产 | 1 | full-business-journey |
| 3 | 外部调研自动化 | 2 | full-business-journey / system-module-journey |
| 4 | 记忆 HITL | 2 | business-journeys / full-business-journey |
| 5 | RAG | 1 | full-business-journey / rag.test |
| 6 | 系统配置 | 1 | system-module-journey / new-routes.test |
| 7 | 语料学习闭环 | 1 | system-module-journey / corpus.test |
| 8 | 数据治理 | 2 | system-module-journey / full-business-journey / data-governance.spec |
| 9 | 播客降级 | 2 | business-journeys / full-business-journey / podcast.test |

**人工确认项（非自动断言，需视觉/运行核对）**

- Playwright 数据治理：导出按钮触发浏览器下载（`download` 行为在 headless 下由测试断言成功态文案"已下载 JSON 备份包"间接确认；实际文件落盘需人工确认）。
- 实时语音真实连接、TTS 真实音频质量、联网搜索真实来源新鲜度：需配置 `DASHSCOPE_API_KEY` 后由 `*.real.test.ts` 或人工验收，离线回归不覆盖。
- UI 视觉质量（层次/留白/移动端）：Playwright 验证可达性与闭环，视觉精致度需人工走查。
