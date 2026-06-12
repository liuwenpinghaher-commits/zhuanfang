# tldraw + 规则模拟 + 关键帧交互世界 v3 方案

版本：v3.0  
日期：2026-06-11  
状态：当前主方案  
替代：`2026-06-11-creation-simulation-learning-world-v2.md`  
核心目标：尽量使用成熟开源能力，少自研底层，把世界引擎收敛成薄协调层。

---

## 0. 结论

当前产品不应该先做完整游戏引擎，也不应该一开始上真实物理沙盒。最优底层是：

```text
tldraw = 可交互世界画布和对象存储
json-rules-engine = 世界规则和学习触发
XState = 创作-交互-改装-复盘流程状态机
Dexie = 本地优先持久化
AI Structured Output = 引导、交互判断、解释、追问
关键帧动画 = 可解释模拟表现
PixiJS / Matter.js = 第二阶段可选增强
```

一句话：

> 世界引擎不是自研游戏引擎，而是把 tldraw 对象、规则引擎、状态机、AI 判断和事件日志连接起来的一层薄协调器。

MVP 要验证的是：

```text
孩子是否愿意因为自己的造物互动失败而分析、改装、再试。
```

不是验证：

```text
物理引擎是否足够真实。
```

---

## 1. 为什么不用 Phaser / Matter.js 做第一底座

### 1.1 Phaser 的问题

Phaser 是完整 2D 游戏框架，适合做传统小游戏。但当前产品的核心是：

- 孩子的所有造物长期存在。
- 造物是可编辑结构图。
- AI 要读取造物语义。
- 家长要看成长记录和回放。
- 世界状态要可解释、可追踪、可改装。

如果用 Phaser 做底座，会出现两套世界：

```text
tldraw/画布世界
Phaser/游戏世界
```

同步成本高，且容易把产品带向“做游戏”，而不是“做可解释学习世界”。

### 1.2 Matter.js 的问题

Matter.js 是 2D 物理引擎，适合真实一点的碰撞、刚体、重力。但第一版需要的是：

```text
窄轮 + 重载 + 泥地 → 陷住
履带 + 泥地 → 通过但慢
重车 + 木桥 → 桥弯曲
电池小 + 路远 → 中途没电
```

这些规则用真实物理引擎反而难以稳定表达，也不一定更适合儿童理解。

### 1.3 先用规则模拟的原因

规则模拟更适合 MVP：

- 资源消耗小。
- 结果稳定。
- 可解释。
- 容易和 AI 追问关联。
- 容易生成家长报告。
- 容易回放。
- 不需要复杂物理调参。

---

## 2. 最优底层架构

```text
UI / Canvas
  - tldraw
  - custom shapes
  - bindings
  - editor tools

World Coordination Layer
  - Object Registry
  - Affordance Graph
  - Interaction Resolver
  - Rule Evaluator
  - Learning Opportunity Detector
  - Event Log
  - Replay Builder

Workflow Layer
  - XState machine
  - guide → create → interact → simulate → explain → upgrade → replay

Persistence
  - Dexie / IndexedDB
  - tldraw snapshot
  - world objects
  - event log
  - learning evidence

AI Layer
  - challenge cards
  - structured interaction decisions
  - explanation and prompts
  - safety checks
```

核心原则：

```text
tldraw 存画布对象和视觉关系
WorldObject 存造物语义
Rules 存世界因果
EventLog 存过程
AI 不直接改世界，只提出结构化建议
```

---

## 3. 复用库分工

### 3.1 tldraw

用来做：

- 无限画布。
- 孩子造物编辑。
- custom shapes。
- shape bindings。
- 造物之间的视觉连接。
- 世界地图。
- 快照保存。
- 回放关键帧显示。

不让 tldraw 负责：

- 学习判断。
- 规则后果。
- AI 决策。
- 真实物理。

### 3.2 json-rules-engine

用来做：

- 地形规则。
- 材料规则。
- 载重规则。
- 能源规则。
- 互动是否触发失败。
- 学习点触发。

示例规则：

```json
{
  "conditions": {
    "all": [
      {"fact": "terrain", "operator": "equal", "value": "mud"},
      {"fact": "wheelType", "operator": "equal", "value": "narrow_wheel"},
      {"fact": "load", "operator": "greaterThanInclusive", "value": 2}
    ]
  },
  "event": {
    "type": "vehicle.stuck",
    "params": {
      "reason": "low_contact_area_with_heavy_load",
      "learningTargets": ["contact_area", "weight", "friction"]
    }
  }
}
```

### 3.3 XState

用来做流程状态：

```text
idle
→ guided_prompt
→ design
→ choose_interaction
→ simulate
→ diagnose
→ upgrade
→ retest
→ reflect
→ saved
```

好处：

- 不手写复杂 if/else。
- UI 状态清晰。
- AI 调用、规则判断、动画播放都能作为 state transitions。
- 后续好测试。

### 3.4 Dexie

用来本地保存：

- tldraw snapshot。
- WorldObject。
- InteractionEvent。
- LearningEvidence。
- ReplayTimeline。
- ParentSummary。

第一阶段可以本地优先，不急着上后端账号。

### 3.5 AI Structured Output

AI 负责：

- 生成挑战卡。
- 理解孩子语音。
- 把孩子想象交互转成 `InteractionRequest`。
- 判断是否需要补问。
- 生成儿童可懂解释。
- 生成复盘问题。

AI 不负责：

- 直接改世界。
- 直接决定最终规则结果。
- 直接生成任意画布对象。

---

## 4. 世界引擎最小实现

世界引擎只做七件事。

### 4.1 Object Registry

登记所有造物。

```ts
type WorldObject = {
  id: string
  name: string
  type: "vehicle" | "bridge" | "cart" | "base" | "energy" | "tool" | "terrain"
  shapeIds: string[]
  state: "draft" | "ready" | "testing" | "broken" | "upgraded"
  capabilities: string[]
  constraints: string[]
  properties: {
    weight?: number
    contactArea?: number
    energy?: number
    stability?: number
    capacity?: number
    material?: string
  }
}
```

### 4.2 Affordance Graph

描述造物能做什么。

```ts
type Affordance = {
  subjectType: string
  action: "move" | "pull" | "carry" | "cross" | "support" | "power" | "connect"
  objectType: string
  requiredCapabilities: string[]
  learningTargets: string[]
}
```

MVP 只要这些：

```text
vehicle pull cart
vehicle cross terrain
bridge support vehicle
cart carry material
track improve cross_mud
```

### 4.3 Interaction Resolver

把孩子或 AI 的交互想法转成可判断请求。

```ts
type InteractionRequest = {
  actorId: string
  action: "move" | "pull" | "cross" | "support" | "upgrade"
  targetId?: string
  destinationId?: string
  context: {
    terrain?: "mud" | "stone" | "slope" | "bridge"
    load?: number
    distance?: number
    weather?: "normal" | "rain"
  }
}
```

输出：

```ts
type InteractionDecision = {
  decision: "simulate" | "ask_question" | "suggest_variant" | "decline"
  reason: string
  learningTargets: string[]
  nextQuestion?: string
}
```

### 4.4 Rule Evaluator

把 WorldObject 和 InteractionRequest 转成 facts，然后跑规则。

```ts
type RuleFacts = {
  actorType: string
  wheelType?: string
  terrain?: string
  load?: number
  contactArea?: number
  weight?: number
  bridgeStrength?: number
  energy?: number
}
```

输出：

```ts
type SimulationResult = {
  outcome: "success" | "stuck" | "slow" | "broken" | "no_energy" | "bridge_bent"
  explanationKey: string
  learningTargets: string[]
  keyframes: Keyframe[]
}
```

### 4.5 Learning Opportunity Detector

判断这次互动是否是学习机会。

```ts
type LearningOpportunity = {
  score: number
  domains: ("math_modeling" | "science_reasoning" | "engineering_tradeoff" | "information_understanding")[]
  prompt: string
  evidenceType: string
}
```

判断逻辑：

```text
有可观察后果 + 能解释原因 + 孩子能改装
→ 高学习价值

只有装饰变化
→ 低学习价值，但可以保存为轻互动
```

### 4.6 Event Log

所有世界变化都记事件。

```ts
type WorldEvent =
  | { type: "object.created"; objectId: string }
  | { type: "interaction.requested"; request: InteractionRequest }
  | { type: "interaction.simulated"; result: SimulationResult }
  | { type: "object.upgraded"; objectId: string; patch: UpgradePatch }
  | { type: "learning.evidence"; evidence: GrowthEvidence }
```

### 4.7 Replay Builder

从 Event Log 生成回放。

MVP 不做连续动画，只做关键帧：

```text
第 1 帧：轮子车拉材料车出发
第 2 帧：进入泥地
第 3 帧：车轮下沉
第 4 帧：车停住
第 5 帧：换成履带
第 6 帧：再次通过
```

tldraw 负责显示这些关键帧。

---

## 5. MVP 世界对象

只做 5 个对象：

```text
探险车
材料车
断桥
泥地
履带改装件
```

只做 4 个动作：

```text
move
pull
cross
upgrade
```

只做 4 条规则：

```text
窄轮 + 泥地 → 陷住
窄轮 + 拉重物 + 泥地 → 更容易陷住
履带 + 泥地 → 通过但速度慢
重车 + 木桥 → 桥弯曲
```

只做 1 条完整体验：

```text
AI 给挑战：造一辆能把材料送去修桥的探险车
→ 孩子选轮子
→ tldraw 生成轮子车和材料车
→ 孩子让车拉材料去桥边
→ 规则判断：窄轮 + 重载 + 泥地
→ 关键帧：陷住
→ AI 问：为什么陷住？
→ 孩子选择/说出原因
→ 改装履带
→ 规则判断：履带 + 泥地
→ 关键帧：通过但慢
→ 桥修复进度 +1
→ 保存回放和成长证据
```

---

## 6. 关键帧动画怎么做

关键帧动画不是电影级动画，而是“因果过程可视化”。

### 6.1 Keyframe 数据

```ts
type Keyframe = {
  id: string
  at: number
  changes: {
    shapeId: string
    x?: number
    y?: number
    rotation?: number
    opacity?: number
    label?: string
    style?: "normal" | "warning" | "success"
  }[]
  narration?: string
}
```

### 6.2 播放方式

用 tldraw editor API 分步更新 shape：

```text
move vehicle
move cart
add mud splash marker
lower vehicle y
show warning label
show explanation card
```

这不是真实物理，但足够表达：

```text
发生了什么
为什么发生
如何改进
```

---

## 7. AI 怎么参与

AI 是解释和引导层，不是世界裁判。

### 7.1 AI 可以做

- 推荐挑战。
- 把孩子语音转成结构化意图。
- 判断孩子想象交互是否安全、适龄、可模拟。
- 在规则结果出来后生成儿童解释。
- 提问引导孩子分析。
- 生成家长摘要。

### 7.2 AI 不可以做

- 不直接改世界状态。
- 不绕过规则引擎决定结果。
- 不生成真实武器细节。
- 不用开放聊天无限陪伴。
- 不把孩子失败归因到人格。

### 7.3 AI 输出格式

```ts
type AiInteractionDraft = {
  intent: string
  proposedRequest: InteractionRequest
  safety: "allowed" | "needs_redirect" | "blocked"
  learningTargets: string[]
  childQuestion: string
}
```

---

## 8. 后续增强路线

### 8.1 第一阶段：规则模拟 + tldraw

目标：

- 验证孩子愿意玩、愿意分析、愿意改装。
- 不追求真实物理。

### 8.2 第二阶段：PixiJS 渲染增强

当 tldraw 关键帧表现不够生动时，加 PixiJS 作为“测试播放器”。

仍然保持：

```text
tldraw 是世界编辑和存档
PixiJS 只是播放测试动画
```

### 8.3 第三阶段：Matter.js 局部物理

当规则表达不了的运动变多时，再接 Matter.js。

只用于：

- 小范围测试场。
- 短时间模拟。
- 输出结果和关键帧。

不用于：

- 接管全部世界状态。
- 替代规则引擎。

---

## 9. v3 MVP 范围

必须有：

- tldraw 画布。
- 5 个世界对象。
- 4 个动作。
- 4 条规则。
- 1 个完整闭环。
- Dexie 本地保存。
- XState 流程状态。
- Event Log。
- Keyframe Replay。
- AI 结构化引导和解释。

暂不做：

- Matter.js。
- Phaser。
- PixiJS。
- 完整物理。
- 多世界。
- 社区。
- 排行榜。
- 复杂课程体系。

---

## 10. 最终判断

最省开发、最贴近当前需求的底层方案是：

```text
tldraw + json-rules-engine + XState + Dexie + AI structured output + keyframe replay
```

世界引擎只保留一层薄协调器：

```text
WorldObject
+ Affordance
+ InteractionRequest
+ RuleFacts
+ SimulationResult
+ WorldEvent
+ Keyframe
```

这样既能造出一个“可交互、可解释、可回放”的模拟世界，又不会一开始陷入真实物理引擎、游戏框架和复杂同步问题。

真正需要自研的不是底层引擎，而是：

- 儿童感兴趣的挑战设计。
- 世界对象的 affordance 体系。
- 规则库。
- AI 引导策略。
- 家长能看懂的成长解释。
