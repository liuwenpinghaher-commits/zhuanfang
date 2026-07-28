# CURRENT 开放清单（2026-07-28 更新）

> 真源：合并 07-23 审查 + 完善方案落地 + 第二轮剩余项闭合。

## 已闭合

| ID | 状态 | 说明 |
|---|---|---|
| IV-P0-01/02 | closed | voice-instructions / agent-context 写门 field-merge |
| AS-P0-01 | closed | Track topicHint 端到端 |
| IV-P1-01 | closed | abort → 499 不落幽灵轮 |
| ME-P1-01/02/03 | closed | approve merge|add；consolidate 摘要簇 |
| R-P1-01 | closed | 中段 resolveMidSessionRecallTopic |
| R-P1-02 | closed | voice/bailian 单通道：guide 优先，card 仅 fallback |
| R-P1-03 | closed | assistant record-turn 无 strategy 时服务端 decideInterviewStrategy 补全 |
| R-P1-04 | closed | end pending 计数 + 跳转记忆治理 |
| R-P1-05 | closed | pending 真进 relevantMemories + 配置页开关 |
| PO-P1-01 | closed | 播客默认确认后再 TTS |
| RV-P1-01 | closed | 复盘仅 themes 拉取 |
| IM-P1-01 | closed | 导入源不再因单候选整源 sensitive |
| IM-P1-02 | closed | knowledge 多 ragChunks + embedding 透传（chat/interview 索引对齐） |
| CO-P1 叙事 | closed | Playbook/语料路径文案对齐软注入+fail-loud |
| GV health | closed | ok 存活 + ready 就绪 |
| GV-P1 配置双源 | closed | env（密钥/模型）vs product systemConfig（产品策略）边界在 Config/capabilities/README 写清；不强制合并读路径 |
| CORPUS 本地自动转写 | closed | 落盘 + 可选 CORPUS_AUDIO_PUBLIC_BASE_URL→SenseVoice；未配置诚实 422；GET /api/corpus/audio-files |
| App 巨石 | closed | 离线同步抽到 `src/hooks/useOfflineProductSync.ts`（App 显著减负） |
| zhuanfang 副本 | closed | `zhuanfang/ARCHIVED.md` + 根 README 标明非入口 |
| bootstrap | closed | cookie-only |
| 长 IO 出锁 | closed | WRITE_GATE_EXEMPT + 终写写门 |
| P1-2 主路径 | closed | scheduler/knowledge 已 replaceStateDurable |
| App 轻拆 | closed | appendAssistantTranscriptFinal + offline hook |

## 仍 open（非阻塞 / 后续）

（当前无 P0/P1/P2 开放项。后续可选：继续按 feature 拆分 App 语音/访谈块、远程 CDN 直传语料等。）

## 验收

```bash
npm run typecheck
REAL_PROVIDER_SMOKE=off npm test -- --run
```
