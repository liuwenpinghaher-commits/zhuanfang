# Zhuanfang

语音专访式日记工具原型。当前版本已经从纯前端 demo 演进为本地可运行的产品 MVP：前端负责沉浸式专访与工作台体验，Product API 负责状态、配置、联网搜索、百炼模型、播客音频、语料转写和实时语音代理。

本文档描述当前实际可运行的能力；早期方案文档（`docs/`）保留为设计过程记录。

## 核心业务

- 实时专访：会前访谈卡、文本专访、实时语音入口、短反馈、留白/打断识别、实时信号追踪、会中控制。
- 会后沉淀：双轨笔记、观点、问题、决策候选、知识债、长期主题。
- 联网素材：百炼 Responses 内置联网、AnySearch / Tavily / Exa / Brave Search 外接搜索、本地降级素材、建议主题批量搜集、来源转资产。
- 语料学习：导入文本或音频专访样本，分析追问逻辑，生成 PlaybookPatch，经确认后影响后续引擎。
- 播客工作台：从笔记、搜索简报、长期主题、知识债、语料学习结果生成单人旁白或主持对谈播客；TTS 已配置时默认直出百炼 CosyVoice 音频。
- 系统配置：provider 健康、运行配置、产品策略、配置版本、质量运营、质量修复动作和 AI 运行事件。
- 数据治理：个人页提供完整 JSON 导出/导入、隐私数据库存、演示数据重置和彻底清空个人数据；Product API 清空会删除已引用的本地对象音频，清空不会恢复 demo 样例，导出包不包含运行密钥。

## 技术底座

- Frontend: React 18, TypeScript, Vite, lucide-react.
- Product API: Fastify, tsx.
- State: `npm run start:api` 默认使用嵌入式 SurrealDB（surrealkv，数据目录 `.data/surreal`）持久化；测试和临时演示可设置 `PRODUCT_STORE=memory`（或 `PRODUCT_STATE_DB_PATH=memory`）回到内存态。R7 起 `PRODUCT_STORE` 仅 `memory|surreal` 两档，surreal 为默认唯一持久档。
- Tests: Vitest, Playwright.
- Optional providers: 百炼 Responses / qwen-plus-character / Qwen-Omni Realtime / CosyVoice / SenseVoice, AnySearch / Tavily / Exa / Brave Search.

Redis 暂缓；Prisma 不是当前首选。项目使用嵌入式 SurrealDB（surrealkv）作为唯一持久状态仓库，原生支持图、向量与混合检索，适合本地单机部署。

## 运行

```bash
npm install
npm run dev:full
```

`dev:full` 会同时启动 Product API 和 Vite 前端；默认前端是 `127.0.0.1:3220`，Product API 默认监听 `127.0.0.1:3210`。
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
# 在 .env.production.local 中设置一个长随机 PRODUCT_API_TOKEN（生产必填）
docker compose --env-file .env.production.local up --build
```

> **生产必须设置 `PRODUCT_API_TOKEN`。** 当 `DEPLOYMENT_PROFILE=production` 时服务会 fail-closed：缺少该令牌时直接拒绝启动并报错——否则鉴权守卫不会生效，所有 `/api/*` 路由（隐私导出、一键清空、修改 provider 配置、语音代理）将无凭据即可访问。`docker-compose.yml` 使用 `${PRODUCT_API_TOKEN:?...}`，未设置时 `docker compose up` 会直接失败。客户端通过 `Authorization: Bearer <token>` 或 `?token=<token>`（WebSocket）携带令牌。

容器会在同一个 `PORT` 上托管前端静态产物和 Product API，默认访问 `http://127.0.0.1:3210`。`VITE_PRODUCT_API_BASE_URL` 在生产模板中保持空值，表示浏览器同源请求 `/api/*`；如果前端和 API 分域部署，再把它改成公开 API 地址。

测试：

```bash
npm test -- --run
npm run test:e2e
# 真实供应商 / surreal 隔离库（需要 key；不污染仓库 .data/）
npm run test:e2e:real
```

`npm run test:e2e` 会自动启动 `Product API` 和前端 dev server；测试中的 API 使用 `PRODUCT_STORE=memory` + `PRODUCT_STATE_DB_PATH=memory`（globalSetup 会核验实际档位是 memory，否则熔断），不会写入默认的 `.data/surreal` 数据目录。默认族 **不会** 跑 `real-*.spec.ts` / `voice-cascade`。

`npm run test:e2e:real`（或 `E2E_REAL=1 playwright test`）使用临时 surreal 数据目录 + 真实 key 跑 real 族与语音 cascade；无 key 时相关用例 skip。语音门控是 `E2E_REAL=1` + DashScope/Bailian key，**没有** `E2E_REAL_VOICE` 环境变量。

`*.real.test.ts` 是外部 provider smoke（从 `.env.local` 读真实 key，会真调 DashScope / AnySearch）。在持有真实 key 的机器上跑全量 vitest 而不想触发外部调用时，设 `REAL_PROVIDER_SMOKE=off`（也接受 `0`/`false`，大小写不敏感）即可让这些用例全部按"未配置 key"跳过。

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

DEPLOYMENT_PROFILE=local
# 生产必填（DEPLOYMENT_PROFILE=production 时缺失会拒绝启动）；本地可留空。
PRODUCT_API_TOKEN=
PROVIDER_SMOKE_TEST_TOPIC=AI 产品商业化热点 provider 冒烟
PROVIDER_SMOKE_TEST_AUDIO_URL=
PROVIDER_SMOKE_TEST_WEBRTC_OFFER_SDP=

HOST=127.0.0.1
PORT=3210
VITE_PRODUCT_API_BASE_URL=http://127.0.0.1:3210
PRODUCT_API_HEALTH_URL=http://127.0.0.1:3210/api/health
PRODUCT_WEB_URL=http://127.0.0.1:3220
PRODUCT_STATIC_DIR=dist
PROVIDER_REQUEST_TIMEOUT_MS=30000
SEARCH_REQUEST_TIMEOUT_MS=30000
BAILIAN_REQUEST_TIMEOUT_MS=30000

BAILIAN_TTS_MODEL=cosyvoice-v3-plus
BAILIAN_TTS_VOICE=longanyang
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

PRODUCT_STORE=surreal
PRODUCT_STATE_DB_PATH=.data/product-state.db
PRODUCT_WEB_ORIGINS=http://127.0.0.1:3220,http://localhost:3220
CORPUS_UPLOAD_DIR=.data/corpus-audio
CORPUS_AUDIO_PUBLIC_BASE_URL=
CORPUS_AUDIO_MAX_BYTES=52428800
PODCAST_AUTO_RENDER_ON_CREATE=false
```

`BAILIAN_BASE_URL` 用于百炼兼容模式的联网搜索和角色扮演专访；`BAILIAN_AUDIO_BASE_URL` 用于 CosyVoice TTS 与 SenseVoice ASR。两类 API 默认域名不同，部署到代理或企业网关时应分别配置。

`ANYSEARCH_BASE_URL`、`ANYSEARCH_LANGUAGE` 和 `ANYSEARCH_ZONE` 控制外接 AnySearch 的服务端请求。`ANYSEARCH_ZONE` 可留空自动选择，也可按 provider 支持情况设置为 `cn` 或 `intl`。

`BAILIAN_ASR_LANGUAGE_HINT`、`BAILIAN_ASR_POLL_ATTEMPTS` 和 `BAILIAN_ASR_POLL_INTERVAL_MS` 控制导入语音专访时的 SenseVoice 转写语言提示和轮询节奏。公网音频较长时可提高轮询次数；本地调试时建议保持默认。

`BAILIAN_REALTIME_WEBRTC_ENDPOINT` 需要百炼侧白名单 Endpoint。Product API 可用但 endpoint 未配置时，实时语音入口会停留在文本专访并显示配置原因；只有 Product API 完全不可用时才进入本地节奏模拟，不会暴露 key。

`BAILIAN_REALTIME_ENABLE_SEARCH` 控制 Realtime session.update 是否允许携带联网材料能力；开启后仍由 Product API 负责整理搜索简报和可追溯来源，浏览器不会直接接触 provider key。

`PRODUCT_STATE_DB_PATH` 为空或不写时，`npm run start:api` 会默认在 `.data/product-state.db` 旁建立 SurrealDB 数据目录 `.data/surreal`；设置为 `memory`、`:memory:` 或 `in-memory`（或 `PRODUCT_STORE=memory`）时使用内存状态库，重启后回到 seed 状态。R7：`PRODUCT_STORE` 仅 `memory|surreal`，旧值 `sqlite/dual/dual-surreal` 已废弃并自动归一到 `surreal`（启动期会响亮提示改档位）。

`PRODUCT_WEB_ORIGINS` 是允许访问 Product API 的浏览器来源白名单，多个 origin 用逗号分隔，例如 `http://127.0.0.1:3220,https://app.example.com`；保存后会立即影响 CORS 响应。

`CORPUS_AUDIO_MAX_BYTES` 控制本地语料音频单文件上传上限，默认 50MB；超过上限时 Product API 返回 413，不会写入本地对象目录。

`CORPUS_AUDIO_PUBLIC_BASE_URL`：本地语料音频上传后会写入 `CORPUS_UPLOAD_DIR`（默认 `.data/corpus-audio`），并可通过鉴权路由 `GET /api/corpus/audio-files/:fileName` 读取。若设置本变量为可被百炼 SenseVoice 拉取的公网基址（例如反代后的 `https://your.host`，服务会拼 `/api/corpus/audio-files/<file>`；若基址已含该 path 前缀则直接拼文件名），本地上传即可自动转写。**未配置时**仍会落盘并返回诚实 422（说明原因与 `local-object://` 引用），不会伪造转写稿；也可继续直接提交公网 http/https/oss URL。

`HOST` / `PORT` 控制 Product API 监听地址；`VITE_PRODUCT_API_BASE_URL` 控制浏览器前端连接哪个 Product API；`PRODUCT_API_HEALTH_URL` 和 `PRODUCT_WEB_URL` 用于 `npm run dev:full` 判断是否复用已有服务。

`PRODUCT_STATIC_DIR` 控制 Product API 是否托管前端构建产物；目录存在且包含 `index.html` 时，非 `/api/*` 的 GET 请求会返回静态资源或 SPA fallback。生产 Docker 镜像默认设置为 `/app/dist`；设置为 `disabled` 可关闭静态托管。

`PRODUCT_API_TOKEN` 是 Product API 的访问令牌。当 `DEPLOYMENT_PROFILE=production` 时它是**必填项**：缺失时服务会 fail-closed 直接拒绝启动，避免在无鉴权守卫的情况下暴露 `/api/*`（隐私导出、一键清空、修改 provider 配置、语音代理）。设置后，浏览器/客户端通过 `Authorization: Bearer <token>` 携带，WebSocket 语音代理通过 `?token=<token>` 携带。本地 `DEPLOYMENT_PROFILE=local` 时可留空。

`DEPLOYMENT_PROFILE` 控制系统配置页“部署就绪”检查的严格度：`local` 面向本机原型，`production` 会严格检查 HTTPS 域名、CORS 正式来源、非内存状态库和公开音频访问。

`PROVIDER_REQUEST_TIMEOUT_MS` 是服务端外部 provider 的全局请求超时；`SEARCH_REQUEST_TIMEOUT_MS`、`BAILIAN_REQUEST_TIMEOUT_MS` 可分别覆盖搜索和百炼请求，未配置时继承全局值。

外部搜索 provider 在 Product API 服务端按环境变量自动启用：`ANYSEARCH_API_KEY` 调用 AnySearch `/v1/search`，`TAVILY_API_KEY` 调用 Tavily `/search`，`EXA_API_KEY` 调用 Exa `/search`，`BRAVE_SEARCH_API_KEY` 调用 Brave Web Search `/res/v1/web/search`。未配置 key 时 UI 仍可生成本地可复核素材，并在任务状态中标注降级原因。

个人页的数据治理区会显示当前 ProductState 的隐私库存，区分显性档案、专访笔记、认知资产、长期记忆、联网/RAG 资料、语料学习、播客生成物、运行审计记录和运营检查证据。`GET /api/state/privacy-report` 返回同一份库存；`GET /api/state/export` 的导出包会附带隐私报告；`POST /api/state/purge` 需要 `confirm=PURGE_PERSONAL_DATA`，会清空个人数据、删除已引用的 `local-object://corpus-audio/...` 本地音频原件，并保留 provider/模型运行配置和一条清空审计事件。响应里的 `artifactPurge` 会列出删除、缺失和跳过的对象文件数量。

## 备份与灾难恢复

R7 起 SurrealDB（`.data/surreal`）是**唯一**持久仓库，`GET /api/state/export` 的 JSON 导出包是唯一的可迁移备份。请把它当成真正的备份对待——定期导出，并核对导出包顶部的 `completeness`：

- `completeness.status = complete`：热态 + 冷层（逐字稿/录音）+ 全部音频字节均在包内，可经 `POST /api/state/import`（`confirm=REPLACE_ALL_STATE`）完整恢复。
- `completeness.status = partial`：备份不完整，`completeness.reasons` 会说清原因。常见两类：
  - **音频超导出预算**：单个 JSON 包音频上限约 18MB（受 28MB 导入体限约束）。超出的会话记入 `audioOmittedSessions`，**不在本包内、无自动恢复路径**。要拿到全部音频，用**分卷导出** `GET /api/state/export?audioVolume=N`（`audioVolumes.total` 是总卷数，逐卷 `N=0,1,2,…` 下载即得全部字节），或逐会话下载单条音频。恢复时先导入基础包，再按需导入各音频分卷（`PRODUCT_AUDIO_EXPORT_BUDGET_BYTES` 可调分卷粒度）。
  - **冷层读失败**（`coldStoreReadFailures > 0`）：导出时某个冷层表读失败（多半是数据目录损坏），该层数据未纳入本包，但**热态仍会尽力导出**（“能导多少导多少”）——这份包用于抢救，不是完整备份。

灾难场景与终点：

1. **进程启动卡死、无任何输出**：嵌入式 surrealkv 是同进程独占锁，第二个进程打开同一 `.data/surreal` 会连接超时。日志会打印 `surreal_connect_failed`（含 `dataDir` 与“疑似双开持锁”）并以退出码 1 退出。处理：确认没有第二个进程（并发 `dev:full`、`dev:full` 跑着又手动 `dev:api`、旧进程未退干净）持有该目录后重启。
2. **权威库被清空/损坏后重启**：空库启动时 `GET /api/state` 会返回内置**示例（demo）数据**。如果浏览器端有离线未同步的改动，冲突弹窗会把这份示例当“服务器版本”呈现——UI 会打上“⚠ 服务器版本疑似示例/初始数据”指纹提示。**此时不要点“采用服务器版本”**（会用示例覆盖真实记录），应选“保留本地并同步”，或改用最近一次的 JSON 导出包 `import` 恢复。
3. **常规恢复**：个人页数据治理区“导入”上传最近一次导出的 JSON 包即可整体替换状态；`import` 通道体限放宽到 64MB。

## 目录

- `src/domain`: 业务模型、确定性引擎、资产沉淀、配置版本、质量报告。
- `src/features`: 前端业务视图。
- `src/realtime`: 百炼 Realtime WebRTC 浏览器桥接。
- `src/hooks`: 前端 feature hooks（如离线同步）。
- `src/api`: 前端 Product API client。
- `apps/api/src`: Fastify Product API、provider client、路由、运行配置。
- `packages/db/src`: SurrealDB ProductState repository（`surreal/` 下热态 + 三冷层 + 混合召回）与内存 repo。
- `tests/e2e`: Playwright 验收流程。
- `docs/superpowers`: 阶段开发方案和规格文档。

## 当前架构

```text
React UI
  -> Product API (Fastify)
     -> ProductStateRepository (Surreal 默认 / memory 测试)
     -> Search providers (AnySearch / Tavily / Exa / Brave)
     -> Bailian Character interview (文本追问，fail-loud)
     -> Bailian Realtime / LiveKit / cascade 语音栈
     -> Bailian TTS / ASR providers
```

**真实性立场**：专访追问与归档是 LLM 能力——未配置或调用失败返回 5xx/429，**不会**静默用确定性模板冒充 AI 追问。演示用的 `local-demo` 搜索等须显式标记 degraded / needs-review。

实时语音的留白、打断和语音追问信号会写入会话 `realtimeSignals`。实时打断支持回填：调用 `POST /api/realtime-voice/sessions/:id/interrupt`，服务端 `truncateAssistantTurn` 截断已说出口的内容。详见 [docs/realtime-improvement-plan.md](docs/realtime-improvement-plan.md)。

播客：创建剧集默认只落脚本；仅当 `PODCAST_AUTO_RENDER_ON_CREATE=true|1|yes|on` 时创建即 TTS。否则请在工作台确认脚本后调用 synthesize。

生产鉴权：`GET /api/runtime-bootstrap` 仅设置 HttpOnly cookie，**不**在 JSON body 回传长期 `PRODUCT_API_TOKEN`。同源 SPA 用 `credentials: include`；分域部署可另设 `VITE_PRODUCT_API_TOKEN`。

`zhuanfang/` 为历史副本，**不是**当前产品入口；请以仓库根目录为准。

开放项真源：`docs/superpowers/CURRENT-开放清单.md`。

## 验证状态

优先命令：

```bash
npm run typecheck
REAL_PROVIDER_SMOKE=off npm test -- --run
```

按需：`npm run test:e2e`、`npm run test:e2e:real`、`npm run build`。

（具体通过数字以本机最近一次命令输出为准；审查报告见 `docs/superpowers/`。）
