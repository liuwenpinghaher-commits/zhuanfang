# CURRENT 开放清单（Stage-2 收口 · 2026-07-28）

> 真源：Stage-1 + Stage-2 全部 P2/P3 open 项已闭合。

## Stage-1（已闭合）

见 `084c6c4b` 等：fail-loud、HITL、offline、播客确认 TTS、语料落盘、IM-P1-02、GV 边界、offline hook。

## Stage-2（已闭合）

| ID | 状态 | 说明 |
|---|---|---|
| S2-B0 度量 | closed | health/runtime-metrics；interrupt/chat 记数；Config TTFA |
| S2-B1 拒召+boot | closed | retrieval 拒召、boot pack、minRecallScore |
| S2-B1b 巩固深化 | closed | importance 衰减 + 矛盾候选 HITL（consolidate 后 enrich） |
| S2-B2 通道配额 | closed | chat 分通道配额 |
| S2-B3 语音观测 | closed | interrupt metrics |
| S2-B3b EoT/误打断 | closed | 语义完成短语；minBargeInMs 防抖；echo guard 保留 |
| S2-B3c TTFA 探针 | closed | cascade onLatency → POST /api/system/runtime-metrics/voice |
| S2-B4 hooks | closed | useOfflineProductSync + useCascadeVoiceMetrics |
| S2-B5 能力位 | closed | embedding / corpus-audio-public |
| S2-B5b 语料直传 | closed | POST /api/corpus/audio-files 仅落盘+返回 publicUrl（CDN/预热） |
| S2-docs | closed | README Stage-2 |

## 仍 open

（无。后续可选：真音频 e2e TTFA 回归、pVAD 模型、预签名云存储。）

## 验收

```bash
npm run typecheck
REAL_PROVIDER_SMOKE=off npm test -- --run
```
