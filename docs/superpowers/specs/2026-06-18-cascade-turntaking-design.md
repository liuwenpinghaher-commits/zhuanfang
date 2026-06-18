# 级联语音轮转改进设计（G1–G5）

> 状态：已与用户评审通过（三层架构 + 各 gap 修法 + 数据流 + 组件边界 + 测试）。
> 下一步：转 writing-plans 出实施计划，再执行全部修复。

## Context（为什么做）

一次「实际业务流程 vs 设计」评审（对照日志 + 真实代码 + 持久化 session 数据）确认：级联语音的**三条流骨架真实存在且接通**（流① omni 纯转写 `create_response:false`、流③ `/turns` 角色模型真注入主题/画像 + PCM 无缝 TTS），但流② 的「实时分析」**名大于实**。五个缺陷：

- **G1** — cascade 用的简化版 `decideCascadeTurn` 只看 `expressionState + silence`，**`preSignals` 传入却整段未读**；且 cascade 用的是 connect 时的 `session.interactionPreSignals` 快照，从不刷新（S2S 路径用的是更完整的 `evaluateIntent`）。
- **G2（核心）** — 「智能轮转」实际大多退化成「静默 3.5s 兜底才回应」：触发 `concluding` 需「降调 + 静默≥800ms」，而"降调"是用**频谱质心（亮度）粗略代理音高**的，不可靠；其余状态多走 `wait → 超时`。
- **G3** — 无任何业务日志：轮转决策（action + reason）、用了哪个 prompt、表达状态全不落盘，运行时不可审计（用户"审查日志"无功而返即此）。
- **G4** — backchannel 文案写死两句（"到目前为止，核心是……" / "嗯，我在听。"）。
- **G5** — 开场 `tts.speak([suggestedOpening])` 旁路编排器（[App.tsx:1037](../../src/App.tsx)），不在状态机内（打断/留白/记录不覆盖开场）。

## 全网最佳实践（调研结论）

语音 agent 轮转/endpointing 的业界共识高度一致：**VAD（快、便宜、本地）做第一道门 + 上面叠一层"语义轮转检测"**。

- **LiveKit turn-detector**：Qwen2.5-0.5B 微调小模型，读**转写文本 + 最近 4 轮上下文**，预测 `<|im_end|>` 概率，按语言阈值判"说完了吗"。文本优先（语义 + 上下文）。
- **Pipecat smart-turn**：音频韵律模型，VAD 静默后触发，~65ms。
- **共识**：纯静默超时是"可预测但迟钝"的基线；语义层让系统在用户明显说完时不傻等、在用户中途停顿（"我想想……"）时不抢话。单一最大延迟旋钮（silence/max-wait）是体感与误切的最大杠杆。

来源：
- LiveKit《Using a transformer to improve end of turn detection》https://blog.livekit.io/using-a-transformer-to-improve-end-of-turn-detection
- LiveKit《Turn Detection for Voice Agents: VAD, Endpointing, and Model-Based Detection》https://livekit.com/blog/turn-detection-voice-agents-vad-endpointing-model-based-detection
- Pipecat smart-turn https://github.com/pipecat-ai/smart-turn
- AssemblyAI《How intelligent turn detection (endpointing) solves the biggest challenge in voice agent development》https://www.assemblyai.com/blog/turn-detection-endpointing-voice-agent

**对本系统的适配判断**：cascade **已经有转写文本**（omni 出），无需额外托管模型即可做"文本级语义判定"——这是最适配、成本最低的最佳实践落地。

## 决策（用户已选）

流② 的语义轮转检测用 **混合语义（hybrid）**：明显情况用中文语法启发式 0 延迟判定，只在真模糊时调一次快 LLM。平衡准确/延迟/成本，最贴近 LiveKit 思路。
（备选「纯 LLM」每次停顿 +300~800ms 且每轮多一次成本；「纯启发式」边界情况不如 LLM。均未选。）

## 架构：三层轮转决策

替换现在的「频谱质心 concluding + 3.5s 兜底」。

```
Layer 0  VAD 门（omni server_vad, 600ms）          ← 已有，不变。只管"静默了没"
   │ speech_stopped(transcript, silenceMs)
   ▼
Layer 1  中文语法完整度启发式（浏览器，0 延迟）     ← 新。纯函数，看转写文本判 3 类
   ├─ 强"未完" → WAIT：悬挂连词(因为/但是/所以/然后/而且/不过/比如/就是说)收尾、
   │                   填充词(那个/这个/就是/呃/嗯/怎么说)收尾、助词(的/地/得)收尾
   ├─ 强"已完" → RESPOND：句末语气词(吗/呢/吧/啊/呀)+终止、问号、。！？终止、完整陈述
   └─ 模糊     → 升 Layer 2
   ▼
Layer 2  LLM 语义 endpointing（服务端 qwen，仅模糊时）← 新。带最近 N 轮上下文判
            "用户说完了吗?" → done/notDone，超时兜底 respond。LiveKit 同思路
```

收益：长停顿（悬挂）→ 不抢话；明显说完 → 立刻接，不傻等 3.5s。`max-wait` 从主路径降级为纯安全网（放宽到 ~8s）。

## 数据流（新）

```
mic→omni转写(committed+partial) ─┐
                                  ├─ speech_stopped(transcript, silenceMs)
每帧特征→expressionState ─────────┘          │
                                             ▼
        decideCascadeTurn(state, silence, completeness, preSignals)
            ├ respond ───► doRespond → /turns(角色模型+主题+画像) → PCM TTS
            ├ wait ──────► 留白（max-wait 放宽至 ~8s 安全网）
            ├ backchannel► pickBackchannel(state,preSignals) → PCM TTS（零延迟）
            └ uncertain ─► await classifyEndpoint(server qwen, 超时兜底 respond)
                              └► done→respond / notDone→wait
        每个分支 → onDecision(trace) → console + 服务端日志 + turn metadata
```

打断：仅在 `thinking` 期（`speaking` 期被 echo guard 挡）`speech_started` → abort LLM + 停 TTS + 取消进行中的 classify。

## 各 Gap 修法

### G2（核心）— 三层语义轮转
见上。`expressionState` 保留为**辅助信号**（emotional/circling 仍可触发 backchannel），但不再是 respond 的唯一依据；concluding 不再依赖不可靠的频谱质心音高。

### G1 — preSignals 真正生效
- cascade 每轮把 `/turns` 返回的 `preSignals`（已有，[interview-sessions.ts:109](../../apps/api/src/routes/interview-sessions.ts)）回写 pipeline，下一轮的决策/backchannel/响应都用最新值（替换只读一次的快照）。
- 回应内容侧（盲区/知识债/画像）已经经 `buildCharacterSystemPrompt` 注入，保留不动。
- `decideCascadeTurn` 接受并使用 `preSignals`（不再忽略）。

### G3 — 决策可审计
- 每个决策产出结构化 trace：`{layer, action, reason, transcript, silenceMs, expressionState}`。
- 三处落地：浏览器 `console.debug`；**服务端结构化日志**（Layer 2 / `/turns`，即用户查的 service log）；**写进 turn metadata** 随 session 持久化（`/api/state` 可查）。

### G4 — backchannel 上下文化（零延迟，不调 LLM）
- 抽 `pickBackchannel(expressionState, preSignals)` 纯函数：按状态选短语集 + 轮换；有 preSignals 摘要就用它。替换写死两句。

### G5 — 开场进状态机
- 开场不再旁路 `tts.speak`，由 pipeline 暴露受控开场：进 `speaking` 态、走 echo guard、可被打断、纳入决策日志。

## 组件边界（均可独立单测）

| 模块 | 职责 | 类型 |
|---|---|---|
| `src/realtime/turnCompleteness.ts`（新） | 中文语法完整度 → `complete`/`incomplete`/`ambiguous` | 纯函数 |
| `src/realtime/cascadeTurnDecision.ts`（重写） | 综合 state+silence+completeness+preSignals → `respond`/`wait`/`backchannel`/`uncertain` | 纯函数 |
| `src/realtime/backchannel.ts`（新） | `pickBackchannel(state, preSignals)` | 纯函数 |
| `src/realtime/cascadedPipeline.ts`（改） | 编排；uncertain 时 await 注入的 `classifyEndpoint`；`onDecision` 回调；受控开场 | 注入式可测 |
| `apps/api/src/intelligence/turn-endpoint-llm.ts`（新） | 服务端 qwen 判 done，带上下文 + 预算 + 超时 | mock chatClient 可测 |
| `POST /api/interview-sessions/:id/turn-complete`（新路由） | Layer 2 端点 | — |

接口草案：
```ts
// turnCompleteness.ts
export type Completeness = "complete" | "incomplete" | "ambiguous";
export function assessTurnCompleteness(transcript: string): Completeness;

// cascadeTurnDecision.ts（重写）
export function decideCascadeTurn(input: {
  expressionState: ExpressionState;
  silenceMs: number;
  completeness: Completeness;
  preSignals: InteractionPreSignals | null;
  minPauseMs?: number;   // 默认 600
  maxWaitMs?: number;    // 默认放宽至 ~8000（纯安全网）
}): { action: "respond" | "wait" | "backchannel" | "uncertain"; backchannelText?: string; reason: string };

// pipeline 新注入项
classifyEndpoint?: (transcript: string, signal: AbortSignal) => Promise<{ done: boolean; reason?: string }>;
onDecision?: (trace: { layer: 0|1|2; action: string; reason: string; transcript: string; silenceMs: number; expressionState: string }) => void;
```

## 错误处理 / 降级

- Layer 2（LLM）超时或失败 → 默认 `respond`（宁可接话，不让用户干等）。
- 无 chatClient / 预算耗尽 → 跳过 Layer 2，`ambiguous` 直接按"短停顿 wait / 长停顿 respond"降级。
- `classifyEndpoint` 进行中用户续说 → abort 该请求，回 listening。
- 所有新 LLM 调用走既有 per-session 预算护栏 + 超时。

## 测试

- 纯函数：`turnCompleteness`（中文各类收尾：悬挂连词/填充词/助词/语气词/问号/陈述完整）、`decideCascadeTurn`（complete→respond、incomplete→wait、ambiguous→uncertain、silence 边界、preSignals 影响）、`pickBackchannel`（按状态选 + 轮换 + preSignals）。
- pipeline：uncertain→注入假 classifier→done/notDone→respond/wait；classify 超时兜底 respond；打断取消进行中的 classify；受控开场进 speaking 态。
- 服务端：`turn-endpoint-llm`（mock chatClient：done/notDone/超时）、`/turn-complete` 路由（含预算耗尽降级）。
- 回归：现有 cascade 9 测试 + 全量 `npm test` + `tsc` + `typecheck:api` 全绿。

## 落点文件

- 新 `src/realtime/turnCompleteness.ts` + `.test.ts`
- 重写 `src/realtime/cascadeTurnDecision.ts` + 更新 `.test.ts`
- 新 `src/realtime/backchannel.ts` + `.test.ts`
- 改 `src/realtime/cascadedPipeline.ts`（classifyEndpoint 注入、onDecision、受控开场、uncertain 编排）+ 更新 `.test.ts`
- 改 `src/App.tsx`（wire classifyEndpoint→新端点、每轮刷新 preSignals、开场走 pipeline、onDecision→console+turn metadata）
- 新 `apps/api/src/intelligence/turn-endpoint-llm.ts` + `.test.ts`
- 改 `apps/api/src/routes/interview-sessions.ts`（新 `/turn-complete` 路由 + 决策日志 + turn metadata）

## 范围外（YAGNI）

- 不托管独立 EOU 模型（LiveKit/Pipecat 那种）——用"转写 + 启发式 + 按需 LLM"达成同效，零额外基建。
- 不动 S2S（bailian）路径的 `evaluateIntent`——本设计只改 cascade。
- 不引入音频韵律模型（smart-turn 式）——本轮文本级足够；若日后要更细的"中途停顿"判别再议。
