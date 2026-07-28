# CURRENT 开放清单（Stage-2 · 2026-07-28）

> 真源：Stage-1 P0–P2 主路径已闭合；本文件跟踪 Stage-2（记忆可复用 / 语音可度量 / 召回可解释）。

## Stage-1（已闭合）

见 git `084c6c4b` 及此前 commits：fail-loud、HITL、offline、播客确认 TTS、语料落盘、IM-P1-02、GV 配置边界、App offline hook。

## Stage-2 本轮落地

| ID | 状态 | 说明 |
|---|---|---|
| S2-B0 度量 | closed | `/api/health` metrics + `/api/system/runtime-metrics`；interrupt/chat 记数 |
| S2-B1 拒召+boot | closed | `src/domain/retrieval.ts` 低置信拒召；boot context pack；memory.minRecallScore |
| S2-B2 通道配额 | closed | chat `retrieveAndRankKnowledge` 分通道配额 + hybrid 拒召 |
| S2-B3 语音观测 | closed | interrupt 记入 voice metrics；配置页 TTFA p95 警示 |
| S2-B5 能力位 | closed | capabilities：embedding、corpus-audio-public |
| S2-docs | closed | README Stage-2 小节 |

## 仍 open（后续）

| ID | 级 | 标题 |
|---|---|---|
| S2-B1b | P2 | 语义巩固置信衰减 / 矛盾 HITL 深化 |
| S2-B3b | P2 | 语义 EoT / pVAD 误打断抑制 |
| S2-B3c | P2 | cascade 全链路 TTFA 自动探针（需真音频） |
| S2-B4 | P2 | App 语音/访谈 feature hooks 继续切片 |
| S2-B5b | P3 | 语料 CDN/预签名直传 |

## 验收

```bash
npm run typecheck
REAL_PROVIDER_SMOKE=off npm test -- --run
```
