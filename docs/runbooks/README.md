# 运维 Runbook（Wave A · A4）

单机 MVP 常见故障：症状 → 日志 event → 处理。

**告警协议（D6.a）：** [`ALERTS.md`](./ALERTS.md) — 阈值、优先级、巡检与降噪。

## 1. 双开锁库 / 启动无输出后退出

- **症状**：第二个 `dev:api` / `dev:full` 卡住或立刻退出。
- **日志**：`surreal_connect_failed`（含 `dataDir`）。
- **原因**：嵌入式 surrealkv 同进程独占 `.data/surreal`。
- **处理**：
  1. `lsof +D .data/surreal` 或活动监视器结束旧 node/tsx
  2. 确认只有一个 API 进程
  3. 重启 `npm run start:api` / `dev:full`

## 2. 导出 partial（音频缺失）

- **症状**：`GET /api/state/export` → `completeness.status = partial`
- **原因**：音频超单包预算或冷层读失败。
- **处理**：
  1. 读 `completeness.reasons` / `audioOmittedSessions`
  2. 分卷：`GET /api/state/export?audioVolume=N`
  3. 冷层失败时先备份 `.data`，勿直接 `rm -rf`

## 3. Provider 5xx 风暴

- **症状**：专访/chat/rag 大量 502；日志 `*_failed` / `llm_failed`
- **处理**：
  1. 查 DashScope 控制台配额与 key
  2. 降并发；确认 `LLM_MAX_CALLS_PER_SESSION` / 滑窗
  3. 勿把 502 当“可忽略降级”——产品设计为 fail-loud

## 4. persist.degraded

- **症状**：`GET /api/health` → `persist.degraded` / `consecutiveFailures > 0`
- **处理**：
  1. 读 `lastError`
  2. 磁盘满 / 权限 / 双开锁
  3. 修复后观察 failures 归零；必要时 JSON export 抢救

## 5. LLM / 路由 429

- **症状**：chat/rag/corpus 返回 429
- **日志**：`llm_budget_exceeded` 或 `rate_limit_exceeded`
- **处理**：
  - 预算：等滑窗（默认 1h）或调 `LLM_MAX_CALLS_PER_SESSION` / `LLM_SYSTEM_WINDOW_MS`
  - 限流：等 `Retry-After`；测试可设 `RATE_LIMIT_DISABLED=true`
  - 桶与场景上界：见 [`docs/COST-ENVELOPE.md`](../COST-ENVELOPE.md)（次数 ≠ 美元）
  - 告警分级：见 [`ALERTS.md`](./ALERTS.md) A-05

## 6. 优雅关闭 flush 超时

- **症状**：滚动重启/SIGTERM 后日志 `graceful_shutdown_flush_timeout`；或重启后丢「刚保存成功」的状态。
- **配置**：`PRODUCT_SHUTDOWN_FLUSH_MS`（默认 10s，上限 30s）。
- **处理**：见 [`ALERTS.md`](./ALERTS.md) **A-15**；先 export，再查双开锁/磁盘，勿盲目 `kill -9`。

## 7. 知识索引滞后（reindex FAF）

- **症状**：状态已更新但 chat 仍召到旧块/召不到新记忆。
- **信号**：`metrics.reindex` / `reindex_failed` / `reindex_ok`。
- **处理**：见 [`ALERTS.md`](./ALERTS.md) **A-16**；索引失败不回滚写；必要时 rebuild。
