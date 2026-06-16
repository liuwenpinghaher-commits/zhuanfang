# 级联"三条流"语音 Implementation Plan（ASR只听 · 实时分析门控 · 按情况回应）

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use `- [ ]`.

**Goal:** 把设计好但从未实现的"三条流"建出来：omni-realtime 当**纯 ASR(只听,不自动开口)** → **ExpressionState/意图分析门控**(决定 回应/留白/附和,而非静音即回应) → LLM + **CosyVoice 流式 TTS(按情况回应,首句即播)**。从根上消除"抢话"，找回留白。

**Architecture:** 浏览器端编排器 `cascadedPipeline.ts` 串起三条流，全程浏览器 + DashScope HTTP/WS，无需 LiveKit 基础设施。关键差异(超出原 cascaded 文档)：VAD 的 `speech_stopped` 只当作**候选断点**，由 `ExpressionStateDetector` + 一个新的 `decideCascadeTurn()` 决定此刻是**回应 / 留白等待 / 只附和一声**——这就是"根据分析回应"。复用现成 `ExpressionStateDetector`/`speechFeatures`/`InteractionIntentEngine`。omni `modalities:["text"]` 保证它不抢话(回应 100% 由客户端分析决定)。

**Tech Stack:** TypeScript, React, Vitest, Fastify(WS 代理), DashScope omni-realtime(WS, text-only)/qwen-plus-character(HTTP)/cosyvoice-v3-plus(WS 流式)。

**Spike 已验证(2026-06-16, `scripts/spike-cascaded.mjs`)：** CosyVoice WS 流式真增量(首帧~2s, `result-generated`+binary frames, voice `longanyang`)；omni `modalities:["text"]` 被接受且不出声(注意：勿喂全零 PCM,会崩；真 mic 帧 OK)。

---

## 爆炸半径

| 类型 | 文件 | 说明 |
|---|---|---|
| 新建 | `src/realtime/cascadedPipeline.ts` | 编排器(~300-350 行)：ASR WS + 累积转写 + 分析门控 + LLM + 流式 TTS + 打断 |
| 新建 | `src/realtime/cascadeTurnDecision.ts` | **分析门控**纯函数 `decideCascadeTurn()`(回应/留白/附和) + test |
| 新建 | `apps/api/src/providers/bailian-streaming-tts.ts` | `createBailianStreamingTtsClient`(CosyVoice WS run/continue/finish) + test |
| 改 | `apps/api/src/routes/realtime-voice.ts` | 新增 TTS WS 代理 `GET /api/realtime-voice/ws/tts/:sessionId`(浏览器↔服务端↔CosyVoice WS) |
| 改 | `apps/api/src/server.ts` | TTS 代理需要 streaming-tts client(env 构造) |
| 改 | `src/domain/types.ts` | `SystemConfig.voice.realtimeMode` 联合加 `"cascade"`(成为默认) |
| 改 | `src/domain/seed.ts` | 默认 `realtimeMode: "cascade"` |
| 改 | `src/App.tsx` | `toggleRealtimeRecording` 加 `cascade` 分支 → `connectCascadedPipeline(...)`；UI 状态(transcribing/llm-thinking/tts-playing) |
| 改 | `src/api/productApi.ts` | realtime-voice session 响应可能带 TTS 代理路径 |
| 改 | `src/features/config/ConfigView.tsx` | 实时语音模式选择加"级联" |
| 不改 | `bailianWebsocket.ts`/`bailianWebrtc.ts`/`livekitVoice.ts` | 旧路径保留为 `s2s`/`livekit` 选项 |

**复用(不重写)：** `ExpressionStateDetector`(`expressionStateDetector.ts`)、`speechFeatures.ts`(speechRate/pitch/pause/重复)、`evaluateIntent`(`interactionIntentEngine.ts`，打断/附和判定)、现成 ASR WS 代理(`/api/realtime-voice/ws/:id`)、文字追问 LLM(`POST /api/interview-sessions/:id/turns` 或 `createBailianCharacterInterviewClient`)。`zhuanfang/**` 不动。

**会断的测试：** `realtime-voice.test.ts`(新增 TTS 代理后核对既有断言)、`server.test.ts`(provider clients 列表)、任何断言 `realtimeMode` 联合的类型测试。

---

## 架构决策：三条流 + 分析门控

```
流① 只听 (ASR)            流② 实时分析门控                    流③ 按情况回应
omni text-only WS    →   累积转写 + speechFeatures            →   (仅当"回应")
 · transcription.delta    + ExpressionStateDetector               qwen-plus-character (HTTP, 流式)
 · speech_started/stopped + decideCascadeTurn():                  → 逐句(。！？)切分
 · (不出声!)               concluding→回应                          → CosyVoice WS 流式 TTS
                          organizing/hesitating/fluent→留白          → 首句即播
                          circling→小结/留白                       打断: speech_started→停 TTS+abort LLM
                          emotional→共情/附和
                          + 最长等待兜底(静默>3.5s 也回应)
```

**核心原则：**
1. omni `modalities:["text"]` → 它**永不自动开口**，"是否回应"100% 由流②决定 → 抢话从架构上消失。
2. `speech_stopped` 只是**候选断点**，不直接触发回应；过 `decideCascadeTurn` 这道闸。
3. 留白是一等行为：分析说"还在组织/犹豫"就**什么都不发**(或只一声"嗯")，等用户继续。
4. 打断：用户在 TTS 播放时开口 → 停 TTS + abort 进行中的 LLM → 用新转写重新判断。

---

## File Structure（决策锁定）
- `cascadeTurnDecision.ts`：**纯函数**，唯一职责=把"分析状态→回应/留白/附和"的决策固化(可测、不碰 IO)。先建它(被编排器依赖)。
- `bailian-streaming-tts.ts`：独立的流式 TTS 客户端(server 端，WS→CosyVoice)，单一职责。
- `cascadedPipeline.ts`：编排器，只做"连线"(把 ASR 事件 → 分析门控 → LLM → TTS → 播放/打断 串起来)，决策逻辑全在 `cascadeTurnDecision.ts`，保持编排器可读。

---

## Tasks

### Task 1: 分析门控纯函数 `decideCascadeTurn`（流②的心脏）

**Files:** Create `src/realtime/cascadeTurnDecision.ts` + `src/realtime/cascadeTurnDecision.test.ts`. 先读 `src/domain/types.ts` 的 `ExpressionState` 联合 + `InteractionPreSignals`。

- [ ] **Step 1: 写失败测试**
```ts
import { describe, expect, it } from "vitest";
import { decideCascadeTurn } from "./cascadeTurnDecision";

const base = { silenceMs: 1000, preSignals: null, maxWaitMs: 3500 } as const;
describe("decideCascadeTurn", () => {
  it("responds when the user concluded a thought", () => {
    expect(decideCascadeTurn({ ...base, expressionState: "concluding" }).action).toBe("respond");
  });
  it("waits (留白) when the user is still organizing / fluent / hesitating", () => {
    for (const s of ["organizing", "fluent", "hesitating"] as const) {
      expect(decideCascadeTurn({ ...base, expressionState: s }).action).toBe("wait");
    }
  });
  it("offers a brief backchannel when circling (not a full turn)", () => {
    const d = decideCascadeTurn({ ...base, expressionState: "circling" });
    expect(d.action).toBe("backchannel");
    expect(d.backchannelText && d.backchannelText.length).toBeGreaterThan(0);
  });
  it("max-wait safety: responds after long silence regardless of state", () => {
    expect(decideCascadeTurn({ ...base, expressionState: "organizing", silenceMs: 4000 }).action).toBe("respond");
  });
  it("never responds on a very short pause even if concluding-ish", () => {
    expect(decideCascadeTurn({ ...base, expressionState: "fluent", silenceMs: 200 }).action).toBe("wait");
  });
});
```
- [ ] **Step 2: 跑测试确认 FAIL**（模块不存在）。
- [ ] **Step 3: 实现**
```ts
import type { ExpressionState, InteractionPreSignals } from "../domain/types";

export interface CascadeTurnInput {
  expressionState: ExpressionState;
  silenceMs: number;            // 自上次语音结束的静默时长
  preSignals: InteractionPreSignals | null;
  maxWaitMs?: number;           // 兜底：静默超过此值也回应（默认 3500）
  minPauseMs?: number;          // 低于此值一律 wait（默认 600）
}
export interface CascadeTurnDecision {
  action: "respond" | "wait" | "backchannel";
  backchannelText?: string;
  reason: string;
}

export function decideCascadeTurn(input: CascadeTurnInput): CascadeTurnDecision {
  const maxWait = input.maxWaitMs ?? 3500;
  const minPause = input.minPauseMs ?? 600;
  // 兜底：用户停太久了，别冷场
  if (input.silenceMs >= maxWait) return { action: "respond", reason: "max-wait safety" };
  // 太短的停顿一律视为换气，留白
  if (input.silenceMs < minPause) return { action: "wait", reason: "pause too short" };
  switch (input.expressionState) {
    case "concluding": return { action: "respond", reason: "user concluded a thought" };
    case "circling":   return { action: "backchannel", backchannelText: "到目前为止，核心是……", reason: "user circling → nudge summary" };
    case "emotional":  return { action: "backchannel", backchannelText: "嗯，我在听。", reason: "emotional → empathy backchannel" };
    case "hesitating":
    case "organizing":
    case "fluent":
    default:           return { action: "wait", reason: "mid-thought → 留白" };
  }
}
```
- [ ] **Step 4: 跑测试 PASS** + `npx tsc -b` 0。
- [ ] **Step 5: Commit** `git add src/realtime/cascadeTurnDecision.ts src/realtime/cascadeTurnDecision.test.ts && git commit -m "feat(voice): cascade turn-decision — analysis-gated respond/wait/backchannel (no silence-only response)"`

---

### Task 2: CosyVoice 流式 TTS 客户端（server 端，WS）

**Files:** Create `apps/api/src/providers/bailian-streaming-tts.ts` + test. 协议见 spike：`run-task`/`continue-task`/`finish-task`，事件 `task-started`/`result-generated`(+binary)/`task-finished`，model `cosyvoice-v3-plus`，voice `longanyang`，format mp3/24k。

- [ ] **Step 1: 写失败测试**（mock `ws`）—— 断言：连接后发 `run-task`(含 model/voice/format)；`task-started` 后逐条 `continue-task`(每句文本)；末尾 `finish-task`；收到 binary frame 触发 `onAudio(chunk)`；`task-finished` 触发 `onComplete()`。用注入式 WS（`wsFactory`）模拟服务器事件序列。
- [ ] **Step 2: FAIL**。
- [ ] **Step 3: 实现** `createBailianStreamingTtsClient({ apiKey, wsUrl?, wsFactory? })` 返回 `{ synthesizeStream(input, onAudio, onComplete, signal?) }`。内部：开 WS(`wss://dashscope.aliyuncs.com/api-ws/v1/inference`, header Authorization)；duplex 协议三段；binary frame → `onAudio`；`signal.aborted` → 立即 `finish-task`+close(支持打断 abort)。`wsFactory` 注入以便测试。
- [ ] **Step 4: PASS** + tsc 0。（真机流式已由 spike 验证，这里只测协议装配。）
- [ ] **Step 5: Commit** `git commit -m "feat(voice): CosyVoice streaming TTS client (WS run/continue/finish, abortable)"`

---

### Task 3: TTS WebSocket 代理路由

**Files:** Modify `apps/api/src/routes/realtime-voice.ts`(+ `server.ts` 注入 streaming-tts client)。模式同现有 ASR 代理(`server.server.on("upgrade")` 匹配 `/api/realtime-voice/ws/:id`)。

- [ ] **Step 1: 写失败测试**（或集成测试）—— 断言新路径 `/api/realtime-voice/ws/tts/:sessionId` 的 upgrade 被识别(404 for unknown session 等)，复用现有 ASR 代理测试结构。
- [ ] **Step 2: FAIL**。
- [ ] **Step 3: 实现** 新增 upgrade 匹配 `^/api/realtime-voice/ws/tts/(.+)$`：浏览器 WS ↔ 服务端 ↔ CosyVoice WS(用 Task 2 的 client 或直接转发)。浏览器发文本句子，服务端 `continue-task`，CosyVoice binary → 转发给浏览器。无 key → close(4001)。
- [ ] **Step 4: PASS**；`npx vitest run apps/api/src/routes/realtime-voice.test.ts` 绿(核对既有断言未破)。
- [ ] **Step 5: Commit** `git commit -m "feat(voice): TTS WebSocket proxy (browser ↔ CosyVoice streaming)"`

---

### Task 4: 编排器 `cascadedPipeline.ts`（把三条流串起来）

**Files:** Create `src/realtime/cascadedPipeline.ts` + test. 先读 `bailianWebsocket.ts`(复用 ASR WS 连接/PCM append/打断保存逻辑 + `featureTracker`/`expressionDetector` 接线，~line 120-153)、`speechFeatures.ts`、`livekitVoice.ts`(回调形状)。

接口：
```ts
export interface CascadedPipelineCallbacks {
  onStateChange: (s: "idle"|"listening"|"transcribing"|"thinking"|"speaking"|"interrupted") => void;
  onUserTranscript: (text: string, isFinal: boolean) => void;
  onAssistantText: (text: string) => void;     // 流③逐句文本(给 UI + 记录 turn)
  onError: (e: Error) => void;
}
export interface ConnectCascadedPipelineOptions {
  asrWsUrl: string; ttsWsUrl: string;
  sendUserTurn: (text: string) => Promise<{ assistantText: string }>; // 复用 /turns(或流式)
  callbacks: CascadedPipelineCallbacks;
  preSignals?: InteractionPreSignals | null;
}
export function connectCascadedPipeline(opts): Promise<{ startListening(): Promise<void>; interrupt(): void; close(): void }>;
```

核心流程(测试用 mock ASR/sendUserTurn/TTS)：
1. 连 ASR WS(omni `modalities:["text"]` + `turn_detection.server_vad` 仅作候选断点 + `input_audio_transcription`)。**不发 response.create**(omni 不出声)。
2. `transcription.delta` → 累积 partial + `onUserTranscript(_, false)` + 更新 `speechFeatures`/`semanticFlags`。
3. `speech_stopped`(候选断点)→ 跑 `ExpressionStateDetector.evaluate(...)` → `decideCascadeTurn({ expressionState, silenceMs, preSignals })`：
   - `wait` → 什么都不做，继续累积(**留白**)；
   - `backchannel` → 经 TTS 播一声 `backchannelText`，**不**走 LLM，继续听；
   - `respond` → `onUserTranscript(full, true)` → `onStateChange("thinking")` → `sendUserTurn(full)`(AbortController)→ 拿 assistantText → 按 `。！？\n` 切句 → 逐句送 TTS WS → `onStateChange("speaking")` → 播放。
4. **打断**：TTS 播放/`thinking` 中收到新的 `speech_started` → 停 TTS 播放 + abort LLM + `onStateChange("interrupted"/"listening")` → 新转写重走第 3 步。
5. 兜底定时器：`respond` 后清；静默累计到 `maxWaitMs` 触发一次 `respond`。

- [ ] **Step 1: 写失败测试**（mock：注入假 ASR WS 能推 transcription.delta/speech_stopped；假 `sendUserTurn` 返回固定 assistantText；假 TTS 记录收到的句子）。断言：
  - 用户"组织中"停顿(organizing, 短静默)→ **不**调用 `sendUserTurn`(留白)。
  - 用户"concluding"停顿 → 调用 `sendUserTurn(完整转写)` 且 TTS 收到逐句。
  - TTS 播放中来 `speech_started` → 触发打断(TTS 停 + 新一轮)。
  - 兜底：长静默 → 即使 organizing 也回应。
- [ ] **Step 2: FAIL**。
- [ ] **Step 3: 实现编排器**（决策全调 Task 1，不在这里重写判定）。
- [ ] **Step 4: PASS** + tsc 0 + 全量 `npx vitest run` 绿。
- [ ] **Step 5: Commit** `git commit -m "feat(voice): cascaded pipeline orchestrator — ASR→analysis-gate→LLM→streaming TTS with 留白 + barge-in"`

---

### Task 5: 接线——`cascade` 模式 + 默认 + App.tsx 分支 + 配置

**Files:** `src/domain/types.ts`(realtimeMode 加 `"cascade"`)、`src/domain/seed.ts`(默认 `"cascade"`)、`src/App.tsx`(`toggleRealtimeRecording` 加 cascade 分支调 `connectCascadedPipeline`，复用现有 `recordInterviewTurn`/pre_signals 接线 + 新的 transcribing/thinking/speaking 状态映射到 `voiceStatus`)、`src/features/config/ConfigView.tsx`(模式选项加"级联(ASR→分析→TTS)")、`productApi.ts`(若 session 响应需带 ttsWsUrl)。

- [ ] **Step 1**: types/seed 加 `"cascade"`；改任何断言 realtimeMode 的测试。
- [ ] **Step 2**: App.tsx：`voiceMode === "cascade"` → 取 ASR/TTS WS url → `connectCascadedPipeline({ sendUserTurn: (t) => productApiClient.recordInterviewTurn(...).then(...)→ 触发 /turns 拿 assistant, callbacks 映射到 setVoiceStatus/setLiveUserTranscript/setSession })`。打断/麦克风发布复用现有逻辑。
- [ ] **Step 3**: ConfigView 模式选择 + 默认级联。
- [ ] **Step 4**: `npx tsc -b` 0、`npm run typecheck:api` 0、`npx vitest run` 绿、`npx vite build` OK。
- [ ] **Step 5: Commit** `git commit -m "feat(voice): wire cascade mode as default realtime path (config + App branch)"`

---

### Task 6: 浏览器真机验证 + 调参（手动，orchestrator 执行）

- [ ] `dev:full` 起服务，实时专访启动语音(cascade)。验证：①开场从跟踪点续接、无寒暄；②**说话中途停顿不被抢话**(留白生效)；③说完一个完整想法后 AI 才回应；④AI 说话时开口能打断；⑤首句快速出声(流式)。
- [ ] 用 Preview MCP 抓 console/network + 截图留证；据实调 `minPauseMs`/`maxWaitMs`/`silence_duration_ms`。
- [ ] 记录实测表现(开场、留白、打断、首包延迟)。

---

### Task 7: 全量回归

- [ ] `npx vitest run`(含新测) 绿、`tsc -b`/`typecheck:api` 0、`npx playwright test` 17+ 绿(先 `lsof -ti:5173/8787 | xargs kill`)、`vite build` OK。
- [ ] **Commit**(若有测试同步) + 最终 holistic review。

---

## Self-Review
- **Spec coverage**：三条流 = Task4(编排)+Task1(分析门控=流②心脏)+Task2/3(流③流式 TTS)+omni text-only(流①, Task4 内连)；"根据分析回应不是静音即回应" = Task1 `decideCascadeTurn`(concluding 才 respond，其余留白)；抢话消除 = omni text-only(不自动开口)+ 门控；打断/留白/附和 = Task1+Task4。
- **Placeholder 扫描**：Task1/2 给了完整可跑代码+测试；Task4 编排器给了接口+状态机+分步算法+测试断言(决策逻辑已在 Task1 固化，编排器只连线)，属大组件的合理粒度；Task6 是手动验证(真机+mic，JS 套测不到)，非 TBD。
- **类型一致性**：`decideCascadeTurn(CascadeTurnInput): CascadeTurnDecision`、`ExpressionState` 复用 types.ts、`connectCascadedPipeline` 回调形状对齐 `livekitVoice.ts` 既有约定；`realtimeMode` 联合在 types/seed/App/Config 四处同步加 `"cascade"`。
- **依赖顺序**：Task1(纯函数)→Task2(TTS client)→Task3(代理)→Task4(编排,依赖1)→Task5(接线,依赖2/3/4)→6/7。

> 待你拍板(已默认按推荐走)：`cascade` 设为**默认** realtimeMode(原 `bailian` S2S 与 `livekit` 保留为可选)。spike 已证两条关键 API 可用。
