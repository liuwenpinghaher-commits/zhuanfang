# CURRENT 开放清单（Wave 路线图 · 2026-07-30）

> 真源：Stage-1/2/3 与旅程后置项已闭合。后续按「全维度优化实施路线图」推进。
> 注：`docs/ontology/2026-06-28-落地符合度审视` 中「混合检索/contradicts 全空」已过时。

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

## 后置收口（2026-07-30 · 已验证）

- WebRTC：公网 DashScope signaling 默认，**无需白名单**
- OSS/S3：endpoint + path-style 预签名
- 导入/approve 向量 warning 前后端透出（不再假成功）
- 语音 strategyTrace：record-turn 后 adopt 权威 state
- 分段 TTFA：cascade 记录 VAD→STT / STT→应答 / LLM TTFT / TTS TTFB；Config + /health + capabilities 可见
- 混合召回 empty-fusion + 非空 RRF 并入无向量 BM25 块（P4 e2e 稳定）
- 真音频 e2e 长跑压测（`E2E_REAL=1`）可按需加深
- 多设备 CRDT（非目标）

## Wave 路线图进度

| ID | 状态 | 说明 |
|---|---|---|
| W0 基线 | closed | README Hybrid RAG + 部署；本清单对齐 |
| A1.3 SSRF | closed | `apps/api/src/safe-url.ts`；corpus transcription 校验；`CORPUS_AUDIO_URL_ALLOWLIST` |
| A1.4 限流 | closed | `rate-limit.ts` + server hook；`RATE_LIMIT_*`；Vitest 默认关 |
| A2 CI | closed | `.github/workflows/ci.yml` |
| A3 容量 | closed | `scripts/capacity-smoke.mjs` + runbook 双开锁 |
| A4 runbook | closed | `docs/runbooks/README.md` |
| B1 纵向策略 | closed | 债排序；`decision_review`；互斥；privacy.longitudinal KPI |
| B2 图消费薄 | closed | `contradiction_review`（checklist 对立看法） |
| B3 Playbook 可证 | closed | 既有 ruleType 单测 + concrete-moment 断言保留 |
| C1 chat 阈值 | closed | `retrieveAndRankKnowledge` 用 `resolveMinRecallScore`（去 0.08 硬编码） |
| C2 rubric | closed | `docs/superpowers/eval/interview-rubric.md` |
| C3 隐私 KPI | closed | `buildPrivacyReport().longitudinal` |
| D1–D6 | open | 播客/搜索/成本/a11y/可移植/OTEL 增强按需 |
| 非目标 | n/a | 多租户、CRDT、完整 AWS SDK |

## 集成与部署态（2026-07-30 · 定稿）

| 文档 | 用途 |
| --- | --- |
| [`docs/DEPLOYMENT-CHECKLIST.md`](../DEPLOYMENT-CHECKLIST.md) | **上线勾选清单（定稿真源）** |
| [`docs/superpowers/2026-07-30-integration-and-deployment-state.md`](./2026-07-30-integration-and-deployment-state.md) | 集成矩阵、架构、容量信封 |
| [`docs/runbooks/README.md`](../runbooks/README.md) | 故障手册 |

摘要（代码 `dafbba1f` + 文档后续 commit）：typecheck + **1600 pass / 0 fail** + build + voice-slo + capacity + compose fail-closed → **Conditional GO**。Full GO = 清单 §6–§8（Playwright e2e、真实 key compose、live export）。

## 验收

```bash
npm run typecheck
env -u DASHSCOPE_API_KEY -u BAILIAN_API_KEY REAL_PROVIDER_SMOKE=off npm test -- --run
npm run build
node scripts/capacity-smoke.mjs
npx tsx scripts/voice-slo-smoke.ts
node scripts/backup-export-smoke.mjs
npm run test:e2e
# 可选：set -a; . ./agent/.env; set +a; npm run test:e2e:real
```
