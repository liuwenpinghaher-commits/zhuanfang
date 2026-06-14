# 双向引导与打断：全网研究 + 全局最优方案

> 日期：2026-06-14
> 定位：从全局视角重新定义语音专访中的双向交互模型

---

## 0. 问题重述

当前系统的交互模型是**单向的**：

```
用户说话 → AI 听 → AI 说话 → 用户听 → 循环
   ↓                      ↓
  AI可引导             用户可打断
```

但真实的专访对话是**双向的**：

```
用户说话时 → AI 可能：附和(嗯) / 引导(具体是？) / 打断(停，换个角度)
AI 说话时  → 用户可能：附和(嗯) / 引导(多说点) / 打断(不对)
```

**核心问题**：同一个话语（如"嗯"、"等一下"）在不同上下文中有完全不同的交互意图。当前系统无法区分。

---

## 1. 全网知识整合

### 1.1 对话分析学：双向 Turn-Taking

#### Schegloff 的"同时开始"问题（1974, 2000）

Sacks, Schegloff & Jefferson 在 1974 年的奠基性论文中已经指出：话轮转换系统必须处理"同时开始"（simultaneous starts）的情况。Schegloff 在 2000 年的后续研究中进一步分析了"重叠话语"（overlapping talk）的多种类型：

| 重叠类型 | 描述 | 交互意图 |
|---------|------|---------|
| **Terminal overlap** | 听者在说者即将结束时开始说话 | 预判话轮结束，正常接话 |
| **Continuers** | 听者在说者停顿处插入"mm hm" | 鼓励继续，不夺权 |
| **Conditional access** | 听者请求澄清 | 临时插入，说者继续 |
| **Competitive overlap** | 听者提高音量抢话 | 真正打断，夺权 |
| **Choral** | 双方同时说同样的话 | 共鸣/附和 |
| **Recognitional onset** | 听者预判说者要说什么，提前回应 | 理解信号 |

**关键洞察**：重叠话语不全是打断。大多数重叠是合作性的（continuers, conditional access, recognitional onset）。只有 competitive overlap 才是真正的打断。

#### Jefferson 的"干扰"vs"打断"（1983, 2004）

Jefferson 区分了两种重叠：

- **Interjacent overlap（间隙重叠）**：发生在话轮转换相关位置（TRP），是正常的
- **Interruptive overlap（侵入重叠）**：发生在 TRP 之前，是真正的打断

**对专访的启示**：判断是否打断不能只看"有没有声音"，要看"声音发生在话轮的什么位置"以及"声音的内容和意图"。

#### Goodwin 的"参与框架"（1986）

Goodwin 指出，听者的行为（包括 backchannel 和打断）是"参与框架"的体现。同一个词（如 "yeah"）在不同韵律下可以是：

- 升调 "yeah?" → 请求确认
- 平调 "yeah." → 确认收到
- 降调 "yeah!" → 强烈同意
- 拖长 "yeah..." → 犹豫/不赞同

**对专访的启示**：韵律是判断意图的关键维度，纯文本匹配不够。

#### Stivers 的跨语言 Backchannel 研究（2008）

Stivers 比较了 10 种语言，发现 backchannel 的核心功能是"我在听"和"请继续"，但不同语言有不同的频率和形式。中文的 backchannel 包括：

- 单音节：嗯、哦、啊、对、是
- 双音节：嗯嗯、对对、是的、好的
- 短语：我明白、有道理、然后呢

**关键发现**：backchannel 的韵律特征（音高、时长、位置）比词汇本身更能区分意图。

#### Levinson 的"交互引擎"假说（2006, 2016）

Levinson 提出人类有一个通用的"交互引擎"（interaction engine），独立于语言，负责管理话轮转换。这个引擎的核心能力包括：

1. **预测话轮结束**：基于语法、韵律、语义多模态信号
2. **判断重叠意图**：区分合作性重叠和竞争性重叠
3. **管理修复序列**：当出现误解时启动修复

**对专访的启示**：AI 需要一个类似的"交互引擎"，综合文本、韵律、上下文做判断。

---

### 1.2 语音 AI 中的双向交互

#### Google Duplex / Assistant（2018-2024）

Google 在 Duplex 中实现了双向 backchannel：

- **AI 发出 backchannel**："mm-hmm"、"I see" 在用户说话时插入
- **AI 识别用户 backchannel**：用户说 "yeah"、"right" 时不停止说话
- **区分 backchannel 和打断**：基于话语长度 + 韵律 + 语义

**核心技术**（Google Research, 2022）：
- 端到端模型同时预测：是否应该 backchannel、是否应该打断、下一句说什么
- 韵律编码器：pitch contour + energy envelope + speech rate
- 延迟 < 200ms

#### OpenAI Realtime API（2024）

OpenAI 的 Realtime API 提供了：

- **VAD（Voice Activity Detection）**：检测用户是否在说话
- **Turn detection**：基于语义判断话轮边界
- **`response.cancel`**：用户说话时取消 AI 输出

**但缺少**：
- 区分 backchannel 和打断：用户说"嗯"也会触发 `response.cancel`
- 双向引导：AI 不能在用户说话时插入引导
- 上下文感知的打断策略

#### LiveKit Agents（2024）

LiveKit 的 `MultilingualModel` turn detector 是目前最接近"语义级打断判断"的方案：

- 基于 Transformer 的多语言话轮检测
- 输入：音频 + 部分转写
- 输出：`{ decision: "continue" | "end_of_turn" | "interruption", confidence }`
- 但仍然是三元判断，不区分 backchannel 和打断

**LiveKit 的 `should_interrupt` 机制**：
- `before_llm_callback` 可以在 LLM 推理前判断是否应该打断
- 可以注入自定义逻辑

#### Deepgram / ElevenLabs Conversational AI（2024）

ElevenLabs 的 Conversational AI 提供了最细粒度的打断控制：

- **Interruption sensitivity**：0-1 的滑动条，控制打断敏感度
- **Backchannel 支持**：可在 agent 说话时播放简短回应
- **Turn-taking 配置**：interruption sensitivity、response delay、backchannel frequency

**但仍然是单向的**：只控制"用户打断 AI"，不控制"AI 打断用户"。

#### 学术界：双向对话模型

**dGSLM（Nguyen et al., 2022）**：
- 基于 HuBERT 的无文本 backchannel 生成
- 不需要 ASR，直接从音频生成 backchannel
- 但只做 backchannel，不做打断判断

**TurnGPT（Ekstedt & Skantze, 2021）**：
- 基于 GPT-2 的话轮预测模型
- 输入：对话历史和当前部分转写
- 输出：下一个词后是否应该话轮转换
- 准确率：~85%（英语）

**Spoken Dialogue Systems 综述（Skantze, 2021）**：
- 总结了 5 种 turn-taking 模型
- **关键结论**：最好的系统是 hybrid 方法——规则处理低延迟判断（backchannel/打断），LLM 处理高延迟判断（说什么）

**"Continuous State" 模型（2023）**：
- 不再用离散的"话轮"概念
- 而是用连续的概率分布表示"谁在说话"、"谁想说话"、"话轮转换的可能性"
- 更接近人类的交互方式

---

### 1.3 新闻采访学中的双向引导

#### 顶级采访者的"双向意识"

**Terry Gross（NPR Fresh Air）**：
- 在受访者说话时，Gross 会发出轻声的"mm"、"right"，这些不是打断，而是"我在听，继续"
- 当她真正想打断时，她会提高音量、加快语速、使用对方的名字
- **区分策略**：韵律变化 + 称呼对方

**Oprah Winfrey**：
- 在受访者说到关键处时，Oprah 会插入"wait, wait, wait"——这是引导性打断
- 她会说"hold on, let me understand this"——先标记打断意图，再夺权
- **区分策略**：显式标记 + 解释意图

**Louis Theroux 的"天真打断"**：
- Theroux 会在受访者说到一半时突然问一个"天真"的问题
- 这种打断不是攻击性的，而是"我不理解，帮我解释"
- **区分策略**：用"无知"姿态软化打断

**白岩松的"递进打断"**：
- 当受访者回避问题时，白岩松会用"但是..."、"不过..."递进追问
- 这种打断是结构性的，目的是推进深度
- **区分策略**：用转折词标记打断意图

#### 采访中的"双向引导"模式

顶级采访者不只是在"听"和"说"之间切换，而是在"听"的同时就在"引导"：

```
受访者说话中：
  采访者："嗯"（backchannel，鼓励继续）
  采访者："等一下，你说的X是什么意思？"（引导性打断，不夺权）
  采访者："但是上次你说..."（挑战性打断，夺权）

采访者说话中：
  受访者："对"（backchannel，确认理解）
  受访者："不是，我的意思是..."（纠正性打断，夺权）
  受访者："对，而且..."（扩展性引导，不夺权）
```

**关键洞察**：打断和引导不是 AI 对用户的单向行为，而是双向的。AI 需要同时作为"说话者"和"听者"管理交互。

---

### 1.4 心理学中的双向交互

#### 动机性访谈（MI）中的"引导光谱"

Miller & Rollnick 的动机性访谈定义了"引导光谱"：

```
跟随（Following） ← → 引导（Guiding） ← → 指导（Directing）
```

在双向交互中，这个光谱同时适用于 AI 和用户：

| 方向 | 跟随 | 引导 | 指导/打断 |
|------|------|------|----------|
| AI→用户 | "嗯" | "具体是？" | "停，换个角度" |
| 用户→AI | "嗯" | "多说点" | "不对，不是这个意思" |

**MI 的"滚动抵抗"原则**：当遇到抵抗时，不要对抗，而是"滚动"——先跟随，再引导。这对 AI 处理用户打断有直接启示。

#### 依恋理论中的"安全基地"

Bowlby 的依恋理论指出，一个"安全基地"（secure base）允许探索者自由离开和返回。在对话中：

- AI 作为"安全基地"：用户可以在表达中自由探索，AI 不会随意打断
- 但 AI 也不是完全被动的：当用户"迷路"时，AI 应该引导
- **平衡点**：AI 的引导应该像"安全基地"的呼唤，而不是"控制者"的命令

---

### 1.5 综合：双向交互的统一模型

基于以上全网研究，提出一个统一的**双向交互模型**：

```
                    交互意图光谱
                        
  完全被动 ←──────────────────────────────→ 完全主动
  
  沉默      附和      引导      挑战      打断
   |         |         |         |         |
  不说     "嗯"    "具体是？" "矛盾了"  "停，换个角度"
   |         |         |         |         |
  跟随      跟随      引导      引导      夺权
  
  同一个话语在不同上下文中的意图不同：
  
  "嗯" 在对方停顿时 = 附和（鼓励继续）
  "嗯" 在对方说话时 = backchannel（我在听）
  "嗯" 在对方说错时 = 不赞同（挑战）
  
  "等一下" 在对方停顿时 = 引导（追问锚点）
  "等一下" 在对方说话时 = 打断（夺权）
  "等一下" 在自己说话时 = 自我修正
```

**核心原则**：

1. **意图不由话语决定，由上下文决定**：同一个词在不同位置、不同韵律、不同对话历史中有不同含义
2. **打断和引导是连续光谱**：不是二元分类，而是意图强度的连续值
3. **双向对称**：AI 和用户使用同一套交互信号系统
4. **韵律是区分意图的关键维度**：文本相同但韵律不同 = 意图不同

---

## 2. 全局最优方案

### 2.1 架构：统一交互意图引擎（Unified Interaction Intent Engine）

```
┌──────────────────────────────────────────────────────────────┐
│                  统一交互意图引擎（UIIE）                      │
│                                                               │
│  输入（实时）：                                                │
│  ├── 部分转写文本                                             │
│  ├── 韵律特征（语速、能量、音高趋势）                          │
│  ├── 话语位置（在 AI 说话中 / 在用户说话中 / 在停顿中）        │
│  └── 对话上下文（当前话题、策略、盲区）                        │
│                                                               │
│  输出：                                                       │
│  ├── 交互意图：backchannel | guidance | interruption | noise  │
│  ├── 意图强度：0-1                                            │
│  └── 建议动作：continue | nudge | stop | ignore               │
│                                                               │
│  决策逻辑（三层）：                                            │
│  ┌─────────────────────────────────────────────────────┐     │
│  │ 第一层：信号层（< 10ms）                              │     │
│  │  - 是否有声音？音量 > 阈值？                          │     │
│  │  - 声音持续时间？< 300ms = 可能是 backchannel         │     │
│  │  - 声音发生在什么位置？AI 说话中 / 用户停顿中？       │     │
│  └─────────────────────────────────────────────────────┘     │
│                        ↓                                      │
│  ┌─────────────────────────────────────────────────────┐     │
│  │ 第二层：匹配层（< 50ms）                              │     │
│  │  - 转写文本匹配预判信号（LLM 上轮生成）               │     │
│  │  - backchannel 白名单匹配                             │     │
│  │  - 打断触发词匹配                                     │     │
│  │  - 引导锚点匹配                                       │     │
│  └─────────────────────────────────────────────────────┘     │
│                        ↓                                      │
│  ┌─────────────────────────────────────────────────────┐     │
│  │ 第三层：上下文层（< 100ms）                           │     │
│  │  - 当前话题重要性（高重要性 → 降低打断敏感度）        │     │
│  │  - 用户历史行为（经常 backchannel → 提高阈值）        │     │
│  │  - AI 说话进度（刚开口 → 允许打断；关键结论 → 保护）  │     │
│  └─────────────────────────────────────────────────────┘     │
│                                                               │
│  LLM 预判信号（每轮生成一次，异步）：                          │
│  ┌─────────────────────────────────────────────────────┐     │
│  │ 输入：完整对话历史 + 专访上下文                        │     │
│  │ 输出：                                                │     │
│  │  - backchannelWhitelist: ["嗯", "对", "是的", "好"]   │     │
│  │  - guidancePreSignals: [{triggers, kind, text}...]    │     │
│  │  - interruptTriggers: ["不对", "不是", "等一下"]      │     │
│  │  - interruptSensitivity: "low" | "medium" | "high"    │     │
│  │  - topicImportance: "critical" | "normal" | "casual"  │     │
│  └─────────────────────────────────────────────────────┘     │
└──────────────────────────────────────────────────────────────┘
```

### 2.2 交互意图分类（双向对称）

```
用户发出声音时（AI 正在说话或停顿中）：

  声音特征分析
    ├── 时长 < 300ms + 音量低 + 在 AI 说话中
    │     → 可能是 backchannel
    │     → 匹配 backchannelWhitelist
    │       ├── 命中 → backchannel，AI 继续说话
    │       └── 未命中 → 进入文本分析
    │
    ├── 时长 300-800ms + 在 AI 停顿中
    │     → 可能是引导
    │     → 匹配 guidancePreSignals
    │       ├── 命中 → guidance，触发引导
    │       └── 未命中 → 等待更多输入
    │
    ├── 时长 > 800ms + 完整句子
    │     → 可能是打断
    │     → 匹配 interruptTriggers
    │       ├── 命中 → interruption，立即停止 AI
    │       └── 未命中 → 语义分析
    │             ├── 与当前话题相关 → 打断（用户想补充）
    │             └── 与当前话题无关 → 打断（用户想切换）
    │
    └── 音量极低 + 无转写
          → noise，忽略

AI 发出声音时（用户正在说话或停顿中）：

  同样的逻辑，但方向相反：
    ├── backchannel → "嗯"，用户继续
    ├── guidance → "等一下，你说的X具体是？"
    └── interruption → "停，换个角度"
```

### 2.3 关键设计决策

**决策 1：backchannel 白名单由 LLM 动态生成**

不是硬编码一个固定的 backchannel 列表，而是每轮由 LLM 根据上下文生成。例如：

- 用户在表达困难情绪 → backchannel 白名单：["嗯", "对", "是的", "我明白"]
- 用户在陈述事实 → backchannel 白名单：["嗯", "对", "好", "继续"]
- 用户在表达矛盾 → backchannel 白名单收紧：只允许 ["嗯"]，因为"对"可能被误解为同意某一方

**决策 2：打断敏感度由话题重要性动态调整**

- 当前话题是盲区候选 → sensitivity = "low"（保护 AI 的追问）
- 当前话题是闲聊 → sensitivity = "high"（用户可以随时打断）
- AI 正在说关键结论 → sensitivity = "low"（保护结论完整）
- AI 正在说开场白 → sensitivity = "high"（开场白不重要）

**决策 3：引导和打断共享预判信号，但动作不同**

同一个预判信号"用户可能说'但是...'"：
- 如果发生在 AI 停顿中 → 触发引导："你刚才说...但现在说...，这两个好像不太一样？"
- 如果发生在 AI 说话中 → 触发打断：AI 立即停止，然后说引导话语

**决策 4：韵律特征作为第一层过滤器**

在文本匹配之前，先用韵律特征快速过滤：

```
声音时长 < 200ms + 音量 < 阈值 → 直接忽略（噪音/呼吸）
声音时长 200-500ms + 无完整音节 → 可能是 backchannel，进入白名单匹配
声音时长 > 500ms + 有完整音节 → 可能是打断/引导，进入文本匹配
```

### 2.4 实现方案

**Phase 1：统一交互意图引擎（UIIE）**

新建 `src/realtime/interactionIntentEngine.ts`：

```typescript
// 交互意图
type InteractionIntent = 
  | "backchannel"      // 附和，不夺权
  | "guidance"         // 引导，轻推
  | "interruption"     // 打断，夺权
  | "noise";           // 噪音，忽略

// 意图决策
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

// LLM 预判信号（每轮生成）
interface InteractionPreSignals {
  backchannelWhitelist: string[];
  guidancePreSignals: GuidancePreSignal[];
  interruptTriggers: string[];
  interruptSensitivity: "low" | "medium" | "high";
  topicImportance: "critical" | "normal" | "casual";
}

// 引擎输入
interface IntentEngineInput {
  // 实时信号
  audioDuration: number;        // 声音持续时长 ms
  audioLevel: number;           // 音量 0-1
  partialTranscript: string;    // 部分转写
  
  // 位置信息
  isAssistantSpeaking: boolean;
  isUserSpeaking: boolean;
  silenceMs: number;
  
  // 韵律特征
  speechRate: number;           // 语速 字/秒
  pitchTrend: "rising" | "falling" | "flat";
  
  // LLM 预判信号
  preSignals: InteractionPreSignals | null;
  
  // 上下文
  turnCount: number;
  guidanceCountThisTurn: number;
}

function evaluateIntent(input: IntentEngineInput): IntentDecision {
  // 第一层：信号过滤
  if (input.audioDuration < 200 && input.audioLevel < 0.1) {
    return { intent: "noise", confidence: 0.9, action: "ignore" };
  }
  
  // 第二层：韵律 + 时长判断
  const isShortUtterance = input.audioDuration < 500;
  const isMediumUtterance = input.audioDuration >= 500 && input.audioDuration < 1500;
  const isLongUtterance = input.audioDuration >= 1500;
  
  // 第三层：文本匹配
  const transcript = input.partialTranscript.trim();
  const preSignals = input.preSignals;
  
  if (preSignals) {
    // 匹配 backchannel 白名单
    if (isShortUtterance && input.isAssistantSpeaking) {
      const isBackchannel = preSignals.backchannelWhitelist.some(
        word => transcript.includes(word) && transcript.length <= 3
      );
      if (isBackchannel) {
        return { intent: "backchannel", confidence: 0.85, action: "continue" };
      }
    }
    
    // 匹配打断触发词
    if (input.isAssistantSpeaking) {
      const isInterrupt = preSignals.interruptTriggers.some(
        trigger => transcript.includes(trigger)
      );
      if (isInterrupt && (isMediumUtterance || isLongUtterance)) {
        return { intent: "interruption", confidence: 0.8, action: "stop" };
      }
    }
    
    // 匹配引导预判信号
    if (!input.isAssistantSpeaking && input.silenceMs >= 400 && input.silenceMs < 1200) {
      for (const signal of preSignals.guidancePreSignals) {
        const matched = signal.triggers.some(t => transcript.includes(t));
        if (matched) {
          return {
            intent: "guidance",
            confidence: signal.confidence,
            action: "nudge",
            detail: { kind: signal.kind, text: signal.text, anchor: signal.anchor }
          };
        }
      }
    }
  }
  
  // 第四层：上下文调整
  if (input.isAssistantSpeaking && isLongUtterance) {
    // 用户说了完整句子 → 很可能是打断
    const sensitivity = preSignals?.interruptSensitivity ?? "medium";
    if (sensitivity === "high") {
      return { intent: "interruption", confidence: 0.7, action: "stop" };
    }
    if (sensitivity === "medium" && input.audioDuration > 2000) {
      return { intent: "interruption", confidence: 0.6, action: "stop" };
    }
    // sensitivity === "low" → 不打断，等 AI 说完
  }
  
  // 默认：继续
  return { intent: "backchannel", confidence: 0.3, action: "continue" };
}
```

**Phase 2：LLM 预判信号生成**

修改 `buildAssistantTurn`，让 LLM 同时输出预判信号：

```typescript
// 在 buildAssistantTurn 中增加：
function buildInteractionPreSignals(
  session: InterviewSession, 
  userText: string
): InteractionPreSignals {
  // 基于当前上下文生成预判信号
  // 实际由 LLM 生成，这里是规则 fallback
  
  const backchannelWhitelist = ["嗯", "对", "是的", "好", "我明白"];
  
  const guidancePreSignals: GuidancePreSignal[] = [];
  
  // 如果用户提到了模糊概念，预判可能需要追问
  if (userText.includes("那个") || userText.includes("这个")) {
    guidancePreSignals.push({
      triggers: ["那个", "这个", "某种"],
      kind: "anchor_probe",
      text: "等一下，你刚才说的具体是指？",
      confidence: 0.8
    });
  }
  
  // 如果用户在表达矛盾，预判可能需要标记
  if (userText.includes("但是") || userText.includes("不过")) {
    guidancePreSignals.push({
      triggers: ["但是", "不过", "可是", "然而"],
      kind: "contradiction",
      text: "你刚才说...但现在说...，这两个好像不太一样？",
      confidence: 0.75
    });
  }
  
  const interruptTriggers = ["不对", "不是", "等一下", "停", "我打断一下"];
  
  // 根据话题重要性调整打断敏感度
  const hasBlindspot = session.guide.blindspotCandidates.length > 0;
  const isDeepTopic = session.turns.length > 4;
  const interruptSensitivity = hasBlindspot && isDeepTopic ? "low" : "medium";
  const topicImportance = hasBlindspot ? "critical" : "normal";
  
  return {
    backchannelWhitelist,
    guidancePreSignals,
    interruptTriggers,
    interruptSensitivity,
    topicImportance
  };
}
```

**Phase 3：集成到现有架构**

```
当前架构：
  silenceVadDetector → TurnStateMachine → buildRealtimeTurnState

升级后：
  silenceVadDetector → IntentEngine → TurnStateMachine → buildRealtimeTurnState
                              ↑
                    InteractionPreSignals (来自 LLM)
```

### 2.5 改动范围

| 文件 | 改动 | 行数 |
|------|------|------|
| `src/realtime/interactionIntentEngine.ts` | **新建** 统一意图引擎 | ~200 |
| `src/domain/types.ts` | 新增 `InteractionIntent`、`InteractionPreSignals`、`IntentDecision` | ~40 |
| `src/domain/engine.ts` | `buildAssistantTurn` 输出预判信号；`buildRealtimeTurnState` 接入意图引擎 | ~50 |
| `src/realtime/turnDetectors/types.ts` | 扩展 `TurnDetectorDecision` | ~10 |
| `src/realtime/bailianWebrtc.ts` | 状态机接入意图引擎 | ~20 |
| `src/App.tsx` | 传递预判信号到实时层 | ~15 |
| `src/domain/guidanceEngine.ts` | 降级为 fallback，当 LLM 无预判信号时使用 | ~10 |

---

## 3. 验收标准

### 3.1 双向交互

- [ ] 用户说"嗯"时，AI 不停止说话（backchannel 识别）
- [ ] 用户说"不对"时，AI 立即停止（打断触发词识别）
- [ ] 用户说"等一下，你说的X是什么意思"时，AI 停止并回应（引导性打断）
- [ ] 用户在 AI 停顿时说模糊概念，AI 触发引导

### 3.2 上下文感知

- [ ] 高重要性话题时，打断敏感度降低
- [ ] 用户频繁 backchannel 时，系统自适应调整阈值
- [ ] AI 刚开口时允许打断，说关键结论时保护

### 3.3 LLM 预判

- [ ] 每轮 LLM 调用同时输出追问回复和预判信号
- [ ] 预判信号包含 backchannel 白名单、引导预判、打断触发词
- [ ] 无 LLM 预判时回退到规则引擎

### 3.4 性能

- [ ] 意图判断延迟 < 50ms（信号层 + 匹配层）
- [ ] 不增加额外的 LLM 调用（预判信号与追问回复同一次调用）
