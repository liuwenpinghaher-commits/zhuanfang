# Execute-plan 54f36045 收尾记录

- **合并**: PR #12 → `main` @ `9678d52`（其后设计文档 `3316a09`）
- **Demo**: 已 rsync + `docker compose build/up` `app-zhuanfang-1`；`/api/health` 200；公网 `/zhuanfang/` 200
- **指标冒烟**: `POST /api/system/runtime-metrics/voice` 带 `falseTriggerKind` / `bargeInSuccess` → 200，汇总含 `falseTriggerCount`

## Spike 结论（demo 容器内，2026-08-10）

| Spike | 结果 | 含义 |
|-------|------|------|
| half-cascade (`scripts/spike-half-cascade.mjs`) | **ERROR**（DashScope WS **401 InvalidApiKey**） | **不排 pr-6i**（半级联生产）；与 OQ2/KD11 一致 |
| Audio3 (`scripts/spike-audio3-session.mjs`) | **ERROR**（同上 401） | **不排 pr-8**；OQ1 仍未冻结，且 key/WS 鉴权需运维排查 |
| pr-9 可插拔 ASR | **defer** | 无瓶颈证据，不实现 |

> 注：容器内 `DASHSCOPE_API_KEY` 长度 114，HTTP 文本路径可能仍可用，但 **Realtime WS** 返回 InvalidApiKey。需在百炼控制台核对 Realtime 权限 / 密钥是否为 DashScope 原生 key，或是否需 `BAILIAN_API_KEY` 不同鉴权头。此为**环境鉴权问题**，不是半级联协议已证伪。

## 跳过项正式关闭

| ID | 状态 |
|----|------|
| pr-6i | **本轮取消** — spike ERROR/无 GO |
| pr-8 | **本轮取消** — OQ1 未冻结 + spike ERROR |
| pr-9 | **defer** — 无数据驱动门槛 |

默认 **cascade** 主路径已上线 demo。
