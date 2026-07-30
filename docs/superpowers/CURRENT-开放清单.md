# CURRENT 开放清单（Stage-3 · 2026-07-28）

> 真源：Stage-1/2 已闭合；Stage-3 将第二大脑推到可评测 / 可巩固 / 可恢复层。
> 收口 commit：`4391dafd`（pVAD-lite + 可选 S3 presign）及后续 workspace/docs 清理。

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
| S3-B5 媒体运维 | closed | backup-export-smoke；本地 presign + 可选 S3 SigV4（`apps/api/src/s3-presign.ts`）；pVAD-lite 已接线 cascade |
| S3-docs | closed | README Stage-3 + `.env.example` CORPUS_S3_* |

## 已落地特性（用法摘要）

### pVAD / Silero
- 配置：`ProductState.systemConfig.voice.endpointingMode = "pvad-experimental"`（亦可 `silence` / `semantic`）
- 代码：`src/realtime/sileroVad.ts`（浏览器 Silero 神经 VAD）+ `pvadEndpointing.ts` → `cascadedAsrSource` / `cascadedPipeline`
- 信号：Silero `isSpeech` 概率与能量/表情启发式融合；失败软降级能量启发式
- 边界：Node/单测无 WebAudio 时静默不可用；真浏览器加载 CDN onnx/wasm

### 语料预签名
- 本地：`POST /api/corpus/audio-files/presign` → `provider:"local"` + `uploadPath`
- 云：设 `CORPUS_S3_BUCKET` + AWS/`CORPUS_S3_*` 密钥 → `provider:"s3"` + `uploadUrl`（SigV4 PutObject）
- 公开读：本地靠 `CORPUS_AUDIO_PUBLIC_BASE_URL`；S3 靠 `CORPUS_S3_PUBLIC_BASE_URL` 或默认 virtual-host URL

## 语音链路（2026-07-30 后置收口）
- cascade：`POST /turns/stream` SSE + **子句级**流式 TTS（`。！？` 硬边界 + `，、；;,` 软边界 ≥8 字）
- WebRTC：`src/realtime/bailianWebrtc.ts` 优先建连，失败诚实回退 WebSocket
- Silero 神经 pVAD：`endpointingMode=pvad-experimental` 融合 speechProb
- LiveKit interrupt：客户端 reliable data channel + agent `await session.interrupt()` 多级回退与可观测日志

## 用户旅程收口（2026-07-30）
- 结束页诚实：`finishInterview` 消费 `pendingMemoryCandidateCount` / `longTermRecallRequiresApproval`；有待审 → 跳转记忆治理；`doNotSave` 不再宣称「档案已生成」
- 主题图召回软匹配：`resolveThemeForPrefetch`（精确优先，保守包含/词重叠；禁止 appearances 回退污染）
- 已闭合核对：R-P1-01 mid queryText、R-P1-05 includePending 配置+域消费、R-P2-01/02 relevance 地板、双通道 guide 优先

## 后置收口（2026-07-30）

- WebRTC：公网 DashScope signaling 默认，**无需白名单**；`BAILIAN_REALTIME_WEBRTC_ENDPOINT` 仅可选覆盖
- OSS/S3：`CORPUS_S3_ENDPOINT` + `CORPUS_S3_FORCE_PATH_STYLE` path-style 预签名
- 导入向量：await reindex，回传 `embeddedChunkCount` / `embeddingFailedCount` / warning；前端导入/approve 透出 warning（不再假成功）
- 语音 strategyTrace：record-turn 后 adopt 权威 state，技法/引用进入 productState
- 分段 TTFA：capabilities 暴露 VAD→STT / STT→LLM / LLM TTFT / TTS TTFB p50，Config 面板可见
- 真音频 e2e 长跑压测（`E2E_REAL=1`）仍可按需加深
- 多设备 CRDT（非目标）

## 验收

```bash
npm run typecheck
env -u DASHSCOPE_API_KEY -u BAILIAN_API_KEY REAL_PROVIDER_SMOKE=off npm test -- --run
REAL_PROVIDER_SMOKE=off npm test -- --run src/realtime/pvadEndpointing.test.ts apps/api/src/s3-presign.test.ts
npx tsx scripts/voice-slo-smoke.ts
node scripts/backup-export-smoke.mjs
npm run test:e2e
# 可选：set -a; . ./agent/.env; set +a; npm run test:e2e:real
```
