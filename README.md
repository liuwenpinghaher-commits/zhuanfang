# Zhuanfang

语音专访式日记工具原型。当前版本已经从纯前端 demo 演进为本地可运行的产品 MVP：前端负责沉浸式专访与工作台体验，Product API 负责状态、配置、联网搜索、百炼模型、播客音频、语料转写和实时语音代理。

当前交付状态以 [docs/implementation-status.md](docs/implementation-status.md) 为准；早期方案文档保留为设计过程记录。

## 核心业务

- 实时专访：会前访谈卡、文本专访、实时语音入口、短反馈、留白/打断识别、实时信号追踪、会中控制。
- 会后沉淀：双轨笔记、观点、问题、决策候选、知识债、长期主题。
- 联网素材：百炼 Responses 内置联网、AnySearch / Tavily / Exa / Brave Search 外接搜索、本地降级素材、建议主题批量搜集、来源转资产。
- 语料学习：导入文本或音频专访样本，分析追问逻辑，生成 PlaybookPatch，经确认后影响后续引擎。
- 播客工作台：从笔记、搜索简报、长期主题、知识债、语料学习结果生成单人旁白或主持对谈播客；TTS 已配置时默认直出百炼 CosyVoice 音频。
- 系统配置：provider 健康、运行配置、产品策略、配置版本、质量运营、质量修复动作和 AI 运行事件。
- 数据治理：个人页提供完整 JSON 导出/导入、隐私数据库存、迁移准备清单、备份恢复演练、运营检查证据、演示数据重置和彻底清空个人数据；Product API 清空会删除已引用的本地对象音频，清空不会恢复 demo 样例，导出包不包含运行密钥。

## 技术底座

- Frontend: React 18, TypeScript, Vite, lucide-react.
- Product API: Fastify, tsx.
- State: `npm run start:api` 默认使用 SQLite `.data/product-state.sqlite` 持久化；测试和临时演示可设置 `PRODUCT_STATE_DB_PATH=memory` 回到内存态。
- Workflow Runtime: 本地确定性 runtime + Mastra-compatible HTTP runtime adapter，可通过配置切换。
- Tests: Vitest, Playwright.
- Optional providers: 百炼 Responses / qwen-plus-character / Qwen-Omni Realtime / CosyVoice / SenseVoice, AnySearch / Tavily / Exa / Brave Search.

Redis 暂缓；Prisma 不是当前首选。项目默认使用轻量 SQLite 状态仓库，适合本地单机和后续迁移。

## 运行

```bash
npm install
npm run dev:full
```

`dev:full` 会同时启动 Product API 和 Vite 前端；默认前端是 `127.0.0.1:5173`，Product API 默认监听 `127.0.0.1:8787`。
如果前端端口、预览端口或部署域名发生变化，在系统配置页或 `.env.local` 中更新 `PRODUCT_WEB_ORIGINS` 即可放行对应浏览器来源。

也可以分两个终端启动：

```bash
npm run dev:api
npm run dev
```

生产构建：

```bash
npm run build
```

生产容器演练：

```bash
cp .env.production.example .env.production.local
docker compose --env-file .env.production.local up --build
```

容器会在同一个 `PORT` 上托管前端静态产物和 Product API，默认访问 `http://127.0.0.1:8787`。`VITE_PRODUCT_API_BASE_URL` 在生产模板中保持空值，表示浏览器同源请求 `/api/*`；如果前端和 API 分域部署，再把它改成公开 API 地址。详细步骤见 [docs/deployment-runbook.md](docs/deployment-runbook.md)。

测试：

```bash
npm test -- --run
npm run test:e2e
```

`npm run test:e2e` 会自动启动 `Product API` 和前端 dev server；测试中的 API 使用 `PRODUCT_STATE_DB_PATH=memory`，不会写入默认的 `.data/product-state.sqlite`。

## 关键配置

可在 `.env.local` 或系统配置页维护。密钥只在 Product API 服务端使用，不下发到浏览器。

```bash
DASHSCOPE_API_KEY=
BAILIAN_API_KEY=
ANYSEARCH_API_KEY=
ANYSEARCH_ALLOW_ANONYMOUS=false
ANYSEARCH_BASE_URL=https://api.anysearch.com
ANYSEARCH_LANGUAGE=zh-CN
ANYSEARCH_ZONE=
TAVILY_API_KEY=
TAVILY_BASE_URL=https://api.tavily.com
EXA_API_KEY=
EXA_BASE_URL=https://api.exa.ai
BRAVE_SEARCH_API_KEY=
BRAVE_SEARCH_BASE_URL=https://api.search.brave.com

BAILIAN_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1
BAILIAN_AUDIO_BASE_URL=https://dashscope.aliyuncs.com
BAILIAN_SEARCH_MODEL=qwen3.7-plus
BAILIAN_CHARACTER_MODEL=qwen-plus-character
BAILIAN_CHARACTER_PROMPT_STYLE=role-play-partial
BAILIAN_CHARACTER_TEMPERATURE=0.55
BAILIAN_CHARACTER_MAX_TOKENS=140

WORKFLOW_RUNTIME_PROVIDER=local
MASTRA_RUNTIME_ENDPOINT=
MASTRA_RUNTIME_API_KEY=
DEPLOYMENT_PROFILE=local
PROVIDER_SMOKE_TEST_TOPIC=AI 产品商业化热点 provider 冒烟
PROVIDER_SMOKE_TEST_AUDIO_URL=
PROVIDER_SMOKE_TEST_WEBRTC_OFFER_SDP=

HOST=127.0.0.1
PORT=8787
VITE_PRODUCT_API_BASE_URL=http://127.0.0.1:8787
PRODUCT_API_HEALTH_URL=http://127.0.0.1:8787/api/health
PRODUCT_WEB_URL=http://127.0.0.1:5173
PRODUCT_STATIC_DIR=dist
PROVIDER_REQUEST_TIMEOUT_MS=30000
SEARCH_REQUEST_TIMEOUT_MS=30000
BAILIAN_REQUEST_TIMEOUT_MS=30000
MASTRA_RUNTIME_TIMEOUT_MS=30000

BAILIAN_TTS_MODEL=cosyvoice-v3-plus
BAILIAN_TTS_VOICE=longyuan_v3
BAILIAN_TTS_FORMAT=mp3
BAILIAN_TTS_SAMPLE_RATE=24000
BAILIAN_TTS_RATE=0.95
BAILIAN_TTS_ENABLE_MARKDOWN_FILTER=true
BAILIAN_TTS_ENABLE_AIGC_TAG=true
BAILIAN_ASR_MODEL=sensevoice-v1
BAILIAN_ASR_LANGUAGE_HINT=zh
BAILIAN_ASR_POLL_ATTEMPTS=20
BAILIAN_ASR_POLL_INTERVAL_MS=500

BAILIAN_REALTIME_MODEL=qwen3.5-omni-plus-realtime
BAILIAN_REALTIME_FALLBACK_MODEL=qwen3.5-omni-flash-realtime
BAILIAN_REALTIME_WEBRTC_ENDPOINT=
BAILIAN_REALTIME_TRANSPORT=webrtc
BAILIAN_REALTIME_VOICE=Ethan
BAILIAN_REALTIME_ENABLE_SEARCH=false
BAILIAN_REALTIME_VAD_TYPE=server_vad
BAILIAN_REALTIME_VAD_THRESHOLD=0.5
BAILIAN_REALTIME_SILENCE_DURATION_MS=800

PRODUCT_STATE_DB_PATH=.data/product-state.sqlite
PRODUCT_BACKUP_STRATEGY=manual-json-export
PRODUCT_WEB_ORIGINS=http://127.0.0.1:5173,http://localhost:5173
CORPUS_UPLOAD_DIR=.data/corpus-audio
CORPUS_AUDIO_PUBLIC_BASE_URL=
CORPUS_AUDIO_MAX_BYTES=52428800
PODCAST_AUTO_RENDER_ON_CREATE=auto
```

`BAILIAN_BASE_URL` 用于百炼兼容模式的联网搜索和角色扮演专访；`BAILIAN_AUDIO_BASE_URL` 用于 CosyVoice TTS 与 SenseVoice ASR。两类 API 默认域名不同，部署到代理或企业网关时应分别配置。

`ANYSEARCH_BASE_URL`、`ANYSEARCH_LANGUAGE` 和 `ANYSEARCH_ZONE` 控制外接 AnySearch 的服务端请求。`ANYSEARCH_ZONE` 可留空自动选择，也可按 provider 支持情况设置为 `cn` 或 `intl`。

`BAILIAN_ASR_LANGUAGE_HINT`、`BAILIAN_ASR_POLL_ATTEMPTS` 和 `BAILIAN_ASR_POLL_INTERVAL_MS` 控制导入语音专访时的 SenseVoice 转写语言提示和轮询节奏。公网音频较长时可提高轮询次数；本地调试时建议保持默认。

`BAILIAN_REALTIME_WEBRTC_ENDPOINT` 需要百炼侧白名单 Endpoint。Product API 可用但 endpoint 未配置时，实时语音入口会停留在文本专访并显示配置原因；只有 Product API 完全不可用时才进入本地节奏模拟，不会暴露 key。

`BAILIAN_REALTIME_ENABLE_SEARCH` 控制 Realtime session.update 是否允许携带联网材料能力；开启后仍由 Product API 负责整理搜索简报和可追溯来源，浏览器不会直接接触 provider key。

`PRODUCT_STATE_DB_PATH` 为空或不写时，`npm run start:api` 会默认使用 `.data/product-state.sqlite`；设置为 `memory`、`:memory:` 或 `in-memory` 时使用内存状态库，重启后回到 seed 状态。

`PRODUCT_WEB_ORIGINS` 是允许访问 Product API 的浏览器来源白名单，多个 origin 用逗号分隔，例如 `http://127.0.0.1:5173,https://app.example.com`；保存后会立即影响 CORS 响应。

`CORPUS_AUDIO_MAX_BYTES` 控制本地语料音频单文件上传上限，默认 50MB；超过上限时 Product API 返回 413，不会写入本地对象目录。

`CORPUS_AUDIO_PUBLIC_BASE_URL` 是本地语料音频的公开访问前缀，例如 `https://api.example.com/api/corpus/audio-files`；配置后，上传得到的 `local-object://corpus-audio/...` 可以映射成公开 URL 交给百炼 SenseVoice 自动转写。未配置时仍保留可编辑手工转写稿。

`HOST` / `PORT` 控制 Product API 监听地址；`VITE_PRODUCT_API_BASE_URL` 控制浏览器前端连接哪个 Product API；`PRODUCT_API_HEALTH_URL` 和 `PRODUCT_WEB_URL` 用于 `npm run dev:full` 判断是否复用已有服务。

`PRODUCT_STATIC_DIR` 控制 Product API 是否托管前端构建产物；目录存在且包含 `index.html` 时，非 `/api/*` 的 GET 请求会返回静态资源或 SPA fallback。生产 Docker 镜像默认设置为 `/app/dist`；设置为 `disabled` 可关闭静态托管。

`DEPLOYMENT_PROFILE` 控制系统配置页“部署就绪”检查的严格度：`local` 面向本机原型，`production` 会严格检查 HTTPS 域名、CORS 正式来源、非内存状态库、公开音频访问和备份策略。`PRODUCT_BACKUP_STRATEGY` 用于声明当前恢复方案，例如 `manual-json-export`、`sqlite-snapshot` 或 `managed-database-backup`。

`PROVIDER_REQUEST_TIMEOUT_MS` 是服务端外部 provider 的全局请求超时；`SEARCH_REQUEST_TIMEOUT_MS`、`BAILIAN_REQUEST_TIMEOUT_MS`、`MASTRA_RUNTIME_TIMEOUT_MS` 可分别覆盖搜索、百炼和 Mastra runtime，未配置时继承全局值。

系统配置页的“发布门禁”会读取 `GET /api/system/release-gate`，把部署就绪、备份恢复、PostgreSQL JSONB 迁移包、真实 Provider 冒烟、Workflow Runtime 和公网音频访问聚合成 `通过 / 观察 / 阻塞` 结论。它会保留备份摘要、迁移快照、runtime provider 和最近一次已保存的 `operationalChecks` 冒烟证据，但不会输出 provider key；缺少百炼 key、最近一次冒烟失败或证据过期时会阻止真实发布。

系统配置页的“上线执行清单”会读取 `GET /api/system/go-live-checklist`，把交付就绪包拆成 P0/P1/P2 操作步骤。P0 覆盖发布审计阻塞项、真实 Provider 冒烟、Workflow Runtime 和 Realtime 语音等会阻塞上线的动作；P1 覆盖公网音频、外部搜索、隐私运营和发布审计归档；P2 用于交付证据归档。清单只返回 env key 名称、证据入口和 packageId，不返回 provider secret、env value 或本地文件内容。

系统配置页的“交付就绪包”会读取 `GET /api/system/shipping-handoff-package`，把发布审计摘要、隐私运营摘要、外部依赖状态、证据入口、runbook 和下一步动作聚合成单一交付视图。它只嵌入摘要和 endpoint，不嵌入完整运行配置值、本地文件内容或 provider secret，适合交付审阅时先看总状态，再按 endpoint 深入核对。

系统配置页的“发布审计包”会读取 `GET /api/system/release-audit-package`，把发布门禁、部署就绪、迁移准备、备份恢复、PostgreSQL JSONB 迁移包和最近运营检查证据合并成同一份快照。审计包显式标记 provider secret、env value 和本地文件内容不会被包含，适合上线前复盘和交付审阅。

系统配置页的“真实 Provider 冒烟”会主动调用已配置 provider，验证真实搜索、角色专访、TTS、ASR 和 Realtime SDP。`PROVIDER_SMOKE_TEST_TOPIC` 控制搜索/角色专访测试主题；`PROVIDER_SMOKE_TEST_AUDIO_URL` 提供可公网访问的音频样本 URL，未配置时 SenseVoice ASR 冒烟会跳过；`PROVIDER_SMOKE_TEST_WEBRTC_OFFER_SDP` 提供 Realtime SDP 交换样本，未配置时 Realtime 冒烟会跳过。失败原因会脱敏展示，并以摘要形式保存到 `ProductState.operationalChecks`。

系统配置页的“Workflow Runtime 冒烟”会调用 `POST /api/system/workflow-runtime-smoke-test`。本地 runtime 会执行一次 ContextPack 构建；当 `WORKFLOW_RUNTIME_PROVIDER=mastra` 且配置了 `MASTRA_RUNTIME_ENDPOINT` 时会通过 Mastra-compatible HTTP adapter 调用外部 runtime；缺少 endpoint 时返回跳过。冒烟不会把 workflow 输出写入业务 `workflowRuns`，但会保存一条 `operationalChecks` 证据供发布门禁判断。

外部搜索 provider 在 Product API 服务端按环境变量自动启用：`ANYSEARCH_API_KEY` 调用 AnySearch `/v1/search`，`TAVILY_API_KEY` 调用 Tavily `/search`，`EXA_API_KEY` 调用 Exa `/search`，`BRAVE_SEARCH_API_KEY` 调用 Brave Web Search `/res/v1/web/search`。未配置 key 时 UI 仍可生成本地可复核素材，并在任务状态中标注降级原因。

个人页的数据治理区会显示当前 ProductState 的隐私库存，区分显性档案、专访笔记、认知资产、长期记忆、联网/RAG 资料、语料学习、播客生成物、运行审计记录和运营检查证据。`GET /api/state/privacy-report` 返回同一份库存；`GET /api/state/export` 的导出包会附带隐私报告；`POST /api/state/purge` 需要 `confirm=PURGE_PERSONAL_DATA`，会清空个人数据、删除已引用的 `local-object://corpus-audio/...` 本地音频原件，并保留 provider/模型运行配置和一条清空审计事件。响应里的 `artifactPurge` 会列出删除、缺失和跳过的对象文件数量。

系统配置页的“隐私运营包”会读取 `GET /api/state/privacy-operations-package`，把隐私库存、用户访问/更正/删除/迁移/透明权利、本地对象音频引用、保留策略、清空 runbook 和下一步动作聚合成审阅材料。该包只输出计数和状态，不包含 provider secret、env value 或本地文件内容。

系统配置页的“迁移准备”会读取 `GET /api/system/migration-readiness`，输出当前 ProductState 的实体计数、SQLite snapshot/event 源表、`postgres-jsonb-first` 目标路线、待审核记忆和 `local-object://` 音频风险。`GET /api/system/postgres-migration-package` 会生成 PostgreSQL JSONB 首阶段迁移包，包含建表 SQL、snapshot/event 写入 SQL、验证 SQL、状态摘要和 runbook。迁移包不迁移密钥；provider key 仍由 `.env.local` 或系统配置页管理。

系统配置页的“备份恢复演练”会读取 `GET /api/system/backup-rehearsal`，在内存里模拟一次 JSON 导出和导入恢复，不改写当前状态。报告会比较导出摘要与恢复摘要、隐私库存、provider secret 排除、迁移清单和本地对象音频引用，并给出生产恢复演练 runbook。

## 目录

- `src/domain`: 业务模型、确定性引擎、资产沉淀、配置版本、质量报告。
- `src/features`: 前端业务视图。
- `src/realtime`: 百炼 Realtime WebRTC 浏览器桥接。
- `src/api`: 前端 Product API client。
- `apps/api/src`: Fastify Product API、provider client、路由、运行配置。
- `packages/db/src`: SQLite ProductState repository。
- `tests/e2e`: Playwright 验收流程。
- `docs/superpowers`: 阶段开发方案和规格文档。

## 当前架构

```text
React UI
  -> Product API
     -> ProductStateRepository
     -> Search providers
     -> Bailian Character interview provider
     -> Bailian Realtime WebRTC SDP proxy
     -> Bailian TTS / ASR providers
     -> Workflow run registry
  -> local fallback engine
```

文本专访和实时语音转写现在共用 `interview-turn-runner`：优先走百炼角色扮演 provider，失败或未配置时降级到本地规则引擎，并统一记录 AI 运行事件。实时语音的留白、打断和语音追问信号会写入会话 `realtimeSignals`，进入“实时轮替”质量门，并在系统配置的透明追踪里展示。
系统配置里的“默认访谈声音”会在创建 Realtime session 时传给 Product API；`BAILIAN_REALTIME_VOICE` 作为服务端默认/回退音色保留。
系统配置页的质量区会显示最近 workflow runs 和质量修复动作；Product API 提供 `/api/system/workflows/:workflowId/run`，用于触发 ContextPack、导入摄取、记忆投影等工作流的可观测运行记录。默认 `WORKFLOW_RUNTIME_PROVIDER=local`，使用当前确定性 runtime；配置 `WORKFLOW_RUNTIME_PROVIDER=mastra` 和 `MASTRA_RUNTIME_ENDPOINT` 后，会把 `{ input, state }` POST 到 `/api/workflows/:workflowId/run`，接收外部 Mastra-compatible runtime 返回的 `{ run, nextState }`。`context_pack_build` 会读取当前 ProductState 并输出主题、确认记忆、候选、修正和来源数量；`memory_projection` 会统计待审候选、敏感候选、确认长期记忆和模型上下文记录，不会自动确认候选；`search_brief_generation`、`podcast_generation`、`import_ingestion` 会分别输出来源/事实/讨论主题、章节/Shownotes/声音、转写轮次/分析维度/PlaybookPatch 等业务指标。质量修复动作会把记忆修正、质量门低分、实时轮替失败、候选记忆精度、来源忠实度和 provider 降级转成下一场专访的 `qualityGuardrails`。

## 验证状态

最近一次已通过：

- `npm test -- --run`
- `npm run build`
- `npm run test:e2e`
- `git diff --check`
