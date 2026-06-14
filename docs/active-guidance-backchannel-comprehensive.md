# 语音专访中的主动引导（Active Guidance）全网最全解决方案

> 版本：v1.0
> 日期：2026-06-14
> 定位：将"附和"升级为与"打断"同级别的主动引导能力——在用户说话过程中，用简短话语或逻辑进行引导，推动用户把问题说深。

---

## 0. 核心结论

**附和（backchannel）不是被动回应，而是和打断（interruption）同级别的主动引导能力。**

两者的本质区别：

| 维度 | 打断（Interruption） | 引导（Active Guidance） |
|------|---------------------|------------------------|
| 目的 | 夺回话语权，纠正方向 | 推动用户说更深，不夺权 |
| 时机 | 用户说话中，AI 需要切换话题 | 用户说话中，AI 发现深化锚点 |
| 话语长度 | 完整句子 | 1-8 个字 |
| 效果 | 用户停止，AI 接话 | 用户继续说，但方向被微调 |
| 风险 | 破坏表达流 | 被误解为敷衍 |
| 信号 | 强制中断 | 轻推（nudge） |

**本方案的核心主张：引导不是附和的增强版，而是和打断并列的另一种主动干预手段。两者共同构成"AI 在用户说话时的干预光谱"。**

---

## 1. 全网知识图谱

### 1.1 对话分析学（Conversation Analysis）

#### 1.1.1 Schegloff 的 Turn-Taking 模型（1974）

Sacks, Schegloff & Jefferson 在 *"A Simplest Systematics for the Organization of Turn-Taking for Conversation"* 中定义了对话轮次的基本规则：

- **TRP（Transition Relevance Place）**：话轮转换相关位置，即当前说话者可能结束的位置
- **Backchannel（反馈项）**：不构成话轮抢夺的简短回应，如 "mm-hmm"、"yeah"、"right"
- **Continuers（延续信号）**：明确表示"请继续"的 backchannel，如 "uh huh"、"go on"

**关键洞察**：Backchannel 和 Turn-taking 处于同一套规则体系下。一个 backchannel 如果时机不对、内容不对，就可能变成 interruption。

#### 1.1.2 Yngve（1970）的 Backchannel 分类

Yngve 最早提出 "back channel" 概念，将其分为：

1. **简短反馈（Brief acknowledgments）**："mm"、"yeah"、"right"
2. **完成型（Completions）**：帮对方说完句子
3. **请求澄清（Clarification requests）**："什么意思？"
4. **简短评估（Brief assessments）**："有意思"、"这很重要"
5. **重述（Restatements）**：用自己话说一遍

#### 1.1.3 Goodwin（1986）的"参与框架"

Goodwin 指出 backchannel 不仅是信号，更是**参与框架（participation framework）**的体现。听者的 backchannel 时刻在告诉说者："我在听"、"我理解"、"我感兴趣"、"我不同意"。

**对专访的启示**：AI 的引导不只是技术问题，更是"关系建立"问题。用户需要感受到 AI 在认真听、在思考、在推动。

#### 1.1.4 Gardner（2001）的回应词研究

Gardner 在 *"When Listeners Talk"* 中系统研究了英语中的回应词：

- **Continuers（延续）**：mm hm, uh huh → "继续说"
- **Acknowledgments（确认）**：yeah, right → "我听到了"
- **Newsmarkers（新闻标记）**：really?, oh → "这有意思"
- **Change-of-activity tokens（活动转换）**：okay, right → "我明白了，下一个"
- **Assessments（评估）**：great, interesting → "这很好/有趣"

**每种回应词都承载不同的交互意图，专访 AI 需要精确选择。**

#### 1.1.5 Stivers（2008）的跨语言比较

Stivers 比较了 10 种语言中的 backchannel 使用频率和功能，发现：

- 日语中 backchannel 频率最高（每 3-4 秒一次）
- 英语中频率较低（每 10-15 秒一次）
- 中文中 backchannel 频率介于两者之间
- **所有语言中，backchannel 的核心功能都是"我在听"和"请继续"**

**对中文专访的启示**：中文的 backchannel 频率应适中，不能像日语那样高频（会被认为打断），也不能像英语那样低频（会被认为冷漠）。

---

### 1.2 语音 AI 中的主动引导技术

#### 1.2.1 Google Duplex / Google Assistant（2018-2024）

Google 在 Duplex 和后续的语音助手中实现了自然语言 backchannel：

- **"mm-hmm" 和 "uh-huh"** 的自然语音合成
- **基于韵律（prosody）的时机判断**：在用户语调下降、语速变慢时插入
- **"Speaking rate adaptation"**：根据用户语速调整 backchannel 频率

**核心技术**：
- 端到端 TTS 模型支持非词汇语音（non-lexical sounds）
- 实时韵律分析（pitch, energy, speech rate）
- 基于 Transformer 的 turn-taking 预测

**论文参考**：
- "Towards Conversational AI with Natural Speech Patterns" (Google, 2022)
- "TurnGPT: A Transformer-based Language Model for Predicting Turn-taking" (2021)

#### 1.2.2 OpenAI Realtime API（2024）

OpenAI 的 Realtime API 提供了多模态语音交互能力：

- **VAD（Voice Activity Detection）**：检测用户是否在说话
- **Turn detection**：判断用户是否说完
- **Semantic turn detection**：基于语义判断话轮边界
- **Interruption handling**：用户说话时自动停止 AI 输出

**但缺少**：精细化的 backchannel 策略。当前只能做"打断"或"不打断"的二元判断。

**对专访的启示**：需要在 Realtime API 基础上叠加一层 backchannel 决策层。

#### 1.2.3 LiveKit Agents（2024）

LiveKit Agents 是目前最成熟的语音 Agent 框架之一：

- **Multilingual Turn Detector**：基于语义的多语言话轮检测
- **AgentState 管理**：`listening`、`thinking`、`speaking` 三态
- **`agent_state_changed` 事件**：可监听状态变化
- **`should_interrupt` 标志**：可自定义打断逻辑

**关键能力**：
- `TurnHandlingOptions` 支持自定义 turn detection 模型
- `before_llm_callback` 可在 LLM 推理前注入上下文
- 支持 `function_tool` 在对话中调用外部工具

**对专访的启示**：LiveKit 的 Agent 架构天然支持"在用户说话时做判断"，但 backchannel 策略需要自定义实现。

#### 1.2.4 Deepgram / ElevenLabs（2024）

Deepgram 的语音 AI 平台提供了：

- **UtteranceEnd 和 UtteranceStart 事件**：精确的话轮边界
- **Interim results**：实时部分转写
- **Endpointing**：可配置的停顿阈值

ElevenLabs 的 Conversational AI：

- **Turn-taking 配置**：interruption sensitivity、response delay
- **Backchannel 支持**：可在 agent 说话时播放简短回应
- **Dynamic variables**：可注入实时上下文

#### 1.2.5 学术界最新进展

**TurnGPT（2021, Ekstedt & Skantze）**：
- 基于 GPT-2 的话轮预测模型
- 输入：对话历史和当前部分转写
- 输出：下一个词后是否应该话轮转换
- 准确率：~85%（英语）

**Response Generation for Backchannel（2022）**：
- 基于 BERT 的 backchannel 时机预测
- 输入：韵律特征 + 文本特征
- 输出：backchannel 类型和时机

**dGSLM（2022, Nguyen et al.）**：
- 基于 HuBERT 的无文本 backchannel 生成
- 不需要 ASR，直接从音频生成 backchannel
- 适用于低延迟场景

**Spoken Dialogue Systems 综述（2023）**：
- 总结了 5 种 turn-taking 模型：rule-based, probabilistic, neural, hybrid, LLM-based
- LLM-based 方法在语义理解上最优，但延迟最高
- Hybrid 方法（规则 + 神经网络）在实时性上最优

---

### 1.3 新闻采访学中的引导技法

#### 1.3.1 经典采访技法

**Terry Gross（NPR Fresh Air）的风格**：
- **镜像（Mirroring）**：重复对方最后几个词 → "你刚才说'失控'..."
- **沉默（Strategic Silence）**：在关键处停顿 3-5 秒，让对方自己补充
- **轻声引导（Soft Prompt）**："多说一点..."、"然后呢？"
- **情感标记（Emotion Labeling）**："听起来你很矛盾"

**Oprah Winfrey 的技法**：
- **共鸣式引导**："我也经历过..."（建立信任后立即追问）
- **递进式追问**："然后发生了什么？" → "你当时什么感觉？" → "现在回头看呢？"
- **总结式引导**："所以你的意思是..."

**Louis Theroux 的"天真追问法"**：
- 假装不理解，让对方解释 → "等等，我不太明白，为什么你会这样想？"
- 用"天真"问题揭示矛盾

#### 1.3.2 调查记者技法

**"Columbo 技法"**（以电视剧角色命名）：
- 在对话看似结束时，突然回头问一个关键问题
- 利用对方放松警惕的时机

**"沉默的 5 秒"**：
- 在对方说完后保持沉默 5 秒
- 大多数受访者会继续补充，且补充的内容往往更真实

**"回音技法"**：
- 重复对方最后一句话的最后一个词
- 效果类似于"继续说"，但更自然

#### 1.3.3 中文采访特有技法

**白岩松的"递进三问"**：
- 第一问：是什么（事实层面）
- 第二问：为什么（原因层面）
- 第三问：意味着什么（意义层面）

**柴静的"共情追问"**：
- 先建立情感连接（"我能理解..."）
- 再追问具体细节（"当时具体发生了什么？"）
- 最后追问内心感受（"你当时心里在想什么？"）

**许知远的"知识引导"**：
- 引用相关书籍/理论/历史事件
- 引导对方从更高维度思考

---

### 1.4 心理学中的主动倾听与引导

#### 1.4.1 Carl Rogers 的"以人为中心疗法"（1951）

Rogers 提出的三大核心条件：

1. **无条件积极关注（Unconditional Positive Regard）**：不评判
2. **共情理解（Empathic Understanding）**：进入对方的参考框架
3. **一致性（Congruence）**：真诚

**核心技法——"反映（Reflection）"**：
- **简单反映**：复述对方的话
- **情感反映**：识别并说出对方的情感
- **意义反映**：说出对方话中的深层含义
- **总结反映**：整合多个点

**对专访的启示**：AI 的引导不应是冷冰冰的逻辑追问，而应带有共情色彩。

#### 1.4.2 动机性访谈（Motivational Interviewing, Miller & Rollnick, 1991）

MI 的四大核心原则（OARS）：

1. **Open questions（开放式问题）**：不用"是不是"，用"怎么"、"什么"
2. **Affirmations（肯定）**：认可对方的努力和优势
3. **Reflective listening（反映性倾听）**：用自己的话复述
4. **Summaries（总结）**：阶段性整合

**MI 的"引导光谱"**：

```
指导（Directing）← → 引导（Guiding）← → 跟随（Following）
```

- **跟随**：完全让对方主导，"嗯"、"然后呢？"
- **引导**：轻推方向，"你提到了'失控'，能多说一点吗？"
- **指导**：给出建议，"你应该..."

**对专访的启示**：专访 AI 应主要在"引导"区间运作，偶尔进入"跟随"（留白），极少进入"指导"（只在用户明确求助时）。

#### 1.4.3 Socratic Questioning（苏格拉底式提问）

6 种苏格拉底式提问：

1. **澄清概念**："你说的'自由'具体指什么？"
2. **探究假设**："你为什么认为这样做是对的？"
3. **寻找证据**："有什么具体例子吗？"
4. **考虑其他视角**："如果从对方角度看呢？"
5. **探究后果**："如果这样做，最坏会怎样？"
6. **反思问题本身**："为什么这个问题对你这么重要？"

#### 1.4.4 神经科学视角

**社会疼痛与物理疼痛共享神经回路（Eisenberger, 2003）**：
- 被忽视/被误解激活的脑区与物理疼痛相同
- 这意味着：AI 的引导如果让人感到被误解，会造成真实的"社交疼痛"

**镜像神经元（Mirror Neurons, Rizzolatti, 1996）**：
- 观察他人行为时，自己的相关脑区也会激活
- 这意味着：AI 的"镜像"式引导（重复对方的话）能激活对方的镜像神经元，增强连接感

**催产素与信任（Kosfeld, 2005）**：
- 被理解和被关注会促进催产素分泌
- 这意味着：好的引导能建立信任，信任能促进更深层的表达

---

### 1.5 HCI 中的语音交互设计

#### 1.5.1 Nielsen Norman Group 的语音交互原则

1. **状态可见（Visibility of System Status）**：用户需要知道 AI 在听、在想、还是在说
2. **用户控制与自由（User Control and Freedom）**：用户可以跳过、打断、调整
3. **错误预防（Error Prevention）**：避免误解用户意图
4. **灵活性（Flexibility）**：支持多种交互方式

**对专访的启示**：引导应该是透明的——用户应该能感知到 AI 在引导，而不是被操控。

#### 1.5.2 Microsoft 的语音交互指南（2023）

- **"3-second rule"**：AI 回应不应超过 3 秒
- **"Progressive disclosure"**：逐步展示信息，不要一次说太多
- **"Breathability"**：给用户留呼吸空间

#### 1.5.3 Amazon Alexa 的对话设计指南

- **"One breath test"**：AI 的每句话应该能在一口气内说完
- **"Earcon"**：用简短音效表示状态变化
- **"Implicit confirmation"**：用自然方式确认理解，而非"我理解你说的是..."

---

## 2. 主动引导的分类体系

基于以上全网调研，将专访中的主动引导分为 **5 大类、15 种子类型**：

### 2.1 延续型引导（Continuation Guidance）

目的：让用户继续说，不改变方向。

| 子类型 | 示例话语 | 适用场景 | 字数 |
|--------|---------|---------|------|
| **轻推（Nudge）** | "嗯"、"然后呢？"、"继续说" | 用户停顿但明显没说完 | 1-4 |
| **回音（Echo）** | 重复最后 1-3 个词："...失控？" | 用户说了关键词后停顿 | 1-3 |
| **节奏同步（Pacing）** | "嗯..."（与用户语速同步） | 用户语速慢、在思考时 | 1 |

### 2.2 深化型引导（Deepening Guidance）

目的：让用户把当前话题说更深。

| 子类型 | 示例话语 | 适用场景 | 字数 |
|--------|---------|---------|------|
| **锚点追问（Anchor Probe）** | "等一下，你说的'那个决定'是什么？" | 用户提到模糊但重要的锚点 | 5-10 |
| **具体化（Concretize）** | "具体发生了什么？" | 用户在抽象描述 | 3-6 |
| **情感标记（Emotion Label）** | "听起来你很矛盾" | 用户表达了复杂情绪 | 4-8 |
| **意义追问（Meaning Probe）** | "这对你意味着什么？" | 用户说完事实但没说感受 | 4-8 |

### 2.3 挑战型引导（Challenge Guidance）

目的：让用户面对盲区或矛盾。

| 子类型 | 示例话语 | 适用场景 | 字数 |
|--------|---------|---------|------|
| **矛盾标记（Contradiction Flag）** | "你刚才说...但现在说..." | 用户前后不一致 | 5-10 |
| **假设追问（Assumption Probe）** | "你为什么觉得一定会这样？" | 用户有隐含假设 | 5-8 |
| **反方引入（Devil's Advocate）** | "如果反过来想呢？" | 用户观点单一 | 3-6 |

### 2.4 结构型引导（Structural Guidance）

目的：帮助用户组织思路。

| 子类型 | 示例话语 | 适用场景 | 字数 |
|--------|---------|---------|------|
| **阶段性总结（Mini Summary）** | "所以到目前为止，核心是..." | 用户说了很多，需要收拢 | 6-12 |
| **框架提示（Frame Prompt）** | "从时间线来看..."、"从人的角度来看..." | 用户思路散乱 | 4-8 |
| **优先级追问（Priority Probe）** | "这里面最重要的是什么？" | 用户列了多个点 | 5-8 |

### 2.5 关系型引导（Relational Guidance）

目的：建立信任，让用户感到被理解。

| 子类型 | 示例话语 | 适用场景 | 字数 |
|--------|---------|---------|------|
| **共情确认（Empathy Acknowledge）** | "这确实不容易" | 用户表达了困难 | 3-6 |
| **镜像（Mirror）** | "我听到的是..." | 需要确认理解 | 4-8 |
| **正常化（Normalize）** | "很多人都会有这种感觉" | 用户表达了自我怀疑 | 4-8 |

---

## 3. 引导与打断的关系模型

### 3.1 干预光谱（Intervention Spectrum）

```
被动 ←————————————————————————————→ 主动

沉默    延续型    深化型    结构型    挑战型    打断
  |       |         |         |         |        |
留白    "嗯"    "具体是？" "核心是？" "矛盾了" "停，换个角度"
  |       |         |         |         |        |
不干预   跟随      引导      引导      引导     夺权
```

**关键原则**：
- 引导和打断处于同一光谱上，只是干预强度不同
- 引导是"轻推"，打断是"强制"
- 专访 AI 应主要在"延续型→深化型→结构型"区间运作
- 挑战型引导需要"挑战预算"控制
- 打断是最后手段

### 3.2 引导的时机模型

```
用户说话时间轴 →
|————— 说话中 —————|—— 停顿 ——|—— 继续说话 ——|—— 长停顿 ——|
       ↑                ↑            ↑               ↑
   延续型引导       深化型引导    结构型引导       挑战型引导
   (不打断流)      (自然间隙)   (收拢时机)      (反思时机)
```

### 3.3 引导与打断的决策矩阵

| 用户状态 | AI 状态 | 引导策略 | 打断策略 |
|---------|---------|---------|---------|
| 流畅表达 | 倾听 | 延续型（"嗯"） | ❌ 不打断 |
| 流畅表达 | 倾听 | 发现锚点 → 标记待追问 | ❌ 不打断 |
| 停顿思考 | 倾听 | 深化型（"具体是？"） | ❌ 不打断 |
| 表达散乱 | 倾听 | 结构型（"核心是？"） | ❌ 不打断 |
| 前后矛盾 | 倾听 | 挑战型（"你刚才说..."） | ⚠️ 仅在矛盾严重时 |
| 跑题严重 | 倾听 | 结构型（拉回） | ✅ 可打断 |
| 用户情绪激动 | 倾听 | 关系型（共情） | ❌ 不打断 |
| 用户求助 | 倾听 | 深化型（追问） | ❌ 不打断 |
| AI 正在说话 | 说话中 | ❌ 不引导 | ✅ 用户开口即打断 |

---

## 4. 技术实现方案

### 4.1 架构总览

```
┌─────────────────────────────────────────────────────────────┐
│                     专访实时语音链路                          │
│                                                              │
│  麦克风 ──→ ASR 流式转写 ──→ Guidance Detector ──→ 决策引擎   │
│                │                    │                │       │
│                │              ┌─────┴─────┐    ┌────┴─────┐ │
│                │              │ 韵律分析   │    │ 引导决策  │ │
│                │              │ 语义分析   │    │ 打断决策  │ │
│                │              │ 上下文匹配 │    │ 时机控制  │ │
│                │              └───────────┘    └────┬─────┘ │
│                │                                    │       │
│                │                              ┌────┴─────┐ │
│                │                              │ TTS 注入  │ │
│                │                              │ 简短语音  │ │
│                │                              └──────────┘ │
│                                                              │
│  LLM ──→ 追问生成 ──→ TTS 完整回复 ──→ 扬声器                │
└─────────────────────────────────────────────────────────────┘
```

### 4.2 核心组件：Guidance Detector

```typescript
// src/realtime/guidanceDetector/types.ts

/** 引导类型 */
export type GuidanceKind =
  | "nudge"            // 轻推："嗯"、"然后呢？"
  | "echo"             // 回音：重复最后几个词
  | "anchor_probe"     // 锚点追问："等一下，你说的X是什么？"
  | "concretize"       // 具体化："具体发生了什么？"
  | "emotion_label"    // 情感标记："听起来你很矛盾"
  | "meaning_probe"    // 意义追问："这对你意味着什么？"
  | "contradiction"    // 矛盾标记："你刚才说...但现在说..."
  | "assumption_probe" // 假设追问："你为什么觉得一定会这样？"
  | "devils_advocate"  // 反方引入："如果反过来想呢？"
  | "mini_summary"     // 阶段性总结
  | "frame_prompt"     // 框架提示
  | "priority_probe"   // 优先级追问
  | "empathy"          // 共情确认
  | "mirror"           // 镜像
  | "normalize";       // 正常化

/** 引导决策 */
export interface GuidanceDecision {
  shouldGuide: boolean;
  kind: GuidanceKind | null;
  text: string | null;         // 要说的引导话语
  confidence: number;          // 0-1
  reason: string;              // 决策理由
  anchor?: string;             // 引导锚点（用户说的关键词）
  urgency: "low" | "medium" | "high";
}

/** 引导检测器上下文 */
export interface GuidanceContext {
  // 实时转写
  partialTranscript: string;    // 部分转写（流式）
  finalTranscript: string;      // 完整转写（判停后）

  // 韵律特征
  speechRate: number;           // 语速（字/秒）
  pitchTrend: "rising" | "falling" | "flat";
  energy: number;               // 音量 0-1
  silenceMs: number;            // 当前静默时长

  // 会话状态
  turnCount: number;
  userSpeakingMs: number;       // 当前轮用户已说多久
  lastGuidanceMs: number;       // 距上次引导多久
  guidanceCountThisTurn: number; // 本轮已引导次数

  // 专访上下文
  activeStrategies: string[];
  openDebts: string[];
  blindspotCandidates: string[];
  recentAnchorWords: string[];

  // AI 状态
  isAssistantSpeaking: boolean;
  assistantProgress: number;    // AI 当前回复进度 0-1
}
```

### 4.3 引导决策引擎

```typescript
// src/realtime/guidanceDetector/guidanceEngine.ts

/**
 * 引导决策引擎
 *
 * 核心逻辑：
 * 1. 韵律层：判断用户是否在自然停顿（可引导）vs 思考停顿（不引导）
 * 2. 语义层：判断当前内容是否有引导价值（锚点、矛盾、模糊）
 * 3. 策略层：根据专访策略决定引导类型和强度
 * 4. 时机层：控制引导频率，避免过度干预
 */
export function evaluateGuidance(ctx: GuidanceContext): GuidanceDecision {
  // ===== 第一层：韵律判断 =====
  // 用户正在流畅说话 → 不引导（除非发现高价值锚点）
  if (ctx.silenceMs < 300 && ctx.speechRate > 2) {
    return maybeHighValueAnchorOnly(ctx);
  }

  // 用户停顿 300-800ms → 可能是思考停顿，轻推
  if (ctx.silenceMs >= 300 && ctx.silenceMs < 800) {
    return evaluateThinkingPause(ctx);
  }

  // 用户停顿 800-1500ms → 可能是话轮结束，深化引导
  if (ctx.silenceMs >= 800 && ctx.silenceMs < 1500) {
    return evaluateTurnBoundary(ctx);
  }

  // 用户停顿 > 1500ms → 话轮结束，正常追问
  return { shouldGuide: false, kind: null, text: null, confidence: 0, reason: "长停顿，进入正常追问", urgency: "low" };

  // ===== 第二层：语义判断 =====
  function evaluateThinkingPause(ctx: GuidanceContext): GuidanceDecision {
    // 检查是否有模糊锚点
    const vagueAnchor = detectVagueAnchor(ctx.partialTranscript);
    if (vagueAnchor) {
      return {
        shouldGuide: true,
        kind: "anchor_probe",
        text: `等一下，你说的"${vagueAnchor}"具体是指？`,
        confidence: 0.8,
        reason: `检测到模糊锚点: ${vagueAnchor}`,
        anchor: vagueAnchor,
        urgency: "medium"
      };
    }

    // 检查是否有情感信号
    const emotionSignal = detectEmotionSignal(ctx.partialTranscript);
    if (emotionSignal) {
      return {
        shouldGuide: true,
        kind: "emotion_label",
        text: generateEmotionLabel(emotionSignal),
        confidence: 0.7,
        reason: `检测到情感信号: ${emotionSignal}`,
        urgency: "medium"
      };
    }

    // 默认：轻推
    if (ctx.guidanceCountThisTurn === 0) {
      return {
        shouldGuide: true,
        kind: "nudge",
        text: "嗯",
        confidence: 0.6,
        reason: "思考停顿，轻推",
        urgency: "low"
      };
    }

    return { shouldGuide: false, kind: null, text: null, confidence: 0, reason: "本轮已引导过，保持沉默", urgency: "low" };
  }

  function evaluateTurnBoundary(ctx: GuidanceContext): GuidanceDecision {
    // 检查前后矛盾
    const contradiction = detectContradiction(ctx.finalTranscript, ctx.activeStrategies);
    if (contradiction) {
      return {
        shouldGuide: true,
        kind: "contradiction",
        text: generateContradictionPrompt(contradiction),
        confidence: 0.75,
        reason: `检测到矛盾: ${contradiction}`,
        urgency: "high"
      };
    }

    // 检查是否有可深化的锚点
    const deepAnchor = detectDeepAnchor(ctx.finalTranscript, ctx.blindspotCandidates);
    if (deepAnchor) {
      return {
        shouldGuide: true,
        kind: "anchor_probe",
        text: generateAnchorProbe(deepAnchor),
        confidence: 0.8,
        reason: `检测到可深化锚点: ${deepAnchor}`,
        anchor: deepAnchor,
        urgency: "medium"
      };
    }

    // 检查是否需要结构化
    if (ctx.turnCount > 3 && ctx.userSpeakingMs > 30000) {
      return {
        shouldGuide: true,
        kind: "mini_summary",
        text: "让我确认一下，到目前为止，核心是...",
        confidence: 0.7,
        reason: "长轮次，需要阶段性总结",
        urgency: "medium"
      };
    }

    return { shouldGuide: false, kind: null, text: null, confidence: 0, reason: "话轮边界，无特殊引导需求", urgency: "low" };
  }
}
```

### 4.4 引导注入机制

引导和打断的关键技术区别在于**注入方式**：

```
打断的注入方式：
  用户音频流 ──→ [ASR] ──→ 检测到打断意图
  AI 音频流  ──→ [立即停止] ──→ 播放新回复

引导的注入方式（方案 A：TTS 叠加）：
  用户音频流 ──→ [ASR] ──→ 检测到引导时机
  AI 音频流  ──→ [降低音量 50%] ──→ 叠加短引导语音 ──→ 恢复音量

引导的注入方式（方案 B：文本注入）：
  用户音频流 ──→ [ASR] ──→ 检测到引导时机
  LLM 上下文 ←── 注入引导标记
  下次 AI 回复时自然融入引导内容
```

**推荐方案**：方案 B（文本注入）为主，方案 A（TTS 叠加）为辅。

- **文本注入**：在 LLM 的 system prompt 中动态注入"刚才用户说到 X，下次回复时先简短回应再追问"
- **TTS 叠加**：仅在"嗯"、"然后呢？"等 1-4 字极短引导时使用

### 4.5 引导预算与频率控制

```typescript
// src/realtime/guidanceDetector/guidanceBudget.ts

export interface GuidanceBudget {
  maxPerTurn: number;           // 每轮最多引导次数
  minIntervalMs: number;        // 两次引导最小间隔
  maxPerMinute: number;         // 每分钟最多引导次数
  challengeBudget: number;      // 挑战型引导配额（每场专访）
  challengeUsed: number;        // 已使用挑战配额
}

export const DEFAULT_GUIDANCE_BUDGET: GuidanceBudget = {
  maxPerTurn: 2,                // 每轮最多 2 次引导
  minIntervalMs: 5000,          // 至少间隔 5 秒
  maxPerMinute: 4,              // 每分钟最多 4 次
  challengeBudget: 3,           // 每场专访最多 3 次挑战型引导
  challengeUsed: 0
};

export function canGuide(budget: GuidanceBudget, ctx: GuidanceContext, kind: GuidanceKind): boolean {
  // 挑战型引导需要配额
  if (["contradiction", "assumption_probe", "devils_advocate"].includes(kind)) {
    if (budget.challengeUsed >= budget.challengeBudget) return false;
  }

  // 频率控制
  if (ctx.guidanceCountThisTurn >= budget.maxPerTurn) return false;
  if (ctx.lastGuidanceMs < budget.minIntervalMs) return false;

  return true;
}
```

### 4.6 与现有 Turn Detector 的集成

```typescript
// 扩展现有 TurnDetector 接口
// src/realtime/turnDetectors/types.ts

export type TurnDetectorDecisionKind =
  | "continue"
  | "end_of_turn"
  | "interruption"
  | "guidance";  // 新增：引导决策

export interface TurnDetectorDecision {
  decision: TurnDetectorDecisionKind;
  confidence: number;
  reason: string;
  guidance?: {        // 新增：引导详情
    kind: GuidanceKind;
    text: string;
    anchor?: string;
  };
}
```

### 4.7 级联架构下的引导实现

在级联架构（ASR→LLM→TTS）中，引导的实现更灵活：

```
ASR 持续监听
  ↓ 实时部分转写
Guidance Detector（独立线程）
  ↓ 检测到引导时机
  ├── 极短引导（1-4字）→ 直接 TTS 播放（不经过 LLM）
  └── 中等引导（5-12字）→ 注入 LLM 上下文，影响下次回复
```

**极短引导的 TTS 预合成**：
- 常用引导话语（"嗯"、"然后呢？"、"具体说说"等 ~20 句）预先 TTS 合成
- 检测到引导时机时直接播放，延迟 < 100ms
- 播放时降低 AI 主回复音量（ducking）

---

## 5. 中文专访的引导话语库

### 5.1 延续型

| 话语 | 适用场景 | 语调要求 |
|------|---------|---------|
| 嗯 | 用户停顿思考时 | 轻声、上扬 |
| 嗯... | 用户语速慢、在组织语言 | 拖长、平稳 |
| 然后呢？ | 用户在叙述事件 | 好奇、上扬 |
| 继续说 | 用户明显没说完 | 鼓励、平稳 |
| 我听着呢 | 用户犹豫是否继续 | 温和、肯定 |

### 5.2 深化型

| 话语 | 适用场景 | 语调要求 |
|------|---------|---------|
| 等一下，你说的"..."具体是指？ | 用户提到模糊概念 | 好奇、追问 |
| 具体发生了什么？ | 用户在抽象描述 | 引导、平稳 |
| 当时你是什么感觉？ | 用户只说事实 | 温和、关切 |
| 这让你想到了什么？ | 用户说完一个点 | 开放、好奇 |
| 为什么你觉得是这样？ | 用户表达了判断 | 追问、不评判 |

### 5.3 挑战型

| 话语 | 适用场景 | 语调要求 |
|------|---------|---------|
| 你刚才说...，但现在又说...，这两个好像不太一样？ | 前后矛盾 | 好奇、不指责 |
| 如果反过来想呢？ | 观点单一 | 开放、邀请 |
| 你确定一定是这样吗？ | 隐含假设 | 温和挑战 |
| 有没有可能不是这样的？ | 用户过于确定 | 邀请反思 |

### 5.4 结构型

| 话语 | 适用场景 | 语调要求 |
|------|---------|---------|
| 让我确认一下，到目前为止，核心是... | 需要收拢 | 总结、确认 |
| 这里面最重要的是什么？ | 用户列了多个点 | 聚焦、追问 |
| 从时间线来看... | 用户思路散乱 | 引导、框架 |
| 如果分几个方面来说... | 用户信息量大 | 结构化 |

### 5.5 关系型

| 话语 | 适用场景 | 语调要求 |
|------|---------|---------|
| 这确实不容易 | 用户表达了困难 | 共情、温和 |
| 我能理解 | 用户表达了情绪 | 简短、真诚 |
| 很多人都会有这种感觉 | 用户自我怀疑 | 正常化、不评判 |
| 谢谢你愿意说这些 | 用户分享了敏感内容 | 感谢、尊重 |

---

## 6. 实现路线图

### Phase 1：基础引导框架（2-3 天）

**目标**：在现有 Turn Detector 基础上增加 `guidance` 决策类型。

**内容**：
1. 扩展 `TurnDetectorDecisionKind` 增加 `"guidance"`
2. 实现 `GuidanceDetector` 基础版（韵律层 + 简单规则）
3. 在 `TurnStateMachine` 中集成引导决策
4. 前端展示引导状态（区别于打断状态）

**文件改动**：
- `src/realtime/turnDetectors/types.ts` — 扩展决策类型
- `src/realtime/guidanceDetector/guidanceEngine.ts` — 新建
- `src/realtime/guidanceDetector/guidanceBudget.ts` — 新建
- `src/realtime/bailianWebrtc.ts` — 集成引导状态
- `src/features/interview/InterviewView.tsx` — 展示引导状态

### Phase 2：语义引导（3-4 天）

**目标**：基于实时转写文本进行语义级引导判断。

**内容**：
1. 实现锚点检测（模糊概念识别）
2. 实现矛盾检测（前后不一致识别）
3. 实现情感信号检测
4. 接入专访上下文（盲区候选、知识债）
5. 引导话语库（~50 句中文引导话语）

**文件改动**：
- `src/realtime/guidanceDetector/anchorDetector.ts` — 新建
- `src/realtime/guidanceDetector/contradictionDetector.ts` — 新建
- `src/realtime/guidanceDetector/emotionDetector.ts` — 新建
- `src/realtime/guidanceDetector/guidancePhrasebook.ts` — 新建

### Phase 3：TTS 引导注入（2-3 天）

**目标**：实现极短引导的即时语音播放。

**内容**：
1. 预合成 20 句常用引导话语的 TTS 音频
2. 实现音频叠加播放（ducking 主回复音量）
3. 实现引导时机与主回复的协调
4. 用户可配置引导频率和强度

**文件改动**：
- `src/realtime/guidanceAudio.ts` — 新建
- `src/realtime/cascadedPipeline.ts` — 集成引导注入
- `src/features/config/ConfigView.tsx` — 引导配置项

### Phase 4：LLM 级引导（3-4 天）

**目标**：让 LLM 感知引导上下文，生成更自然的追问。

**内容**：
1. 在 `buildInterviewAgentContext` 中注入引导历史
2. LLM system prompt 增加引导策略说明
3. 引导效果反馈闭环（用户是否回应了引导）
4. A/B 测试框架

---

## 7. 验收标准

### 7.1 引导检测

- [ ] 系统能在用户停顿 300-800ms 时检测到引导时机
- [ ] 系统能识别模糊锚点（如"那个东西"、"这个决定"）并生成锚点追问
- [ ] 系统能识别前后矛盾并生成矛盾标记
- [ ] 引导检测延迟 < 200ms

### 7.2 引导执行

- [ ] 极短引导（"嗯"、"然后呢？"）能在 100ms 内播放
- [ ] 引导播放时主回复音量自动降低（ducking）
- [ ] 每轮引导不超过 2 次
- [ ] 两次引导间隔不少于 5 秒
- [ ] 挑战型引导每场不超过 3 次

### 7.3 用户体验

- [ ] 用户能感知到 AI 在引导（而非被动附和）
- [ ] 引导不打断用户的表达流
- [ ] 用户可以调整引导频率（低/中/高）
- [ ] 用户可以关闭引导功能

### 7.4 与打断的协调

- [ ] 引导和打断不冲突（引导期间用户开始说完整句子 → 升级为打断）
- [ ] 打断后重置引导计数器
- [ ] 引导状态在前端有明确视觉区分

---

## 8. 参考文献

### 对话分析学
- Sacks, H., Schegloff, E. A., & Jefferson, G. (1974). A simplest systematics for the organization of turn-taking for conversation. *Language*, 50(4), 696-735.
- Yngve, V. H. (1970). On getting a word in edgewise. *CLS*, 6, 567-578.
- Goodwin, C. (1986). Between and within: Alternative sequential treatments of continuers and assessments. *Human Studies*, 9(2-3), 205-217.
- Gardner, R. (2001). *When Listeners Talk: Response Tokens and Listener Stance*. John Benjamins.
- Stivers, T. (2008). Stance, alignment, and affiliation during storytelling: When nodding is a token of affiliation. *Research on Language and Social Interaction*, 41(1), 31-57.

### 语音 AI
- Ekstedt, E., & Skantze, G. (2021). TurnGPT: A Transformer-based Language Model for Predicting Turn-taking in Spoken Dialog. *Findings of EMNLP*.
- Nguyen, T. A., et al. (2022). dGSLM: Generative Spoken Language Model for Backchannel Prediction. *ICASSP*.
- Skantze, G. (2021). Turn-taking in Conversational AI Systems: A Review. *Computer Speech & Language*, 67, 101178.
- Google Research. (2022). Towards Conversational AI with Natural Speech Patterns.
- LiveKit Agents Documentation. (2024). https://docs.livekit.io/agents/
- OpenAI Realtime API Documentation. (2024). https://platform.openai.com/docs/guides/realtime

### 新闻采访学
- Gross, T. (2004). *All I Did Was Ask: Conversations with Writers, Actors, Musicians, and Artists*. Hachette.
- Adams, S., & Hicks, W. (2009). *Interviewing for Journalists*. Routledge.
- 白岩松. (2015). 《白说》. 长江文艺出版社.
- 柴静. (2013). 《看见》. 广西师范大学出版社.

### 心理学
- Rogers, C. R. (1951). *Client-Centered Therapy*. Houghton Mifflin.
- Miller, W. R., & Rollnick, S. (2013). *Motivational Interviewing: Helping People Change* (3rd ed.). Guilford Press.
- Eisenberger, N. I., et al. (2003). Does rejection hurt? An fMRI study of social exclusion. *Science*, 302(5643), 290-292.
- Rizzolatti, G., et al. (1996). Premotor cortex and the recognition of motor actions. *Cognitive Brain Research*, 3(2), 131-141.

### HCI
- Nielsen, J. (1994). 10 Usability Heuristics for User Interface Design. Nielsen Norman Group.
- Microsoft. (2023). Voice Interaction Design Guidelines.
- Amazon. (2023). Alexa Design Guide for Conversation.
