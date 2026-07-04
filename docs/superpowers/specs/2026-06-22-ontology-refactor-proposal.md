# 专访 1.0 本体论重构方案

- 日期：2026-06-22
- 性质：架构方案/评估文档（结论先行，供决策）。非实现 spec。
- 关联：存储评估见 `2026-06-21-surrealdb-migration-evaluation.md`（结论：不迁 SurrealDB）；本文谈的是**领域模型**层，与存储层正交。

---

## 0. 结论（TL;DR）

**建议做，但要做"务实本体"，不要做"语义网重栈"。**

专访 1.0 的本质就是**为用户构建一张个人认知知识图谱**——把"我说了什么/我学到了什么"沉淀为可检索、可关联、可追溯的认知资产。所以"用本体论重构"在这个产品上不是赶时髦，而是**把已经存在却被打散的领域模型显式化**。

但有两种做法，差别巨大：

| | 务实本体（**建议**） | 语义网重栈（**不建议**） |
|---|---|---|
| 形态 | 在现有 TS/SQLite 栈内，定义显式的**实体类型 + 关系类型 + 不变量**，用一个统一的 `Entity + Relation` 图模型收敛当前散落的三套边 | 引入 RDF/OWL 三元组库 + SPARQL + 推理机（reasoner），把整个状态搬成三元组 |
| 工作量 | 渐进式演进，每阶段独立可交付、可叫停 | 推倒重写域层/查询/测试 + 新重依赖 + 学习成本 |
| 规模匹配 | 单用户、数百~数千实体，JS 内存图微秒级遍历足够 | OWL/SPARQL 是为开放世界、跨机构、百万三元组设计的，本场景用不上 |
| 风险 | 低（适配器并存、灰度收敛） | 高（功能冻结、全栈风险） |

**真正的痛点不是"没有本体"，而是"本体是隐性的、且被三种不一致的方式编码"**（见 §2）。务实本体把它显式化、统一化，顺手解决系统审查里那批"跨库一致性 / 关系孤儿 / 召回口径不一"的根因。

**值得做的判断依据**：不是为了优雅，而是因为当前每加一种认知资产、每加一种关联，都要在 25 个数组 + 三套边编码 + N 个召回/时间线/主题聚合函数里重复实现一遍。本体层把"实体怎么存、关系怎么连、怎么被召回"收敛成一处，**边际成本下降**才是收益本体。

---

## 1. 先厘清"本体论重构"指什么

"本体论"（Ontology）在知识系统里有三个由轻到重的层级，必须先选准，否则方案会跑偏：

- **L1 概念本体（建模纪律）**：把领域里的**实体类（classes）**、**关系类型（relation types）**、**公理/不变量（axioms）**写成一份显式规范。产出是文档 + 类型定义。零运行时成本。
- **L2 务实本体图（本文建议落点）**：在 L1 基础上，用一个**统一的有类型图模型**（`EntityNode` + `Relation`）承载所有实体和关系，纯函数在图上做召回/聚合/推理。仍在现有 TS/SQLite 栈内。
- **L3 形式化语义网（不建议）**：RDF 三元组 + OWL 类公理 + 描述逻辑推理机 + SPARQL。面向开放世界推理与跨系统互操作。

本文方案 = **L1（先写清）→ L2（渐进落地）**，明确**不上 L3**。理由同 §0 表格 + SurrealDB 评估里的同一条纪律：**单用户本地工具，不为理论优雅引入与规模不匹配的重栈。**

---

## 2. 现状：系统已经有一套"隐性本体"

专访 1.0 的 `ProductState` 是 25+ 个数组字段。把它们当作图来看，**节点（实体）和边（关系）其实都已存在**，只是：①散落在数组里靠字符串 id 互指；②**同一种语义的边用三种不同方式编码**。

### 2.1 已有实体（节点类）

| 实体类 | 代码类型 | 角色 |
|---|---|---|
| 专访 | `InterviewSession` | 一次对话 |
| 轮次 | `InterviewTurn`（冷层） | 对话的最小证据单元 |
| 双轨笔记 | `DualTrackNote` | 「说了什么 / 学到什么」 |
| 观点 | `Point` | 可验证、可修正的判断 |
| 问题 | `Question` | 待回访的开放问题 |
| 决策 | `Decision` | 需复盘的选择 |
| 知识债 | `KnowledgeDebt`（debts） | 待补齐的概念 |
| 主题线 | `Theme` | 跨专访累积的认知轴 |
| 长期记忆 | `MemoryRecord` | 确认入库、可召回 |
| 记忆候选/修正 | `MemoryCandidate` / `MemoryCorrection` | HITL 中间态 |
| 外部素材 | `ImportSource` / `RagChunk` / `SearchBrief` | 联网/导入资料 |
| 知识索引块 | `KnowledgeChunk`（冷层，派生） | RAG 召回单元 |
| 档案 | `UserProfile` / `ProfileSuggestion` | 用户画像（HITL 自学习） |
| 语料学习 | `CorpusImport` / `CorpusInsight` / `PlaybookPatch` | 导入专访学习 |
| 生成物 | `PodcastEpisode` / `ChatSession` | 派生产物 |

### 2.2 已有关系（边）—— 问题就在这里

| 语义 | 现在怎么编码 | 出现位置 |
|---|---|---|
| **溯源**（资产 ← 来自哪一轮发言） | `EvidenceAnchor { sessionId, turnId }`，作为 `evidenceAnchors?[]` / `keyQuoteAnchor` / `representativeQuoteAnchor` 内嵌在节点上 | Point/Question/Decision/Debt/Note/Theme/MemoryRecord |
| **归类**（资产 → 属于哪条主题线） | `relatedThemeIds?: string[]`，字符串 id 数组内嵌在节点上 | Point/Question/Decision/Debt/Note/Theme |
| **关联**（记忆 ↔ 主题） | 独立实体 `MemoryEdge { fromMemoryRecordId, themeId }`，单独成数组 | `state.memoryEdges` |
| **谱系**（问题 ← 由某条笔记提升而来） | 隐式，写在 `whyImportant` 文案里，无结构化字段 | `createQuestionFromNote` |
| **派生**（素材 → chunk → 索引块） | 靠 `sourceId` 跨表字符串关联 | importSources→ragChunks→knowledge_chunks |

**核心病灶**：上面是**同一类东西（实体间的有向有类型关系），却用了内嵌结构体 / 内嵌 id 数组 / 独立实体 / 纯文案 四种不一致的表示**。后果在系统审查里已逐条暴露：

- 删一个会话，它的 `transcript` 块、`relatedThemeIds` 反向引用、`EvidenceAnchor` 指向都可能变成**孤儿**（无统一的边管理 → 无法级联）。
- 召回逻辑要在 `collectRelevantMemories` 里**手工列举** notes/points/questions/decisions/themes（漏了 decisions 就是上次修的 bug）——因为没有"遍历所有指向该主题的实体"的统一图查询。
- `MemoryEdge` 只连"记忆↔主题"，而"观点↔主题"走 `relatedThemeIds`，**两套机制做同一件事**，主题聚合要分别处理。
- `attributeThemeIds` 用子串匹配硬猜归属——因为归属关系在抽取时没有被当作**一等的边**显式建立。

> 一句话：**本体已经在那里，只是没有被当作本体来管理。** 重构的本质是"提取 + 统一 + 显式化"，而不是"从零发明"。

---

## 3. 目标本体设计（显式化）

### 3.1 上层本体（meta-model）

只需三个一等概念：

```ts
// 一等节点：所有认知实体的统一外壳
interface EntityNode {
  id: string;
  kind: EntityKind;            // 'note' | 'point' | 'decision' | 'debt' | 'theme'
                               // | 'memory' | 'question' | 'session' | 'turn' | 'material' | ...
  attributes: Record<string, unknown>;  // 该 kind 的具体字段(沿用现有结构)
  createdAt: string;
  updatedAt: string;
}

// 一等边：所有关系的统一表示(取代内嵌 anchor / id 数组 / MemoryEdge 三套)
interface Relation {
  id: string;
  from: string;                // EntityNode.id
  to: string;                  // EntityNode.id
  type: RelationType;          // 见 3.3
  provenance?: Provenance;     // 这条边/这个事实从哪来(LLM 抽取? 用户确认? 启发式?)
  weight?: number;             // 关联强度(可选,用于召回排序)
  createdAt: string;
}

// 溯源：取代散落的 sourceType 字段,统一回答"这个事实可信吗、谁负责"
interface Provenance {
  origin: 'llm_extracted' | 'user_confirmed' | 'heuristic' | 'imported' | 'seed';
  sessionId?: string;
  turnId?: string;             // 证据链锚点统一并入这里
  confidence?: number;
}
```

要点：
- **`EntityNode.attributes` 内嵌现有结构**——不丢弃 `Point`/`Theme` 等已验证的字段定义，只是给它们套上统一外壳。迁移成本因此可控。
- **`Relation` 一举取代三套边编码**：`EvidenceAnchor`→`type:'derived_from'` 且 `provenance.turnId`；`relatedThemeIds`→`type:'belongs_to_theme'`；`MemoryEdge`→`type:'about_theme'`。
- **`Provenance` 把"溯源 + 来源类型 + 可信度 + 敏感来源"收敛成一处**，直接服务于审查发现的"敏感内容不该进 chat 召回""HITL 不能把推断当事实"——这些都变成对 `provenance.origin` 的统一过滤，而不是每条链路各写一遍。

### 3.2 实体分类法（taxonomy）

认知资产有共性，值得显式建一层父类（影响召回/展示/治理的统一处理）：

```
CognitiveEntity（认知实体：可溯源、可归类、可治理）
├── Utterance        言说类   → Turn(原始发言)
├── Distillation     蒸馏类   → Note / Point / Decision / Debt
├── Inquiry          追问类   → Question
├── Axis             主轴类   → Theme（跨实体聚合的轴）
├── Memory           记忆类   → MemoryRecord / Candidate / Correction
└── External         外部类   → ImportSource / RagChunk / SearchBrief
```

父类带来的统一能力：`治理`（按父类做 export/purge/敏感过滤）、`召回`（统一遍历"指向某主题的所有 Distillation+Inquiry+Memory"）、`证据`（所有 CognitiveEntity 都能 `derived_from` 某 Utterance）。这正是当前"每个数组各写一遍"的根除点。

### 3.3 关系类型表（带语义约束）

| RelationType | 定义域 → 值域 | 基数 | 语义 | 取代现状 |
|---|---|---|---|---|
| `derived_from` | CognitiveEntity → Turn | N:M | 证据溯源 | `EvidenceAnchor` |
| `belongs_to_theme` | Distillation/Inquiry → Theme | N:M | 归类到主轴 | `relatedThemeIds[]` |
| `about_theme` | Memory → Theme | N:M | 记忆挂主轴 | `MemoryEdge` |
| `promoted_from` | Question → Note | N:1 | 谱系 | 现仅文案 |
| `derives` | ImportSource → RagChunk → KnowledgeChunk | 1:N | 派生链 | `sourceId` 字符串 |
| `corrects` | MemoryCorrection → MemoryRecord | N:1 | 修正 | 隐式 |
| `contradicts` | Point ↔ Point | N:M | 张力（**新增能力**） | 无 |
| `evolves_into` | Theme(t) → Theme(t+1) | 1:1 | 主题演化（**新增能力**） | `appearances` 计数 |

最后两行是本体化后**新解锁**的认知能力：一旦关系是一等的，就能问"我有哪些互相矛盾的判断""这条主题怎么演化的"——这是当前架构很难做、而产品叙事很想要的。

### 3.4 公理 / 不变量（axioms）

本体的价值不止"建模"，还在于**可机器校验的领域规则**。把现在散落在各处的隐性约束变成显式公理，由一个一致性校验器统一执行：

```
A1  每个 Distillation 至少有一条 derived_from（无溯源的蒸馏=幻觉,拒绝入库或标记）
A2  Theme.maturity ≤ f(指向它的 belongs_to_theme 边数)   // 现 clampMaturityByAppearances 的本体化
A3  provenance.origin='llm_extracted' 的事实，未经 user_confirmed 不得呈现为"事实"  // HITL 公理化
A4  sensitivity='sensitive' 的 Memory 不产生进入 chat 索引的派生边（除非 policy 开）
A5  删除任一 EntityNode → 其所有出入边级联删除（根除孤儿,审查里的跨库一致性问题一次性解决）
```

A1/A2/A3/A4 现在都是**散落在 finalize/context-pack/knowledge 里、各写一遍、容易漏**的逻辑（审查发现的 bug 大多是"某条链路漏了某条规则"）。公理化 = 写一处、校验器统一兜底。

---

## 4. 架构方案（务实落地）

### 4.1 统一图层，纯函数不变

```
┌─────────────────────────────────────────────┐
│  域层纯函数 (state)=>state —— 仍然纯、可测     │
│  但内部不再手工遍历 25 数组,而是查图:          │
│    graph.neighbors(themeId, 'belongs_to_theme')│
│    graph.provenanceOf(pointId)                 │
│    axioms.check(state) → 违例清单              │
├─────────────────────────────────────────────┤
│  OntologyGraph（内存索引,从 ProductState 投影）│
│   nodes: Map<id, EntityNode>                   │
│   relations: Map<id, Relation> + 双向邻接索引   │
├─────────────────────────────────────────────┤
│  存储层 —— 不变。node:sqlite 单 blob + 冷层     │
│  （Relation/Node 就是 ProductState 里的字段,   │
│    或新增 relations:[] 一个数组）              │
└─────────────────────────────────────────────┘
```

关键决策：
- **存储不动**（呼应 SurrealDB 评估）。`OntologyGraph` 是从 `ProductState` **投影出来的内存索引**（像现在 knowledge_index 的关系），不是新数据库。JS 邻接表在数百~数千节点上遍历是微秒级。
- **纯函数范式不动**。`(state)=>state` 保留，只是把"手写 25 数组遍历"换成"查 graph + 校验 axioms"。148 个函数渐进改写、不是推倒。
- **LLM 抽取直接产出三元组**。`finalize` 不再返回"一堆数组 + 靠 `attributeThemeIds` 子串硬猜归属"，而是让 LLM 直接产出 `(实体, 关系, 溯源)` 三元组，归属关系在抽取时就显式建立——根除子串误匹配。

### 4.2 推理层（轻量、确定性，非 OWL reasoner）

不引入描述逻辑推理机。"推理"= 一组确定性纯函数，在图上跑：

- **传递闭包**：`Point --belongs_to_theme--> Theme`，`Theme --evolves_into--> Theme'` ⟹ 时间线自动连起。
- **矛盾检测**：两个 `Point` 同属一主题、状态/内容对立 → 生成 `contradicts` 边 + 提示用户复盘。
- **成熟度推导**：A2 公理直接作为推导规则。
- **召回**：从 query 实体出发的加权邻域遍历，替代现在 `collectRelevantMemories` 的手工列举。

### 4.3 与 LLM 的衔接

本体让 prompt 更可控：抽取时给 LLM **固定的关系类型表（§3.3）**作为 schema，要求输出受控三元组而非自由文本。这天然修复审查里"finalize 字段抽了没人消费""归属靠子串猜"——因为输出结构就是本体，消费方按本体遍历即可。

---

## 5. 迁移路径（分阶段，每阶段独立可交付、可叫停）

> 纪律：任意阶段结束系统都应是**绿的、可用的**。不存在"重构到一半不能用"的中间态。

### P0 · 写本体规范（1 份文档，0 运行时风险）
产出 `ontology.md`：实体分类法（§3.2）、关系类型表（§3.3）、公理（§3.4）。**这步本身就有价值**：它是后续所有抽取 prompt、召回逻辑、治理规则的单一事实源。可独立交付。

### P1 · 引入 `Relation` 统一边模型，先吞三套边
- 新增 `state.relations: Relation[]`（一个数组）+ `OntologyGraph` 投影 + 双向邻接索引。
- 写**适配器**：把现有 `EvidenceAnchor` / `relatedThemeIds` / `MemoryEdge` 读时投影成 `Relation`，写时双写。**新旧并存**，零破坏。
- TDD：图查询（neighbors/provenanceOf）+ 适配器幂等。
- 交付物：统一图查询可用，老字段仍在。**审查里的"删除级联/孤儿"问题在此阶段用 A5 公理 + 级联删除根治。**

### P2 · 召回/时间线/主题聚合改走图
- `collectRelevantMemories`、主题聚合、时间线从"手工列举数组"改为"图邻域遍历"。
- 收益立竿见影：再加一种认知资产，召回**自动覆盖**（不会再发生"漏了 decisions"）。
- 交付物：召回口径统一、可测；老的手工列举函数删除。

### P3 · 公理校验器 + 轻量推理
- `axioms.check(state)` 统一执行 A1–A5，接到 finalize/PUT 边界，违例记审计、必要时拦截。
- 抽取 prompt 改为产出受控三元组；`attributeThemeIds` 子串猜测下线。
- 新增 `contradicts` / `evolves_into` 推理 + 对应 UI（矛盾复盘、主题演化时间线）。
- 交付物：HITL/敏感/溯源规则从"各处手写"收敛为公理；解锁两项新认知能力。

### P4 · （可选）收敛 25 数组
- 当上面都稳定后，可把按 kind 散落的数组**收敛为 `nodes + relations` 两张表**，彻底单一表示。
- **这一步成本最高、收益最虚**（呼应 SurrealDB 评估对"大重写"的判断）。**默认不做**，除非 P1–P3 后确有维护痛点。本体的绝大部分价值在 P0–P3 已兑现。

---

## 6. 收益 / 成本 / 风险（诚实）

### 收益（按确定性排序）
1. **根治一类 bug**：跨库孤儿、删除不级联、召回漏类、归属靠猜、HITL/敏感规则各处漏写——这些审查反复出现的问题，本体化是它们的**共同根因解**。
2. **边际成本下降**：新增认知资产/关系/召回，从"改 N 处"变成"加一个 kind / 一种 RelationType"。
3. **解锁产品叙事**：矛盾检测、主题演化、"我的认知图谱"可视化——都依赖关系是一等的。
4. **LLM 更可控**：受控三元组输出，抽取质量与可消费性提升。

### 成本
- P0–P3 触及域层相当一部分函数与测试（但**渐进、适配器并存**，不是冻结式重写）。
- P4 才是大重写——**不默认做**。
- 一次性认知成本：团队/你需要接受"按图思考"。

### 风险与缓解
| 风险 | 缓解 |
|---|---|
| 渐进迁移期新旧两套边并存出歧义 | 适配器单向投影 + 写时双写，P2 末统一删老字段 |
| 过度抽象，EntityNode.attributes 退化成 `any` 大杂烩 | 保留每个 kind 的强类型 attributes（discriminated union），外壳统一但内核仍强类型 |
| "推理"膨胀成隐性魔法 | 推理只允许确定性纯函数 + 公理显式列举，禁止黑箱 |
| 投机做 P4 | 明确把 P4 标为可选，P0–P3 已兑现绝大部分价值 |

---

## 7. 决策建议

1. **现在就做 P0**（写本体规范）——零风险，且立即成为抽取/召回/治理的单一事实源。
2. **P1–P3 作为一条"认知图谱化"主线**渐进推进，每阶段独立交付、可叫停；优先级排在"新功能"和"修 bug"之间——因为它**顺手修一批根因 bug**。
3. **不上 L3 语义网**（OWL/RDF/SPARQL/reasoner）——规模不匹配，纯增风险。
4. **P4（收敛 25 数组）默认不做**，仅当 P1–P3 后出现明确维护痛点再单独立项。
5. **存储层不动**（与 SurrealDB 评估一致）：本体是领域模型层的事，与持久化正交。

### 何时该升级到 L3（触发条件，满足任一再评估）
- 走向多用户/多设备，需要跨实例的语义互操作。
- 需要对接外部知识库 / 开放数据（RDF 互操作成为真需求）。
- 推理复杂度超出确定性纯函数能表达（需要描述逻辑分类、一致性证明）。
- 实体规模到十万+，内存图遍历扛不住。

均不满足 → 务实本体（L2）是终点。

---

## 附录 A · 核心类型草案

```ts
type EntityKind =
  | 'session' | 'turn'
  | 'note' | 'point' | 'decision' | 'debt'   // Distillation
  | 'question'                                // Inquiry
  | 'theme'                                   // Axis
  | 'memory' | 'memory_candidate'             // Memory
  | 'material' | 'rag_chunk' | 'search_brief';// External

type RelationType =
  | 'derived_from' | 'belongs_to_theme' | 'about_theme'
  | 'promoted_from' | 'derives' | 'corrects'
  | 'contradicts' | 'evolves_into';

// 强类型内核 + 统一外壳：避免 attributes 退化成 any
type EntityNode =
  | { id: string; kind: 'point';  attributes: Point;  createdAt: string; updatedAt: string }
  | { id: string; kind: 'theme';  attributes: Theme;  createdAt: string; updatedAt: string }
  | { id: string; kind: 'memory'; attributes: MemoryRecord; createdAt: string; updatedAt: string }
  // … 每个 kind 一支,沿用现有结构定义
  ;

interface OntologyGraph {
  node(id: string): EntityNode | undefined;
  neighbors(id: string, type?: RelationType, dir?: 'out' | 'in'): EntityNode[];
  relationsOf(id: string): Relation[];
  provenanceOf(id: string): Provenance[];   // 沿 derived_from 回到 Turn
  add(node: EntityNode): void;
  link(rel: Relation): void;
  remove(id: string): void;                 // 级联删出入边(A5)
}
```

## 附录 B · 端到端示例：一轮专访如何变成本体

用户在某轮说："我决定把招聘权下放给团队，但我担心失控。"

**现状**：finalize 产出 → 一条 `Decision`（招聘权下放）+ 一条 `Point`（担心失控）→ 各自塞进 `decisions[]`/`points[]` → `attributeThemeIds` 子串猜"放权"主题 → `relatedThemeIds` 写 id → 证据锚点 `EvidenceAnchor` 内嵌 → 三套边、四处逻辑。

**本体化后**：finalize 让 LLM 直接产出受控三元组：

```
(decision:D1 "招聘权下放")  --derived_from-->  (turn:T7)   prov{llm_extracted, T7}
(point:P1 "担心失控")        --derived_from-->  (turn:T7)
(D1) --belongs_to_theme--> (theme:放权)
(P1) --belongs_to_theme--> (theme:放权)
(P1) --contradicts? --> (point:P0 "倾向亲自把关")        ← 推理层检出张力
```

下游全部按本体遍历：
- 召回：`neighbors(放权, 'belongs_to_theme')` 一次拿全（不会漏 decision）。
- 溯源：`provenanceOf(D1)` 直达 T7（统一，不分内嵌字段）。
- 治理：删 session → 级联删 T7 及其所有入边（无孤儿）。
- 新能力：P1 与历史 P0 的 `contradicts` 触发"认知张力"提示。

一处建模，处处一致——这就是本体论重构的价值所在。
