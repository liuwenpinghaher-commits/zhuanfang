# 告警草案（D6.a · 定稿）

> **日期：** 2026-07-30  
> **范围：** 单机单用户 MVP 的 **可操作告警协议**（信号 → 阈值 → 动作）  
> **不是：** 多租户 on-call、PagerDuty 集成、Prometheus 规则仓库（属 D6.d / 产品形态变化）  
> **信号真源：** `GET /api/health` · `GET /api/system/runtime-metrics` · `GET /api/system/capabilities` · stderr JSON `event`  
> **配套：** [`README.md`](./README.md)（故障处置）· [`../COST-ENVELOPE.md`](../COST-ENVELOPE.md) · `apps/api/src/observability/runtime-metrics.ts` · `apps/api/src/routes/health.ts`

本文件回答：**单机部署时，盯什么、何时算红、先做什么、不要误报什么。**

---

## 0. 使用方式（MVP）

| 模式 | 做法 | 适用 |
| --- | --- | --- |
| **手动** | 开场前 / 出问题后 curl health + capabilities | 个人日常 |
| **轻量 cron** | 每 1–5 min 拉 `/api/health`，按 §2 判定 | 常开本机/小 VPS |
| **日志扫** | `rg '"event":"'` 或 journald/docker logs | 事后归因 |
| **外发告警** | 可选：cron 脚本失败时 `osascript`/邮件/Webhook | 有需求再加；**本草案不强制** |

**鉴权提醒：**

- `/api/health`：**可免 token**（liveness；勿在响应里塞隐私）。  
- `/api/system/runtime-metrics`、`/api/system/capabilities`、`/api/ops/graph-consistency`：**需鉴权**（Bearer / cookie）。  
- 图一致性审计 **不要** 高频轮询（只读但含内部 id；设计为运维主动核对）。

**样本窗口诚实边界：**

- Voice 环形缓冲 **最多 64** 条；recall/grounding **128**。  
- p95 / 成功率是 **进程内近期样本**，重启即空；**不是** 7 日 TSDB。  
- 样本过少时（见各条 min sample）**不告警**，只记观察。

---

## 1. 探针语义（先分清 ok / ready）

`GET /api/health` 契约（代码）：

| 字段 | 含义 | 监控用法 |
| --- | --- | --- |
| `ok: true` | 进程活着、路由可答 | **liveness**（Docker HEALTHCHECK 级） |
| `ready: true` | `!persist.degraded` | **readiness**；写路径可信时才为 true |
| `persist.degraded` | `consecutiveFailures > 0` | **P0** 数据面 |
| `metrics.voice.*` | TTFA / 分段 / budgetHint | 语音体验（需有样本） |
| `metrics.recall.*` | hit / empty / low_score / error | 召回健康 |

**规则：** 容器/进程探活只看 `ok`；**业务是否可写** 看 `ready` 且无 `persist.degraded`。

快速探针示例：

```bash
export BASE=http://127.0.0.1:3210
export PRODUCT_API_TOKEN='…'   # 仅受保护路由需要

# Liveness / readiness
curl -sS "$BASE/api/health" | jq '{ok,ready,persist,voice:(.metrics.voice| {ttfaP95Ms,sampleCount,budgetHint})}'

# 完整环形指标（需鉴权）
curl -sS -H "Authorization: Bearer $PRODUCT_API_TOKEN" \
  "$BASE/api/system/runtime-metrics" | jq '{voice:.voice| {ttfaP50Ms,ttfaP95Ms,sampleCount,bargeInSuccessRate,budgetHint}, recall:.recall, grounding:.grounding}'
```

---

## 2. 告警目录

优先级：

| 级 | 含义 | 响应预期（单机） |
| --- | --- | --- |
| **P0** | 丢数据 / 服务不可用 / 鉴权失效暴露 | 立刻停写或止血 |
| **P1** | 主路径不可用或系统性失败 | 本次会话内处理 |
| **P2** | 体验/成本/容量恶化 | 当日或下次使用前 |
| **P3** | 观察项 | 记一笔，不打断 |

### A-01 · Persist degraded（P0）

| | |
| --- | --- |
| **信号** | `health.ready == false` 或存在 `persist.degraded == true`；`consecutiveFailures > 0` |
| **阈值** | **任意** `consecutiveFailures ≥ 1` 即告警（连续失败计数 >0 已表示写路径异常） |
| **窗口** | 即时（每次 health） |
| **日志/事件** | 仓库层 lastError；可能伴随磁盘/锁相关 stderr |
| **动作** | 1. 读 `lastError` / `lastErrorAt`  2. 按 [runbook §4](./README.md) 查磁盘、权限、双开锁  3. **暂停** 重要写入；`GET /api/state/export` 抢救  4. 修复后确认 `ready: true` 且 failures 归零 |
| **勿做** | 忽略后继续大批 import/approve；对同一 `.data/surreal` 再起第二 API |

### A-02 · 进程 / 容器探活失败（P0）

| | |
| --- | --- |
| **信号** | `GET /api/health` 连接失败、非 200、或超时 |
| **阈值** | 连续 **2** 次失败（间隔 ≥30s，对齐 Docker healthcheck 量级） |
| **动作** | 1. `docker compose ps` / 进程是否在  2. 日志是否 `surreal_connect_failed`（双开锁）→ [runbook §1](./README.md)  3. 是否 production 缺 `PRODUCT_API_TOKEN` 拒启  4. 重启单实例；确认卷仍在（`down -v` 会清库） |

### A-03 · Production 危险配置（P0）

| | |
| --- | --- |
| **信号** | 启动日志 `auth_guard_inactive_in_production` / `state_store_in_memory_in_production`；或 capabilities/`DEPLOYMENT_PROFILE` 与预期不符 |
| **阈值** | **出现即告警**（不应在健康生产出现） |
| **动作** | 立刻停对外暴露；补 `PRODUCT_API_TOKEN`；`PRODUCT_STORE=surreal`；轮换已泄露的假设 |

### A-04 · Provider 5xx 风暴（P1）

| | |
| --- | --- |
| **信号** | 专访/chat/rag/podcast 连续 **502/5xx**；stderr `llm_failed` / `*_failed` / `unhandled_server_error` |
| **阈值** | **5 min 内 ≥ 5** 次 provider 失败，或 **连续 3** 次同能力失败 |
| **动作** | 1. [runbook §3](./README.md)  2. DashScope 配额/key/地区  3. 降并发；核对预算未误杀（对比 A-05）  4. **不要** 把 502 当可忽略降级 |
| **关联** | 未配 key 的「一直 5xx」是配置态，不是瞬时风暴——capabilities 会 `needs-key` |

### A-05 · 429 限流 / 预算（P1–P2）

| | |
| --- | --- |
| **信号** | HTTP 429；日志 `rate_limit_exceeded` 或 `llm_budget_exceeded` |
| **阈值** | **P1：** 主路径（专访 turn / chat）**10 min 内 ≥ 10** 次 429，或用户明显卡死  **P2：** 偶发 1–3 次 |
| **动作** | 1. 区分 event（限流 vs 预算）  2. 预算 → 等 `LLM_SYSTEM_WINDOW_MS` 滑窗或调 `LLM_MAX_CALLS_PER_SESSION`（含 `reviews` 等系统键；见 [COST-ENVELOPE](../COST-ENVELOPE.md) §2.1 / §6）  3. 限流 → 等 `Retry-After`；生产禁止 `RATE_LIMIT_DISABLED=true` |
| **分级说明** | 主动打满预算的自测不是事故；非预期顶满才是 |

### A-06 · 语音 TTFA 恶化（P2）

| | |
| --- | --- |
| **信号** | `metrics.voice.ttfaP95Ms` / `ttfaP50Ms`（health 或 runtime-metrics） |
| **预算参考**（`budgetHint`，**非硬 SLA**） | p50 ≤ **700** ms · p95 ≤ **1200** ms · barge-in stop 参考 **200** ms |
| **阈值** | 同时满足：`sampleCount ≥ 5`（且 ttfa 有效样本建议 ≥5）**且** `ttfaP95Ms > 1200` → **P2**；`ttfaP95Ms > 2500` 或 p50 > 1500 → 升 **P1**（体验接近不可用） |
| **分段** | 看 `segments.vadEndToStt` / `sttToLlm` / `llmTtft` / `ttsTtfb` 定位瓶颈 |
| **动作** | 1. 确认 1 路 cascade、本机负载  2. 供应商延迟 vs 本地 VAD  3. 长 prompt / 重召回是否拖 LLM TTFT  4. 回归：`npx tsx scripts/voice-slo-smoke.ts`（mock 预算，非真音频） |
| **勿做** | 样本 <5 时对 p95 大惊小怪；把 mock smoke 当生产真值 |

### A-07 · Barge-in / interrupt 失败（P2）

| | |
| --- | --- |
| **信号** | `bargeInSuccessRate`、`bargeInFailCount`、`interruptRecoveryRate`（runtime-metrics / capabilities.metrics） |
| **阈值** | 已知尝试 ≥ **3** 且 `bargeInSuccessRate < 0.9` → **P2**；连续会话完全无法打断 → **P1** |
| **动作** | 1. cascade interrupt 路由与客户端 mute  2. LiveKit：data channel + agent `session.interrupt` 日志  3. 查 `path: interrupt` 样本 |

### A-08 · 召回异常（P2）

| | |
| --- | --- |
| **信号** | `metrics.recall`：`error` / `empty` / `low_score` / `hit` |
| **阈值** | `eventCount ≥ 10` 且（`error / eventCount ≥ 0.1` → **P1**；或 `empty+low_score` 占比 ≥ **0.8** 且用户预期应有记忆 → **P2**） |
| **日志** | `surreal_hybrid_fusion_empty` 等 hybrid 相关 JSON event |
| **动作** | 1. 先复现 P4 / surreal-recall 路径，**勿先改 RRF 常量**  2. 查 embedding 是否失败、索引是否空  3. minRecallScore / 拒召是否过于激进（产品预期内的 refused 不是故障） |
| **对照** | grounding `refuseRate` 高可能是诚实拒答，结合 citation 与用户投诉判断 |

### A-09 · Grounding 质量漂移（P3–P2）

| | |
| --- | --- |
| **信号** | runtime-metrics `grounding.*`（capabilities 亦透出） |
| **阈值** | `eventCount ≥ 20` 且 `groundedAnswerRate < 0.3` 同时 `refuseRate` 异常低（疑似硬答无依据）→ **P2**；高 refuse + 用户满意 → **不告警** |
| **动作** | 查 chat groundingMode、资料是否入库、召回阈值；避免为「好看」关掉拒召 |

### A-10 · 导出完整性（P1 备份窗 / P2 日常）

| | |
| --- | --- |
| **信号** | `GET /api/state/export` → `completeness.status` |
| **阈值** | 计划内备份得到 `partial` → **P1**（备份窗口）；探活式抽检 partial → **P2** |
| **动作** | [runbook §2](./README.md)；分卷 `audioVolume`；冷层失败先备份目录 |

### A-11 · 写锁 / 卡死（P1）

| | |
| --- | --- |
| **信号** | 日志 `write_slot_blocked` 持续、`write_slot_force_released`；UI 长时间无法保存 |
| **阈值** | **5 min** 内多次 force_released 或用户写入全面阻塞 |
| **动作** | 查是否长 LLM 持锁；降并发；确认无僵尸请求；必要时重启（先 export） |

### A-12 · SSRF / 安全拒止噪声（P3 / 偶发 P1）

| | |
| --- | --- |
| **信号** | 日志 `ssrf` 相关拒绝；语料转写 4xx |
| **阈值** | 预期内拒绝 → 观察；**突发大量**对非常用 host → 查是否被扫或配置错误 allowlist |
| **动作** | 核对 `CORPUS_AUDIO_URL_ALLOWLIST`；勿为方便默认放开私网 |

### A-13 · 图一致性漂移（P2，按需）

| | |
| --- | --- |
| **信号** | `GET /api/ops/graph-consistency` → `ok: false`（需鉴权 + surreal） |
| **阈值** | `missingCount` / `unexpectedCount` / node 漂移 **> 0**（`danglingProvenanceCount` 单独解读：锚点删除后的悬空溯源，**不一定**是损坏） |
| **频率** | 变更后或月度；**禁止** 30s 轮询 |
| **动作** | 只读报告；按运维策略修复；不自动 rewrite |

### A-14 · Research scheduler 异常（P3–P2）

| | |
| --- | --- |
| **信号** | `research_scheduler_tick_error` / `scheduler_*_error` / `research_scheduler_tick_capped` |
| **阈值** | 连续 tick error → **P2**；仅 capped → **P3**（预算保护，见成本信封） |
| **动作** | 关自动研究或降频；查外搜 key；避免后台抽干 `system`/`research_auto_run` |

### A-15 · Shutdown flush 超时 / 可能丢已确认写（P1）

| | |
| --- | --- |
| **信号** | stderr JSON `graceful_shutdown_flush_timeout`（或 `graceful_shutdown_flush_failed`）；启动/关闭日志含 `flushTimeoutMs` |
| **含义** | SIGTERM/SIGINT 后 persist 队列未能在预算内排空——**可能**丢失已 HTTP 200 但未落 surreal 的写（N-02 窗口） |
| **配置** | `PRODUCT_SHUTDOWN_FLUSH_MS`（默认 **10000**，上限 **30000**）；`PRODUCT_SHUTDOWN_CLOSE_MS`（默认 8000，server.close 预算） |
| **阈值** | **出现即记 P1**（尤其生产 rolling restart / OOM kill 前后） |
| **动作** | 1. 查磁盘/锁/双开（[runbook §1](./README.md)、A-01） 2. 确认只有单 API 实例占用 `.data/surreal` 3. 若常态超时：在 10–30s 内调高 `PRODUCT_SHUTDOWN_FLUSH_MS` 并查 persist 积压 4. 重启前尽量 `GET /api/state/export` 5. **勿**把 flush 超时当「可忽略 warning」 |
| **分仓** | 多用户 stores registry 落地后 flush = `registry.closeAll()`（`flushFromRegistry`）；超时语义相同 |
| **勿做** | 无限加大超时掩盖磁盘故障；用 `kill -9` 当日常重启 |

### A-16 · 知识索引 reindex 失败 / 滞后（P2–P3）

| | |
| --- | --- |
| **信号** | `health.metrics.reindex.failedTotal` 上升；stderr `reindex_failed` / `reindex_discarded_stale_epoch`；`GET /api/system/runtime-metrics` → `reindex` |
| **对照** | 成功：`reindex_ok` + `successTotal`；无变更：`noop`（不告警） |
| **语义** | 写路径 **fire-and-forget**：状态已落库，索引滞后只影响 chat/rag 召回，**不**回滚写 |
| **阈值** | `failedTotal` 在活跃写入窗口内 **≥ 3** 或 `lastOutcome=failed` 且用户报「刚改的记忆召不到」→ **P2**；偶发 stale_discarded（reset/purge 竞态）→ **P3** |
| **动作** | 1. 查 embedding/budget（`llm_budget_exceeded` / `knowledge_embed_failed`） 2. 必要时 `rebuild` 知识索引路由 3. 确认未在 purge 中途期望召回 4. 勿把 FAF reindex 改成默认同步 await 写路径 |
| **指标窗口** | 进程内环 + 计数；重启清空（与 voice 环一致） |

### A-17 · 可选 JSONL 指标落盘失败（P3）

| | |
| --- | --- |
| **信号** | `metrics_jsonl_append_failed`；配置了 `PRODUCT_METRICS_JSONL_PATH`（或 alias `PRODUCT_METRICS_PERSIST_PATH`）但文件不增长 |
| **阈值** | 连续失败 → **P3**（内存环仍可用） |
| **动作** | 查路径权限/磁盘；留空 env 即关闭落盘。**不改** `POST /api/system/runtime-metrics/voice` body schema |

---

## 3. 建议巡检节奏（单机）

| 节奏 | 检查 |
| --- | --- |
| **每次开用前** | `curl /api/health` → `ok && ready` |
| **语音场次后** | health/runtime-metrics：ttfa p95、barge-in（若有打断） |
| **每周（有活跃开发）** | 扫日志：`persist` / `429` / `llm_failed` / `hybrid` / `surreal_connect` |
| **每次准备部署** | `DEPLOYMENT-CHECKLIST` §1–§5；capabilities 无危险 warning |
| **每次宣称备份有效** | export `completeness=complete`（或分卷齐） |
| **月度** | graph-consistency 一次；依赖安全通告（Track M） |

---

## 4. 最小 cron 草案（可选）

不引入新依赖时，可用 shell 做 readiness 门禁（示例，自行改路径/通知）：

```bash
#!/usr/bin/env bash
# scripts/local-health-watch.sh  — optional; not wired into npm by default
set -euo pipefail
BASE="${PRODUCT_API_BASE_URL:-http://127.0.0.1:3210}"
body="$(curl -fsS --max-time 5 "$BASE/api/health")"
echo "$body" | jq -e '.ok == true and .ready == true' >/dev/null
# optional TTFA gate when enough samples:
echo "$body" | jq -e '
  (.metrics.voice.sampleCount // 0) < 5
  or (.metrics.voice.ttfaP95Ms // 0) <= 1200
' >/dev/null
```

- 退出码 ≠0 → 本机通知或日志。  
- **不要** 在未设 token 的脚本里打印 Bearer。  
- 生产反代后 `BASE` 用内网地址，避免把 health 暴露策略搞混（health 本身免鉴权）。

---

## 5. 信号索引（速查）

| 来源 | 字段 / event | 主要告警 |
| --- | --- | --- |
| `GET /api/health` | `ok` `ready` `persist` `metrics.voice|recall` | A-01 A-02 A-06 A-08 |
| `GET /api/system/runtime-metrics` | voice/recall/grounding 全文 | A-06 A-07 A-08 A-09 |
| `GET /api/system/capabilities` | provider status + metrics 摘要 | A-03 A-04 A-07 |
| `GET /api/ops/graph-consistency` | `report.ok` | A-13 |
| stderr JSON | `surreal_connect_failed` | A-02 / runbook §1 |
| stderr JSON | `llm_budget_exceeded` `rate_limit_exceeded` | A-05 |
| stderr JSON | `llm_failed` `*_failed` | A-04 |
| stderr JSON | `auth_guard_inactive_in_production` | A-03 |
| stderr JSON | `write_slot_*` | A-11 |
| export JSON | `completeness.status` | A-10 |
| stderr JSON | `graceful_shutdown_flush_timeout` / `graceful_shutdown_flush_failed` | A-15 |
| stderr JSON | `reindex_failed` / `reindex_ok` / `reindex_discarded_stale_epoch` | A-16 |
| health/metrics | `metrics.reindex.*` | A-16 |
| stderr JSON | `metrics_jsonl_append_failed` | A-17 |

代码预算提示常量：

```text
budgetHint.ttfaP50TargetMs = 700
budgetHint.ttfaP95TargetMs = 1200
budgetHint.bargeInStopTargetMs = 200
```

（`apps/api/src/observability/runtime-metrics.ts`）

---

## 6. 明确不告警 / 降噪

| 现象 | 原因 |
| --- | --- |
| 未配 key 时 chat/专访 5xx | 诚实 fail-loud；先配 key |
| 拒召 / `groundingMode=refused` | 低分记忆保护，未必是故障 |
| `PRODUCT_STORE=memory` 测试 | 预期非持久 |
| Vitest / e2e 内 429 | 测试关限流或打满预算 |
| hybrid_empty 偶发 | 融合空有并入逻辑；持续 error 再升 A-08 |
| dangling provenance | 删除 turn 后的预期残留类计数 |
| voice sampleCount=0 | 尚未走语音，TTFA 无意义 |
| OTEL export 失败（本地无 collector） | 可 `OTEL_SDK_DISABLED=true`；非 P0 |

---

## 7. 验收（D6.a 完成定义）

- [x] runbook 附录列出 **阈值 + 动作**（本文）  
- [x] 对齐现有 health/metrics/日志 event，不虚构 TSDB  
- [x] 区分 P0–P3 与 ok/ready  
- [x] CURRENT / 维护路线图可发现  
- [ ] D6.b span `session.id` 白名单（未做）  
- [ ] D6.c compose OTEL profile（未做）  
- [ ] D6.d Prometheus/OTLP metrics 导出（未做）

---

## 8. 相关链接

| 文档 | 用途 |
| --- | --- |
| [`docs/runbooks/README.md`](./README.md) | 故障逐步处置 |
| [`docs/COST-ENVELOPE.md`](../COST-ENVELOPE.md) | 429 预算与场景上界 |
| [`docs/DEPLOYMENT-CHECKLIST.md`](../DEPLOYMENT-CHECKLIST.md) | 上线勾选 |
| [`docs/MAINTENANCE-ROADMAP.md`](../MAINTENANCE-ROADMAP.md) | 队列 |
| `npx tsx scripts/voice-slo-smoke.ts` | 本地 TTFA 预算 mock |
| `node scripts/backup-export-smoke.mjs` | export completeness |

**D6.a 状态：closed（告警协议文档）**  
**下一默认维护项：** 按产品痛点在 D1.a（播客过期刷新）与 D2.a（搜索 URL 去重）中二选一；无痛点则停在文档维护。
