# 级联架构（Cascaded Pipeline）实时语音方案

> **日期**: 2026-06-14
> **目标**: 用 ASR→LLM→TTS 三级联架构替代当前单链路 S2S 模式，实现接近全双工的语音专访体验

---

## 1. 背景

当前系统使用 `qwen3.5-omni-plus-realtime` 单链路 S2S 模式，本质是半双工轮流制：用户说完 → AI 生成回复 → 用户再说。用户在 AI 说话时开口会触发 `response.cancel` 打断。

全网调研结论：
- 真正全双工（Seeduplex、Moshi）无公开 API
- 级联架构（ASR→LLM→TTS）是业界最成熟的替代方案，LiveKit、Deepgram、Azure 均推荐此模式
- 级联架构可实现"ASR 持续监听 + TTS 持续播放"的并行效果，接近全双工体验

## 2. 架构设计

```
┌──────────────────────────────────────────────────────────┐
│                       浏览器                              │
│                                                           │
│  麦克风 ──→ PCM 16kHz ──→ ASR WebSocket                   │
│                │           (Omni Realtime, text-only)      │
│                │              │                            │
│                │              ↓ 实时转写文本                 │
│                │         cascadedPipeline.ts               │
│                │         · 累积转写                        │
│                │         · VAD 判停                        │
│                │         · 打断检测                        │
│                │              │                            │
│                │              ↓ 用户完整文本                │
│                │         百炼 LLM (HTTP)                    │
│                │         qwen-plus-character               │
│                │         · 专访上下文                      │
│                │         · 追问策略                        │
│                │              │                            │
│                │              ↓ AI 回复文本（逐句流式）      │
│                │         CosyVoice TTS (WebSocket 流式)     │
│                │         · 逐句合成                        │
│                │         · 首句即播                        │
│                │              │                            │
│                └── 停止信号 ──→ 打断时停止 TTS 播放         │
│                                                           │
│                          ↓ PCM 24kHz 音频                  │
│                       扬声器播放                            │
└──────────────────────────────────────────────────────────┘
```

### 2.1 三个模型的能力分工

| 阶段 | 模型 | 协议 | 职责 | 延迟 |
|------|------|------|------|------|
| **ASR** | `qwen3.5-omni-plus-realtime` modalities:["text"] | WebSocket 流式 | 持续监听、实时转写、VAD 判停、`speech_started`/`speech_stopped` 事件 | 实时 |
| **LLM** | `qwen-plus-character` | HTTP API | 接收转写文本 + 专访上下文，生成追问回复 | ~1-2s |
| **TTS** | `cosyvoice-v3-plus` | WebSocket 流式 | 逐句合成语音，`run-task`/`continue-task`/`finish-task` | 首包 ~300ms |

### 2.2 流式流水线（Streaming Pipeline）

参考 LiveKit 最佳实践，不等每段完成再开始下一段：

```
时间轴 →
ASR:  [用户说话中...] → "我不想" → "我不想每次都" → "我不想每次都替团队兜底" [判停]
LLM:                              → "我不想每次都替团队兜底" → [开始推理]
TTS:                                                              → "我理解" → "我理解你的感受" [播放中]
```

**关键优化**：
1. **ASR 流式部分转写**：`conversation.item.input_audio_transcription.delta` 提供实时部分转写，用户说半句时 LLM 可预推理
2. **TTS 逐句流式**：LLM 每生成一个完整句子（以 `。！？\n` 分割）立即送入 TTS，不等全文完成
3. **打断处理**：用户在 TTS 播放时说话 → ASR 检测到 `speech_started` → 立即停止 TTS → 新转写到达 → LLM 判断是否切换话题

## 3. 打断策略

级联架构下打断更灵活，因为 LLM 能看到完整文本：

| 场景 | ASR 事件 | 行为 |
|------|----------|------|
| 用户说"嗯""对" | `speech_started` + 短转写 | 识别为 backchannel，TTS 继续播放，LLM 收到后可选微调后续回复 |
| 用户简短打断 | `speech_started` + 短转写 + `speech_stopped` | 停止 TTS，LLM 判断：相关内容 → 整合回复；无关 → 先回应新问题 |
| 用户长段表达 | `speech_started` + 长转写 | 停止 TTS，丢弃当前 LLM 回复，用新转写重新推理 |
| LLM 推理中用户说话 | `speech_started` | 取消当前 LLM 请求（AbortController），用新转写重新推理 |

## 4. 文件改动

### 4.1 新建文件

**`src/realtime/cascadedPipeline.ts`** — 核心编排器（~350 行）

```typescript
// 接口
export interface CascadedPipelineConnection {
  start(): void;
  stop(): void;
  close(): void;
}

// 内部状态机
type PipelineState = "idle" | "listening" | "transcribing" | "llm-thinking" | "tts-playing" | "interrupted";

// 核心流程
// 1. 创建 ASR WS 连接（复用现有代理，modalities: ["text"]）
// 2. 监听 speech_started → 停止 TTS 播放
// 3. 监听 transcription.delta → 累积文本 + 实时显示
// 4. 监听 speech_stopped → 提交完整转写给 LLM
// 5. LLM 流式返回 → 逐句送入 TTS
// 6. TTS 流式返回音频 → AudioBuffer 播放
```

**`src/realtime/cascadedPipeline.test.ts`** — 单元测试

### 4.2 修改文件

**`apps/api/src/providers/bailian.ts`** — 新增 CosyVoice 流式 TTS 客户端（+80 行）

```typescript
export interface BailianStreamingTtsClient {
  synthesizeStream(
    input: { text: string; voice: string },
    onAudio: (chunk: ArrayBuffer) => void,
    onComplete: () => void,
    signal?: AbortSignal
  ): Promise<void>;
}

export function createBailianStreamingTtsClient(options: {
  apiKey: string;
  audioBaseUrl?: string;
}): BailianStreamingTtsClient;
```

使用 CosyVoice WebSocket API：`wss://dashscope.aliyuncs.com/api-ws/v1/inference`，`run-task` → `continue-task` → `finish-task` 协议。

**`apps/api/src/routes/realtime-voice.ts`** — 新增 TTS WebSocket 代理（+60 行）

```
GET /api/realtime-voice/ws/tts/:sessionId
```

浏览器连接此端点 → 服务端转发到 CosyVoice WebSocket，双向流式传输。

**`apps/api/src/routes/system.ts`** — 新增配置项（+10 行）

```typescript
{
  key: "REALTIME_MODE",
  section: "voice",
  label: "实时语音模式",
  valueKind: "select",
  defaultValue: "cascade",
  options: [
    { label: "级联 (ASR→LLM→TTS)", value: "cascade" },
    { label: "端到端 (S2S)", value: "s2s" },
  ]
}
```

**`src/App.tsx`** — 新增级联模式分支（+30 行）

`toggleRealtimeRecording` 中根据 `REALTIME_MODE` 选择：
- `"cascade"` → `connectCascadedPipeline(voiceSession, { ... })`
- `"s2s"` → 现有 `connectBailianRealtimeWebsocket(voiceSession, { ... })`

**`src/styles.css`** — TTS 播放状态指示器（+20 行）

### 4.3 不改动的文件

`engine.ts`、`types.ts`、`InterviewView.tsx`、`ConfigView.tsx`、`productApi.ts`、`bailianWebrtc.ts`、`bailianWebsocket.ts`

## 5. 两种模式对比

| 维度 | S2S（当前） | Cascade（新增） |
|------|-----------|----------------|
| 模型数 | 1（Omni Realtime） | 3（Omni ASR + LLM + CosyVoice） |
| 全双工体验 | ❌ 轮流制 | ⚠️ 接近（ASR 持续监听 + TTS 持续播放） |
| 打断 | 客户端 cancel | LLM 文本级判断 |
| 音色 | Omni 内置 55 种 | CosyVoice 独立控制 |
| 追问质量 | Omni 内置推理 | qwen-plus-character 专访优化 |
| 成本 | Omni 按分钟 | ASR 贵 + LLM 便宜 + TTS 便宜 |
| 可调试性 | 黑盒 | 每段文本可查 |
| 默认模式 | — | **cascade**（级联） |

## 6. 爆炸半径

- **新建**：`cascadedPipeline.ts`（~350 行）、`cascadedPipeline.test.ts`
- **轻改**：`bailian.ts`（+80 行）、`realtime-voice.ts`（+60 行）、`system.ts`（+10 行）、`App.tsx`（+30 行）、`styles.css`（+20 行）
- **不改**：所有其他文件

## 7. 验证计划

1. `npm run dev:full` 启动服务
2. 配置页选择"级联 (ASR→LLM→TTS)"模式
3. 进入专访页，点击语音按钮
4. 验证：声波动画显示、实时转写文本出现、AI 语音回复播放
5. 验证打断：AI 说话时用户开口 → TTS 停止 → 新回复生成
6. `npx vitest run` 全量测试通过
7. `npx vite build` 构建通过
