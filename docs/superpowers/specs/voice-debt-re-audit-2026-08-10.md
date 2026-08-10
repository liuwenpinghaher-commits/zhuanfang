# 语音 HEAD 债务再审计：fixed vs residual

| 字段 | 值 |
|------|-----|
| **日期** | 2026-08-10 |
| **策略** | Craft-First Cascade Plus（CFC+） |
| **基线** | 工作区 `main` HEAD（实现启动日核验）；设计见 `design-voice-system-cfc-plus-f77a7584` |
| **状态** | 启动日记 · 只读分类，**禁止**按 2026-06-20 报告原文再开 fix PR |
| **验收主路径** | 默认 `realtimeMode: "cascade"` |

---

## 1. 目的

把 6 月复审报告中的语音 P1 与后续补洞，对照 **当前 HEAD 代码** 分成：

1. **fixed** — 行为已在主干落地；Phase 1 只做 **回归锁定**，**不要**再以「fix P1-xx」开空转 PR。  
2. **residual** — 真实仍开放的洞（指标、SLA、工艺门禁、未验证协议）；按 CFC+ PR 映射推进。

历史报告（`系统问题复审报告-2026-06-20.md`）仅作线索，**不以原文状态为准**。

---

## 2. Fixed（勿再开 fix PR）

下列项在 HEAD 已有实现 + 测试/接线证据；后续只允许 golden / 回归锁（如 PR-1），禁止重复「修复」同名缺陷。

| 摘要 | 证据要点 |
|------|----------|
| **P1-06** omni 会中重连 | `bailianWebsocket`：`maxReconnectAttempts`、退避、`onReconnecting`/`onReconnected`；测试标 `P1-06` |
| **P1-06** LiveKit 重连信号 | SDK `RoomEvent.Reconnecting` 等（依赖 SDK，非业务重写） |
| **P1-07** omni ASR delta schema | `text`/`stash` 校验 + `asr_invalid_delta`；测试标 `P1-07` |
| **P1-08** TTS close + AudioContext | `cascadedTtsSink.close()`；pipeline 测试 P1-08 |
| **P1-09** provider 超时（主体） | `_impl` per-request timeout；`bailian-streaming-tts` connect/first-progress |
| **P1-11** 打断恢复全 scene | `cancelAndSaveContext`：除 `backchannel` 外全 scene（含 key_insight / transition） |
| **P1-12** assistant final 追加 | `appendAssistantTranscriptFinal`；`startRealtimeVoiceConnect` 接入 |
| **maxWait + micSuppressed** | `armMaxWait` 检查 `!micSuppressed && state∉{thinking,speaking}` |
| **TTFA 骨架已接线** | pipeline `onLatency` → `useCascadeVoiceMetrics` → `POST .../runtime-metrics/voice` |
| **cascade 断线韧性（主体）** | `asrConnectionLifecycle`、recovery review；既有 e2e |
| **echo quarantine（逻辑）** | `turnAssembler` quarantine；pipeline `onTranscriptQuarantined`（计数 residual → pr-0b） |

> **P1-10** LiveKit interrupt：代码侧已 best-effort（停本地播 + `publishData` + 重开麦），**不算「仍空操作」**；成功率未量化 → 记入 residual SLA，**不是**再写一遍 interrupt 函数。

---

## 3. Residual（真实开放）

| 摘要 | 说明 | 映射 |
|------|------|------|
| barge-in **客户端字段覆盖** | 类型/路由侧有 barge-in 汇总；cascade 自然 barge 上报、health POST 字段覆盖不全 | **pr-0b** |
| **falseTrigger** 计数 | quarantine 逻辑有；服务端无 falseTrigger 事件/counter | **pr-0b** |
| 会话级 craft / **turn-15** rubric | 仅有 craft-golden 策略单测；无会话合规率与人工 turn-15 门禁 | **pr-5** |
| **LiveKit interrupt SLA** | best-effort 已装；成功率未量化，不进默认 cascade SLA | **pr-2o**（可选向量化） |
| **半级联协议未证明** | Omni 口播 brain 文本未 spike | **pr-6s**（失败则不排 pr-6i） |
| **Audio3 未冻结** | OQ1 暂不冻结 model/音色；不合并生产 Audio3 路径 | **pr-8s** 可后做；**pr-8 blocked** |
| P1-09 **抽查遗漏** | 主体超时已修；WebRTC SDP 等边角需 checklist 抽查 | PR-1 清单附带 |

---

## 4. 总表：ID · status · evidence · Phase/PR

| ID | status | evidence path | Phase / PR mapping |
|----|--------|---------------|--------------------|
| P1-06 omni reconnect | **fixed** | `src/realtime/bailianWebsocket.ts`；`src/realtime/bailianWebsocket.test.ts`（`P1-06`） | 回归锁 · PR-1；**禁止** fix PR |
| P1-06 LiveKit reconnect | **fixed**（SDK） | `src/realtime/livekitVoice.ts`（Room reconnect 事件） | 文档标明依赖 SDK |
| P1-07 ASR delta schema | **fixed** | `src/realtime/bailianWebsocket.ts`（`conversation.item.input_audio_transcription.delta` + `asr_invalid_delta`） | 回归锁 · PR-1 |
| P1-08 TTS close | **fixed** | `src/realtime/cascadedTtsSink.ts` `close()`；`cascadedPipeline.test.ts` P1-08 | 回归锁 · PR-1 |
| P1-09 timeouts | **fixed**（主体） / residual 抽查 | `apps/api/src/providers/bailian/_impl.ts`；`apps/api/src/providers/bailian-streaming-tts.ts`（P1-09 注释与测试） | 主体勿再 fix；遗漏 → PR-1 checklist |
| P1-10 LiveKit interrupt | **fixed** best-effort / **residual** SLA | `src/realtime/livekitVoice.ts` `interrupt()`；`agent/` 侧消费 | 勿再「空操作 fix」；SLA → pr-2o |
| P1-11 interrupt scenes | **fixed** | `src/realtime/bailianWebsocket.ts` `cancelAndSaveContext`；`src/domain/signals.ts` `InterruptionScene` | 回归锁 · PR-1 |
| P1-12 appendAssistantTranscriptFinal | **fixed** | `src/domain/session-transcript.ts`；`src/realtime/startRealtimeVoiceConnect.ts` | 回归锁 · PR-1；禁旁路覆盖 |
| maxWait micSuppressed | **fixed** | `src/realtime/cascadedPipeline.ts` `armMaxWait`（`!micSuppressed`） | 回归 + 误触可观测 · PR-1 / pr-0b |
| TTFA skeleton wired | **fixed**（骨架） | `src/realtime/cascadedPipeline.ts` `onLatency`；`src/hooks/useCascadeVoiceMetrics.ts`；`apps/api/src/observability/runtime-metrics.ts` | 勿从零重建；字段补洞 · pr-0b |
| cascade disconnect resilience | **fixed**（主体） | `src/realtime/asrConnectionLifecycle.ts`；recovery review / `tests/e2e/voice-resilience.spec.ts` | 回归 · 已有 e2e；**禁止**当未修重写 |
| echo quarantine logic | **fixed**（逻辑） / residual 见 falseTrigger | `src/realtime/turnAssembler.ts`；`cascadedPipeline` `onTranscriptQuarantined` | 勿重写 quarantine；计数 → **pr-0b** |
| barge-in client field coverage | **residual** | `productApi` / `health` POST 与 cascade 自然 barge 上报缺口 | **pr-0b** |
| falseTrigger counters | **residual** | quarantine 逻辑已 fixed；counter/API 无 | **pr-0b** |
| session craft / turn-15 rubric | **residual** | `src/domain/craft-golden.ts` 仅策略级 | **pr-5**（turn-15 人工优先） |
| LiveKit interrupt SLA | **residual** | 成功率未量化；默认 SLA=cascade | **pr-2o** 可选 |
| half-cascade protocol | **residual**（unproven） | — | **pr-6s** spike 硬门禁 |
| Audio3 not frozen | **residual** | OQ1 未冻结；无生产 flag 路径承诺 | **pr-8 blocked** until freeze |

---

## 5. Phase 1 重定义（强制）

**不是**「按 6 月报告修 P1-06..12」。

1. **回归锁定**已修行为（单测 + demo 已部署栈冒烟，禁止回归项）。  
2. **补真实残留洞**（指标字段、falseTrigger 事件、可选 LiveKit 成功率、timeout 抽查）。  
3. L3 工艺/护栏/rubric 走 pr-4 → pr-5；半级联 / Audio3 走 spike，**未 go 不实现**。

### 禁止

- 以 `fix(P1-06)` / `fix(P1-08)` 等标题对 **fixed** 项开空转 PR。  
- 无 counter 时写 falseTrigger≤2% 自动 CI 门禁。  
- 把 Audio3 / 半级联算进默认用户听感或默认 cascade 交付。  
- 把 LiveKit best-effort 当成与 cascade 同等 SLA。

---

## 6. 相关文档

| 文档 | 用途 |
|------|------|
| 设计 CFC+（`design-voice-system-cfc-plus-f77a7584`） | 策略与完整债务表权威源 |
| `docs/superpowers/specs/2026-08-02-realtime-voice-resilience-design.md` | cascade 断线/recovery 设计 |
| `docs/superpowers/2026-08-02-realtime-voice-resilience-verification.md` | 韧性验证记录 |
| `docs/superpowers/specs/2026-08-04-realization-must-set-adr.md` | Must-set；默认质量承诺栈 = cascade |
| `系统问题复审报告-2026-06-20.md` | **历史线索 only** |

---

## 7. 变更记录

| 日期 | 说明 |
|------|------|
| 2026-08-10 | 实现启动日记：HEAD fixed vs residual 分类落档（本文件） |
| 2026-08-10 | §4 总表补 cascade disconnect resilience、echo quarantine logic 行 |
