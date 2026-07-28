# CURRENT 开放清单（2026-07-28 更新）

> 真源：合并 07-23 审查 + 完善方案落地 + 第二轮剩余项闭合。

## 已闭合

| ID | 状态 | 说明 |
|---|---|---|
| IV-P0-01/02 | closed | voice-instructions / agent-context 写门 field-merge |
| AS-P0-01 | closed | Track topicHint 端到端 |
| IV-P1-01 | closed | abort → 499 不落幽灵轮 |
| ME-P1-01/02/03 | closed | approve merge\|add；consolidate 摘要簇 |
| R-P1-01 | closed | 中段 resolveMidSessionRecallTopic |
| R-P1-02 | closed | voice/bailian 单通道：guide 优先，card 仅 fallback |
| R-P1-03 | closed | assistant record-turn 无 strategy 时服务端 decideInterviewStrategy 补全 |
| R-P1-04 | closed | end pending 计数 + 跳转记忆治理 |
| R-P1-05 | closed | pending 真进 relevantMemories + 配置页开关 |
| PO-P1-01 | closed | 播客默认确认后再 TTS |
| RV-P1-01 | closed | 复盘仅 themes 拉取 |
| IM-P1-01 | closed | 导入源不再因单候选整源 sensitive |
| CO-P1 叙事 | closed | Playbook/语料路径文案对齐软注入+fail-loud |
| GV health | closed | ok 存活 + ready 就绪 |
| bootstrap | closed | cookie-only |
| 长 IO 出锁 | closed | WRITE_GATE_EXEMPT + 终写写门 |
| P1-2 主路径 | closed | scheduler/knowledge 已 replaceStateDurable |
| App 轻拆 | partial | appendAssistantTranscriptFinal 抽到 domain |

## 仍 open（非阻塞 / 后续）

| ID | 级 | 标题 |
|---|---|---|
| IM-P1-02 | P2 | knowledge 索引 vs ragChunks 双索引粒度统一 |
| GV-P1 配置双源 | P2 | runtime env vs product systemConfig 完全统一读路径 |
| CORPUS 本地自动转写 | P2 | SenseVoice 仅公网 URL；UI/README 已诚实 |
| App 巨石 | P2 | App.tsx 仍大，可继续按 feature hooks 切片 |
| zhuanfang 副本 | P3 | 历史树干扰，可归档 |

## 验收

```bash
npm run typecheck
REAL_PROVIDER_SMOKE=off npm test -- --run
```
