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
| S3-B4 壳切片 | closed | useInterviewSessionShell + useInterruptedUtteranceStash + useRealtimeVoiceSession + startRealtimeVoiceConnect |
| S3-B5 媒体运维 | closed | backup-export-smoke；本地 presign + 可选 S3 SigV4；pVAD-lite 启发式已接线 |
| S3-docs | closed | README Stage-3 |

## 仍 open / 后置

- 真音频 e2e TTFA 全链路（`E2E_REAL=1` + key；voice-cascade 已有 skip 门控）
- 真实神经网络 pVAD 权重（现为能量/表情启发式 pvad-lite）
- OSS 兼容端点 / 多云对象存储适配（现支持标准 S3 SigV4 PutObject）
- 多设备 CRDT（非目标）

## 验收

```bash
npm run typecheck
REAL_PROVIDER_SMOKE=off npm test -- --run
REAL_PROVIDER_SMOKE=off npm test -- --run src/domain/rag-golden.test.ts
npx tsx scripts/voice-slo-smoke.ts
node scripts/backup-export-smoke.mjs
```
