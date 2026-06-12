# 动态学习世界 + Excalidraw 矢量投影重构方案

版本：v1.0  
日期：2026-06-11  
状态：已被新方案替代  
替代：`2026-06-11-excalidraw-voice-sketch-learning-product-strategy.md`  
新主方案：`2026-06-11-creation-simulation-learning-world-v2.md`  
替代原因：本版仍偏“世界给孩子任务”。新方向应是“孩子自发创作一个东西，系统把它放进动态世界模拟测试，通过失败、分析和改装自然激发学习需求”。  
核心结论：世界状态引擎是底座，Excalidraw 是矢量场景投影层，不是世界数据库，也不是动画引擎。

---

## 0. 重构结论

产品方向应从：

```text
孩子语音 → 生成简笔画 → 保存作品 → 回放作品
```

重构为：

```text
孩子进入持续存在的学习世界
→ 世界提出事件、任务和问题
→ 孩子通过信息理解、表达写作、数学建模、科学探究、AI 验证和复盘解决问题
→ 系统记录 Learning Event
→ World State Engine 更新世界
→ Scene Compiler 把世界投影成 Excalidraw 矢量场景
→ Timeline Replay 回放世界如何因孩子的学习行为而变化
→ Growth Model 生成孩子的能力证据和家长周报
```

一句话定位：

> 一个持续存在的动态学习世界。孩子通过语音、信息理解、表达写作、数学建模、科学探究和 AI 判断来建设世界；世界以 Excalidraw 矢量场景呈现和回放，长期培养学习理解能力、表达写作、数学建模、科学探究与常识、分析思维、创造性思维、技术素养、韧性、好奇心、终身学习、元认知和 AI 素养。

这次重构的关键取舍：

- 不再把“生成画面”当产品核心。
- 不再把 Excalidraw 当世界底座。
- 不做开放式 AI 陪聊。
- 不做纯游戏，也不做题库。
- 核心资产从“作品图片”升级为“世界状态 + 学习事件 + 能力证据 + 矢量回放”。

---

## 1. 第一性需求

### 1.1 真正要培养的能力

目标不是让孩子学会某个工具，而是培养面向未来的底层素质：

基础能力：

- 信息学习与理解：从文字、图表、地图、实验记录、说明书、任务规则和资料卡中提取条件、关系、证据和问题。阅读不是独立目标，而是理解数学、科学和世界问题的入口。
- 表达与写作：说清判断，写计划、说明、日志、报告、信件、实验记录和复盘。
- 数学建模：数量、空间、比例、时间、成本、路径、概率、资源分配，把世界问题转成可计算、可比较、可取舍的方案。
- 科学探究与常识：观察、假设、实验、因果、生态、材料、力、电、天气、能源，把世界现象转成可解释、可验证、可改进的理解。

未来能力：

- 分析思维：能拆问题、找原因、比较方案。
- 创造性思维：能提出新方案、改造已有方案。
- 技术素养：理解工具、系统、AI、自动化和规则。
- 韧性：失败后能修复、迭代、再试。
- 好奇心：主动发现未知，提出问题。
- 终身学习：会查、会问、会试、会反思。

元认知：

```text
计划 → 执行 → 检查 → 复盘
```

AI 素养：

- AI 可能错。
- AI 不是权威。
- AI 不能替自己思考。
- 需要验证信息来源。
- 不能向 AI 透露隐私。

### 1.2 孩子的真实动机

孩子不会因为“提高未来竞争力”而坚持使用。他会因为这些而坚持：

- 世界是我的。
- 我说的话会让世界变化。
- 我解决问题后，世界真的变好了。
- 我能建设基地、知识中心、实验室、村庄、机关和探险地图。
- 我能回放自己怎么一步步让世界变大。

所以产品必须做到：

```text
学习行为 → 世界变化 → 新问题出现 → 继续建设
```

### 1.3 家长的真实需求

家长没有大量陪伴时间，希望：

- 孩子可以独立使用。
- 兴趣不是空耗，而是转成能力。
- 每周能看到真实成长证据。
- 产品安全、不过度沉迷、不做 AI 情感依赖。
- 信息理解、表达写作、数学建模、科学探究能潜移默化发生。

---

## 2. 产品形态

### 2.1 核心世界

产品中的世界长期存在，可以持续搭建，也可以创建新世界。

默认世界建议叫：

```text
未来岛
```

未来岛由六个区域组成：

1. 知识中心
   - 信息理解、资料学习、说明理解、图表解读、表达写作。

2. 工程区
   - 数学建模、空间、材料、结构、成本、路径、规划。

3. 实验室
   - 科学探究、观察、假设、实验、因果、记录。

4. AI 工坊
   - AI 素养、信息验证、工具理解、自动化。

5. 探险地图
   - 好奇心、问题发现、叙事、地理/自然常识。

6. 复盘塔
   - 计划、执行、检查、复盘、韧性。

每个区域不是菜单，而是世界里的真实地点。孩子完成相应任务后，该区域扩建、修复、点亮、解锁新路径或出现新角色。

### 2.2 主循环

```text
进入未来岛
→ 世界出现一个事件
→ 孩子理解线索、资料、图表、地图或现象说明
→ 孩子说出判断或计划
→ 系统要求写一句/算一下/解释原因/做观察
→ AI 追问或给出反例
→ 孩子修改方案
→ 世界状态更新
→ 保存本次事件和回放
```

### 2.3 每日和每周节奏

每日 10-15 分钟：

- 一个世界事件。
- 一个核心能力目标。
- 一个小变化。
- 一条复盘。

每周 1 个大工程：

- 需要跨区域完成。
- 最终形成一个可回放的世界变化故事。
- 家长只看 1 分钟精选回放和一页摘要。

---

## 3. 最佳底层架构

### 3.1 总体模块

```text
Input Layer
  - Voice Capture
  - Text Input
  - Click/Drag Interaction

AI Orchestrator
  - Speech-to-Text Adapter
  - Intent Parser
  - Learning Event Extractor
  - Tutor/NPC Prompt Generator

Learning Core
  - Learning Event Model
  - Mission Engine
  - Curriculum Graph
  - Growth Model
  - Safety Policy Engine

World Core
  - World State Engine
  - World Patch Validator
  - World Timeline
  - World Save/Load

Presentation Layer
  - Scene Compiler
  - Excalidraw Projection
  - Timeline Replay Player
  - Parent Report View

Storage
  - World State
  - Learning Events
  - Scene Snapshots
  - Replay Timeline
  - Growth Evidence
  - Parent Reports
```

### 3.2 关键原则

最重要的架构原则：

```text
World State 不存放在 Excalidraw 里。
```

原因：

- Excalidraw 是画布，不是领域数据库。
- 长期世界需要语义状态：建筑等级、任务状态、知识解锁、孩子能力证据。
- Excalidraw elements 只知道图形，不知道“这座桥是因为孩子完成材料估算而建成的”。
- 后续如果要切换 tldraw、Canvas、SVG、WebGL 或 3D，不能被 Excalidraw 数据结构锁死。

正确关系：

```text
World State → Scene Compiler → Excalidraw elements
```

而不是：

```text
Excalidraw elements → 反推 World State
```

---

## 4. 核心领域模型

### 4.1 World

```json
{
  "worldId": "world_future_island_001",
  "ownerChildId": "child_001",
  "name": "未来岛",
  "createdAt": "2026-06-11T09:00:00+08:00",
  "activeRegions": ["library", "engineering", "lab", "ai_workshop", "adventure", "reflection_tower"],
  "currentDay": 18,
  "worldLevel": 3
}
```

### 4.2 Region

```json
{
  "regionId": "engineering",
  "name": "工程区",
  "learningDomains": ["math", "analysis", "creativity"],
  "level": 2,
  "unlockedStructures": ["bridge", "warehouse", "waterwheel"],
  "openMissions": ["mission_bridge_repair_002"]
}
```

### 4.3 World Object

```json
{
  "objectId": "bridge_001",
  "type": "bridge",
  "regionId": "engineering",
  "state": "under_construction",
  "level": 1,
  "properties": {
    "material": "wood",
    "length": 8,
    "stability": 0.6
  },
  "createdByEvents": ["event_calculated_materials_001"],
  "pendingProblems": ["needs_stronger_support"]
}
```

### 4.4 Mission

```json
{
  "missionId": "mission_bridge_repair_002",
  "title": "修好去知识中心的桥",
  "regionId": "engineering",
  "primaryDomains": ["information_understanding", "math_modeling", "analysis"],
  "secondaryDomains": ["expressive_writing", "science_reasoning"],
  "futureSkills": ["analytical_thinking", "resilience", "metacognition"],
  "steps": [
    "understand_information",
    "model_materials",
    "explain_plan",
    "check_risk",
    "revise_plan",
    "reflect"
  ],
  "status": "active"
}
```

### 4.5 Learning Event

这是系统最重要的数据对象。

```json
{
  "eventId": "event_calculated_materials_001",
  "childId": "child_001",
  "worldId": "world_future_island_001",
  "missionId": "mission_bridge_repair_002",
  "eventType": "calculated_materials",
  "domain": "math",
  "futureSkill": "analytical_thinking",
  "metacognitionPhase": "execute",
  "inputMode": "voice",
  "evidence": {
    "transcript": "桥有八格长，每格需要两个木板，所以需要十六个木板。",
    "structuredAnswer": {
      "length": 8,
      "woodPerUnit": 2,
      "totalWood": 16
    }
  },
  "qualitySignals": {
    "gaveReason": true,
    "usedNumbers": true,
    "checkedRisk": false,
    "revised": false
  }
}
```

### 4.6 World Patch

AI 不能直接改世界，只能提出 World Patch。

```json
{
  "patchId": "patch_bridge_progress_001",
  "sourceEventId": "event_calculated_materials_001",
  "operations": [
    {
      "op": "update_object",
      "objectId": "bridge_001",
      "changes": {
        "state": "materials_ready",
        "properties.requiredWood": 16
      }
    },
    {
      "op": "add_problem",
      "objectId": "bridge_001",
      "problem": "needs_stronger_support"
    }
  ],
  "requiresValidation": true
}
```

### 4.7 Scene Projection

```json
{
  "projectionId": "scene_bridge_001",
  "worldStateVersion": 42,
  "renderer": "excalidraw",
  "regionId": "engineering",
  "objectsRendered": ["bridge_001", "river_001", "library_001"],
  "sceneElementIds": ["ex_bridge_body", "ex_river", "ex_library"]
}
```

---

## 5. Excalidraw 的最佳位置

### 5.1 Excalidraw 负责什么

Excalidraw 负责：

- 世界地图的矢量表现。
- 区域场景的手绘风格表达。
- 建筑、路线、机关、实验过程的可视化。
- 场景快照。
- SVG/PNG/JSON 导出。
- 回放中的每一帧画布状态。
- 孩子少量手动标注和修改。

### 5.2 Excalidraw 不负责什么

Excalidraw 不负责：

- 世界语义状态。
- 任务系统。
- 学习目标。
- 能力评估。
- 安全策略。
- NPC 对话逻辑。
- 动画时间线。
- 长期进度。

### 5.3 Scene Compiler

Scene Compiler 把 World State 编译成 Excalidraw elements。

示例：

```text
bridge_001(state=materials_ready, length=8)
→
rectangle: bridge deck
line: supports
text: "需要 16 个木板"
warning marker: "支撑还不够"
```

### 5.4 回放

回放不依赖 Excalidraw 的内部历史。产品维护自己的 World Timeline：

```json
{
  "timelineId": "tl_bridge_001",
  "frames": [
    {
      "time": 0,
      "type": "mission_start",
      "text": "桥坏了，知识中心暂时去不了。"
    },
    {
      "time": 1200,
      "type": "learning_event",
      "eventId": "event_understand_information_001"
    },
    {
      "time": 2600,
      "type": "world_patch_applied",
      "patchId": "patch_bridge_progress_001"
    },
    {
      "time": 3600,
      "type": "scene_projection",
      "projectionId": "scene_bridge_001"
    }
  ]
}
```

回放时：

```text
World State at version N
→ Scene Compiler
→ update Excalidraw Scene
→ show child transcript / NPC question / learning label
```

---

## 6. 学习任务如何潜移默化发生

### 6.1 信息学习与理解

信息学习与理解不做成狭义“阅读理解题”，也不只限于故事和线索。它是孩子解决世界问题前的输入能力：读懂文字、图表、地图、实验记录、材料说明、任务规则、AI 建议和科学资料，从中提取条件、关系、证据和待解决的问题。

示例：

```text
知识中心收到一份桥梁检查记录：

昨晚下雨后，通往知识中心的桥变松了。
村民说桥下面少了几根支柱。
如果今天还下雨，桥可能更危险。

桥长 8 格，每格原本有 2 根支柱，现在少了 3 根。

请找出：
1. 桥为什么危险？
2. 你需要知道哪些数量？
3. 你先检查哪里？
```

孩子必须理解信息，才能进入数学建模、科学解释或方案设计。这里的重点不是“读了多少字”，而是“能不能从信息中抓住条件、关系和问题”。

### 6.2 表达与写作

写作不做成作文，而做成世界文档。

类型：

- 建造计划。
- 实验记录。
- 冒险日志。
- 给 NPC 的说明信。
- 复盘报告。
- AI 验证记录。

示例：

```text
请写一句给村民看的告示：
这座桥今天为什么不能走？
```

### 6.3 数学

数学不做成刷题，而做成世界运行规则。孩子需要用数量、空间、比例、时间、成本、路径、概率和资源分配来让世界继续运转。

类型：

- 材料数量。
- 面积和周长。
- 路径长度。
- 时间安排。
- 比例和缩放。
- 预算和取舍。
- 简单概率。

示例：

```text
桥长 8 格，每格需要 2 块木板。
你需要多少木板？
如果仓库只有 12 块，你还差多少？
```

### 6.4 科学探究与常识

科学不做成百科讲解，而做成世界现象和探究任务。孩子需要观察现象、提出假设、设计验证、解释因果，再让世界发生合理变化。

类型：

- 天气影响桥。
- 植物需要水和光。
- 材料有强弱。
- 斜坡更省力。
- 电路需要闭合。
- 水从高处往低处流。
- 生态需要平衡。

示例：

```text
实验室里的植物变黄了。
线索：这几天没有阳光，水很多。
你觉得可能是什么原因？下一步怎么观察？
```

### 6.5 AI 素养

AI 素养不做成说教，而做成 AI 工坊事件。

示例：

```text
AI 助手说：木桥一定比石桥轻，所以一定更安全。

你要判断：
1. 这句话哪里可能不完整？
2. 需要比较哪些条件？
3. 能不能直接相信？
```

---

## 7. 世界区域与能力映射

| 世界区域 | 基础能力 | 未来能力 | 典型事件 |
|---|---|---|---|
| 知识中心 | 信息理解、表达写作 | 好奇心、终身学习 | 读资料、看图表、提取条件、写说明 |
| 工程区 | 数学建模、空间规划 | 分析思维、创造性思维 | 建桥、建基地、算材料、算成本 |
| 实验室 | 科学探究、观察记录 | 好奇心、韧性 | 观察植物、测试材料、改实验 |
| AI 工坊 | 技术理解、信息判断 | AI 素养、批判思维 | 判断 AI 建议、验证信息 |
| 探险地图 | 地图理解、路径规划、科学探究 | 好奇心、创造性思维 | 规划路线、解释现象、判断风险 |
| 复盘塔 | 表达写作、元认知记录 | 元认知、韧性 | 计划、检查、复盘 |

---

## 8. Mission Engine

### 8.1 任务结构

每个 Mission 都必须包含：

```text
世界问题
学习目标
信息理解材料：文字 / 图表 / 地图 / 实验记录 / 说明书 / 任务规则
孩子输入
至少一个思考追问
一个世界变化
一个复盘动作
```

### 8.2 每日 Mission 示例

#### 修桥去知识中心

目标：

- 信息理解：读懂桥梁检查记录，提取数量和风险条件。
- 数学建模：计算木板和支柱数量，比较材料是否足够。
- 分析：找出桥的风险。
- 元认知：复盘是否检查够。

流程：

```text
1. 孩子读桥梁检查记录和材料清单。
2. 孩子提取桥长、每格材料、缺少支柱等关键信息。
3. 孩子计算材料数量。
4. AI 问：只算木板够吗？支撑怎么办？
5. 孩子补充方案。
6. 世界中桥从 broken 变成 under_repair。
7. 孩子回答：下次我会先检查哪里？
```

#### 植物实验室

目标：

- 信息理解：读懂观察记录和植物状态变化。
- 科学探究：理解光、水、植物状态，提出可验证假设。
- 表达写作：写观察记录。
- 分析：提出假设。
- 韧性：实验失败后调整。

流程：

```text
1. 世界提示植物变黄。
2. 孩子读取三条观察记录。
3. 孩子说可能原因。
4. 系统要求写一句观察记录。
5. AI 追问：怎么验证不是水太多？
6. 孩子提出下一步观察。
7. 实验室生成观察表。
```

#### AI 工坊误判

目标：

- AI 素养：不盲信 AI。
- 信息理解：读懂 AI 建议中的条件、遗漏和不确定性。
- 分析：找不完整条件。
- 表达写作：写验证计划。

流程：

```text
1. AI 工坊给出一个可疑建议。
2. 孩子判断哪里可能错。
3. 孩子说需要验证什么。
4. 系统要求写一句“我不能直接相信，因为...”
5. 世界点亮验证徽章。
```

---

## 9. AI Orchestrator

### 9.1 AI 的输入输出边界

AI 输入：

- 当前 mission。
- 当前 world state 摘要。
- 孩子的语音转写。
- 年龄和安全策略。
- 允许的 event schema。

AI 输出只能是：

```text
LearningEventDraft
NPCQuestion
WorldPatchDraft
GrowthSignalDraft
```

AI 不能直接输出：

- 最终世界状态。
- 任意 Excalidraw elements。
- 无限开放聊天。
- 成人或危险内容。
- 对孩子人格的判断。

### 9.2 AI 输出示例

```json
{
  "learningEventDraft": {
    "eventType": "explained_reason",
    "domain": "analysis",
    "futureSkill": "analytical_thinking",
    "evidence": "因为桥下面少了支柱，所以走上去可能会塌。"
  },
  "npcQuestion": {
    "role": "工程师",
    "text": "你已经发现支柱少了。那你觉得先修桥面，还是先修支柱？为什么？"
  },
  "worldPatchDraft": {
    "operations": [
      {
        "op": "mark_object_problem_understood",
        "objectId": "bridge_001",
        "problem": "missing_supports"
      }
    ]
  }
}
```

---

## 10. Growth Model

### 10.1 能力证据

系统不直接给孩子显示“逻辑 70 分”。系统记录能力证据。

证据类型：

- 理解信息材料。
- 用数字解决问题。
- 说明理由。
- 比较方案。
- 发现风险。
- 提出问题。
- 修改方案。
- 写出计划。
- 做观察记录。
- 质疑 AI。
- 完成复盘。

### 10.2 家长报告

家长周报结构：

```text
本周世界变化
- 知识中心到工程区的桥修到第 2 阶段
- 实验室新增植物观察表
- AI 工坊点亮 1 个验证徽章

本周能力证据
- 信息理解：4 次
- 数学建模：3 次
- 科学解释：2 次
- 说明理由：6 次
- 复盘修改：2 次

代表回放
- 修桥任务 58 秒

下周建议
- 继续做“方案比较”和“科学观察”任务
```

---

## 11. 存储设计

### 11.1 必须保存

```text
World State
Mission State
Learning Events
World Patches
Scene Projections
Replay Timeline
Growth Evidence
Parent Reports
```

### 11.2 可选保存

```text
语音原文
完整转写
孩子手动画布操作
导出 SVG/PNG
```

### 11.3 默认不保存

```text
长期原始音频
真实姓名
学校
住址
无关开放聊天
```

---

## 12. 技术路线建议

### 12.1 MVP 技术栈

前端：

```text
React + TypeScript + @excalidraw/excalidraw
```

后端：

```text
Node.js/Fastify 或 FastAPI
```

AI：

```text
ASR Provider + LLM Provider + Structured Output
```

存储：

```text
SQLite 起步，后续 PostgreSQL
```

核心自研：

```text
World State Engine
Learning Event Model
Mission Engine
Scene Compiler
Timeline Replay Engine
Growth Model
Safety Policy Engine
```

### 12.2 Excalidraw 替代评估

Excalidraw 适合第一版，因为：

- 手绘感强。
- 矢量存档清晰。
- 可通过 JSON 表达场景。
- 能导出 SVG/PNG/JSON。
- 能通过 API 更新场景。

tldraw 值得 POC，因为：

- 更偏 SDK 和自定义 infinite canvas app。
- 自定义 shape、store、snapshot、persistence 能力更强。

推荐策略：

```text
MVP 用 Excalidraw 快速验证世界投影和回放。
同时保持 World State 与 Scene Compiler 解耦。
如果 Excalidraw 在自定义对象、性能或交互上受限，可以替换为 tldraw。
```

---

## 13. MVP 范围

### 13.1 MVP 必须做

```text
一个持续存在的未来岛
3 个区域：知识中心、工程区、实验室
6 个每日 Mission
1 个每周大工程
语音输入 + 文字备用
Learning Event 记录
World Patch 更新
Excalidraw 场景投影
Timeline Replay
家长周报
安全策略
```

### 13.2 MVP 不做

```text
开放聊天
社交社区
排行榜
抽卡
商城
真实 Minecraft 连接
完整 3D
多人协作
复杂课程体系
```

### 13.3 MVP 成功标准

孩子侧：

- 7 天内完成 3 个 Mission。
- 至少 60% Mission 有一次追问后的补充回答。
- 至少 50% 孩子愿意看一次回放。

学习侧：

- 每周至少产生 5 条有效能力证据。
- 至少覆盖信息理解、数学建模、科学探究、表达/分析中的 2 类。

家长侧：

- 家长能在 3 分钟内看懂本周世界变化和能力证据。
- 家长认为它不是“普通 AI 聊天”的比例超过 70%。

---

## 14. 第一批 Mission

### 14.1 知识中心：桥坏了

能力：

- 信息理解
- 数学建模
- 分析思维
- 元认知

世界变化：

- 断桥出现。
- 孩子理解检查记录后，桥上出现问题标记。
- 孩子完成材料建模后，工程区出现材料堆。
- 孩子复盘后，桥进入修复状态。

### 14.2 实验室：植物变黄

能力：

- 科学探究
- 观察记录
- 假设
- 表达写作

世界变化：

- 植物出现黄色叶片。
- 孩子写观察记录后，墙上出现观察表。
- 孩子提出验证方案后，实验台解锁。

### 14.3 工程区：仓库不够用

能力：

- 数学建模
- 空间规划
- 创造性思维

世界变化：

- 仓库显示拥挤。
- 孩子计算面积后，出现扩建蓝图。
- 孩子比较方案后，仓库升级。

### 14.4 AI 工坊：可疑建议

能力：

- AI 素养
- 批判性思维
- 表达写作

世界变化：

- AI 工坊出现警示灯。
- 孩子指出 AI 建议不完整后，验证台亮起。
- 孩子写验证计划后，获得验证徽章。

### 14.5 探险地图：迷路路线

能力：

- 地图理解
- 叙事表达
- 路径规划

世界变化：

- 迷雾地图出现。
- 孩子讲出路线后，道路被点亮。
- 孩子指出风险后，地图上出现安全标记。

### 14.6 复盘塔：失败的桥

能力：

- 韧性
- 元认知
- 复盘表达写作

世界变化：

- 桥第一次测试失败。
- 孩子找出原因后，复盘塔升一层。
- 孩子提出下一次改法后，桥获得加强结构。

---

## 15. 路线图

### 阶段 1：架构验证，2-3 周

目标：

- 验证 World State → Excalidraw Projection → Replay 是否成立。

范围：

- 1 个世界。
- 2 个区域。
- 3 个 Mission。
- 文本输入优先，语音可后置。
- 本地存储。

### 阶段 2：MVP，6-8 周

目标：

- 验证孩子能连续使用，家长能看懂成长。

范围：

- 3-4 个区域。
- 6-10 个 Mission。
- 语音输入。
- AI 结构化输出。
- 家长周报。
- 安全策略。

### 阶段 3：内测，8-12 周

目标：

- 支持真实家庭连续使用 4 周。

范围：

- 6 个区域。
- 40+ Mission。
- 每周大工程。
- 个性化任务推荐。
- 更完整能力证据模型。

### 阶段 4：商业版

目标：

- 家庭订阅和项目包。

范围：

- 多孩子档案。
- 更多世界主题。
- 更强回放与分享。
- 教育机构版本探索。

---

## 16. 风险与对策

### 16.1 仍然偏游戏，学习弱

对策：

- 每个 Mission 必须绑定基础能力和未来能力。
- 世界变化必须由 Learning Event 触发。
- 没有学习事件，不更新关键建筑。

### 16.2 学习感太强，孩子不愿用

对策：

- 任务包装成世界事件。
- 信息理解、表达写作、数学建模、科学探究都放入解决问题的过程。
- 单次 10-15 分钟闭环。

### 16.3 Excalidraw 承载动态世界受限

对策：

- Excalidraw 只做 projection。
- 自研 timeline replay。
- 保持 Scene Compiler 可替换。
- 同步评估 tldraw 作为第二画布方案。

### 16.4 AI 输出不可控

对策：

- AI 只输出 draft。
- World Patch Validator 强校验。
- Mission Engine 给定任务边界。
- Safety Policy Engine 优先级最高。

### 16.5 家长看不懂价值

对策：

- 周报不展示复杂指标。
- 用世界变化 + 能力证据 + 代表回放说明价值。
- 明确区分“不是 AI 陪聊，而是动态学习世界”。

---

## 17. 最终判断

最佳重构方案是：

```text
Learning World State Engine
+ Learning Event Model
+ Mission Engine
+ Growth Model
+ Safety Policy Engine
+ Excalidraw Scene Projection
+ Timeline Replay
```

其中：

- World State Engine 是真正底座。
- Learning Event 是学习证据核心。
- Mission Engine 把信息理解、表达写作、数学建模、科学探究变成世界事件。
- Excalidraw 是矢量投影层，不是世界数据库。
- Timeline Replay 回放世界如何被孩子的学习行为改变。
- Growth Model 把长期使用转成家长能看懂的成长证据。

这套架构既保留 Excalidraw 的优势，又避免被画布工具锁死。它能支撑持续存在的世界、另创世界、长期成长档案、未来替换画布引擎，以及后续更复杂的动态交互。

---

## 18. 资料依据

Excalidraw：

- Excalidraw API `updateScene`、读取 scene elements、files、app state：https://docs.excalidraw.com/docs/%40excalidraw/excalidraw/api/props/excalidraw-api
- Excalidraw JSON Schema 和 `.excalidraw` plaintext JSON 文件结构：https://docs.excalidraw.com/docs/codebase/json-schema
- Excalidraw Export Utilities，支持导出 PNG、SVG、JSON：https://docs.excalidraw.com/docs/%40excalidraw/excalidraw/api/utils/export

tldraw 替代评估：

- tldraw persistence、snapshot、schema migration 能力：https://tldraw.dev/docs/persistence
- tldraw SDK 面向自定义 infinite canvas app 的能力说明：https://github.com/tldraw/tldraw
