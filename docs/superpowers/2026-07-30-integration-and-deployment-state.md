# 综合集成验证与部署系统态（2026-07-30）

> 验证主机：本地 macOS · Node v26.5.0 · npm 12.0.0  
> Git：`main` @ `dafbba1f`（`feat(roadmap): execute Wave 0–C`）  
> 工作区：干净（验证时无未提交改动）

---

## 1. 集成验证矩阵

| 门禁 | 命令 | 结果 | 备注 |
| --- | --- | --- | --- |
| Typecheck | `npm run typecheck` | **PASS** | root + apps/api + packages/db |
| 全量 Vitest | `env -u DASHSCOPE_API_KEY -u BAILIAN_API_KEY REAL_PROVIDER_SMOKE=off npm test -- --run` | **PASS** | **1600 pass / 0 fail / 6 skip** · 158 files · ~27s |
| 生产 Build | `npm run build` | **PASS** | Vite 产物见 §3 |
| Capacity smoke | `node scripts/capacity-smoke.mjs 2000` | **PASS** | hitCount=8 · rankMs≈1.25ms（JS 关键词代理，非 Surreal） |
| Backup export smoke | `node scripts/backup-export-smoke.mjs` | **PASS (dry)** | 未设 `PRODUCT_API_BASE_URL` → dry-run；上线后应对运行中 API 再跑 live |
| Voice SLO smoke | `npx tsx scripts/voice-slo-smoke.ts` | **PASS** | ttfaP50=510 / p95=890 · bargeIn=1.0 · okP95/okBarge |
| Compose schema | `PRODUCT_API_TOKEN=… docker compose config -q` | **PASS** | 无 token 时 **故意失败**（fail-closed） |
| CI 工件 | `.github/workflows/ci.yml` | **存在** | typecheck + unit（`REAL_PROVIDER_SMOKE=off`） |
| Runbook | `docs/runbooks/README.md` | **存在** | 双开锁 / partial export / 5xx / persist / 429 |

### 1.1 未在本轮执行（明确边界）

| 项 | 原因 | 上线前建议 |
| --- | --- | --- |
| `npm run test:e2e`（Playwright） | 需起 dev 双进程 + 浏览器；本轮以 Vitest 全量 + build 为主 | 部署前在 CI/本机跑一轮默认 e2e（memory 档） |
| `npm run test:e2e:real` | 需真实 DashScope/Bailian key + 临时 surreal 目录 | 有 key 环境 nightly；勿污染默认 `.data/surreal` |
| Live `backup-export-smoke` | 未起常驻 API | `PRODUCT_API_BASE_URL=http://127.0.0.1:3210 node scripts/backup-export-smoke.mjs` |
| Docker 镜像完整 `up --build` | 耗时长且需生产 env | 用 `.env.production.local` 演练一次 |

### 1.2 关键 e2e 族（Vitest 内已绿）

在全量 suite 中已包含并通过对 API/数据层有意义的集成：

- `apps/api/src/e2e/surreal-data-layer-journey.real.test.ts`（含 P4 BM25 无向量块 + 图审计 expected=actual=6）
- `apps/api/src/e2e/full-business-journey.test.ts` / `business-journeys.test.ts` / `system-module-journey.test.ts`
- Surreal governance / local-embedding real（有模型缓存时；skip 已计入 6 skip）

---

## 2. 最终系统架构（部署视角）

```text
Browser (Vite SPA → dist/)
  │  same-origin /api/*  或  VITE_PRODUCT_API_BASE_URL
  │  credentials: cookie bootstrap 或 Bearer / ?token=
  ▼
Product API (Fastify, Node ≥22.5)
  ├─ Auth: production 强制 PRODUCT_API_TOKEN（缺则拒启）
  ├─ CORS: PRODUCT_WEB_ORIGINS + CSRF 同源写保护
  ├─ Rate limit: 敏感路由滑窗（RATE_LIMIT_*；Vitest 默认关）
  ├─ SSRF guard: corpus 音频 URL（CORPUS_AUDIO_URL_ALLOWLIST）
  ├─ LLM budget: 调用次数滑窗（非 token 计费）
  ├─ Providers: Bailian/DashScope (chat/character/realtime/tts/asr/embed)
  │            + 可选 AnySearch/Tavily/Exa/Brave + LiveKit agent
  └─ State
       ├─ PRODUCT_STORE=surreal（默认唯一持久档）
       │    .data/surreal  — 嵌入式 surrealkv（单进程独占锁）
       │    热态 ProductState + 冷层 raw/audio/knowledge_chunk
       │    原生混合召回：HNSW + BM25 + search::rrf（memory/rag/kc）
       └─ PRODUCT_STORE=memory — 仅测试/演示，重启丢失
  └─ 语料音频：.data/corpus-audio 或 S3/OSS path-style 预签名
```

### 2.1 能力档位（诚实语义）

| 能力 | 就绪条件 | 失败表现 |
| --- | --- | --- |
| 专访追问 / finalize | `DASHSCOPE_API_KEY` 或 `BAILIAN_API_KEY` | 503/502，不装模板 AI |
| Chat / RAG QA | 同上 +（可选）embedding | 502 embed/LLM；拒召 → grounding refused |
| 混合召回 | `PRODUCT_STORE=surreal` | memory 档走域层 cosine/关键词（配置态） |
| Cascade 语音 | key + 浏览器权限 | TTFA 分段进 health/metrics |
| WebRTC Omni | transport=webrtc；默认公网信令，无白名单 | 失败回退 WS |
| 语料 ASR | key + 公网可拉 URL 或 PUBLIC_BASE | 422/502，不假转写 |
| 播客 TTS | key；默认确认后 synthesize | failed 保留脚本 |
| 鉴权 | production + token | 无 token **拒绝启动** |

### 2.2 Wave 收口状态（代码已合 main）

- **Closed**：W0 文档、A1.3 SSRF、A1.4 限流、A2 CI、A3 容量脚本、A4 runbook、B1 债/决策策略、B2 矛盾策略、B3 playbook 可证基线、C1 chat 阈值、C2 rubric、C3 privacy longitudinal KPI  
- **Open（按需）**：D1–D6 播客/搜索/成本/a11y/可移植/OTEL 增强  
- **非目标**：多租户、Surreal CRDT 多设备、完整 AWS SDK  

---

## 3. 构建产物

`npm run build` 输出（本次）：

| 文件 | 约大小 | gzip |
| --- | ---: | ---: |
| `dist/index.html` | 0.49 kB | 0.33 kB |
| `dist/assets/index-*.css` | 55.6 kB | 10.1 kB |
| `dist/assets/vendor-react-*.js` | 140.9 kB | 45.3 kB |
| `dist/assets/index-*.js`（×3 chunks） | ~1.2 MB 合计 | ~343 kB |

生产容器：`PRODUCT_STATIC_DIR=/app/dist`，同源托管 SPA + API。

---

## 4. 推荐部署路径

### 4.1 Docker Compose（首选演练/小流量生产）

```bash
cp .env.production.example .env.production.local
# 必填：长随机 PRODUCT_API_TOKEN
# 建议：DASHSCOPE_API_KEY、正式 PRODUCT_WEB_ORIGINS、HTTPS 反代
# 可选：CORPUS_AUDIO_PUBLIC_BASE_URL、CORPUS_S3_*、CORPUS_AUDIO_URL_ALLOWLIST

docker compose --env-file .env.production.local up --build -d
curl -sS http://127.0.0.1:3210/api/health
# 浏览器：http://127.0.0.1:3210
```

要点：

- 卷 `zhuanfang-data` → `/app/.data`（Surreal + 语料）
- **禁止** production 使用 `PRODUCT_STORE=memory`
- 无 `PRODUCT_API_TOKEN` 时 compose **不会**启动（已验证）
- 单进程：不要对同一数据目录再挂第二个 API

### 4.2 本机单进程

```bash
npm ci && npm run build
export PRODUCT_STATIC_DIR=dist
export PRODUCT_STORE=surreal
export PRODUCT_STATE_DB_PATH=.data/product-state.db
export DEPLOYMENT_PROFILE=production   # 若公网/共享
export PRODUCT_API_TOKEN='…'           # production 必填
export DASHSCOPE_API_KEY='…'           # 业务能力
npm run start:api
```

### 4.3 上线检查清单（勾选）

**定稿完整清单（含 Full GO 与签字栏）：[`docs/DEPLOYMENT-CHECKLIST.md`](../DEPLOYMENT-CHECKLIST.md)**

摘要：

- [ ] `DEPLOYMENT_PROFILE=production` + 强随机 `PRODUCT_API_TOKEN`
- [ ] `PRODUCT_WEB_ORIGINS` 仅正式前端 origin（逗号分隔）
- [ ] `PRODUCT_STORE=surreal`，磁盘可写，**单实例**
- [ ] Provider key 已配；未配能力会 5xx（预期）
- [ ] 语料：公网 base 或 S3 + path-style；内网 URL 走 allowlist
- [ ] 限流：`RATE_LIMIT_*` 按流量调；勿在生产设 `RATE_LIMIT_DISABLED=true`
- [ ] HTTPS 终止 +（可选）`trustProxy` 已由服务支持
- [ ] 备份：`GET /api/state/export` 且 `completeness.status=complete`
- [ ] 健康：`GET /api/health`（voice/recall/persist）
- [ ] 阅读 `docs/runbooks/README.md`
- [ ] （Full GO）Playwright e2e + 真实 key compose + live export smoke

### 4.4 部署后冒烟

```bash
curl -sS -H "Authorization: Bearer $PRODUCT_API_TOKEN" "$BASE/api/health"
curl -sS -H "Authorization: Bearer $PRODUCT_API_TOKEN" "$BASE/api/system/capabilities"
PRODUCT_API_BASE_URL=$BASE PRODUCT_API_TOKEN=$PRODUCT_API_TOKEN node scripts/backup-export-smoke.mjs
# 浏览器：建一场文本专访 → 结束 → 记忆治理；导入资料 → /api/rag 或 chat
```

---

## 5. 运维与容量信封（写进部署预期）

| 假设 | 值 |
| --- | --- |
| 租户模型 | **单用户 / 单机 MVP**（非多租户 SaaS） |
| 语音 | 推荐 **1 路** cascade |
| 知识规模 | 建议 **&lt; ~10k** chunks 量级再观察 hybrid 延迟 |
| 存储锁 | 嵌入式 Surreal **禁止双开**同一 `.data/surreal` |
| LLM 预算 | 调用次数/窗，**不是** USD/token 账本 |
| 备份 | JSON export 为可迁移真源；音频可能分卷 |

故障入口：`docs/runbooks/README.md`（双开锁、partial export、provider 5xx、persist.degraded、429）。

---

## 6. 安全部署态摘要

| 控制 | 状态 |
| --- | --- |
| Production 无 token 拒启 | ✅ |
| Bearer / cookie / `?token=` | ✅（OTEL 脱敏 query token） |
| CORS + 跨站 mutating 403 | ✅ |
| 敏感路由限流 | ✅ |
| 出站音频 URL SSRF 护栏 | ✅ |
| 导入/外材 sanitize | ✅ |
| Fail-loud（不静默假 AI） | ✅ |
| 单共享 token 无 RBAC | ⚠️ 接受为 MVP；勿多用户共用一密钥长期暴露 |
| Playwright e2e 本轮未跑 | ⚠️ 建议补跑 |

---

## 7. 结论

**系统在 `dafbba1f` 上达到可部署的集成门禁：**

1. 类型、全量单元/API 集成（1600）、生产前端 build、compose 配置（含 token 硬门槛）、语音 SLO 与容量/备份 dry smoke 均通过。  
2. 架构为 **单机 Surreal + Fastify + 同源 SPA**，能力按 key 诚实降级/失败。  
3. Wave 0–C 安全与第二大脑闭环已进 main；Wave D 为可选增强。  
4. **部署前仍建议**：Playwright 默认 e2e 一轮 + 带真实 key 的 compose 启动 + live export smoke。

**部署就绪判定：条件就绪（Conditional GO）** — 代码与离线集成门禁绿；缺真实 provider 长跑与 Playwright 浏览器 e2e 的现场确认。
