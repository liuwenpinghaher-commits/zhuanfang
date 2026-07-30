# 生产部署检查清单（定稿）

> **真源清单**（上线前逐项勾选）  
> 代码基线：`main` @ `dafbba1f`+（集成报告见 `docs/superpowers/2026-07-30-integration-and-deployment-state.md`）  
> 架构：单机 · 单用户 MVP · 嵌入式 SurrealDB · Fastify 同源托管 SPA  
> 非目标：多租户、多设备 CRDT、完整 AWS SDK

---

## 0. 部署就绪总判

| 判定 | 条件 |
| --- | --- |
| **Conditional GO** | 离线门禁已绿（typecheck / 1600 tests / build / compose fail-closed / voice-slo / capacity） |
| **Full GO** | 另完成：§6 Playwright e2e、§7 带真实 key 的 compose 演练、§8 live export smoke |

当前仓库集成态：**Conditional GO**。下列清单用于冲刺 Full GO 与正式上线。

---

## 1. 发布前（代码与门禁）

- [ ] `git status` 干净，目标 commit 已 push `origin/main`
- [ ] `npm ci`
- [ ] `npm run typecheck`
- [ ] `env -u DASHSCOPE_API_KEY -u BAILIAN_API_KEY REAL_PROVIDER_SMOKE=off npm test -- --run`  
      期望：0 fail（skip 可接受）
- [ ] `npm run build` 成功且 `dist/index.html` 存在
- [ ] `node scripts/capacity-smoke.mjs` 有输出且无异常
- [ ] `npx tsx scripts/voice-slo-smoke.ts` → `okP95` / `okBarge` 为 true
- [ ] CI workflow 存在：`.github/workflows/ci.yml`
- [ ] 已读 `docs/runbooks/README.md`（双开锁 / partial export / 5xx / persist / 429）

---

## 2. 密钥与环境（`.env.production.local`）

从模板生成（**勿提交**真实文件）：

```bash
cp .env.production.example .env.production.local
```

### 2.1 必填

| 变量 | 要求 | 勾选 |
| --- | --- | --- |
| `DEPLOYMENT_PROFILE` | 必须为 `production` | [ ] |
| `PRODUCT_API_TOKEN` | 长随机密钥（≥32 字节熵）；**缺失则服务/compose 拒启** | [ ] |
| `PRODUCT_STORE` | 必须 `surreal`（禁止 production 用 `memory`） | [ ] |
| `PRODUCT_STATE_DB_PATH` | 可写路径（compose 默认容器内 `/app/.data/product-state.db`） | [ ] |
| `PRODUCT_WEB_ORIGINS` | 仅正式前端 origin，逗号分隔，含 `https://…` | [ ] |
| `PORT` / 反代 | 对外 HTTPS；容器内常见 `3210` | [ ] |

生成 token 示例：

```bash
openssl rand -base64 48
```

### 2.2 业务能力（按需；未配则对应 API 诚实 5xx）

| 变量 | 用途 | 勾选 |
| --- | --- | --- |
| `DASHSCOPE_API_KEY` 或 `BAILIAN_API_KEY` | 专访 / chat / RAG / TTS / ASR / embed | [ ] |
| `BAILIAN_REALTIME_TRANSPORT` | `websocket`（默认）或 `webrtc` | [ ] |
| `BAILIAN_REALTIME_WEBRTC_ENDPOINT` | 可选覆盖；默认公网信令、**无需白名单** | [ ] |
| `ANYSEARCH_*` / `TAVILY_*` / `EXA_*` / `BRAVE_*` | 外接搜索 | [ ] |
| `EMBEDDING_PROVIDER=local` | 可选本地 bge；需模型缓存 | [ ] |

### 2.3 语料 / 对象存储

| 变量 | 用途 | 勾选 |
| --- | --- | --- |
| `CORPUS_AUDIO_PUBLIC_BASE_URL` | 本地上传后 SenseVoice 可拉的公网基址 | [ ] |
| `CORPUS_S3_BUCKET` + AWS/`CORPUS_S3_*` 密钥 | 云预签名 PUT | [ ] |
| `CORPUS_S3_ENDPOINT` | OSS/MinIO 自定义端点 | [ ] |
| `CORPUS_S3_FORCE_PATH_STYLE` | 有 ENDPOINT 时默认 path-style | [ ] |
| `CORPUS_S3_PUBLIC_BASE_URL` | 对象公网读基址 | [ ] |
| `CORPUS_AUDIO_URL_ALLOWLIST` | 内网/特殊主机出站放行（SSRF 旁路，逗号分隔） | [ ] |

### 2.4 限流与预算（建议显式设定）

| 变量 | 默认意图 | 勾选 |
| --- | --- | --- |
| `RATE_LIMIT_MAX` | 一般 API 窗内次数（默认 60/min 量级） | [ ] |
| `RATE_LIMIT_STRICT_MAX` | export/chat/rag/voice 等更严（默认 20） | [ ] |
| `RATE_LIMIT_WINDOW_MS` | 窗口毫秒（默认 60000） | [ ] |
| ~~`RATE_LIMIT_DISABLED=true`~~ | **生产禁止** | [ ] 确认未开启 |
| `LLM_MAX_CALLS_PER_SESSION` | 每 session/系统桶调用上限 | [ ] |
| `LLM_SYSTEM_WINDOW_MS` | 系统桶滑窗 | [ ] |

### 2.5 前端同源

| 变量 | 要求 | 勾选 |
| --- | --- | --- |
| `VITE_PRODUCT_API_BASE_URL` | **生产 compose 保持空** → 浏览器同源 `/api/*` | [ ] |
| 分域时 | 设公开 API 基址，并同步 CORS + 可选 `VITE_PRODUCT_API_TOKEN` | [ ] |

---

## 3. 基础设施

- [ ] 仅 **一个** API 进程使用该数据目录（Surreal 嵌入式独占锁）
- [ ] 磁盘空间：预留状态 + 语料音频 + 导出分卷
- [ ] 持久卷已挂载（compose：`zhuanfang-data` → `/app/.data`）
- [ ] 反向代理终止 TLS；转发 `X-Forwarded-Proto`（服务 `trustProxy: true`）
- [ ] 防火墙仅暴露 443（及必要 SSH）；不裸奔无鉴权端口到公网
- [ ] 日志不落完整 `Authorization` / `?token=`（OTEL 已脱敏 query）
- [ ] 备份策略：定期 `GET /api/state/export`，检查 `completeness.status`

---

## 4. 启动

### 4.1 Docker Compose

```bash
docker compose --env-file .env.production.local config -q   # 缺 token 应失败
docker compose --env-file .env.production.local up --build -d
docker compose --env-file .env.production.local logs -f --tail=100
```

- [ ] `config -q` 在填好 token 后通过
- [ ] 容器 `running` / `healthy`（或日志无启动 fatal）
- [ ] 无 `auth_guard_inactive_in_production` / `state_store_in_memory_in_production` 警告

### 4.2 本机进程

```bash
export PRODUCT_STATIC_DIR=dist
export PRODUCT_STORE=surreal
export DEPLOYMENT_PROFILE=production
export PRODUCT_API_TOKEN='…'
export DASHSCOPE_API_KEY='…'
npm run start:api
```

- [ ] 监听预期 `HOST:PORT`
- [ ] `dist` 已挂静态（非 API 路径回 SPA）

---

## 5. 部署后冒烟（带鉴权）

设：

```bash
export BASE=https://your.host          # 或 http://127.0.0.1:3210
export PRODUCT_API_TOKEN='…'
```

- [ ] `curl -sS -o /dev/null -w '%{http_code}\n' "$BASE/api/health"` → **200**（health 可免 token）
- [ ] `curl -sS -H "Authorization: Bearer $PRODUCT_API_TOKEN" "$BASE/api/system/capabilities"` → 200，检查 store/providers
- [ ] 无 token 访问 `/api/state` → **401**
- [ ] 错误 Origin 的 mutating POST → **403**（若可测）
- [ ] `PRODUCT_API_BASE_URL=$BASE PRODUCT_API_TOKEN=$PRODUCT_API_TOKEN node scripts/backup-export-smoke.mjs` → live OK
- [ ] 浏览器：打开站点 → runtime-bootstrap cookie → 建文本专访 → 结束页诚实（有待审进记忆治理）
- [ ] 导入短文本资料 → chat 或资料问答有引用或诚实空
- [ ] （可选）cascade 语音 30s：打断与 TTFA 分段在配置/health 可见

---

## 6. 浏览器 E2E（Full GO 建议）

- [x] `npm run test:e2e`（memory 档，不写默认 surreal 目录）— **2026-07-30 本机 35/35 PASS**（端口隔离 13210/13220/13230）
- [ ] （有 key）`npm run test:e2e:real` 或 `E2E_REAL=1`，使用隔离数据目录

---

## 7. 真实 Provider Compose 演练（Full GO 建议）

- [x] `.env.production.local` 填入真实 `DASHSCOPE_API_KEY`（勿提交）— 本机已有
- [x] `docker compose --env-file .env.production.local up --build -d` — **2026-07-30 PASS**
- [x] 完成 §5 冒烟 + 一场真实短专访 + chat（TTS/ASR 可选未强跑）— **12/12 API 冒烟**
- [x] `docker compose down` 后数据仍在卷中（未误加 `-v`）— **VOLUME_PERSIST PASS**

报告：`docs/superpowers/2026-07-30-v2-compose-exercise.md`

---

## 8. 备份与恢复演练（Full GO 建议）

- [ ] `GET /api/state/export` → `completeness.status=complete`（或理解 partial 原因）
- [ ] 导出包安全离线存放（含个人数据）
- [ ] 在演练环境 `POST /api/state/import`（`confirm=REPLACE_ALL_STATE`）恢复抽检
- [ ] 确认 purge 确认词 `PURGE_PERSONAL_DATA` 不会被自动化误触

---

## 9. 回滚与应急

| 场景 | 动作 | 勾选 |
| --- | --- | --- |
| 坏版本 | 回滚镜像/commit；保留 `.data` 卷 | [ ] |
| 双开锁库 | 杀旧进程；见 runbook §1 | [ ] |
| Provider 全挂 | 接受 5xx；降并发；查配额 | [ ] |
| persist.degraded | 查磁盘/权限；export 抢救 | [ ] |
| 密钥泄露 | 轮换 `PRODUCT_API_TOKEN` + provider key；使旧 cookie 失效 | [ ] |

---

## 10. 容量与产品预期（签字确认）

运维/产品知悉：

- [ ] **单用户 / 单机**，非多租户 SaaS  
- [ ] 推荐 **1 路** cascade 语音  
- [ ] 知识库建议观察 **&lt; ~10k** chunks 量级  
- [ ] LLM 预算是 **调用次数**，不是美元账单  
- [ ] 未配置的 AI 能力会 **失败暴露**，不会静默假成功  
- [ ] Wave D（播客增强/成本账本/a11y 深挖等）为可选，不阻塞本清单  

---

## 11. 签字

| 角色 | 姓名 | 日期 | 结果 |
| --- | --- | --- | --- |
| 工程 | | | Conditional GO / Full GO / NO-GO |
| 运维 | | | |
| 产品 | | | |

**关联文档**

- 集成矩阵与架构：`docs/superpowers/2026-07-30-integration-and-deployment-state.md`
- 故障手册：`docs/runbooks/README.md`
- 开放项：`docs/superpowers/CURRENT-开放清单.md`
- 用户运行说明：`README.md` →「部署步骤」
