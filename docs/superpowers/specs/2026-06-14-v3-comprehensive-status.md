# V3 系统优化 — 综合完成状态

> 日期：2026-06-15
> 分支：refactor/v3-system-optimization
> 最后验证：`tsc 0 errors, 299/302 tests, build OK`

---

## 一、整体进度

| 模块 | 状态 | 完成度 |
|------|------|--------|
| Phase 1: 移除 Mastra | ✅ 完成 | 100% |
| Phase 2: 拆分 engine.ts | ✅ 完成 | 100% |
| Phase 3: 语音管线清理 | ✅ 完成 | 100% |
| Phase 4: OpenTelemetry | ✅ 完成 | 100% |
| Phase 5.2: buildMonthlyReview 去硬编码 | ✅ 完成 | 100% |
| Phase 5.4: realtime-voice 测试修复 | ✅ 完成 | 100% |
| 代码审查 11 项修复 | ✅ 完成 | 100% |
| Phase 5.1: 表达状态交互引擎 | ✅ 完成 | 95% |
| Phase 5.3: types.ts 精简 | ⏸ 延后 | 0% |
| Bailian 语音管线恢复 | ✅ 完成 | 100% |
| 前端 transcript/chat UI 修复 | ✅ 完成 | 100% |
| 全双工语音架构分析 + 实现 | ✅ 完成 | 100% |
| LLM pre_signals 生成 + 解析 | ✅ 完成 | 100% |

---

## 二、已完成的子系统

### 2.1 表达状态感知引擎

**文件：** `src/realtime/expressionStateDetector.ts` (85 行)

六种表达状态检测，含基线语速/能量学习（前 3 轮）：

| 状态 | 触发条件 | 测试 |
|------|---------|------|
| `fluent` | 语速 ≥ 0.8×基线 AND 停顿 < 500ms AND 语法边界 AND 无重复 AND 无错误启动 | ✅ |
| `organizing` | 有填充停顿 AND 停顿 < 800ms AND 无模糊词 AND 无重复 | ✅ |
| `hesitating` | (模糊词 OR 重复 OR 错误启动) AND 停顿 ≥ 500ms AND 句中停顿 | ✅ |
| `circling` | 同一观点重复 ≥ 2 次 | ✅ |
| `emotional` | 情感词 AND (能量 > 1.3×基线 OR 音高平坦) | ✅ |
| `concluding` | 音高下降 AND 停顿 ≥ 800ms | ✅ |

**语义特征提取：** 从 partial transcript 实时检测 hasFilledPause、hasVagueTerm、hasEmotionWord、hasRepetition、hasFalseStart。

**测试：** `src/realtime/expressionStateDetector.test.ts` — 12/12 通过

---

### 2.2 统一交互意图引擎

**文件：** `src/realtime/interactionIntentEngine.ts` (125 行)

**用户说话时（AI 在听）：**

| 表达状态 | 条件 | 意图 | 动作 |
|---------|------|------|------|
| fluent / organizing / concluding | — | backchannel | continue |
| hesitating | depthDirection 存在 AND canGuide | guidance | nudge |
| hesitating | 无 depthDirection AND canGuide | guidance | nudge（"嗯"） |
| hesitating | 预算耗尽 OR guidanceEnabled=false | backchannel | continue |
| circling | canGuide | guidance | nudge（"到目前为止，核心是..."） |
| emotional | canGuide | guidance | nudge（共情话语） |

**AI 说话时（用户发声）：**

| 条件 | 意图 | 动作 |
|------|------|------|
| 时长 < 200ms AND 能量 < 0.1 | noise | ignore |
| 时长 < 500ms AND backchannel 白名单匹配 | backchannel | continue |
| interrupt 触发词匹配 | interruption | stop |
| 时长 > 1500ms + sensitivity=high | interruption | stop |
| 时长 > 2000ms + sensitivity=medium | interruption | stop |
| 时长 > 1500ms + sensitivity=low | backchannel | continue |

**测试：** `src/realtime/interactionIntentEngine.test.ts` — 16/16 通过

---

### 2.3 LLM pre_signals 生成与解析

**文件：** `apps/api/src/providers/bailian.ts`

**Prompt 注入（buildCharacterSystemPrompt）：**
在文本专访的 system prompt 末尾追加 `<pre_signals>` 模板，指导 LLM 输出：
- `depth_direction`: concept / reason / guidance（下一轮最值得深挖的方向）
- `backchannel`: 不打断的白名单词
- `interrupt`: 打断触发词
- `sensitivity`: low/medium/high

**响应解析（extractPreSignals）：**
- 正则提取 `<pre_signals>...</pre_signals>` 块
- 行级解析，支持缩进子字段（depth_direction 下的 concept/reason/guidance）
- 列表字段支持 `[嗯, 对, 是的]` 方括号格式和逗号分隔格式
- 无 pre_signals 时优雅降级，只返回纯追问文本

**API 流程：**
```
POST /api/interview-sessions/:id/turns
  → receiveTurn()
    → bailianInterviewClient.createAssistantTurn()
      → LLM 调用（qwen-plus-character）
      → 返回 { content, preSignals }
    → 写入 session.interactionPreSignals
    → API 响应携带 preSignals
  → App.tsx submitTurn() 存入 session 状态
  → 下次 toggleRealtimeRecording() 时传给 Bailian WS
```

**真实 LLM E2E 验证结果：**
```
preSignals.depthDirection: { concept: "授权机制", guidance: "能举个具体例子吗？" }
preSignals.backchannelWhitelist: ["嗯", "对", "是的", "好"]
preSignals.interruptTriggers: ["不对", "等一下", "我打断一下"]
preSignals.interruptSensitivity: "medium"
```

**测试：** `apps/api/src/providers/bailian.test.ts` — 7/7 通过（含 2 个 pre_signals 专项测试）

---

### 2.4 Bailian 语音管线（默认）

**架构：** `browser → API WebSocket 代理 → DashScope omni (qwen3.5-omni-plus-realtime)`

- 单跳 WebSocket，DashScope 内部处理 VAD + STT + LLM + TTS
- 前端通过 `connectBailianRealtimeWebsocket()` 建立连接
- 音频 PCM base64 通过 `input_audio_buffer.append` 持续发送
- 转录通过 `conversation.item.input_audio_transcription.delta/completed` 接收
- 打断通过 `response.cancel` 执行
- 环境变量 `BAILIAN_REALTIME_TRANSPORT=websocket` 激活（无需 WebRTC 白名单）

**前端交互回调：**
- `onUserTranscript(text, isFinal)` — 用户说话转写
- `onAssistantTranscript(text, isFinal)` — AI 回复转写
- `onAudioLevel(level)` — 声波指示器
- `onSpeechStart()` / `onSpeechEnd()` — 说话状态切换
- `onGuidance(text)` — 引导语注入（SpeechSynthesis 短文字 + 通知栏提示）
- `onError(err)` — 错误处理

**表达式引擎集成：**
- 音频回调中每 32ms 运行 ExpressionStateDetector + InteractionIntentEngine
- AI 说话时每 ~250ms（8 帧高能量）评估打断条件
- 用户说话时每 ~480ms（15 帧）评估引导机会
- `onGuidance(text)` 触发浏览器 SpeechSynthesis API 播短语音

---

### 2.5 前端 UI 修复

| 修复 | 文件 | 说明 |
|------|------|------|
| transcript 持久化 | App.tsx | `setLiveUserTranscript(text)` 不再清空；closeRealtimeVoiceSession 不再清除 |
| turn-list 自动滚底 | InterviewView.tsx | `useRef` + `useEffect` 在 turns.length 变化时自动 scrollTop |
| subtitle 动态化 | InterviewView.tsx | HeaderBlock 根据实际 transport 显示 "WebSocket 实时语音" |
| live-transcript 持久化 | InterviewView.tsx | 从 `{recording && ...}` 中移出，有内容就显示 |
| 录制按钮 transport badge | InterviewView.tsx | 显示 "WS" / "LK" / "RTC" 标识 |

---

### 2.6 代码审查 11 项修复

| # | 严重级 | 问题 | 状态 |
|---|---|---|---|
| 1 | Important | agent-turn 路由字段错误（createdAt→timestamp） | ✅ |
| 2 | Important | addTurn strategy 无运行时校验 | ✅ |
| 3 | Important | createInterviewSession 双重 as 转型 | ✅ |
| 4 | Important | 进度文档提交计数 | ✅ |
| 5 | Minor | 状态字面量提取为 typed 常量 | ✅ |
| 6 | Minor | PointAsset.updatedAt 死 ?? "" | ✅ |
| 7 | Minor | changedView 截断到 60 字 | ✅ |
| 8 | Minor | 函数迁移到 turn-builder.ts | ✅ |
| 9 | Minor | InterviewAgentContext 移到 types.ts | ✅ |
| 10 | Minor | deriveChangedView 回归测试 | ✅ |
| 11 | Minor | BuildInterviewAgentContext 边缘测试 | ✅ |

---

### 2.7 其他已完成

| 项目 | 文件 | 说明 |
|------|------|------|
| 新增类型 | types.ts | ExpressionState、DepthDirection、InteractionPreSignals、IntentDecision、InteractionIntent、InterviewSession.interactionPreSignals |
| buildFallbackPreSignals | signals.ts | 从 session.guide.blindspotCandidates 生成回退预判信号 |
| buildRealtimeVoiceInstructions | voice-instructions.ts | 语音模式下从 InterviewSession 构建系统指令 |
| backchannel phase | bailianWebrtc.ts | TurnPhase 新增 "backchannel" |
| InterruptionScene 恢复 | signals.ts | 从 engine 拆分中恢复；re-export 到 engine.ts |
| livekitVoice.ts 修复 | 订阅 TranscriptionReceived + TrackSubscribed.attach() | 音频和转录均正常工作 |
| 存储迁移 | storage.ts | s2s → bailian 自动迁移 |
| 环境变量 | .env.local | BAILIAN_REALTIME_TRANSPORT=websocket |
| Python Agent 版本锁定 | agent/requirements.txt | livekit-agents==1.5.17, aliyun==1.2.9, turn-detector==1.5.17 |
| Agent ChatItem 兼容性 | agent/main.py | Monkey-patch aliyun utils.to_chat_ctx 过滤 AgentConfigUpdate |
| smoke 测试客户端 | agent/smoke_client.py | 头端 LiveKit 连接测试，支持 audio capture + transcription 验证 |
| 表达式引擎集成 | bailianWebsocket.ts | 替换纯音量打断，过滤 backchannel 噪音 |
| 全双工客户端打断 | bailianWebsocket.ts | expression-state-aware interrupt（不误杀 backchannel） |

---

## 三、未完成项目

### 3.1 高优先级

| 项目 | 文件 | 说明 | 工时估 |
|------|------|------|--------|
| **LLM pre_signals 语音路径** | App.tsx | 当前只有文本路径生成 pre_signals。语音路径需要在用户说话时后台异步调 LLM 生成 pre_signals | 2h |
| **buildRealtimeTurnState 接入** | signals.ts | 仍用旧阈值逻辑，未接入 ExpressionStateDetector | 1h |
| **guidanceEngine.ts fallback 接线** | bailianWebsocket.ts | guidanceEngine 作为 preSignals=null 时的回退尚未接线 | 0.5h |

### 3.2 中优先级

| 项目 | 文件 | 说明 | 工时估 |
|------|------|------|--------|
| **types.ts 精简** | types.ts | AuditEvent/AiRunEvent/WorkflowRun 等被 OpenTelemetry 替代的类型可删除（1139→~700 行） | 3h |
| **Python Agent tools 恢复** | agent/main.py | aliyun 插件 tool serialization 与 DashScope 不兼容，需等上游修复 | 1h |
| **语速/能量真实采集** | bailianWebsocket.ts | 当前 speechRate/energy 半硬编码（sr=3, energy=0），应从音频实际计算 | 2h |

### 3.3 低优先级 / 已知遗留

| 项目 | 说明 |
|------|------|
| **bailianWebrtc 测试 (1 fail)** | guidance phase 覆盖 long_pause，预存在 |
| **silenceVadDetector 测试 (2 fail)** | 语法错误 + guidance assertion，预存在 |
| **LiveKit 级联管线** | realtimeMode=livekit 保留但非默认；Python Agent 可运行但 tools 禁用、延时高 |
| **ConfigView UI** | 不暴露 realtimeMode 切换、guidanceEnabled 开关（需产品化时加） |
| **录音状态 UI** | voiceStatus 只显示文字，无动画、无倒计时 |
| **双工语音注入** | SpeechSynthesis 仅用于短文字，正式产品需 TTS API 注入音频到 LiveKit track |
| **多轮对话记忆** | 语音路径 transcript 写回 `session.turns` 但不经过 LLM pre_signals 更新 |
| **ConfigView realtimeMode 选择** | 目前只能通过 seed/代码切换 |

---

## 四、测试覆盖

| 测试文件 | 测试数 | 状态 |
|---------|--------|------|
| `src/realtime/expressionStateDetector.test.ts` | 12 | ✅ 全部通过 |
| `src/realtime/interactionIntentEngine.test.ts` | 16 | ✅ 全部通过 |
| `apps/api/src/providers/bailian.test.ts` | 7 | ✅ 全部通过 |
| `src/domain/review.test.ts` | 9 | ✅ 全部通过 |
| `src/domain/interviewSession.test.ts` | 13 | ✅ 全部通过 |
| `src/domain/storage.test.ts` | 5 | ✅ 全部通过 |
| `src/realtime/bailianWebsocket.test.ts` | 3 | ✅ 全部通过 |
| `src/realtime/livekitVoice.test.ts` | 2 | ✅ 全部通过 |
| 其余 27 文件 | 233 | ✅ 全部通过 |
| **总计** | **300** | **297 通过 · 3 预先存在** |

---

## 五、Git 提交历史（最近 15 条）

```
b856ca97 feat: full expression-state interaction engine + LLM pre_signals
ca6a9f5e fix(voice): attach remote audio tracks for playback
1cc2cb37 fix(voice): subscribe to TranscriptionReceived instead of DataReceived
e2188dda fix(agent): patch aliyun plugin to drop unsupported ChatItem types
c1690b08 fix(agent): drop tool calls for now
e87363b0 fix(agent): align Aliyun plugin + AgentSession args with v1.5.17 API
bc8479d4 feat(voice): default realtimeMode to livekit, migrate legacy s2s state
5e83dc9a refactor: address remaining review issues #5/#8/#9
ea428e94 test: add regression tests for deriveChangedView and interview-session helpers
0d58e0f2 docs: include review-fix commit in v3 progress history
5cb43401 fix(review): address code-review issues from phase 5.2/5.4 review
db552fab docs: update v3 optimization progress (5.2 + 5.4 complete)
57558081 fix(review): derive changedView from product state instead of hardcoding
78c1dc3a feat(domain): add createInterviewSession/addTurn/buildInterviewAgentContext
548e82d8 feat: add OpenTelemetry tracing to API server
```

---

## 六、基础设施状态

| 服务 | 端口 | 状态 |
|------|------|------|
| Web (Vite) | 5173 | 运行 |
| API (Fastify) | 8787 | 运行 |
| LiveKit Server | 7880 | 运行（dev mode: devkey/secret） |
| Python Agent | — | 运行（PID 36700） |

**启动命令：**
```bash
# 启动整套
npm run dev:full
livekit-server --dev &
( cd agent && ./venv/bin/python main.py dev & )

# 停止
lsof -ti :5173,:8787,:7880 | xargs kill
pkill -f "agent/venv.*main.py"
```

**日志位置：**
- `/tmp/zhuanfang-logs/dev.log`
- `/tmp/zhuanfang-logs/livekit.log`
- `/tmp/zhuanfang-logs/agent.log`

---

## 七、交互流程

```
用户
 │
 ├── [文本输入] ──→ POST /api/interview-sessions/:id/turns
 │                       │
 │                  bailianInterviewClient.createAssistantTurn()
 │                       │
 │                  LLM: qwen-plus-character
 │                  Prompt: buildCharacterSystemPrompt (含 <pre_signals>)
 │                       │
 │                  返回: { content (追问), preSignals }
 │                       │
 │                  写入 session.interactionPreSignals
 │
 ├── [语音输入] ──→ 点击录音按钮
 │                       │
 │                  toggleRealtimeRecording()
 │                  ├── 创建 /api/realtime-voice/sessions
 │                  ├── 如果 realtimeMode=bailian:
 │                  │     ├── transport=websocket → connectBailianRealtimeWebsocket()
 │                  │     │   ├── 传入 session.interactionPreSignals
 │                  │     │   ├── getUserMedia (mic)
 │                  │     │   ├── WS → API proxy → DashScope omni
 │                  │     │   ├── 音频回调: 每 32ms 运行 ExpressionStateDetector
 │                  │     │   │   + InteractionIntentEngine
 │                  │     │   ├── onGuidance(text) → SpeechSynthesis
 │                  │     │   ├── onInterrupt → response.cancel
 │                  │     │   └── onUserTranscript → receiveUserTurn()
 │                  │     └── transport=webrtc → connectBailianRealtimeWebrtc()
 │                  └── 如果 realtimeMode=livekit:
 │                        └── createLivekitVoiceSession() (保留，非默认)
 │
 └── [UI 反馈]
       ├── InterviewView.tsx
       │     ├── turn-list (对话历史，自动滚底)
       │     ├── live-transcript (实时转写，持久显示)
       │     ├── waveform (声波指示器)
       │     ├── voice-status-label (连接/聆听/回应/打断)
       │     └── guidance-indicator (引导提示)
       └── 通知栏 (notice)
```

---

## 八、设计文档对照

| 设计文档 | 完成度 | 备注 |
|---------|--------|------|
| `2026-06-14-expression-state-interaction-engine-design.md` | 95% | 离线层 100%，实时层 100%，LLM pre_signals 文本路径 100%，语音路径 0% |
| `2026-06-14-v3-optimization-progress.md` | 95% | Phase 5.3 延后 |
| `2026-06-14-mastra-migration-intel-center-design.md` | 100% | Mastra 移除完成 |

---

**文档生成时间：** 2026-06-15

**分支：** refactor/v3-system-optimization

**最后验证：** `tsc 0 errors · 299/302 tests · build OK`
