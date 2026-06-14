# 实时语音改进方案 v2（已实施）

本文档记录参考 LiveKit Agents 后对专访系统实时语音链路做的改进，以及后续可继续的工作。基于 v2 客观对比修订版 plan，**仅吸收设计、不引入 LiveKit 框架**。

## 背景与定位

- 你的系统：**专访产品**（领域纵深，引擎/记忆/质量闭环/合规审计）。
- LiveKit Agents：**通用语音 Agent 框架**（Turn 判定/事件 schema/打断回填/流式 TTS/fallback 链/指标/provider 抽象）。
- 交集：实时语音对话编排（约占本仓库代码 5%、LiveKit 70%）。
- 改造原则：保留百炼 omni 端到端短链路与 SDP 直通方案，不引入 LiveKit Server/SFU/Worker。

## 已落地的改动（M1–M4）

### M1：事件 schema + 类型基线扩展

文件：`src/domain/types.ts`、`src/domain/engine.ts`

- `RealtimeSessionSignal.eventType` 在原 4 值基础上增量扩展为统一 union（`RealtimeSessionEventType`），新增：
  - `user_started_speaking`、`user_stopped_speaking`、`user_input_transcribed`
  - `agent_state_changed`、`agent_speech_committed`、`agent_speech_interrupted`
  - `metrics_collected`
- `RealtimeSessionSignal` 新增可选字段：`agentState`、`spokenTextSoFar`、`truncatedFromChars`、`metrics`、`turnDetectorId`、`detectorReason`、`detectorConfidence`。
- `AiRunEvent` 新增可选 `metrics: AiRunEventMetrics`，承载 `timeToFirstTokenMs / timeToFirstAudioMs / endOfUtteranceDelayMs / turnDetectorConfidence / interruptedAtMs / spokenCharsBeforeInterrupt`。
- `InterviewTurn` 新增可选 `truncated: InterviewTurnTruncation` 与 `providerTurnId`。
- `formatRealtimeSignalTrace` labels 表覆盖全部新事件类型，未识别值会回退到 raw eventType。

向后兼容：所有新字段都是可选；旧 4 值仍然可用，未消费新事件的代码路径无感。

### M2：Turn 判定抽象层（仅接口 + 保底实现）

文件：`src/realtime/turnDetectors/{types,silenceVadDetector,index}.ts`、`src/realtime/bailianWebrtc.ts`

- 新建 `TurnDetector` 接口：`evaluate(ctx) -> { decision: continue|end_of_turn|interruption; confidence; reason }`。
- 默认实现 `createSilenceVadDetector` 复刻原有阈值逻辑，行为零变化，作为保底层。
- `createTurnStateMachine` 新签名接收可选 `detector: TurnDetector`，未传时使用默认 silence VAD detector。
- 状态机 `getState()` 输出新增 `detectorId / detectorReason / detectorConfidence / detectorDecision` 可选字段，前端可读取展示。
- 状态机 `update()` 入参允许带 `isAssistantSpeaking` 与 `transcript`，并暴露 `setAssistantSpeaking(value)` 用于外部同步 agent 播放状态。
- 单测：`src/realtime/turnDetectors/silenceVadDetector.test.ts` 覆盖 7 个判定场景。

不做：LLM 语义判定 detector（成本/延迟权衡未落地）。接口已留好，未来再加。

### M3：打断回填（truncate-on-interruption）

引擎层：`src/domain/engine.ts`

- 新增 `truncateAssistantTurn(session, input)`：按 `turnId` → `providerTurnId` → 最近未截断 assistant turn 的优先级解析目标，截断 `content` 为 `spokenTextSoFar`，写入 `truncated: { spokenChars, originalChars, reason, truncatedAt }`。返回 `{ session, truncatedTurn, changed }`。
- 单测：`src/domain/truncateAssistantTurn.test.ts`，7 个用例（按 id / 按 providerTurnId / fallback 最新 / 找不到 / 已截断不重复截 / provider_error reason / spokenText 超长 clamp）。

浏览器侧：`src/realtime/bailianWebrtc.ts`

- 新增 `BailianRealtimeWebrtcConnection` 接口：`beginAssistantTurn / markAssistantSpeaking / completeAssistantTurn / getAssistantProgress / interruptAssistant`。
- 维护 `AssistantSpeechProgress`（chunks + totalChars + totalAudioMs + completed）。
- `interruptAssistant({ reason?, interruptedAtMs? })` 拼接 `spokenTextSoFar`，调用 `productApiClient.interruptRealtimeVoiceSession`，把回填结果交给上层 UI。
- `productApiClient` 类型为 `ProductApiClientForRealtime`，`interruptRealtimeVoiceSession` 是可选方法，便于测试与渐进接入。

API 客户端：`src/api/productApi.ts`

- 新增 `interruptRealtimeVoiceSession(sessionId, body)` 方法。
- 新增 `InterruptRealtimeVoiceSessionRequest / Response` 类型。

服务端：`apps/api/src/routes/realtime-voice.ts`

- `POST /api/realtime-voice/sessions/:id/interrupt` 由空操作升级为真实回填：
  - 从 `stateRepo` 读取关联 `interviewSession`，调用 `truncateAssistantTurn`。
  - 写入 `realtimeSignals` 末尾事件，类型为 `agent_speech_interrupted`，附带 `spokenTextSoFar / truncatedFromChars / metrics.interruptedAtMs / metrics.spokenCharsBeforeInterrupt`。
  - 写入 `aiRunEvents`：`workflow=interview_turn_generation`，`providerId=bailian-realtime`，未匹配到 turn 时记 `degraded`。
  - 返回 `{ interrupted, sessionId, truncated, spokenChars, originalChars, assistantTurnId, providerTurnId }`。
- 当 `stateRepo` 缺失或 `interviewSessionId` 未设置时返回 `truncated: false`，不抛异常，保留兼容路径。
- 路由单测：`apps/api/src/routes/realtime-voice.test.ts`，5 个用例。

### M4：单 turn 指标采集（保守版）

文件：`apps/api/src/interview-turn-runner.ts`

- 在 `bailianInterviewClient.createAssistantTurn` 完成后记录 `latencyMs`，作为 `timeToFirstTokenMs` 等价值（当前为非流式调用，TTFT ≈ latency；后续若改为 streaming 再细化）。
- `aiRunEvent.metrics.timeToFirstTokenMs` 写入 ProductState，可被现有 release-gate / privacy 报告复用。

按 v2 取舍：发布门禁 P95 观察项暂未实现；待真实数据积累后再决定阈值。

## 验证证据

- 单测：`npm test -- --run` → 37 套件 / 223 用例全绿（新增 12 个用例覆盖 truncateAssistantTurn 与 realtime-voice 路由）。
- 类型/构建：`npm run build` → tsc + vite build 均通过。
- 端到端：`npm run test:e2e` → 14 项 Playwright 全绿。
- `git diff --check` → 无空白问题。

## 显式不做的事

- ❌ TTS 流式合成 + chunk 对齐（仅 pipeline 路径用得到，omni 路径无需）。
- ❌ Pipeline Voice Provider（ASR+LLM+TTS 三段降级，端到端延迟反而劣于"降级到文本"）。
- ❌ Provider 抽象层重构（5 个 interface + 依赖注入已是合格抽象，等真有第二家 provider 再做）。
- ❌ semanticPauseDetector（Turn 判定语义增强，等接口稳定 1–2 周再做实验）。
- ❌ 把现有 4 值 eventType 替换为新 union（破坏向后兼容）。
- ❌ 引入 Prometheus / OpenTelemetry。

## 后续工作储备

按价值递减排：

1. **TTFA 真实采集**：在 realtime data channel 首个 audio chunk 到达时记录时间戳，写入 `aiRunEvent.metrics.timeToFirstAudioMs`。需要 UI 层拿到的事件时间钩子。
2. **发布门禁 P95 观察项**：积累 ≥50 个真实 turn 后开启，超阈值仅置 `观察`。
3. **`semanticPauseDetector`**：用 `qwen-plus`（短上下文 + 低温）做 turn-end 判定，每秒 1–2 次调用，返回 `{ decision, confidence, reason }` 接入接口即可，可与 silence VAD 并联取较高置信度。
4. **interrupt UI 闭环**：前端在打断成功后展示"已说出 N/M 字"提示，避免用户对截断无感。
5. **`agent_state_changed` 事件落地**：在 dataChannel 收到百炼 `response.created / response.audio_transcript.delta / response.done` 时各发一条状态事件，便于复盘。

## 文件改动清单

```
src/domain/types.ts                              # 类型扩展
src/domain/engine.ts                             # labels + truncateAssistantTurn
src/domain/truncateAssistantTurn.test.ts         # 新增单测
src/realtime/turnDetectors/types.ts              # 新增接口
src/realtime/turnDetectors/silenceVadDetector.ts # 新增默认实现
src/realtime/turnDetectors/silenceVadDetector.test.ts # 新增单测
src/realtime/turnDetectors/index.ts              # 入口
src/realtime/bailianWebrtc.ts                    # 接入 detector + markAssistantSpeaking + interruptAssistant
src/api/productApi.ts                            # interruptRealtimeVoiceSession
apps/api/src/routes/realtime-voice.ts            # /interrupt 真实回填
apps/api/src/routes/realtime-voice.test.ts       # 新增单测
apps/api/src/interview-turn-runner.ts            # metrics.timeToFirstTokenMs
docs/realtime-improvement-plan.md                # 本文档
```

## 兼容性结论

- 现有调用方不传 `detector` / 不调用 `interruptRealtimeVoiceSession` / 不读取新 eventType / 不设置 `truncated` 字段时，**行为完全不变**。
- ProductState JSON 导出/导入路径无破坏：所有新字段为可选。
- 隐私运营包字段级承诺保持：`spokenTextSoFar` 是用户已经听到的 agent 输出，不含 provider secret，可纳入现有隐私库存口径。
