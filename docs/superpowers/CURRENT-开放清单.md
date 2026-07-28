# CURRENT 开放清单（Stage-3 · 2026-07-28）

> 真源：Stage-1/2 已闭合；Stage-3 将第二大脑推到可评测 / 可巩固 / 可恢复层。

## Stage-1 / Stage-2

见既有 commit（`084c6c4b`、`777d8ed5` 等）：fail-loud、HITL、拒召/boot、度量、EoT、TTFA、语料落盘。

## Stage-3

| ID | 状态 | 说明 |
|---|---|---|
| S3-B0 评测基座 | closed | `tests/fixtures/rag-golden/` + rag-golden 单测；barge-in/recovery + grounding metrics |
| S3-B1 记忆生命周期 | closed | echo-chamber；resolve-conflict supersede/demote；consolidate mode=queue；citation envelope |
| S3-B2 语音质量 | closed | interrupt stash + voice-slo-smoke；mouth-to-ear 预算参考 |
| S3-B3 Grounding | closed | chat groundingMode；prompt 引用门禁；runtime grounding 计数 |
| S3-B4 壳切片 | closed | useInterviewSessionShell + useInterruptedUtteranceStash + useRealtimeVoiceSession（close/interrupt/state；connect 仍在 App） |
| S3-B5 媒体运维 | closed | backup-export-smoke；预签名云存储后置 |
| S3-docs | closed | README Stage-3 |

## 仍 open / 后置

- 真音频 e2e TTFA（`test:e2e:real` + key）
- pVAD / SmartTurn
- 语料预签名云存储
- App 语音 connect（cascade/omni/livekit 接线）继续下沉 useRealtimeVoiceSession
- 多设备 CRDT（非目标）

## 验收

```bash
npm run typecheck
REAL_PROVIDER_SMOKE=off npm test -- --run
REAL_PROVIDER_SMOKE=off npm test -- --run src/domain/rag-golden.test.ts
npx tsx scripts/voice-slo-smoke.ts
node scripts/backup-export-smoke.mjs
```
