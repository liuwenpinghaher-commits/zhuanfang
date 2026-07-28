# CURRENT 开放清单（2026-07-28）

> 真源：合并 07-23 旅程审 / 上下文残留 / 全系统审 + 本轮落地。  
> 状态：`closed` 已在工作区验证接线；`open` 仍待做；`partial` 有门禁未满。

## 本轮已闭合 / 接线确认

| ID | 状态 | 说明 |
|---|---|---|
| IV-P0-01/02 | closed | voice-instructions / agent-context 写门内 re-read + field-merge |
| AS-P0-01 | closed | Track「继续这条线」→ `launchInterview(..., topicHint)` |
| IV-P1-01 | closed | `/turns` abort → 499 不落幽灵轮 |
| ME-P1-01 | closed | approve `merge\|add` + UI「合并记住 / 仍新增」 |
| ME-P1-02/03 | closed | consolidate 仅摘要簇 deprecate；summary 指向 keeper |
| R-P1-01 | closed | `resolveMidSessionRecallTopic` 中段 query |
| R-P1-04 | closed | `/end` 返回 pending 计数；结束有 pending 跳转记忆治理 |
| PO-P1-01 | closed | 默认创建不自动 TTS（显式 env 才 auto） |
| RV-P1-01 | closed | 复盘仅 themes 页拉取；预算桶 `reviews` |
| GV health 假绿 | closed | `ok`=存活；`ready=false` + `persist.degraded` 当落库失败 |
| bootstrap body 密钥 | closed | 仅 HttpOnly cookie |
| 长 IO 出锁 | closed | search/import/chat 等 WRITE_GATE_EXEMPT + 终写写门 |

## 仍 open / partial（下一批）

| ID | 级 | 标题 | 建议 |
|---|---|---|---|
| R-P1-02 | P1 | card+guide 双通道叠注 | prompt 只保留 guide 或 card 去记忆叠注 |
| R-P1-03 | P1 | 默认语音 strategyTrace / 助手权威落库薄 | Omni/LiveKit 补 record-turn strategy |
| R-P1-05 | P1 | includePendingCandidatesInContext 配置空转 | 真消费或删配置 |
| P1-2 残余 | P1 | 个别后台 reembed/scheduler 路径抽查 | 钉 durable 测试 |
| IM-P1-01/02 | P1 | 敏感整源屏蔽 / 双索引 | chunk 粒度 + 统一索引 |
| CO-P1-* | P1 | Playbook 名实 | 叙事降级或加深执行 |
| GV-P1 配置双源 | P1 | runtime env vs systemConfig | 统一读路径 + capabilities 探针 |
| CORPUS 本地转写 | P2 | public base URL 未接线 | 实现或 UI 去承诺 |
| App 巨石 | P2 | App.tsx ~3k | 按 feature hooks 切片 |
| zhuanfang 副本 | P2 | 干扰 | 归档/移出默认路径 |
| 工作区未 commit | P0 运维 | 审查绿不可部署 | **用户确认后 commit** |

## 验收命令

```bash
npm run typecheck
REAL_PROVIDER_SMOKE=off npm test -- --run
```
