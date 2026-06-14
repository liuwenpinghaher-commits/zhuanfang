# 语音专访主动引导（Active Guidance）深化实现方案 v2

> 版本：v2.0（可直接实施）
> 日期：2026-06-14
> 定位：在现有代码基础上，以最小改动实现与"打断"同级别的主动引导能力

---

## 0. 设计原则

1. **引导和打断是同一光谱的两端**：共用同一套 Turn Detector 接口，不另起炉灶
2. **最小改动**：每个文件改动不超过 50 行，新增文件不超过 3 个
3. **向后兼容**：所有新字段可选，旧路径行为不变
4. **可配置**：用户可调整引导频率/强度，可关闭
5. **可观测**：引导决策有 trace，前端可见

---

## 1. 类型层改动

### 1.1 `src/domain/types.ts` — 扩展类型

**改动 1：扩展 `RealtimeTurnState`，增加引导字段**

```typescript
// 当前定义（行 1008-1014）：
export interface RealtimeTurnState {
  phase: "listening" | "holding" | "thinking" | "speaking";
  nextAction: string;
  backchannel?: string;
  shouldInterrupt: boolean;
  confidence: number;
}

// 改为：
export interface RealtimeTurnState {
  phase: "listening" | "holding" | "thinking" | "speaking";
  nextAction: string;
  backchannel?: string;
  shouldInterrupt: boolean;
  confidence: number;
  // 新增：主动引导
  guidance?: RealtimeGuidanceDecision;
}

export interface RealtimeGuidanceDecision {
  kind: GuidanceKind;
  text: string;
  anchor?: string;
  reason: string;
  confidence: number;
}

export type GuidanceKind =
  | "nudge"             // 轻推："嗯"、"然后呢？"
  | "echo"              // 回音：重复最后几个词
  | "anchor_probe"      // 锚点追问："等一下，你说的X具体是指？"
  | "concretize"        // 具体化："具体发生了什么？"
  | "emotion_label"     // 情感标记："听起来你很矛盾"
  | "contradiction"     // 矛盾标记
  | "mini_summary"      // 阶段性总结
  | "mirror";           // 镜像："我听到的是..."
```

**改动 2：扩展 `RealtimeSessionSignal`，增加引导字段**

```typescript
// 在现有字段后增加（行 1016-1032 之后）：
export interface RealtimeSessionSignal {
  // ... 现有字段保持不变 ...
  // 新增：
  guidanceKind?: GuidanceKind;
  guidanceText?: string;
  guidanceAnchor?: string;
}
```

**改动 3：扩展 `RealtimeSessionEventType`，增加引导事件**

```typescript
// 行 1036-1048：
export type RealtimeSessionEventType =
  | "listening"
  | "hold"
  | "interruption"
  | "assistant_response"
  | "user_started_speaking"
  | "user_stopped_speaking"
  | "user_input_transcribed"
  | "agent_state_changed"
  | "agent_speech_committed"
  | "agent_speech_interrupted"
  | "metrics_collected"
  | "guidance_triggered"    // 新增：引导触发
  | "guidance_delivered";   // 新增：引导已送达
```

**改动 4：扩展 `SystemConfig.interview`，增加引导配置**

```typescript
// 在 interview 配置块中增加（行 ~50）：
export interface SystemConfig {
  // ... 现有字段 ...
  interview: {
    playbookVersion: string;
    launchMode: "immersive";
    silenceHoldMs: number;
    maxFollowUpDepth: number;
    // 新增：
    guidanceEnabled: boolean;       // 是否启用引导
    guidanceFrequency: "low" | "medium" | "high";  // 引导频率
    maxGuidancePerTurn: number;     // 每轮最多引导次数（默认 2）
    minGuidanceIntervalMs: number;  // 两次引导最小间隔（默认 5000）
    challengeBudgetPerSession: number; // 每场挑战型引导配额（默认 3）
  };
}
```

---

## 2. 引擎层改动

### 2.1 `src/domain/engine.ts` — 核心引导逻辑

**改动 1：新增 `evaluateGuidance` 函数（~120 行，新增在 `buildRealtimeTurnState` 之前）**

```typescript
// 引导检测的上下文
interface GuidanceEvalContext {
  partialTranscript: string;
  finalTranscript: string;
  silenceMs: number;
  isUserSpeaking: boolean;
  isAssistantSpeaking: boolean;
  turnCount: number;
  guidanceCountThisTurn: number;
  lastGuidanceTimestamp: string | null;
  blindspotCandidates: Array<{ concept: string; reason: string }>;
  recentAnchorWords: string[];
  guidanceBudget: {
    maxPerTurn: number;
    minIntervalMs: number;
    challengeBudget: number;
    challengeUsed: number;
  };
}

export function evaluateGuidance(ctx: GuidanceEvalContext): RealtimeGuidanceDecision | null {
  // 第一层：频率控制
  if (ctx.guidanceCountThisTurn >= ctx.guidanceBudget.maxPerTurn) return null;
  if (ctx.lastGuidanceTimestamp) {
    const elapsed = Date.now() - new Date(ctx.lastGuidanceTimestamp).getTime();
    if (elapsed < ctx.guidanceBudget.minIntervalMs) return null;
  }

  // 第二层：时机判断 — 只在用户停顿 400-1200ms 时引导
  if (ctx.silenceMs < 400 || ctx.silenceMs > 1200) return null;
  if (!ctx.isUserSpeaking && ctx.silenceMs < 400) return null;
  if (ctx.isAssistantSpeaking) return null;

  // 第三层：语义判断 — 检测引导锚点
  const transcript = ctx.finalTranscript || ctx.partialTranscript;
  if (!transcript || transcript.length < 5) return null;

  // 检测模糊锚点（"那个东西"、"这个决定"、"那种感觉"等）
  const vagueAnchor = detectVagueAnchor(transcript);
  if (vagueAnchor) {
    return {
      kind: "anchor_probe",
      text: `等一下，你说的"${vagueAnchor}"具体是指？`,
      anchor: vagueAnchor,
      reason: `检测到模糊锚点: "${vagueAnchor}"`,
      confidence: 0.82
    };
  }

  // 检测情感信号
  const emotionSignal = detectEmotionSignal(transcript);
  if (emotionSignal) {
    return {
      kind: "emotion_label",
      text: generateEmotionLabel(emotionSignal),
      anchor: emotionSignal.word,
      reason: `检测到情感信号: ${emotionSignal.type}`,
      confidence: 0.75
    };
  }

  // 检测矛盾（需要至少 2 轮对话）
  if (ctx.turnCount >= 2) {
    const contradiction = detectContradiction(transcript);
    if (contradiction && ctx.guidanceBudget.challengeUsed < ctx.guidanceBudget.challengeBudget) {
      return {
        kind: "contradiction",
        text: `你刚才说"${contradiction.previous}"，但现在提到"${contradiction.current}"，这两个好像不太一样？`,
        anchor: contradiction.current,
        reason: `检测到前后矛盾`,
        confidence: 0.7
      };
    }
  }

  // 默认：轻推（只在用户明显在思考时）
  if (ctx.silenceMs >= 600 && ctx.silenceMs < 900 && ctx.guidanceCountThisTurn === 0) {
    return {
      kind: "nudge",
      text: "嗯",
      anchor: undefined,
      reason: "用户思考停顿，轻推延续",
      confidence: 0.6
    };
  }

  return null;
}

// 模糊锚点检测
function detectVagueAnchor(text: string): string | null {
  const patterns = [
    /那个(东西|事|问题|人|决定|选择|时候|感觉|想法)/,
    /这个(东西|事|问题|人|决定|选择|时候|感觉|想法)/,
    /某种(程度|意义|方式|东西|感觉)/,
    /怎么说呢/,
    /反正就是/,
    /你懂的/,
    /那种(感觉|状态|情况)/,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) return match[0];
  }
  return null;
}

// 情感信号检测
interface EmotionSignal {
  type: "conflict" | "frustration" | "uncertainty" | "regret" | "hope";
  word: string;
}

function detectEmotionSignal(text: string): EmotionSignal | null {
  if (text.includes("矛盾") || text.includes("纠结") || text.includes("两难")) {
    return { type: "conflict", word: "矛盾" };
  }
  if (text.includes("不知道") || text.includes("不确定") || text.includes("也许") || text.includes("可能吧")) {
    return { type: "uncertainty", word: "不确定" };
  }
  if (text.includes("烦") || text.includes("累") || text.includes("受不了") || text.includes("没办法")) {
    return { type: "frustration", word: "烦" };
  }
  if (text.includes("后悔") || text.includes("早知道") || text.includes("如果当初")) {
    return { type: "regret", word: "后悔" };
  }
  return null;
}

function generateEmotionLabel(signal: EmotionSignal): string {
  switch (signal.type) {
    case "conflict": return "听起来你内心很矛盾";
    case "uncertainty": return "你好像也不太确定";
    case "frustration": return "这确实让人很疲惫";
    case "regret": return "你似乎有些遗憾";
    case "hope": return "你对此是有期待的";
  }
}

// 矛盾检测（简化版）
interface Contradiction {
  previous: string;
  current: string;
}

function detectContradiction(text: string): Contradiction | null {
  // 检测"但是"、"不过"、"可是"后面的内容
  const butMatch = text.match(/(?:但是|不过|可是|然而|却)\s*(.{4,20}?)(?:[，。！？]|$)/);
  if (!butMatch) return null;

  // 简单启发式：如果"但是"前面有肯定性表述
  const beforeBut = text.substring(0, text.indexOf(butMatch[0]));
  const positivePatterns = [/我觉得.{2,10}是/, /我认为/, /应该是/, /肯定是/, /一直是/];
  for (const pattern of positivePatterns) {
    const match = beforeBut.match(pattern);
    if (match) {
      return {
        previous: match[0].substring(0, 12),
        current: butMatch[1].substring(0, 12)
      };
    }
  }
  return null;
}
```

**改动 2：修改 `buildRealtimeTurnState`，集成引导决策（~15 行改动）**

```typescript
// 当前函数（行 5868-5910）需要改为：

export function buildRealtimeTurnState(
  session: InterviewSession,
  signal: RealtimeSignal,
  guidanceCtx?: {
    partialTranscript?: string;
    finalTranscript?: string;
    guidanceCountThisTurn?: number;
    lastGuidanceTimestamp?: string | null;
  }
): RealtimeTurnState {
  const silenceHoldMs = Math.max(300, session.enginePolicy?.silenceHoldMs ?? 1200);
  const guidanceEnabled = session.enginePolicy?.guidanceEnabled ?? true;

  // 打断判断（保持不变）
  if (signal.isAssistantSpeaking && (signal.isUserSpeaking || signal.inputLevel > 0.2)) {
    return {
      phase: "listening",
      nextAction: "用户开口打断，停止输出，把控制权还给用户。",
      shouldInterrupt: true,
      confidence: Math.min(1, signal.inputLevel + 0.35)
    };
  }

  if (signal.isUserSpeaking || signal.inputLevel > 0.2) {
    return {
      phase: "listening",
      nextAction: "持续听用户说完，不抢话。",
      shouldInterrupt: false,
      confidence: Math.min(1, signal.inputLevel + 0.2)
    };
  }

  // 引导判断（新增）
  if (guidanceEnabled && guidanceCtx && signal.silenceMs >= 400 && signal.silenceMs < silenceHoldMs) {
    const budget = {
      maxPerTurn: session.enginePolicy?.maxGuidancePerTurn ?? 2,
      minIntervalMs: session.enginePolicy?.minGuidanceIntervalMs ?? 5000,
      challengeBudget: session.enginePolicy?.challengeBudgetPerSession ?? 3,
      challengeUsed: 0 // 由上层维护
    };

    const guidance = evaluateGuidance({
      partialTranscript: guidanceCtx.partialTranscript ?? "",
      finalTranscript: guidanceCtx.finalTranscript ?? "",
      silenceMs: signal.silenceMs,
      isUserSpeaking: signal.isUserSpeaking,
      isAssistantSpeaking: signal.isAssistantSpeaking ?? false,
      turnCount: session.turns.length,
      guidanceCountThisTurn: guidanceCtx.guidanceCountThisTurn ?? 0,
      lastGuidanceTimestamp: guidanceCtx.lastGuidanceTimestamp ?? null,
      blindspotCandidates: session.guide?.blindspotCandidates ?? [],
      recentAnchorWords: [],
      guidanceBudget: budget
    });

    if (guidance) {
      return {
        phase: "holding",
        nextAction: `引导：${guidance.text}`,
        backchannel: guidance.text,
        shouldInterrupt: false,
        confidence: guidance.confidence,
        guidance
      };
    }
  }

  // 留白判断（保持不变）
  if (signal.silenceMs < silenceHoldMs) {
    const shouldBackchannel = signal.silenceMs >= Math.min(700, Math.round(silenceHoldMs * 0.6));
    return {
      phase: "holding",
      nextAction: `保持留白，等待用户自然补完。当前阈值 ${silenceHoldMs}ms。`,
      backchannel: shouldBackchannel ? "嗯，我在听。" : undefined,
      shouldInterrupt: false,
      confidence: 0.72
    };
  }

  // 后续逻辑保持不变
  if (session.turns.length === 0) {
    return {
      phase: "speaking",
      nextAction: session.card.suggestedOpening,
      shouldInterrupt: false,
      confidence: 0.82
    };
  }

  return {
    phase: "thinking",
    nextAction: "先镜像用户刚才的锚点，再提出一个追问。",
    shouldInterrupt: false,
    confidence: 0.8
  };
}
```

**改动 3：修改 `buildRealtimeVoiceInstructions`，增加引导策略说明（~5 行）**

```typescript
// 在现有 instructions 数组末尾增加（行 507-543 之后）：
export function buildRealtimeVoiceInstructions(session: InterviewSession | null, fallbackCard?: InterviewCard) {
  // ... 现有逻辑保持不变 ...
  const guidanceEnabled = session?.enginePolicy?.guidanceEnabled ?? true;
  const guidanceFreq = session?.enginePolicy?.guidanceFrequency ?? "medium";

  return [
    // ... 现有内容 ...
    guidanceEnabled ? [
      "主动引导规则：",
      "- 用户在思考停顿时（400-1200ms），用简短话语轻推，如'嗯'、'然后呢？'",
      "- 用户提到模糊概念时（'那个东西'、'这个决定'），追问具体含义",
      "- 用户表达矛盾情绪时，先标记情感再追问",
      guidanceFreq === "high"
        ? "- 引导频率：高 — 积极介入，发现锚点即追问"
        : guidanceFreq === "low"
          ? "- 引导频率：低 — 仅在明显模糊或矛盾时介入"
          : "- 引导频率：中 — 在关键锚点和情感信号处介入",
      "- 引导不等于打断：引导后用户应继续说，而非停止",
      "- 每轮引导不超过2次，间隔不少于5秒"
    ].join("\n") : "",
    // ... 现有结尾 ...
  ].filter(Boolean).join("\n");
}
```

**改动 4：修改 `buildInterviewEnginePolicy`，增加引导配置（~5 行）**

```typescript
// 行 495-505：
export function buildInterviewEnginePolicy(state: ProductState): InterviewEnginePolicy {
  return {
    allowWebInInterview: state.systemConfig.search.allowWebInInterview,
    maxFollowUpDepth: state.systemConfig.interview.maxFollowUpDepth,
    silenceHoldMs: state.systemConfig.interview.silenceHoldMs,
    playbookVersion: state.systemConfig.interview.playbookVersion,
    appliedPlaybookRules: collectAppliedPlaybookRules(state),
    qualityGuardrails: buildQualityGuardrails(state),
    memory: { ...state.systemConfig.memory },
    // 新增：
    guidanceEnabled: state.systemConfig.interview.guidanceEnabled ?? true,
    guidanceFrequency: state.systemConfig.interview.guidanceFrequency ?? "medium",
    maxGuidancePerTurn: state.systemConfig.interview.maxGuidancePerTurn ?? 2,
    minGuidanceIntervalMs: state.systemConfig.interview.minGuidanceIntervalMs ?? 5000,
    challengeBudgetPerSession: state.systemConfig.interview.challengeBudgetPerSession ?? 3,
  };
}
```

**改动 5：修改 `appendRealtimeSignalTrace`，记录引导事件（~5 行）**

```typescript
// 行 3440-3470，在 trace 对象中增加：
const trace: RealtimeSessionSignal = {
  // ... 现有字段 ...
  // 新增：
  ...(realtimeState.guidance ? {
    guidanceKind: realtimeState.guidance.kind,
    guidanceText: realtimeState.guidance.text,
    guidanceAnchor: realtimeState.guidance.anchor,
  } : {}),
};
```

**改动 6：修改 `formatRealtimeSignalTrace`，增加引导事件标签（~5 行）**

```typescript
// 行 3563 之后，在 labels 对象中增加：
const labels: Record<RealtimeSessionSignal["eventType"], string> = {
  // ... 现有 labels ...
  guidance_triggered: "引导触发",
  guidance_delivered: "引导送达",
};
```

---

## 3. Turn Detector 层改动

### 3.1 `src/realtime/turnDetectors/types.ts` — 扩展决策类型

```typescript
// 当前（行 7）：
export type TurnDetectorDecisionKind = "continue" | "end_of_turn" | "interruption";

// 改为：
export type TurnDetectorDecisionKind = "continue" | "end_of_turn" | "interruption" | "guidance";

// 扩展 TurnDetectorDecision：
export interface TurnDetectorDecision {
  decision: TurnDetectorDecisionKind;
  confidence: number;
  reason: string;
  // 新增：
  guidance?: {
    kind: GuidanceKind;
    text: string;
    anchor?: string;
  };
}
```

### 3.2 `src/realtime/turnDetectors/silenceVadDetector.ts` — 增加引导判定

```typescript
// 在 evaluate 方法中，`end_of_turn` 判定之前增加引导判定：
evaluate(ctx: TurnDetectorContext): TurnDetectorDecision {
  const userActive = ctx.inputLevel > inputLevelThreshold || ctx.isUserSpeaking;

  if (userActive && ctx.isAssistantSpeaking) {
    return {
      decision: "interruption",
      confidence: clampConfidence(ctx.inputLevel + 0.4),
      reason: "用户在 agent 说话期间发声，判定为打断"
    };
  }

  if (userActive) {
    return {
      decision: "continue",
      confidence: clampConfidence(ctx.inputLevel + 0.2),
      reason: "检测到用户正在说话"
    };
  }

  // 新增：引导判定 — 中等停顿（400-800ms），可能是思考停顿
  if (ctx.silenceMs >= 400 && ctx.silenceMs < 800 && !ctx.isAssistantSpeaking) {
    return {
      decision: "guidance",
      confidence: 0.55,
      reason: `静默 ${ctx.silenceMs}ms 处于引导窗口，可轻推`,
      guidance: {
        kind: "nudge",
        text: "嗯",
        anchor: undefined
      }
    };
  }

  if (ctx.silenceMs >= options.longPauseThresholdMs) {
    return {
      decision: "end_of_turn",
      confidence: 0.85,
      reason: `静默 ${ctx.silenceMs}ms 超过长停顿阈值`
    };
  }

  if (ctx.silenceMs >= options.silenceThresholdMs) {
    return {
      decision: "continue",
      confidence: 0.45,
      reason: `静默 ${ctx.silenceMs}ms 处于短停顿区间`
    };
  }

  return {
    decision: "continue",
    confidence: 0.2,
    reason: "短停顿或静默尚未达到判定阈值"
  };
}
```

---

## 4. 状态机层改动

### 4.1 `src/realtime/bailianWebrtc.ts` — 扩展 TurnState

```typescript
// 行 6-15，扩展 TurnPhase 和 TurnState：
export type TurnPhase = "idle" | "user_speaking" | "short_pause" | "long_pause"
  | "assistant_speaking" | "interrupted" | "guidance";  // 新增 guidance

export interface TurnState {
  phase: TurnPhase;
  silenceMs: number;
  isUserSpeaking: boolean;
  isAssistantSpeaking: boolean;
  shouldInterrupt: boolean;
  backchannel: string | null;
  detectorId?: string;
  detectorReason?: string;
  detectorConfidence?: number;
  detectorDecision?: TurnDetectorDecision["decision"];
  // 新增：
  guidance?: {
    kind: GuidanceKind;
    text: string;
    anchor?: string;
  };
}
```

**修改 `createTurnStateMachine` 中的 `update` 方法**：

```typescript
// 在 phase 判定逻辑中增加：
if (lastDecision?.decision === "guidance") {
  phase = "guidance";
} else if (isUserSpeaking && isAssistantSpeaking) {
  phase = "interrupted";
} else if (isUserSpeaking) {
  // ... 保持不变
}

// buildState 中增加：
return {
  // ... 现有字段 ...
  guidance: lastDecision?.guidance,
};
```

---

## 5. 前端层改动

### 5.1 `src/App.tsx` — 增加引导状态管理（~30 行）

```typescript
// 新增状态（在现有 useState 之后）：
const [guidanceState, setGuidanceState] = useState<{
  active: boolean;
  kind: string | null;
  text: string | null;
  countThisTurn: number;
  lastTimestamp: string | null;
}>({
  active: false,
  kind: null,
  text: null,
  countThisTurn: 0,
  lastTimestamp: null
});

// 修改 realtimeState 的 useMemo（行 235-244）：
const realtimeState = useMemo(
  () =>
    session
      ? buildRealtimeTurnState(session, {
          inputLevel: recording ? audioLevel : 0.02,
          silenceMs: recording ? 0 : 900,
          isUserSpeaking: recording,
          isAssistantSpeaking: voiceStatus === "speaking"
        }, {
          // 新增：传入引导上下文
          partialTranscript: liveUserTranscript,
          guidanceCountThisTurn: guidanceState.countThisTurn,
          lastGuidanceTimestamp: guidanceState.lastTimestamp
        })
      : null,
  [recording, session, audioLevel, voiceStatus, liveUserTranscript, guidanceState]
);

// 新增：引导触发时的副作用
useEffect(() => {
  if (realtimeState?.guidance && !guidanceState.active) {
    setGuidanceState(prev => ({
      active: true,
      kind: realtimeState.guidance!.kind,
      text: realtimeState.guidance!.text,
      countThisTurn: prev.countThisTurn + 1,
      lastTimestamp: new Date().toISOString()
    }));

    // 引导展示 2 秒后自动清除
    const timer = setTimeout(() => {
      setGuidanceState(prev => ({ ...prev, active: false }));
    }, 2000);

    return () => clearTimeout(timer);
  }
}, [realtimeState?.guidance]);

// 新增：用户开始新轮时重置引导计数
useEffect(() => {
  if (voiceStatus === "listening" && !realtimeState?.shouldInterrupt) {
    setGuidanceState(prev => ({
      ...prev,
      countThisTurn: 0,
      active: false
    }));
  }
}, [voiceStatus]);

// 修改 interruptAssistant，重置引导计数：
async function interruptAssistant() {
  // ... 现有逻辑 ...
  setGuidanceState(prev => ({
    ...prev,
    countThisTurn: 0,
    active: false
  }));
}

// 在 InterviewView 的 props 中增加：
<InterviewView
  // ... 现有 props ...
  guidanceState={guidanceState}
/>
```

### 5.2 `src/features/interview/InterviewView.tsx` — 引导 UI（~25 行）

```typescript
// 扩展 props：
interface InterviewViewProps {
  // ... 现有 props ...
  guidanceState?: {
    active: boolean;
    kind: string | null;
    text: string | null;
    countThisTurn: number;
  };
}

// 在 voice-panel 区域增加引导指示器（在 live-transcript 之后）：
{guidanceState?.active && guidanceState.text && (
  <div className="guidance-indicator" aria-live="polite">
    <span className="guidance-badge">
      {guidanceState.kind === "anchor_probe" ? "追问锚点" :
       guidanceState.kind === "emotion_label" ? "情感标记" :
       guidanceState.kind === "contradiction" ? "发现矛盾" :
       guidanceState.kind === "nudge" ? "轻推" :
       guidanceState.kind === "echo" ? "回音" : "引导"}
    </span>
    <p className="guidance-text">{guidanceState.text}</p>
  </div>
)}

// 修改 voice-status-label，增加引导状态：
{voiceStatus === "speaking" && guidanceState?.active && (
  <><span className="status-dot guidance" />引导中</>
)}
```

### 5.3 `src/styles.css` — 引导样式（~20 行）

```css
/* 引导指示器 */
.guidance-indicator {
  margin-top: 8px;
  padding: 8px 12px;
  background: rgba(99, 102, 241, 0.08);
  border-left: 3px solid #6366f1;
  border-radius: 4px;
  animation: guidanceFadeIn 0.3s ease-out;
}

.guidance-badge {
  font-size: 11px;
  font-weight: 600;
  color: #6366f1;
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.guidance-text {
  margin: 4px 0 0;
  font-size: 14px;
  color: #e2e8f0;
  font-style: italic;
}

.status-dot.guidance {
  background: #6366f1;
  animation: guidancePulse 1.5s ease-in-out infinite;
}

@keyframes guidanceFadeIn {
  from { opacity: 0; transform: translateY(-4px); }
  to { opacity: 1; transform: translateY(0); }
}

@keyframes guidancePulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.5; }
}
```

### 5.4 `src/features/config/ConfigView.tsx` — 引导配置项（~15 行）

在配置页面的"专访"区域增加：

```tsx
{/* 引导配置 */}
<ConfigSection title="主动引导">
  <ConfigToggle
    label="启用主动引导"
    description="在用户思考停顿时用简短话语轻推，帮助用户把问题说深"
    checked={config.interview.guidanceEnabled}
    onChange={(v) => updateConfig("interview.guidanceEnabled", v)}
  />
  <ConfigSelect
    label="引导频率"
    options={[
      { value: "low", label: "低 — 仅在明显模糊或矛盾时介入" },
      { value: "medium", label: "中 — 在关键锚点和情感信号处介入" },
      { value: "high", label: "高 — 积极介入，发现锚点即追问" },
    ]}
    value={config.interview.guidanceFrequency}
    onChange={(v) => updateConfig("interview.guidanceFrequency", v)}
  />
</ConfigSection>
```

---

## 6. 类型层补充

### 6.1 `src/domain/types.ts` — 扩展 InterviewEnginePolicy

```typescript
// 在 InterviewEnginePolicy 接口中增加（找到该接口定义）：
export interface InterviewEnginePolicy {
  allowWebInInterview: boolean;
  maxFollowUpDepth: number;
  silenceHoldMs: number;
  playbookVersion: string;
  appliedPlaybookRules: string[];
  qualityGuardrails: string[];
  memory: { /* ... */ };
  // 新增：
  guidanceEnabled: boolean;
  guidanceFrequency: "low" | "medium" | "high";
  maxGuidancePerTurn: number;
  minGuidanceIntervalMs: number;
  challengeBudgetPerSession: number;
}
```

---

## 7. 测试计划

### 7.1 单元测试：`src/domain/engine.test.ts`

```typescript
// 新增测试用例：
describe("evaluateGuidance", () => {
  it("在 600ms 静默时返回轻推引导", () => {
    const result = evaluateGuidance({
      partialTranscript: "我觉得这个项目...",
      finalTranscript: "",
      silenceMs: 600,
      isUserSpeaking: false,
      isAssistantSpeaking: false,
      turnCount: 1,
      guidanceCountThisTurn: 0,
      lastGuidanceTimestamp: null,
      blindspotCandidates: [],
      recentAnchorWords: [],
      guidanceBudget: {
        maxPerTurn: 2,
        minIntervalMs: 5000,
        challengeBudget: 3,
        challengeUsed: 0
      }
    });
    expect(result?.kind).toBe("nudge");
    expect(result?.text).toBe("嗯");
  });

  it("检测到模糊锚点时返回 anchor_probe", () => {
    const result = evaluateGuidance({
      partialTranscript: "就是那个东西一直困扰我",
      finalTranscript: "就是那个东西一直困扰我",
      silenceMs: 500,
      isUserSpeaking: false,
      isAssistantSpeaking: false,
      turnCount: 1,
      guidanceCountThisTurn: 0,
      lastGuidanceTimestamp: null,
      blindspotCandidates: [],
      recentAnchorWords: [],
      guidanceBudget: {
        maxPerTurn: 2,
        minIntervalMs: 5000,
        challengeBudget: 3,
        challengeUsed: 0
      }
    });
    expect(result?.kind).toBe("anchor_probe");
    expect(result?.anchor).toBe("那个东西");
  });

  it("超过每轮引导上限时不返回引导", () => {
    const result = evaluateGuidance({
      partialTranscript: "我觉得...",
      finalTranscript: "",
      silenceMs: 600,
      isUserSpeaking: false,
      isAssistantSpeaking: false,
      turnCount: 1,
      guidanceCountThisTurn: 2, // 已达上限
      lastGuidanceTimestamp: null,
      blindspotCandidates: [],
      recentAnchorWords: [],
      guidanceBudget: {
        maxPerTurn: 2,
        minIntervalMs: 5000,
        challengeBudget: 3,
        challengeUsed: 0
      }
    });
    expect(result).toBeNull();
  });

  it("间隔不足时不返回引导", () => {
    const result = evaluateGuidance({
      partialTranscript: "我觉得...",
      finalTranscript: "",
      silenceMs: 600,
      isUserSpeaking: false,
      isAssistantSpeaking: false,
      turnCount: 1,
      guidanceCountThisTurn: 0,
      lastGuidanceTimestamp: new Date().toISOString(), // 刚刚引导过
      blindspotCandidates: [],
      recentAnchorWords: [],
      guidanceBudget: {
        maxPerTurn: 2,
        minIntervalMs: 5000,
        challengeBudget: 3,
        challengeUsed: 0
      }
    });
    expect(result).toBeNull();
  });
});
```

### 7.2 单元测试：`src/realtime/turnDetectors/silenceVadDetector.test.ts`

```typescript
// 新增测试用例：
it("在 400-800ms 静默且 agent 不在说话时返回 guidance", () => {
  const detector = createSilenceVadDetector({
    silenceThresholdMs: 800,
    longPauseThresholdMs: 1500
  });
  const result = detector.evaluate({
    inputLevel: 0.05,
    silenceMs: 500,
    isUserSpeaking: false,
    isAssistantSpeaking: false
  });
  expect(result.decision).toBe("guidance");
  expect(result.guidance?.kind).toBe("nudge");
});
```

---

## 8. 实施顺序

### Day 1：类型层 + 引擎层（2-3 小时）

1. `src/domain/types.ts` — 扩展 `RealtimeTurnState`、`RealtimeSessionSignal`、`RealtimeSessionEventType`、`SystemConfig.interview`、`InterviewEnginePolicy`
2. `src/domain/engine.ts` — 新增 `evaluateGuidance`、`detectVagueAnchor`、`detectEmotionSignal`、`detectContradiction`；修改 `buildRealtimeTurnState`、`buildRealtimeVoiceInstructions`、`buildInterviewEnginePolicy`、`appendRealtimeSignalTrace`、`formatRealtimeSignalTrace`
3. `src/realtime/turnDetectors/types.ts` — 扩展 `TurnDetectorDecisionKind`、`TurnDetectorDecision`
4. `src/realtime/turnDetectors/silenceVadDetector.ts` — 增加 guidance 判定

### Day 2：状态机 + 前端（2-3 小时）

5. `src/realtime/bailianWebrtc.ts` — 扩展 `TurnPhase`、`TurnState`、`createTurnStateMachine`
6. `src/App.tsx` — 增加 `guidanceState`、修改 `realtimeState` useMemo、增加 useEffect
7. `src/features/interview/InterviewView.tsx` — 增加引导 UI
8. `src/styles.css` — 增加引导样式
9. `src/features/config/ConfigView.tsx` — 增加引导配置项

### Day 3：测试 + 验证（1-2 小时）

10. `src/domain/engine.test.ts` — 新增 evaluateGuidance 测试
11. `src/realtime/turnDetectors/silenceVadDetector.test.ts` — 新增 guidance 测试
12. `npm test -- --run` — 全量测试
13. `npm run build` — 构建验证

---

## 9. 验收标准

- [ ] `npm test -- --run` 全部通过（现有 223 用例 + 新增 ~10 用例）
- [ ] `npm run build` 构建通过
- [ ] 配置页可开关引导功能
- [ ] 配置页可调整引导频率（低/中/高）
- [ ] 专访中用户停顿时，前端显示引导指示器
- [ ] 引导不触发打断（shouldInterrupt 为 false）
- [ ] 每轮引导不超过配置上限
- [ ] 两次引导间隔不少于配置值
- [ ] 引导事件记录在 realtimeSignals trace 中
- [ ] 关闭引导后行为与当前版本一致（向后兼容）

---

## 10. 文件改动清单

```
src/domain/types.ts                              # +30 行（类型扩展）
src/domain/engine.ts                             # +150 行（evaluateGuidance + 集成）
src/domain/engine.test.ts                        # +60 行（新增测试）
src/realtime/turnDetectors/types.ts              # +10 行（扩展决策类型）
src/realtime/turnDetectors/silenceVadDetector.ts # +10 行（guidance 判定）
src/realtime/turnDetectors/silenceVadDetector.test.ts # +15 行（新增测试）
src/realtime/bailianWebrtc.ts                    # +15 行（扩展状态机）
src/App.tsx                                      # +35 行（引导状态管理）
src/features/interview/InterviewView.tsx         # +25 行（引导 UI）
src/features/config/ConfigView.tsx               # +15 行（引导配置）
src/styles.css                                   # +20 行（引导样式）
```

**总计：约 385 行新增/改动，零文件删除，完全向后兼容。**
