# 表达状态感知 + 统一交互意图引擎 设计文档

> 日期：2026-06-14
> 定位：用"表达状态感知 + LLM 深度预判"替代当前的"关键词匹配 + 规则打断"，实现全双工双向交互

---

## 0. 问题诊断

当前系统存在三个根本性问题：

### 0.1 引导是关键词匹配，不是语义理解

```
当前：用户说"那个东西" → 触发 anchor_probe
问题：用户流畅表达中说了"那个东西"也会触发，打断表达流
根因：没有区分"表达状态"，把关键词当成触发条件
```

### 0.2 打断是音量判断，不是意图理解

```
当前：用户在 AI 说话时发出声音 → 打断
问题：用户说"嗯"（backchannel）也会打断，用户咳嗽也会打断
根因：没有区分 backchannel、打断、噪音
```

### 0.3 回合制思维，不是全双工

```
当前：用户说完 → AI 分析 → AI 回复 → 循环
问题：引导和打断只能在"用户说完后"发生，不能在"用户说话中"发生
根因：架构设计是回合制的，不是持续感知的
```

---

## 1. 设计目标

### 1.1 核心目标

将引导和打断从"关键词/音量触发"升级为"表达状态感知 + 内容价值判断"。

### 1.2 具体目标

1. **表达状态感知**：区分流畅、组织、犹豫、绕圈、情绪、收尾六种状态
2. **内容价值判断**：LLM 基于完整上下文预判"下一轮最值得深挖的方向"
3. **双向交互统一**：同一套引擎处理"AI 引导用户"和"用户打断 AI"
4. **全双工**：用户说话中持续感知，在自然间隙干预
5. **向后兼容**：LLM 无预判时回退规则引擎

### 1.3 非目标

- 不做实时 LLM 调用（延迟不可接受）
- 不做端到端韵律模型（引入额外复杂度）
- 不做语音情感识别（超出当前范围）

---

## 2. 架构设计

### 2.1 三层架构

```
┌──────────────────────────────────────────────────────────────┐
│                    全双工交互架构                              │
│                                                               │
│  ═══════════════ 离线层（每轮一次）═══════════════              │
│  LLM 调用                                                     │
│    输入：完整对话历史 + 盲区 + 知识债 + 策略 + 观点演变        │
│    输出：追问回复 + <pre_signals> 块                           │
│                                                               │
│  ═══════════════ 实时层（每 100ms）═══════════════             │
│  ExpressionStateDetector                                      │
│    输入：韵律 + 停顿 + 填充信号 + 重复                         │
│    输出：ExpressionState（fluent/organizing/hesitating/...）   │
│                                                               │
│  InteractionIntentEngine                                      │
│    输入：ExpressionState + preSignals + 位置信息               │
│    输出：IntentDecision（backchannel/guidance/interruption）   │
└──────────────────────────────────────────────────────────────┘
```

### 2.2 数据流

```
AI 说完追问
  │
  ├── LLM 生成 preSignals（存入 session）
  │
  ▼
用户开始说话 ──────────────────────────────────────→
  │
  ▼ (每 100ms)
ExpressionStateDetector.evaluate()
  │
  ├── fluent → 不干预
  ├── organizing → 不干预（用户在组织语言）
  ├── concluding → 不干预（等话轮结束）
  │
  ├── hesitating → InteractionIntentEngine.evaluate()
  │     └── 有 preSignals.depthDirection → 触发 guidance
  │
  ├── circling → InteractionIntentEngine.evaluate()
  │     └── 触发 mini_summary
  │
  └── emotional → InteractionIntentEngine.evaluate()
        └── 触发 emotion_label

AI 说话中，用户发出声音
  │
  ▼
InteractionIntentEngine.evaluate()
  ├── 匹配 backchannel 白名单 → backchannel，AI 继续
  ├── 匹配 interrupt 触发词 → interruption，AI 停止
  └── 长句 → 根据 sensitivity 决定
```

---

## 3. 类型定义

### 3.1 ExpressionState

```typescript
type ExpressionState =
  | "fluent"           // 流畅表达：语速稳定，停顿在语法边界
  | "organizing"       // 组织语言：有填充停顿（"嗯..."），无模糊词
  | "hesitating"       // 犹豫：异常停顿 + 模糊词/重复/错误启动
  | "circling"         // 绕圈：同一观点重复 2+ 次
  | "emotional"        // 情绪化：情感词汇 + 韵律变化
  | "concluding";      // 收尾：末尾延长 + 音高下降 + 长停顿
```

### 3.2 DepthDirection（LLM 预判）

```typescript
interface DepthDirection {
  /** LLM 判断下一轮最值得深挖的方向 */
  concept: string;
  /** 为什么值得深挖（基于盲区、知识债、策略） */
  reason: string;
  /** 引导话语（一句，邀请式） */
  guidance: string;
}
```

### 3.3 InteractionPreSignals（LLM 输出）

```typescript
interface InteractionPreSignals {
  /** 下一轮最值得深挖的方向（一条，不是多条） */
  depthDirection: DepthDirection | null;
  /** 用户说这些时不打断（backchannel 白名单） */
  backchannelWhitelist: string[];
  /** 用户说这些时立即停止 AI */
  interruptTriggers: string[];
  /** 打断敏感度 */
  interruptSensitivity: "low" | "medium" | "high";
}
```

### 3.4 IntentDecision（实时引擎输出）

```typescript
type InteractionIntent = "backchannel" | "guidance" | "interruption" | "noise";

interface IntentDecision {
  intent: InteractionIntent;
  confidence: number;
  action: "continue" | "nudge" | "stop" | "ignore";
  detail?: {
    kind?: GuidanceKind;
    text?: string;
    anchor?: string;
  };
}
```

### 3.5 扩展 InterviewSession

```typescript
// 在 InterviewSession 中增加：
interface InterviewSession {
  // ... 现有字段 ...
  interactionPreSignals?: InteractionPreSignals;
}
```

---

## 4. 组件设计

### 4.1 ExpressionStateDetector

**文件**：`src/realtime/expressionStateDetector.ts`

**职责**：基于韵律和语义特征判断用户的表达状态。

**输入**：

```typescript
interface ExpressionStateInput {
  // 韵律特征
  speechRate: number;           // 当前语速（字/秒）
  baselineSpeechRate: number;   // 基线语速
  energy: number;               // 音量 0-1
  baselineEnergy: number;       // 基线音量
  pitchTrend: "rising" | "falling" | "flat";

  // 停顿特征
  currentSilenceMs: number;
  pausePosition: "grammar_boundary" | "mid_clause" | "sentence_start";

  // 语义特征（从 ASR 部分转写提取）
  hasFilledPause: boolean;      // 有"嗯..."、"那个..."等
  hasRepetition: boolean;       // 有重复（"我...我觉得"）
  hasFalseStart: boolean;       // 有错误启动（"我觉得...不是..."）
  hasVagueTerm: boolean;        // 有模糊词（"那个东西"、"某种"）
  hasEmotionWord: boolean;      // 有情感词（"矛盾"、"烦"、"后悔"）

  // 历史特征
  samePointCount: number;       // 同一观点重复次数
  timeSinceLastGuidance: number; // 距上次引导 ms
}
```

**输出**：`ExpressionState`

**检测逻辑**：

```
fluent:
  语速 >= 0.8 × 基线语速
  AND 停顿 < 500ms
  AND 停顿位置 = 语法边界
  AND 无重复
  AND 无错误启动

organizing:
  有填充停顿
  AND 停顿 < 800ms
  AND 无模糊词
  AND 无重复

hesitating:
  (有模糊词 OR 有重复 OR 有错误启动)
  AND 停顿 >= 500ms
  AND 停顿位置 = 句中

circling:
  同一观点重复次数 >= 2

emotional:
  有情感词
  AND (能量 > 1.3 × 基线 OR 音高趋势 = 平坦)

concluding:
  音高趋势 = 下降
  AND 停顿 >= 800ms
```

**韵律基线学习**：在用户前 3 轮表达中学习基线语速和基线音量。

### 4.2 InteractionIntentEngine

**文件**：`src/realtime/interactionIntentEngine.ts`

**职责**：综合表达状态、LLM 预判信号、位置信息，输出交互意图。

**输入**：

```typescript
interface IntentEngineInput {
  expressionState: ExpressionState;
  preSignals: InteractionPreSignals | null;
  isAssistantSpeaking: boolean;
  partialTranscript: string;
  audioDuration: number;
  guidanceCountThisTurn: number;
  guidanceBudget: {
    maxPerTurn: number;
    minIntervalMs: number;
  };
}
```

**输出**：`IntentDecision`

**决策逻辑**：

```
═══════════ 用户在说话中（AI 在听）═══════════

expressionState = fluent / organizing / concluding
  → { intent: "backchannel", action: "continue" }
  （不干预，让用户继续表达）

expressionState = hesitating
  → 检查 preSignals.depthDirection
    有 → { intent: "guidance", action: "nudge", detail: depthDirection.guidance }
    无 → 检查引导预算
      有预算 → { intent: "guidance", action: "nudge", detail: "嗯" }
      无预算 → { intent: "backchannel", action: "continue" }

expressionState = circling
  → { intent: "guidance", action: "nudge", detail: "到目前为止，核心是..." }

expressionState = emotional
  → { intent: "guidance", action: "nudge", detail: 共情话语 }

═══════════ AI 在说话中（用户在听）═══════════

用户发出声音
  → audioDuration < 200ms AND energy < 阈值
    → { intent: "noise", action: "ignore" }

  → audioDuration < 500ms AND 匹配 backchannelWhitelist
    → { intent: "backchannel", action: "continue" }
    （AI 继续说话）

  → 匹配 interruptTriggers
    → { intent: "interruption", action: "stop" }

  → audioDuration > 1500ms（完整句子）
    → sensitivity = "high" → { intent: "interruption", action: "stop" }
    → sensitivity = "medium" AND duration > 2000ms → { intent: "interruption", action: "stop" }
    → sensitivity = "low" → { intent: "backchannel", action: "continue" }
```

### 4.3 LLM 预判信号生成

**位置**：`src/domain/engine.ts` 中的 `buildAssistantTurn`

**Prompt 扩展**：在现有 system prompt 末尾增加：

```
在回复末尾，用 <pre_signals>...</pre_signals> 输出交互预判信号：

<pre_signals>
depth_direction:
  concept: [基于盲区候选、知识债、策略追踪，判断下一轮最值得深挖的一个方向]
  reason: [为什么这个方向值得深挖]
  guidance: [一句邀请式引导话语，如"你刚才提到的X，能具体说说吗？"]
backchannel: [用户说这些时不打断，逗号分隔，如：嗯,对,是的,好]
interrupt: [用户说这些时立即停止，逗号分隔，如：不对,等一下,我打断一下]
sensitivity: [low/medium/high，基于话题重要性]
</pre_signals>

规则：
- depth_direction 只输出一条，是你认为最值得深挖的方向
- guidance 必须是邀请式，不能是断言式
- sensitivity 根据话题重要性：盲区/知识债=low，闲聊=high
- 如果当前没有明确的深挖方向，depth_direction 可以为空
```

**解析逻辑**：在 `buildAssistantTurn` 中解析 `<pre_signals>` 块，提取结构化数据存入 `session.interactionPreSignals`。

**规则 Fallback**：当 LLM 未输出 `<pre_signals>` 或解析失败时，使用规则引擎生成默认预判信号：

```typescript
function buildFallbackPreSignals(session: InterviewSession): InteractionPreSignals {
  return {
    depthDirection: session.guide.blindspotCandidates[0]
      ? {
          concept: session.guide.blindspotCandidates[0].concept,
          reason: session.guide.blindspotCandidates[0].reason,
          guidance: `你提到了${session.guide.blindspotCandidates[0].concept}，能具体说说吗？`
        }
      : null,
    backchannelWhitelist: ["嗯", "对", "是的", "好", "我明白"],
    interruptTriggers: ["不对", "不是", "等一下", "我打断一下", "停"],
    interruptSensitivity: "medium"
  };
}
```

---

## 5. 集成方案

### 5.1 与现有 Turn Detector 的关系

```
现有架构：
  silenceVadDetector → TurnStateMachine → buildRealtimeTurnState

升级后：
  ExpressionStateDetector → InteractionIntentEngine → TurnStateMachine → buildRealtimeTurnState
         ↑                          ↑
    韵律特征 + 语义特征        InteractionPreSignals（来自 LLM）
```

**TurnStateMachine 改动**：新增 `guidance` 和 `backchannel` 两种 phase，替代原有的简单 `interrupted` 判断。

### 5.2 与现有 guidanceEngine 的关系

`guidanceEngine.ts` 降级为 fallback：当 LLM 未生成 `InteractionPreSignals` 时使用。

### 5.3 前端改动

- `App.tsx`：新增韵律特征采集（语速、能量），传递给 ExpressionStateDetector
- `InterviewView.tsx`：引导指示器 UI 保持不变，增加 backchannel 状态显示
- `ConfigView.tsx`：引导配置保持不变

---

## 6. 文件改动清单

| 文件 | 操作 | 行数 |
|------|------|------|
| `src/domain/types.ts` | 修改：新增 ExpressionState、DepthDirection、InteractionPreSignals、IntentDecision | +50 |
| `src/realtime/expressionStateDetector.ts` | **新建**：表达状态感知引擎 | ~150 |
| `src/realtime/expressionStateDetector.test.ts` | **新建**：单元测试 | ~80 |
| `src/realtime/interactionIntentEngine.ts` | **新建**：统一交互意图引擎 | ~120 |
| `src/realtime/interactionIntentEngine.test.ts` | **新建**：单元测试 | ~80 |
| `src/domain/engine.ts` | 修改：buildAssistantTurn 输出 pre_signals；buildRealtimeTurnState 接入新引擎 | +60 |
| `src/realtime/bailianWebrtc.ts` | 修改：状态机接入意图引擎 | +20 |
| `src/App.tsx` | 修改：韵律特征采集 + 传递预判信号 | +30 |
| `src/domain/guidanceEngine.ts` | 保留：降级为 fallback | - |
| `src/domain/seed.ts` | 修改：默认配置 | +5 |

**总计**：~600 行新增，~115 行修改，4 个新文件。

---

## 7. 验收标准

### 7.1 表达状态感知

- [ ] 用户流畅表达时，系统识别为 `fluent`，不触发任何干预
- [ ] 用户组织语言时（"嗯..."），系统识别为 `organizing`，等待
- [ ] 用户犹豫时（模糊词 + 停顿），系统识别为 `hesitating`
- [ ] 用户绕圈时（同一观点重复），系统识别为 `circling`
- [ ] 用户情绪化时，系统识别为 `emotional`
- [ ] 用户收尾时（音高下降 + 长停顿），系统识别为 `concluding`

### 7.2 引导触发

- [ ] `hesitating` + 有 depthDirection → 触发 LLM 预生成的引导话语
- [ ] `circling` → 触发阶段总结
- [ ] `emotional` → 触发共情标记
- [ ] `fluent` / `organizing` / `concluding` → 不触发引导
- [ ] 两次引导间隔 >= 5 秒
- [ ] 每轮引导 <= 2 次

### 7.3 打断升级

- [ ] 用户说 backchannel 白名单中的词 → AI 不停止
- [ ] 用户说 interrupt 触发词 → AI 立即停止
- [ ] 用户说完整句子 + sensitivity=high → AI 停止
- [ ] 用户说完整句子 + sensitivity=low → AI 继续
- [ ] 噪音（< 200ms + 低音量）→ 忽略

### 7.4 LLM 预判

- [ ] LLM 每轮输出 `<pre_signals>` 块
- [ ] depthDirection 基于盲区、知识债、策略生成
- [ ] guidance 是邀请式话语
- [ ] LLM 无输出时回退规则引擎

### 7.5 向后兼容

- [ ] 关闭引导功能后行为与当前版本一致
- [ ] 现有测试全部通过
- [ ] `npm run build` 构建通过

---

## 8. 自审

- [x] 无 TBD/TODO/占位符
- [x] 类型定义完整，接口一致
- [x] 范围聚焦：只做表达状态感知 + 意图引擎，不做 TTS 注入、不做实时 LLM
- [x] 无歧义：每个 ExpressionState 有明确的检测条件
