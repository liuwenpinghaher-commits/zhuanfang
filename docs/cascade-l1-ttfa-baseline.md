# Cascade 默认路径 L1 · TTFA 基线对比（附录 A）

**日期模板**：2026-08-10（填表时改成实测日）  
**范围**：`realtimeMode: cascade` 默认用户路径（Cosy TTS + `/turns/stream` 子句播放）。  
**不包含**：Omni E2E、Audio 3.0 辅路径、ASR 模型切换。

本文说明如何读 TTFA 分段、如何填基线表、如何与改动前后对比。指标骨架已由 PR-0b 接线；本 PR-L1 仅优化首包播放垫片 / 首句软切分 / 韵律默认与配置注释。

---

## 1. 字段怎么读

| 字段 | 含义 | 瓶颈归属 |
|------|------|----------|
| `ttfaMs` | 用户停说（或 thinking 起点）→ **开始调用 TTS speak** | 全链路总览 |
| `vadEndToSttMs` | 停说到 ASR final | ASR / VAD endpoint |
| `sttToLlmMs` | ASR final → 开始 LLM | 编排间隙 |
| `llmTtftMs` | LLM 首 token | 主持人脑 / 模型 |
| `ttsTtfbMs` | 首 token → TTS speak 开始 | 流式分段 + TTS 首包路径 |

**注意**：浏览器侧首帧 PCM 还有一小段 AudioContext 调度垫片（warm ≈50ms / cold ≈80ms，见 `cascadedTtsSink`）。该垫片在听感上叠加于 `ttsTtfb`，但 **不** 单独进入服务端 TTFA 样本（样本点是 speak 调用时刻）。

**P50 怎么读**：在 `n≥10` 的 finite `ttfaMs` 样本上，P50 是「一半回合更快」的中位体感。单用户产品不要求 n=20 才开工；**晋级 Phase 2 建议累计 n≥20 落盘**。

**参考预算**（非硬 SLA，见 README / runbooks）：

- 观察：`ttfa` P50 ≤ 700ms、P95 ≤ 1200ms  
- 告警参考：P95 > 1200 且样本够 → 查分段；P95 > 2500 或 P50 > 1500 → 体验接近不可用

---

## 2. 采集命令（demo 已部署栈）

```bash
BASE="${BASE:-https://www.qing.blue}"

# 健康摘要（含 voice p50/p95 若有样本）
curl -sS "$BASE/api/health" | jq '{ok,ready,voice:(.metrics.voice//{})}'

# 完整环形缓冲与分段
curl -sS "$BASE/api/system/runtime-metrics" | jq '{
  ttfaP50Ms: .voice.ttfaP50Ms,
  ttfaP95Ms: .voice.ttfaP95Ms,
  sampleCount: .voice.sampleCount,
  ttfaSampleCount: .voice.ttfaSampleCount,
  segments: .voice.segments,
  bargeInSuccessRate: .voice.bargeInSuccessRate,
  falseTriggerCount: .voice.falseTriggerCount,
  budgetHint: .voice.budgetHint
}'
```

配置页在 capabilities 返回 metrics 时也会展示 TTFA；p95 偏高会 amber 提示。

**剧本建议**：同一人、同一环境、cascade 模式，连续 ≥10 轮正常问答（可含 1–2 次自然打断）。改配置或部署后先清预期、再跑同剧本。

---

## 3. 附录 A · 基线记录模板

```text
日期:
demo 主机 / URL:
git sha / 镜像 tag:
realtimeMode: cascade
样本 n (ttfa):
ttfa P50 / P95 (ms):
vadEndToStt P50:
llmTtft P50:
ttsTtfb P50:
barge-in 尝试 / 成功:
quarantine / falseTrigger 备注:
操作人:
curl/JSON 粘贴或截图路径:
结论: baseline | insufficient_data | regression | improved
```

**对比规则（人工）**：

1. 改前填一行 `baseline`（n≥10 优先）。  
2. 合入 L1 / 部署后再跑同剧本，填 `improved` 或 `regression`。  
3. 若 `llmTtft` 占主导 → 优先脑侧；若 `ttsTtfb` 高 → 查流式首句分段与 TTS 代理；若 `vadEndToStt` 高 → endpoint / ASR（**勿裸改 ASR 模型**，须 spike）。  
4. P50 恶化 >10% 且 n≥10 → 标 regression，回看本 PR 的 soft-clause / 首包垫片是否过激。

---

## 4. 本路径可调旋钮（不改 Omni / Audio3）

| 旋钮 | 位置 | 默认 | 调参方向 |
|------|------|------|----------|
| 首包调度垫片 | `cascadedTtsSink` `FIRST_CHUNK_LATENCY_*` | warm 50ms / cold 80ms | 过低可能首字破音 |
| 流式首句软切分 | `cascadedPipeline` `minSoftChars` | 首句 4 / 其后 8 | 首句更低 → 更早出声、可能更碎 |
| 韵律 | `speech-text` `deriveSpeechProsody` | 问句略快+升调；沉思 ≥0.88 | 过慢拖体感；过快不自然 |
| `minBargeInMs` | `systemConfig.voice` / pipeline | 280 | 见 types 注释 |
| `endpointingMode` | `systemConfig.voice` | semantic | silence / semantic / pvad-experimental |
| `minPauseMs` | pipeline `decisionOpts` | 600 | 抢话 vs 傻等 |

---

## 5. 明确不做

- 不改 ASR 模型、不切换 `create_response` 语义  
- 不接 Audio 3.0 / Omni 默认翻盘  
- 不把单次 curl 空窗（n=0）当成 P50 改善  
