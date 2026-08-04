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
- 资源：`npm run copy:vad-assets`（`postinstall` / `dev` / `build` 自动）把 onnx + ORT wasm 拷到 `public/vad/`，浏览器 **同源** 加载 `/vad/`（无 jsDelivr CDN）
- 信号：Silero `isSpeech` 概率与能量/表情启发式融合；失败软降级能量启发式
- 边界：Node/单测无 WebAudio 时静默不可用；资源缺失时 init 失败软降级（不拉 CDN）

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
| D3.a 成本信封 | closed | `docs/COST-ENVELOPE.md`（调用桶/场景上界；≠ USD） |
| D6.a 告警草案 | closed | `docs/runbooks/ALERTS.md`（P0–P3 阈值/动作/降噪） |
| UX-UI 交互与亮色主题 | closed | `src/theme.ts` + `data-theme` tokens；侧栏外观切换 light/dark/system；导航 `aria-current`；见 `docs/superpowers/2026-07-30-ui-light-theme.md` |
| UI-SYSTEM Wave A 表单控件 | closed | `docs/UI-SYSTEM.md` + 全局 `--control-*` + 素材库参考页 |
| UI-SYSTEM Wave B 页面对齐 | closed | 布局工具类 + 去内联布局；动态数据 style 保留 |
| UI-SYSTEM Wave C 交互微动效 | closed | spinner/aria-busy、hover/disabled、record 态、reduced-motion；污染 shell e2e 隔离 13210/13220/13230 |
| UX-UI 全站视觉重做 | closed | 共享设计系统抬升（header/panel/button/metric/form/empty）；专访启动/会话/工作台/芯片；去外链 Unsplash；见 `docs/superpowers/2026-07-30-ui-visual-redesign.md` |
| D1–D6 其余 | open（切片） | 分析见 `2026-07-30-wave-d-analysis.md`；产品痛点再开 D1.a/D2.a；见 `docs/MAINTENANCE-ROADMAP.md` |
| 非目标 | n/a | 多租户、CRDT、完整 AWS SDK |
| 维护路线 | 定稿 | `docs/MAINTENANCE-ROADMAP.md`（V 验证优先 → D 按需） |
| V1 Playwright e2e | closed | 默认族 38/38 绿（含 visual）；污染 shell 隔离（scrubShellEnv + 强制 VITE→13210）；避免本机 3210 鉴权 API 被 reuse |
| V2 真 key compose | closed | `up --build` + 鉴权冒烟 12/12 + down 无 -v 卷保留；见 `2026-07-30-v2-compose-exercise.md` |
| V3 live export smoke | closed | compose API export `completeness=complete`；见 `2026-07-30-v3-live-export-smoke.md` |
| Track V Full GO（验证） | closed | V1+V2+V3 齐；产品签字仍见 DEPLOYMENT-CHECKLIST §10–11 |

## 集成与部署态（2026-07-30 · 定稿）

| 文档 | 用途 |
| --- | --- |
| [`docs/ARCHIVE.md`](../ARCHIVE.md) | **文档归档入口 + 最终健康检查** |
| [`docs/DEPLOYMENT-CHECKLIST.md`](../DEPLOYMENT-CHECKLIST.md) | **上线勾选清单（定稿真源）** |
| [`docs/superpowers/2026-07-30-integration-and-deployment-state.md`](./2026-07-30-integration-and-deployment-state.md) | 集成矩阵、架构、容量信封 |
| [`docs/superpowers/2026-08-01-podcast-multisource-llm-deploy-verification.md`](./2026-08-01-podcast-multisource-llm-deploy-verification.md) | **播客多源 LLM 上线 + 生产冒烟（`31294d37`）** |
| [`docs/runbooks/README.md`](../runbooks/README.md) | 故障手册 |

最终健康检查（`14304554`）：typecheck + **1600 pass / 0 fail** + build + voice-slo + capacity + compose → **绿 · Conditional GO**。Full GO = 清单 §6–§8。

### 2026-08-01 追加（播客多源 LLM）

| 项 | 状态 |
| --- | --- |
| 全来源脚本 LLM + UI 诚实文案 | **closed** · `31294d37` |
| typecheck + Vitest 1618 + e2e 38/38 | **closed** |
| Compose 生产 redeploy + health/surreal | **closed** |
| 生产 note/theme/debt 脚本冒烟 | **closed** |
| TTS 默认音色 `longanhuan` 短/中脚本 | **closed** |
| CosyVoice 音色归一（`longyuan_v3`→预设）+ 动态超时 | **closed** |
| 播客音频过期提示 + 重新合成引导 | **closed** |
| 我的资产 P1：仅重要/排序/URL state/带入专访 | **closed** |
| 今日访谈台：继续优先 / 空场 discard / launch 上下文 | **closed** · `6b295e0f` |
| 实时专访 UX：对话优先 / 控制折叠 | **closed** · `080308b0` |
| 上场摘要回流 + 结束确认 + Esc 停录 + 移动端 | **closed** |
| 主题线 / Track 端到端（resume 空场、复盘 SWR、继续绑定 themeId、Track 回流钻取、雷达诚实） | **closed** · 见 `2026-08-01-themes-track-optimization-report.md` |
| 双轨笔记阅读室（回访开场、保存留页、轻量 pill、主题/播客/原文、档案高亮） | **closed** · 见 `2026-08-01-notes-reading-room-optimization-report.md` |
| 双轨笔记工作流生产冒烟 | **closed · archived** · PASS · `2026-08-01-notes-workflow-smoke.md` + `scripts/notes-workflow-smoke.mjs` |
| 素材库原料车间（URL 同步、导入结果/审核闭环、列表经营、真实错误） | **closed · archived** · `38199901` · 见 `2026-08-01-material-library-optimization-report.md` |
| 素材库端到端业务质量验证 | **closed · archived · PASS** · `f31f6d4a` · `2026-08-01-material-library-final-audit.md` + `scripts/material-workflow-smoke.mjs` · 生产已部署 |
| 2026-08-01 页面经营台会话收口（主题线+笔记+素材库） | **closed · archived** · tip `93e855b2` · 见 `2026-08-01-session-final-report.md` · ARCHIVE §0.10 |
| 资产对话经营台（真新对话/跳源/grounding/预填/开专访） | **closed · archived · PASS** · `8806ce12` · 见 optimization-report + `2026-08-01-asset-chat-workflow-smoke.md` |

## Realization Must-set（2026-08-04 · 代码门禁 · 非真人 D4）

> ADR：[`docs/superpowers/specs/2026-08-04-realization-must-set-adr.md`](./specs/2026-08-04-realization-must-set-adr.md)  
> **不宣称**「完美产品 / Full product GO / 4 周真人 D4 通过」——仅代码 Must-set。

| 项 | 状态 | 说明 |
|---|---|---|
| ADR · D1–D4 DoD + 非目标 + cascade 默认质量承诺 | **closed** | 上链 ADR |
| Craft golden 工厂（5 剧本 · shipped strategy/retrieval） | **closed** | `src/domain/craft-golden.ts` + `craft-golden.test.ts` |
| Confirmed-only packing + conflict 不可静默 approve | **closed** | domain block + **route 409**（无假「已确认记忆」）· PATCH 改写重注记 · `force` 显式覆盖 · UI 拦截文案 · **client 采纳 409 body.state/revision**（防 stale PUT）· `memory-discipline` + `memory-candidates-conflict` + `productApi` 409-adopt 测 |
| Longitudinal `contradicts` / supersede 生产写 + 策略/召回消费 | **closed** | `applyCognitiveRelations` / `resolveMemoryConflict` + guide/strategy · `longitudinal-edges.test.ts`（含 craft 场景 4） |
| doNotSave 诚实结束 + 未确认 partial 不入权威稿 | **closed** | `session-end-presentation.ts` + hook 接线 · `turnAssembler` · `session-authority.test.ts` |
| 真人 D4（4 周主观价值） | **open（推迟）** | 协议在使用方案；本清单不伪造分数 |

轻量跑（无完整 vite 前端插件依赖时）：

```bash
REAL_PROVIDER_SMOKE=off npx vitest run --config vitest.domain.config.ts \
  src/domain/craft-golden.test.ts \
  src/domain/memory-discipline.test.ts \
  src/domain/longitudinal-edges.test.ts \
  src/domain/session-authority.test.ts
```

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
# Must-set domain 子集见上「Realization Must-set」
```
