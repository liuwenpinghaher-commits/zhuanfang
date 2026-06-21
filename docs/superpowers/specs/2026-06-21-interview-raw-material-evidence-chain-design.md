# 设计：专访原始材料 / 证据链（Phase 1）

- 日期：2026-06-21
- 状态：待用户复审
- 范围：Phase 1（文本专访稿 + AI 思考 + 事后旁注 + 轮次级溯源 + 冷热拆分存储）
- 明确推迟：Phase 2（原始语音音频采集 / 存储 / 回放）—— 另立 spec

---

## 1. 背景与问题

双轨笔记（`DualTrackNote`）是 AI 蒸馏后的派生物（summary / keyQuote / saidTrack / learnedTrack），**不含原始材料**。用户提问："为什么没有原始信息（专访稿、原始 chat 的语音/文本/思考）？"

实测现状：

- **文本专访稿**：每一轮原文存在 `session.turns`（`InterviewTurn[]`，含 role/content/intent/timestamp/strategy/prosody），且不被裁剪——但**笔记/档案里只展示蒸馏结果，原文没露出**。
- **AI 思考**：`session.strategyTrace`（`InterviewStrategyDecision[]`：每轮为何这么问——strategy/reason/depth/referencedMemory/blindspotConcept）**已持久化，未展示**。
- **原始语音**：live 语音路径只流式播放，**不落盘**（仅留 prosody 数值，波形丢失）。
- **用户自己的思考**：除说出口的话外，未单独捕获。

→ 一半是"有数据没呈现"（文本 + AI 思考），一半是"根本没捕获"（语音 + 用户旁注）。

### 1.1 存储底座现状（关键约束）

- 整个 `ProductState` 序列化为**单个 JSON blob**（`product_state_snapshots.state_json TEXT`，一行，UPSERT 全量重写）。
- 前后端走**全量 PUT，请求体硬上限 28MB**（`REQUEST_BODY_LIMIT_BYTES`）。
- 每次保存把**完整 state 复制进 `product_state_events` 一行**（保留最近 N 条，retention DELETE）。
- 已有上限：`MAX_REVIEWED_CANDIDATES=200`、`MAX_EVENT_LOG=1000`。
- **当前 blob 已 ≈ 2.43 MB**（10 次专访 turns + 61 记忆 + 资产）。`session.turns` 已在热 blob 内，是最大增长项；粗算 ~100 次专访逼近 28MB，且**每次保存都付全量代价**，事件日志再翻倍。
- **融合现状**：live 系统只读**当前会话**的 turns（context-pack）；**过去会话的 turns 从不被召回**——目前"只写不读"。

→ 结论：单 blob + 全量 PUT 模型扛不住专访稿累积；音频（Phase 2）绝不能进此 blob。"怎么存"必须重新设计。

---

## 2. 目标与非目标

### 目标（Phase 1）
1. 把已有原始材料（专访稿 + AI 思考）**呈现**出来。
2. 建立**轮次级证据链**：任意派生资产（记忆/主题/笔记/观点/决策/知识债）↔ 产生它的具体轮次，双向可达。
3. **事后旁注**：在查看器里对某一轮加用户旁注（第三轨原始材料）。
4. **冷热拆分存储**：解决单 blob 膨胀，为音频 Phase 2 铺路。
5. 与现有记忆系统 / 主题线打通（兑现"累积认知原料 / 证据链"这一首要目的）。

### 非目标
- 原始语音音频采集/存储/回放（Phase 2，另立 spec）。
- 实时（访谈中）旁注——本期只做事后回看批注。
- 字符级证据范围——轮次级（turnId）足够"跳到那一刻"。
- 独立 RawMaterial 顶层实体抽象——复用 `session.turns`，只做存储分层。
- 把源句重新喂进未来召回的 prompt（避免膨胀；留待后续）。

---

## 3. 架构：冷热两层

### 热层（`ProductState` blob，保持小而快，进全量 PUT）
- 全部派生资产 + 轻量 `evidenceAnchors`（仅 id 引用）。
- 双轨笔记。
- `interviewAnnotations[]`（顶层数组，**加上限**）。
- **当前活跃/进行中会话**：保留完整 `turns`（live context-pack 需要）。
- **已完成会话**：保留元数据（id/title/dates/qualityReport/relatedThemeIds）；`turns: []` + 显式标记 `rawMaterialOffloaded: true`（见 §4）；**不再保留 strategyTrace**。前端据此标记决定"读热层 turns（活跃会话）还是懒加载冷层（已降冷会话）"。

### 冷层（新建 SQLite 表 `interview_raw_material`，按 sessionId 一行，不进全量 PUT）
```sql
CREATE TABLE IF NOT EXISTS interview_raw_material (
  session_id          TEXT PRIMARY KEY,
  turns_json          TEXT NOT NULL,   -- InterviewTurn[]
  strategy_trace_json TEXT,            -- InterviewStrategyDecision[]（AI 思考）
  created_at          TEXT NOT NULL
);
```
- 在 finalize 后由路由层写入；按需懒加载（`GET /api/sessions/:id/raw-material`）。
- Phase 2 的音频引用/段落落在此层（或并列的 blob 表）。

### 仓储抽象
- 新增 `RawMaterialRepository` 接口：`get(sessionId)` / `put(sessionId, material)` / `delete(sessionId)` / `deleteAll()`。
- 两套实现：内存（测试）+ SQLite（生产），与现有 `ProductStateRepository` 双实现一致。

---

## 4. 数据模型（新增类型）

```ts
// 证据锚点：资产 → 来源轮次
export interface EvidenceAnchor { sessionId: string; turnId: string; }

// 给关键派生资产加可选锚点（向后兼容；老数据无则空）
//   MemoryRecord / MemoryCandidate / PointAsset / DecisionAsset / KnowledgeDebt
//     + evidenceAnchors?: EvidenceAnchor[]
//   DualTrackNote + keyQuoteAnchor?: EvidenceAnchor
//   LongTermTheme：representativeQuote 的出处（先只锚 keeper 一条；轻量）

// 用户旁注（事后第三轨）
export interface InterviewAnnotation {
  id: string;
  sessionId: string;
  turnId: string;      // 锚定的轮次
  text: string;
  createdAt: string;
}
// ProductState + interviewAnnotations: InterviewAnnotation[]   // 顶层,便于 purge,与 memoryCorrections 同模式

// 冷层载荷
export interface InterviewRawMaterial {
  sessionId: string;
  turns: InterviewTurn[];
  strategyTrace: InterviewStrategyDecision[];
  createdAt: string;
}
```
`InterviewTurn` 已有稳定 `id` → 锚点 = `sessionId + turnId`。

降冷标记（避免"空 turns 是降冷还是真没说话"的歧义）：
```ts
// InterviewSession + rawMaterialOffloaded?: boolean
//   true  → turns/strategyTrace 已搬到 interview_raw_material 冷层,需懒加载
//   未设/false → turns 在热层（活跃/进行中会话）
```

---

## 5. 溯源生成（正确性核心）

finalize-llm 已要求 LLM "逐字摘录"用户原话作 evidenceQuote。

- **新增纯函数** `resolveEvidenceAnchors(quote: string, turns: InterviewTurn[]): EvidenceAnchor[]`：把逐字引用匹配到来源 turn（精确包含 → 归一化包含的退化匹配）；匹配不到**留空，绝不伪造**。
- **在 domain finalize 内**（turns 仍在手时）给各资产盖锚点——保持 domain 纯函数、离线安全。
- **存量回填**：一次性 backfill，对现有会话资产用同一匹配补锚点（逐字引用命中率高）；幂等（已有锚点不重复加）。

---

## 6. 降冷流程（在路由层，保持 domain 纯）

domain `finalizeSession` 不变（仍产出含完整 turns + 锚点的完整 state）。`POST /api/interview-sessions/:id/end` 路由处理器在 finalize 之后：

1. 取刚完成会话的 `{ turns, strategyTrace }`。
2. 写入 `RawMaterialRepository.put(sessionId, material)`（冷层）。
3. 把热 state 里该会话的 `turns` 置空、`strategyTrace` 移除（只留元数据 + 标记）。
4. `replaceState(hot)`。

这样 domain 不感知冷热；拆分只发生在持久化边界。

---

## 7. 懒加载端点

`GET /api/sessions/:id/raw-material` → `RawMaterialRepository.get(id)` → `InterviewRawMaterial`（turns + strategyTrace）。打开查看器 / 点"查看出处"时才拉。404 当不存在（如老数据未回填 / 活跃会话改读热层 turns）。

---

## 8. 旁注捕获（事后）

查看器里每轮"加旁注" → 纯域函数 `addAnnotation(state, sessionId, turnId, text)` / `removeAnnotation(state, id)` → `onSetProductState` + 现有 autosave（与边界/记忆修正同模式，**无新端点**）。`interviewAnnotations` 设上限（如 500，防 unbounded growth）。

---

## 9. 证据链查看器（UI）

双轨笔记每条加"查看原始材料" → 打开**专访稿面板**（NotesView 内展开或独立档案视图）：
- 逐轮原文（角色/内容/时间）；assistant 轮内联展示 AI 思考（strategyTrace）。
- 每轮右侧"→ 由此产生：[记忆][观点][决策]"（反向溯源，由资产锚点交叉索引）。
- 每轮可加/看用户旁注（第三轨）。
- 别处（记忆库/主题线/资产）的"查看原文出处"链接 → 打开面板并滚动到锚定轮次（懒加载冷层）。

---

## 10. 融合使用（证据链进认知循环）

- **资产→源头**：记忆/主题/笔记锚点 → 懒加载冷层 → 跳到那一句（核心兑现）。
- **源头→产物**：查看器反向展示每轮产生了哪些资产。
- **导出**：export 端点打包热 state + 全部冷层原始材料（一并可恢复）。
- **清除**：purge 的 interviews / all scope **同时清冷层行**（`RawMaterialRepository.deleteAll()` 或按 sessionId），隐私闭环。
- **召回（未来，非本期）**：有锚点后，未来可让召回带回精确源句。

---

## 11. 迁移

一次性迁移（normalize 阶段或一次性脚本）：

1. 现有已完成会话的 `turns + strategyTrace` → 写入冷层。
2. 从热 blob 剥离这些 turns（活跃会话不动）。
3. 跑 §5 回填给现有资产补锚点。

副作用：热 blob 从 2.43MB 显著缩小（专访稿是大头）。迁移幂等、可重入。

---

## 12. 测试

- TDD（纯函数）：`resolveEvidenceAnchors`（逐字命中 / 归一化命中 / 不命中留空 / 多轮）、`addAnnotation` / `removeAnnotation`（增删/不可变/上限/审计）、回填幂等。
- 仓储：`RawMaterialRepository` 内存 + SQLite 双实现的 get/put/delete/deleteAll 单测。
- 路由：`/end` 降冷后热 state 不含完成会话 turns、冷层可取回；`GET raw-material` 200/404。
- 迁移：对一份含完整 turns 的旧 state 跑迁移 → 热层剥离 + 冷层落地 + 锚点回填，且幂等。
- UI：查看器跳转 / 反向溯源 / 旁注增删手测。
- 全量回归（当前 86 测试文件全绿不破）。

---

## 13. 范围边界 / 风险

- **审计事件类型**：新增 `annotation_created` / `annotation_removed`（沿用 entityType `interview_session`）。
- **读取完成会话 turns 的旧代码**：迁移前需审计所有 `session.turns` 读点，确认除"活跃会话 context-pack"外，其余（导出/质量报告/反向溯源）都改走冷层或在 finalize 前完成。质量报告已在 finalize 时算，无碍。
- **锚点指向冷层 turn**：热层只有 id，解析需懒加载——查看器/跳转已按需加载，无热路径依赖。
- **回填命中率**：逐字引用命中高，但 LLM 偶有改写 → 留空（不伪造），可接受。
- **YAGNI**：不做音频、实时旁注、字符级范围、独立 RawMaterial 实体、召回带源句。
