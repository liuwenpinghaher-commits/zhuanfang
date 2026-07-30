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

## 运行（本地开发）

```bash
npm install
cp .env.example .env.local   # 填入 DASHSCOPE_API_KEY 等可选密钥
npm run dev:full
```

`dev:full` 会同时启动 Product API 和 Vite 前端；默认前端是 `127.0.0.1:3220`，Product API 默认监听 `127.0.0.1:3210`。
如果前端端口、预览端口或部署域名发生变化，在系统配置页或 `.env.local` 中更新 `PRODUCT_WEB_ORIGINS` 即可放行对应浏览器来源。

也可以分两个终端启动：

```bash
npm run dev:api
npm run dev
```

生产构建（不启动服务）：

```bash
npm run build
```

测试：

```bash
npm run typecheck
# 本机若已 export DASHSCOPE_API_KEY，建议关掉 provider smoke，避免单测误打外网
env -u DASHSCOPE_API_KEY -u BAILIAN_API_KEY REAL_PROVIDER_SMOKE=off npm test -- --run
npm run test:e2e
# 真实供应商 / surreal 隔离库（需要 key；不污染仓库 .data/）
npm run test:e2e:real
```

`npm run test:e2e` 会自动启动 `Product API` 和前端 dev server；测试中的 API 使用 `PRODUCT_STORE=memory` + `PRODUCT_STATE_DB_PATH=memory`（globalSetup 会核验实际档位是 memory，否则熔断），不会写入默认的 `.data/surreal` 数据目录。默认族 **不会** 跑 `real-*.spec.ts` / `voice-cascade`。

`npm run test:e2e:real`（或 `E2E_REAL=1 playwright test`）使用临时 surreal 数据目录 + 真实 key 跑 real 族与语音 cascade；无 key 时相关用例 skip。语音门控是 `E2E_REAL=1` + DashScope/Bailian key，**没有** `E2E_REAL_VOICE` 环境变量。

`*.real.test.ts` 是外部 provider smoke（从 `.env.local` 读真实 key，会真调 DashScope / AnySearch）。在持有真实 key 的机器上跑全量 vitest 而不想触发外部调用时，设 `REAL_PROVIDER_SMOKE=off`（也接受 `0`/`false`，大小写不敏感）即可让这些用例全部按"未配置 key"跳过。

## 部署步骤

### A. 本机 / 单机进程（开发或小流量）

1. `npm install && npm run build`
2. 准备环境变量（见下方「关键配置」与 `.env.example`）：至少 `PRODUCT_STORE=surreal`；生产再加 `DEPLOYMENT_PROFILE=production` + 长随机 `PRODUCT_API_TOKEN`。
3. 启动 API（同时托管前端静态产物时设 `PRODUCT_STATIC_DIR=dist`）：

```bash
export PRODUCT_STATIC_DIR=dist
export PRODUCT_STORE=surreal
export PRODUCT_STATE_DB_PATH=.data/product-state.db
npm run start:api
# 默认 http://127.0.0.1:3210  （HOST/PORT 可改）
```

4. 数据目录：Surreal 落在 `PRODUCT_STATE_DB_PATH` 同级的 `surreal/`（默认 `.data/surreal`）；语料音频默认 `.data/corpus-audio`。备份用 `GET /api/state/export`，不要只拷进程内存。
5. 健康检查：`GET /api/health`（含 `metrics.voice` / `metrics.recall` 等运行时信号）。

### B. Docker Compose（推荐生产演练）

```bash
cp .env.production.example .env.production.local
# 必填：长随机 PRODUCT_API_TOKEN
# 建议：DASHSCOPE_API_KEY、PRODUCT_WEB_ORIGINS（正式域名）、CORPUS_AUDIO_PUBLIC_BASE_URL（若要 SenseVoice 拉本地音频）
docker compose --env-file .env.production.local up --build -d
curl -sS http://127.0.0.1:3210/api/health
```

> **生产必须设置 `PRODUCT_API_TOKEN`。** 当 `DEPLOYMENT_PROFILE=production` 时服务会 fail-closed：缺少该令牌时直接拒绝启动并报错——否则鉴权守卫不会生效，所有 `/api/*` 路由（隐私导出、一键清空、修改 provider 配置、语音代理）将无凭据即可访问。`docker-compose.yml` 使用 `${PRODUCT_API_TOKEN:?...}`，未设置时 `docker compose up` 会直接失败。客户端通过 `Authorization: Bearer <token>` 或 `?token=<token>`（WebSocket）携带令牌。

容器要点：

- 同一 `PORT`（默认 3210）托管前端静态产物 + Product API；`PRODUCT_STATIC_DIR=/app/dist`。
- `VITE_PRODUCT_API_BASE_URL` 在生产模板中保持**空值** → 浏览器同源请求 `/api/*`；前后端分域时再写成公开 API 基址，并同步 `PRODUCT_WEB_ORIGINS`。
- 持久卷 `zhuanfang-data` → `/app/.data`（含 Surreal 与语料音频）。
- Compose 默认 `PRODUCT_STORE=surreal`；**不要**在生产用 `memory`。
- 停止 / 查看：`docker compose --env-file .env.production.local logs -f`，`docker compose down`（加 `-v` 会删卷，等同清库）。

### C. 上线检查清单（定稿）

**完整可勾选清单（发布前 / 密钥 / 基建 / 启动 / 冒烟 / Full GO）：**
[`docs/DEPLOYMENT-CHECKLIST.md`](docs/DEPLOYMENT-CHECKLIST.md)

**集成验证与系统态：**
[`docs/superpowers/2026-07-30-integration-and-deployment-state.md`](docs/superpowers/2026-07-30-integration-and-deployment-state.md)

摘要要求：

| 项 | 要求 |
| --- | --- |
| 鉴权 | `DEPLOYMENT_PROFILE=production` + 强随机 `PRODUCT_API_TOKEN`（缺失拒启） |
| CORS | `PRODUCT_WEB_ORIGINS` 仅正式 origin |
| 状态库 | `PRODUCT_STORE=surreal`，可写，**单进程独占** |
| LLM / 语音 | `DASHSCOPE_API_KEY`（或 `BAILIAN_API_KEY`）；未配 → 5xx，不假成功 |
| 语料 | `CORPUS_AUDIO_PUBLIC_BASE_URL` 和/或 S3 path-style；内网 URL → allowlist |
| SSRF / 限流 | 默认开启；生产禁止 `RATE_LIMIT_DISABLED=true` |
| HTTPS / 备份 / 运维 | 反代 TLS；定期 export；`docs/runbooks/README.md` |
| 容量 | 单用户单机；1 路 cascade；知识块建议 &lt;~10k |
| 成本信封 | 调用次数闸 ≠ 美元；见 [`docs/COST-ENVELOPE.md`](docs/COST-ENVELOPE.md) |

### D. 可选：OSS / MinIO 语料直传

```bash
CORPUS_S3_BUCKET=your-bucket
CORPUS_S3_REGION=cn-hangzhou
CORPUS_S3_ENDPOINT=https://oss-cn-hangzhou.aliyuncs.com   # 自定义端点
CORPUS_S3_FORCE_PATH_STYLE=true                          # 有 ENDPOINT 时默认 true（path-style）
CORPUS_S3_PUBLIC_BASE_URL=https://cdn.example.com/corpus # SenseVoice 可拉的公网基址
AWS_ACCESS_KEY_ID=...
AWS_SECRET_ACCESS_KEY=...
```

`POST /api/corpus/audio-files/presign` 在 bucket+凭证齐全时返回 `provider:"s3"` + SigV4 `uploadUrl`；否则保持 `provider:"local"`。

## Hybrid RAG 架构

导入资料问答与知识索引在 **Surreal 权威档**（`PRODUCT_STORE=surreal`）走原生混合检索，而不是仅靠域层 cosine/关键词排序。

### 目标与分层

```text
Browser / 外部集成
  POST /api/rag/query          # 纯导入资料 QA（HTTP 唯一原生 rag 出口）
  POST /api/chat 等            # 全局助手：八源知识索引（含 knowledge_chunk 混合召回）
       │
       ▼
Product API (Fastify)
  embed(question)              # 云端 embedding 或 EMBEDDING_PROVIDER=local
  asNativeRecall(repository)   # 探测 Surreal 原生能力
       │
       ├─ recallRagChunks      # 热态 rag_chunk（导入块）
       ├─ searchHybrid         # 冷层 knowledge_chunk
       └─ recallMemoriesByVector + queryText  # 长期记忆 memory
       │
       ▼
域层门控重验（不信任 SQL 门控 alone）
  buildSemanticRagContextFromRecall / 同等 policy
  usage=interview-context + 来源 isImportSourceAllowedInContext
       │
       ▼
LLM 生成答案；citations 只保留模型实际标注的 [n]
```

内存档（`PRODUCT_STORE=memory`）没有原生索引能力，回落域层 `buildSemanticRagContext`（cosine + 关键词）——这是配置态，不是生产降级伪装。

### 三路索引（Surreal）

| 表 | HNSW（向量） | BM25 全文 | Analyzer |
| --- | --- | --- | --- |
| `memory` | `memory_emb` COSINE dim=1024 | `memory_ft` on `text` | `zh` ngram(1,3) |
| `rag_chunk` | `rag_emb` | `rag_ft` | 同上 |
| `knowledge_chunk` | `kc_emb` | `kc_ft` | 同上 |

- 维度常量：`packages/db/src/surreal/constants.ts` → `EMBEDDING_DIMENSION = 1024`（与 `bge-large-zh-v1.5` / 云端默认输出对齐；schema 守卫防漂移）。
- Analyzer 升级见 migration `010_r4a_ngram.surql`（自 ngram(2,2) → (1,3)，并 REBUILD 三索引）。
- 查询侧 token 治理（三路统一）：`search::analyze('zh', q)` → `selectBm25QueryTokens`（去重 → 有多字 gram 则丢单字 1-gram → cap 32）→ `buildBm25Clause` 生成 `text @@ $t0 OR …`。

### `rag_chunk` 混合召回契约（`recallRagChunks`）

实现：`packages/db/src/surreal/surreal-product-state-repository.ts`。

1. **纯 HNSW**：仅 `embedding`、无 `queryText` → KNN `<|k,ef|>` + usage 门控。
2. **BM25-only**：有 `queryText`、无向量 → 关键词直查；**无 embedding 的降级摄入块由此可达**（HNSW 索引不含它们）。
3. **Hybrid**（有向量 + 有 queryText）：
   - `LET $vec` / `LET $bm` 保持**纯索引**子查询（LET 内禁止再叠 AND，否则 KNN/BM25 路径会空——P2a）。
   - `search::rrf([$vec,$bm], limit, 60)` 融合；`limit = max(k, 60)`，衰减常量 `RRF_RANK_CONSTANT=60`。
   - 最终 `SELECT` 再叠 `usage` 门控；`WHERE id IN …` 不保序 → JS `reorderByRrfRank`。
4. **BM25 并入（稳定性关键）**：
   - 融合**为空**：BM25 ∪ HNSW 复核（关键词块优先），并打 `surreal_hybrid_fusion_empty`。
   - 融合**非空**：保留 RRF 名次，并为 BM25 独有命中（典型：无向量块）**预留 top-k 名额**再追加——避免 rrf 只返回 HNSW 路时丢掉专名/无嵌入块（P4 e2e 判别器 `rc_y`）。
5. **失败语义**：`search::rrf` / BM25 真错误上抛 → 路由 502，**不**静默回落域层 cosine 冒充混合结果。原生命中被门控滤空 = 诚实空结果。

`knowledge_chunk.searchHybrid` 与 `memory` 混合路径共用同一套 RRF/BM25 机械件（`buildBm25Clause` / `reorderByRrfRank`）；knowledge 表无行级 usage/sensitivity 门控（摄入侧已过滤）。

### HTTP 与消费点

- **`POST /api/rag/query`**：`{ question }` → embed → `recallRagChunks({ embedding, queryText, k: TOP_K*2, usage: "interview-context" })` → `buildSemanticRagContextFromRecall` → LLM；citations 仅含答案中的 `[n]`（C-P2-03，不 dump 全部 top-k）。
- **Chat / 访谈预召回**：冷层 `searchHybrid` + 记忆混合召回；低置信拒召见 Stage-2（`src/domain/retrieval.ts`）。
- **导入 / 再索引**：嵌入失败或截断会在 import/approve 响应里透出 warning 字段；无向量块仍应能被 BM25 路径检索到。

### 可观测事件（stderr JSON）

| event | 含义 |
| --- | --- |
| `surreal_hybrid_fusion_empty` | RRF 结果空，已走 BM25/HNSW 复核 |
| `surreal_rag_bm25_skipped` / `*_bm25_skipped` | analyze 后无 token，跳过 BM25 |
| `surreal_rag_bm25_fallback_failed` / `surreal_rag_bm25_union_failed` | BM25 直查异常 |
| `surreal_rag_recall_failed` / `rag_native_recall_failed` | 原生召回失败 → API 502 |
| `rag_embed_failed` | 问题向量化失败 → 502 |

### 回归锁

- 包测：`packages/db/src/surreal/surreal-recall.test.ts`（HNSW / 混合拉无向量块 / BM25-only / usage 门控）。
- 生产接线 e2e：`apps/api/src/e2e/surreal-data-layer-journey.real.test.ts` ④ P4——有向量无关块 `rc_x` + 无向量关键词块 `rc_y`，断言原生 `recallRagChunks` 与 `/api/rag/query` citations 均含 `rc_y`（域层纯 cosine 物理不可达 `rc_y`）。
- Golden：`tests/fixtures/rag-golden/cases.json` + `src/domain/rag-golden.ts`（确定性 hit@k，无 LLM-judge）。

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
CORPUS_S3_BUCKET=
CORPUS_S3_REGION=
CORPUS_S3_ENDPOINT=
# true/false；设置 ENDPOINT 时默认 true（OSS/MinIO path-style）
CORPUS_S3_FORCE_PATH_STYLE=
CORPUS_S3_PUBLIC_BASE_URL=
# or AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY / AWS_REGION / AWS_SESSION_TOKEN
# Embedding：默认云端；本地离线可设 EMBEDDING_PROVIDER=local（bge-large-zh-v1.5，1024 维）
# EMBEDDING_PROVIDER=local
PODCAST_AUTO_RENDER_ON_CREATE=false
```

`BAILIAN_BASE_URL` 用于百炼兼容模式的联网搜索和角色扮演专访；`BAILIAN_AUDIO_BASE_URL` 用于 CosyVoice TTS 与 SenseVoice ASR。两类 API 默认域名不同，部署到代理或企业网关时应分别配置。

`ANYSEARCH_BASE_URL`、`ANYSEARCH_LANGUAGE` 和 `ANYSEARCH_ZONE` 控制外接 AnySearch 的服务端请求。`ANYSEARCH_ZONE` 可留空自动选择，也可按 provider 支持情况设置为 `cn` 或 `intl`。

`BAILIAN_ASR_LANGUAGE_HINT`、`BAILIAN_ASR_POLL_ATTEMPTS` 和 `BAILIAN_ASR_POLL_INTERVAL_MS` 控制导入语音专访时的 SenseVoice 转写语言提示和轮询节奏。公网音频较长时可提高轮询次数；本地调试时建议保持默认。

`BAILIAN_REALTIME_TRANSPORT`：`websocket`（默认）或 `webrtc`。WebRTC 默认走 DashScope 公网信令 `https://dashscope.aliyuncs.com/api/v1/webrtc/realtime`，**不需要**工作区 endpoint 白名单；`BAILIAN_REALTIME_WEBRTC_ENDPOINT` 仅在你要覆盖该默认信令 URL 时设置。专访主路径仍优先 cascade（ASR→LLM→TTS）；Omni Realtime / LiveKit 为可选传输。

`BAILIAN_REALTIME_ENABLE_SEARCH` 控制 Realtime session.update 是否允许携带联网材料能力；开启后仍由 Product API 负责整理搜索简报和可追溯来源，浏览器不会直接接触 provider key。

`EMBEDDING_PROVIDER=local` 时使用本机 `bge-large-zh-v1.5`（1024 维，与 Surreal HNSW DIMENSION 一致）；未设置则走云端 embedding（需 DashScope/Bailian key）。本地模型缓存通常在 `node_modules/@huggingface/transformers/.cache/...`；首次会下载。

`PRODUCT_STATE_DB_PATH` 为空或不写时，`npm run start:api` 会默认在 `.data/product-state.db` 旁建立 SurrealDB 数据目录 `.data/surreal`；设置为 `memory`、`:memory:` 或 `in-memory`（或 `PRODUCT_STORE=memory`）时使用内存状态库，重启后回到 seed 状态。R7：`PRODUCT_STORE` 仅 `memory|surreal`，旧值 `sqlite/dual/dual-surreal` 已废弃并自动归一到 `surreal`（启动期会响亮提示改档位）。

`PRODUCT_WEB_ORIGINS` 是允许访问 Product API 的浏览器来源白名单，多个 origin 用逗号分隔，例如 `http://127.0.0.1:3220,https://app.example.com`；保存后会立即影响 CORS 响应。

`CORPUS_AUDIO_MAX_BYTES` 控制本地语料音频单文件上传上限，默认 50MB；超过上限时 Product API 返回 413，不会写入本地对象目录。

`CORPUS_AUDIO_PUBLIC_BASE_URL`：本地语料音频上传后会写入 `CORPUS_UPLOAD_DIR`（默认 `.data/corpus-audio`），并可通过鉴权路由 `GET /api/corpus/audio-files/:fileName` 读取。若设置本变量为可被百炼 SenseVoice 拉取的公网基址（例如反代后的 `https://your.host`，服务会拼 `/api/corpus/audio-files/<file>`；若基址已含该 path 前缀则直接拼文件名），本地上传即可自动转写。**未配置时**仍会落盘并返回诚实 422（说明原因与 `local-object://` 引用），不会伪造转写稿；也可继续直接提交公网 http/https/oss URL。

`CORPUS_S3_*` / `AWS_*`（可选云预签名）：
- 启用条件：`CORPUS_S3_BUCKET` + (`AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY` 或 `CORPUS_S3_ACCESS_KEY_ID`/`CORPUS_S3_SECRET_ACCESS_KEY`)。
- 区域：`AWS_REGION` 或 `CORPUS_S3_REGION`（默认 `us-east-1`）；临时凭证可用 `AWS_SESSION_TOKEN` / `CORPUS_S3_SESSION_TOKEN`。
- 自定义端点：`CORPUS_S3_ENDPOINT`（阿里云 OSS、MinIO 等）；`CORPUS_S3_FORCE_PATH_STYLE` 在设置 ENDPOINT 时默认 path-style（`true`），虚拟主机样式可显式设 `false`。
- 行为：`POST /api/corpus/audio-files/presign` 返回 `provider:"s3"`、`uploadUrl`、`uploadHeaders`、`publicUrl`（优先 `CORPUS_S3_PUBLIC_BASE_URL`，否则按 endpoint/region 推导）。
- 未配置时保持 `provider:"local"` + `uploadPath` 本地 PUT，不伪造云上传。
- 实现：`apps/api/src/s3-presign.ts`（最小 SigV4 PutObject，无额外 AWS SDK）。

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

## Stage-3：评测 / 记忆生命周期 / 语音 SLO

- **RAG golden**：`tests/fixtures/rag-golden/cases.json`（30+ 中文个人域 query）+ `src/domain/rag-golden.ts` 确定性 hit@k / 拒召正确率（CI 无 LLM-judge）。
- **Citation envelope + groundingMode**：召回命中带 sourceId/score；chat 返回 `grounded | partial | refused` 并记 runtime metrics。
- **记忆生命周期**：echo-chamber 过滤；矛盾 `POST /api/memory-candidates/:id/resolve-conflict`（supersede/demote-not-delete）；consolidate 支持 `mode=queue` 只预览。
- **语音 SLO**：TTFA 分段 p50/p95、barge-in 成功率、interrupt recovery；打断 stash 注入下一轮（`previousAgentUtteranceInterrupted`）。本地参考预算 p50≤700ms / p95≤1200ms（非硬 SLA）。
- **脚本**：`npx tsx scripts/voice-slo-smoke.ts`；`node scripts/backup-export-smoke.mjs`。
- **语音 connect**：`src/realtime/startRealtimeVoiceConnect.ts` + `useRealtimeVoiceSession`（App 只负责建 session 与回调注入）。
- **语料预签名**：`POST /api/corpus/audio-files/presign`
  - 默认：`provider:"local"` → `PUT /api/corpus/audio-files/:file`（JSON `{ audioBase64 }`，需鉴权）
  - 云：配置 bucket + AWS 凭证后 → `provider:"s3"` → 客户端直传 `uploadUrl`（SigV4）
  - SenseVoice 仍需可拉取的 `publicUrl`（`CORPUS_AUDIO_PUBLIC_BASE_URL` 或 `CORPUS_S3_PUBLIC_BASE_URL`）
- **pVAD / Silero**（`src/realtime/pvadEndpointing.ts` + `sileroVad.ts` + cascade 接线）
  - `systemConfig.voice.endpointingMode`：`silence` | `semantic`（默认）| `pvad-experimental`
  - `pvad-experimental`：浏览器 Silero 神经 VAD（`isSpeech`）与能量/`ExpressionState`/completeness 融合，调整 `minPauseMs`/`maxWaitMs`，并可把 `uncertain` 偏置为 `respond`
  - 资源：`scripts/copy-vad-assets.mjs` 在 `postinstall`/`dev`/`build` 将 onnx + ORT wasm 拷到 `public/vad/`；运行时同源 `/vad/`（**不依赖** jsDelivr CDN）
  - **诚实边界**：init/模型加载失败软降级能量启发式；Node/单测无 WebAudio 时不可用；capabilities 标注为实验端点
  - 入口：`startRealtimeVoiceConnect` 从 `productState.systemConfig.voice` 注入 cascade `decisionOpts`
- **非目标**：多租户、Surreal 原生 CRDT 多设备同步、强绑单一 S2S。OSS/MinIO 已通过 `CORPUS_S3_ENDPOINT` + path-style 支持；不实现完整 AWS SDK 面。

## Stage-2：记忆 / 召回 / 语音度量

- **低置信拒召**：chat 与访谈相关记忆在 hybrid 分数过低或空命中时不硬塞资料；prompt 注入「无可靠记忆」说明（`src/domain/retrieval.ts`）。
- **Boot context**：`buildBootContextPack` 按字符预算组装画像 + 近场专访 + 语义事实 + 记忆策略，供开场/语音指令复用。
- **通道配额**：知识块按 memory / material / transcript / asset 分通道截断，避免长文素材挤掉个人记忆。
- **运行时度量**：`GET /api/health` 附带 `metrics.voice`（ttfa p50/p95、interruptCount）与 `metrics.recall`；完整环形缓冲见 `GET /api/system/runtime-metrics`。配置页在 capabilities 返回 metrics 时展示 TTFA 与召回计数；p95>700ms 会 amber 提示。
- **语音路径选型**：`cascade`（ASR→LLM→TTS）可控、易调试、transcript 一等公民；`bailian` omni / livekit 更自然但中间态更黑盒。生产默认优先 cascade；barge-in 走 `POST /api/realtime-voice/sessions/:id/interrupt` 截断已播并记 metrics。
- **语料直传预热**：`POST /api/corpus/audio-files` 仅落盘并返回 `localObjectUrl` / 可选 `publicUrl`（需 `CORPUS_AUDIO_PUBLIC_BASE_URL`），供 CDN 或后续 SenseVoice 使用，不伪造转写。
- **记忆巩固**：`POST /api/memory/consolidate` 在去重摘要后做 importance 衰减，并生成「待裁决矛盾」HITL 候选。
- **配置边界**：服务端 env（密钥/模型/CORPUS_AUDIO_PUBLIC_BASE_URL）≠ ProductState.systemConfig（产品策略，含可选 `memory.minRecallScore`）。

## 当前架构

```text
React UI
  -> Product API (Fastify)
     -> ProductStateRepository (Surreal 默认 / memory 测试)
        -> 热态：会话/资产/记忆/rag_chunk + 原生混合召回
        -> 冷层：rawMaterial / audio / knowledge_chunk(+searchHybrid)
     -> Hybrid RAG：HNSW + BM25 + search::rrf（见上文专节）
     -> Search providers (AnySearch / Tavily / Exa / Brave)
     -> Bailian Character interview (文本追问，fail-loud)
     -> Bailian Realtime / LiveKit / cascade 语音栈
     -> Bailian TTS / ASR / Embedding providers（或 local bge）
```

**真实性立场**：专访追问与归档是 LLM 能力——未配置或调用失败返回 5xx/429，**不会**静默用确定性模板冒充 AI 追问。演示用的 `local-demo` 搜索等须显式标记 degraded / needs-review。原生混合召回失败同样 502，不用域层路径掩盖 Surreal 差异。

实时语音的留白、打断和语音追问信号会写入会话 `realtimeSignals`。实时打断支持回填：调用 `POST /api/realtime-voice/sessions/:id/interrupt`，服务端 `truncateAssistantTurn` 截断已说出口的内容。详见 [docs/realtime-improvement-plan.md](docs/realtime-improvement-plan.md)。

播客：创建剧集默认只落脚本；仅当 `PODCAST_AUTO_RENDER_ON_CREATE=true|1|yes|on` 时创建即 TTS。否则请在工作台确认脚本后调用 synthesize。

生产鉴权：`GET /api/runtime-bootstrap` 仅设置 HttpOnly cookie，**不**在 JSON body 回传长期 `PRODUCT_API_TOKEN`。同源 SPA 用 `credentials: include`；分域部署可另设 `VITE_PRODUCT_API_TOKEN`。

产品入口始终是**仓库根目录**（`src/`、`apps/api/`、`packages/db/`）。历史上的嵌套副本/agent worktree 已从工作区移除，勿再以子目录副本为开发主路径。

开放项真源：`docs/superpowers/CURRENT-开放清单.md`。  
文档归档与最终健康检查：`docs/ARCHIVE.md`。  
上线勾选清单：`docs/DEPLOYMENT-CHECKLIST.md`。  
长期维护路线：`docs/MAINTENANCE-ROADMAP.md`。  
成本/调用信封（D3.a）：`docs/COST-ENVELOPE.md`。  
Wave D 分析：`docs/superpowers/2026-07-30-wave-d-analysis.md`。

## 验证状态

优先命令：

```bash
npm run typecheck
# 本机若 shell 已 export DASHSCOPE_API_KEY，单测可能误开真实 client；建议显式关掉 provider smoke
env -u DASHSCOPE_API_KEY -u BAILIAN_API_KEY REAL_PROVIDER_SMOKE=off npm test -- --run
npx tsx scripts/voice-slo-smoke.ts
node scripts/backup-export-smoke.mjs
```

按需：`npm run test:e2e`、`npm run test:e2e:real`（需 `agent/.env` 或环境中的 key）、`npm run build`。

聚焦单测：

- 混合召回：`packages/db/src/surreal/surreal-recall.test.ts`
- Surreal 数据层 e2e（含 P4 无向量 BM25）：`apps/api/src/e2e/surreal-data-layer-journey.real.test.ts`
- RAG 路由：`apps/api/src/routes/rag.test.ts`
- 语音 / 预签名：`src/realtime/pvadEndpointing.test.ts`、`apps/api/src/s3-presign.test.ts`、`apps/api/src/routes/corpus-presign.test.ts`

（具体通过数字以本机最近一次命令输出为准；审查报告见 `docs/superpowers/`。开放项真源：`docs/superpowers/CURRENT-开放清单.md`。）
