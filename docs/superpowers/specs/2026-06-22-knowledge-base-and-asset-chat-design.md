# 设计：素材库 + 统一知识索引 + 资产对话（个人知识库 + Chat）

- 日期：2026-06-21
- 状态：待用户复审
- 范围：一份合并设计，三块联动——素材库（导入）→ 统一知识索引（knowledge_chunks）→ 资产对话（通用助手 chat）
- 存储方向：维持现状 `node:sqlite` + 整状态范式（SurrealDB 评估见 `2026-06-21-surrealdb-migration-evaluation.md`，结论：当前不迁）

## 1. 目标
在「认知资产」组加两个视图：**素材库**（导入/管理个人资料）和**资产对话**（基于全部认知资产的通用 AI 助手，带引用）。底座是把所有来源切块+嵌入的**统一知识索引**。最大化复用现有 embedding / LLM / RAG 召回逻辑。

## 2. 现有可复用基建
- `POST /api/import/documents` → `ingestImportSource`：文本 → `ImportSource` + 嵌入 `ragChunks` + 抽记忆候选。
- `POST /api/rag/query`：嵌入召回 + LLM 带引用作答（现仅检索 ragChunks）。
- `embeddingClient`（Bailian，1024 维）、`cosineSimilarity`、`buildSemanticRagContext`、per-session LLM 预算、离线兜底。
- 冷热分层范式（raw-material/audio 独立 SQLite，不进 ProductState blob）。

## 3. 数据模型

### 3.1 统一知识索引（独立 SQLite，派生、可重建，**不进 ProductState blob**）
新仓 `KnowledgeIndexRepository`（内存 + sqlite 双实现，镜像 raw-material）：
```ts
export type KnowledgeSourceType =
  | "note" | "memory" | "theme" | "point" | "decision" | "debt" | "transcript" | "material";

export interface KnowledgeChunk {
  id: string;
  sourceType: KnowledgeSourceType;
  sourceId: string;        // 指向来源资产/会话/素材的 id（引用跳转用）
  title: string;           // 来源标题/简述（引用展示用）
  text: string;            // 该块文本
  keywords: string[];      // 关键词兜底检索
  embedding?: number[];    // 1024 维；缺省退化为关键词检索
  createdAt: string;
}
```
表 `knowledge_chunks(id PK, source_type, source_id, title, text, keywords_json, embedding_json, created_at)`。按 sourceId 可批量删/重建。

### 3.2 Chat 会话（**整合进 ProductState**，带上限）
```ts
export interface ChatCitation { sourceType: KnowledgeSourceType; sourceId: string; title: string; snippet: string; }
export interface ChatMessage { id: string; role: "user" | "assistant"; content: string; citations?: ChatCitation[]; createdAt: string; }
export interface ChatSession { id: string; title: string; messages: ChatMessage[]; createdAt: string; updatedAt: string; }
// ProductState + chatSessions: ChatSession[]
```
随客户端整状态同步。封顶 `MAX_CHAT_SESSIONS`（如 50，超出按 updatedAt 淘汰旧的）+ 单会话 `MAX_CHAT_MESSAGES`（如 200）防 blob 膨胀。normalize/seed/empty/purge/migration 接入（同 interviewAnnotations 模式）。

## 4. 切块与嵌入（纯函数）
`buildKnowledgeChunks(state, rawMaterialBySession): KnowledgeChunk[]`（纯函数，离线安全）：
- **蒸馏资产**（note/memory/theme/point/decision/debt）：每条 → 一块（短文本，标题 + 正文拼成可检索文本）。
- **transcript**：从冷层 raw-material 取 turns，按 user 轮（或滑窗）切块，sourceId = sessionId + turnId 锚。
- **material**：复用 importSources 的 ragChunks 文本（sourceType="material"，sourceId=importSourceId）。
- 嵌入在仓储/路由层用 `embeddingClient` 批量补；无 client/超预算 → embedding 留空、走关键词。**绝不阻塞**。

## 5. 增量索引（全量，靠持久化边界 diff）
不接进 148 个域函数。在**持久化边界**（route 调 `replaceState(next)` 处，封装一个 `reindexOnStateChange(prev, next)`）：
- diff 新旧 state 的可索引资产（按 id 比对 note/memory/theme/point/decision/debt 的增/改/删）→ 对变化的来源 `knowledgeIndex.deleteBySource(...)` + 重建该来源的块（重嵌）。
- transcript：在 `/end` 降冷后，对该会话补索引（已有 raw-material 写入点）。
- material：`/api/import/documents` 后对该 importSource 补索引。
- **手动「重建知识索引」端点/按钮**：全量回填/刷新（存量数据 + 修复）。
- 嵌入批量、异步友好、离线兜底；增量失败只 warn，不阻塞主写。

## 6. 资产对话（通用助手 + 检索 + 引用）
- `POST /api/chat`（body `{ sessionId?, message }`）：
  1. 嵌入 message（或关键词）→ 从 knowledge_chunks 召回 top-K（余弦 + 关键词兜底，跨源混排）。
  2. 组 prompt：**通用 AI 助手**人设 + 召回片段（编号）+ 近 N 轮历史 + 用户 message。指令：「优先依据下面用户自己的资料回答，用到哪条就标注其编号作引用；资料不足时可基于常识与推理补充，但要说明哪些是资料、哪些是你的推断；不要把推断伪装成用户资料。」（**通用助手**：不限定只答资料内、可自由推理，但诚实区分来源。）
  3. LLM 作答 → 解析/附引用（命中的 chunk → ChatCitation）→ 追加 user+assistant 两条消息进 ChatSession（新建或追加）→ 返回 `{ session, answer, citations }`。
  4. 离线/超预算：诚实降级（"对话暂不可用，请稍后"），不伪造。
- **端点收敛**：因 chatSessions 在 ProductState，**只需一个 `POST /api/chat` 端点**（做检索+LLM+追加，返回新 state，前端 adopt）。会话列表/新建/删除/改标题走 domain 纯函数（`createChatSession`/`renameChatSession`/`deleteChatSession`）+ 现有 autosave，**不另设 GET/DELETE 端点**。
- 引用可点：transcript → 证据链查看器跳轮；memory/asset → 跳对应条目（复用 §证据链已有跳转）。

## 7. UI（认知资产组两个新视图）
- 导航：`ui.ts` groupedNavigation「认知资产」组加 `material`（素材库）、`asset-chat`（资产对话）；`View` 类型 + navIcon 补。
- **素材库 `MaterialLibraryView`**：导入框（粘贴 / `.txt`·`.md` 文件读为文本 → `/api/import/documents`）+ 列表（importSources：标题/类型/日期/块数/敏感度/软归属主题）+ 删除 + **「重建知识索引」**按钮（含进度/结果提示）。
- **资产对话 `AssetChatView`**：左侧会话列表（新建/历史/删除）+ 右侧消息流（用户/助手气泡）+ 引用条（可点跳源）+ 输入框（发送调 POST /api/chat）。加载/空/错误/离线降级态。

## 8. 治理 / 隐私
- knowledge_chunks：派生、可重建 → **不进导出**（导入后点「重建索引」即可）；随 all-purge 清（`knowledgeIndex.deleteAll()`）。
- chatSessions：个人数据，在 ProductState → 随 export 走、随 all-purge 清（整状态清空即清）。
- importSources（素材）：已在 state，随治理走；删除素材时一并删其 knowledge_chunks（sourceId）。

## 9. 测试
- 纯函数 TDD：`buildKnowledgeChunks`（各 sourceType 切块/离线无嵌入）、检索排序（余弦+关键词兜底+混排+topK）、接地 prompt 组装、chat 域函数（新建/追加/封顶淘汰/删除）、`reindexOnStateChange` 的 diff（增/改/删→正确增删块、幂等）。
- 仓储双实现 TDD：KnowledgeIndexRepository（put/get/query/deleteBySource/deleteAll/listAll；embedding_json 往返）。
- 端点 TDD：POST /api/chat（检索+LLM mock+引用+追加+离线降级）、重建索引端点。
- UI：tsc + 手测（导入→重建→对话→点引用跳源）。
- 全量回归不破（当前 95 测试文件）。

## 10. 范围边界 / YAGNI
- v1：仅文本/`.txt`/`.md` 导入（无 PDF/OCR/图片）。
- 增量索引按 §5 diff（覆盖编辑），但嵌入是 best-effort（无 client 走关键词）。
- 通用助手 chat：检索 + 引用 + 自由推理，但**不联网、无 agent 工具调用、无多文档对比工作流**（后续）。
- 单一嵌入模型（复用现有）；不引向量数据库（评估见 SurrealDB 文档，JS 余弦在本规模足够）。
- 引用解析：LLM 标编号 + 服务端映射回 chunk；不做精确 span 高亮（轮级/条级即可）。

## 11. 里程碑（供 writing-plans 拆）
1. 类型 + KnowledgeIndexRepository（内存+sqlite）+ chatSessions 接 ProductState 管道。
2. buildKnowledgeChunks + 嵌入补全 + 重建索引端点（全量回填）。
3. reindexOnStateChange（持久化边界 diff 增量）+ /end、import 索引补点。
4. chat 域函数（会话 CRUD/封顶）+ POST /api/chat（检索+接地通用 prompt+引用+离线降级）。
5. 素材库 UI + 导航。
6. 资产对话 UI（会话列表+消息流+引用跳源）+ 导航。
7. 治理（purge 清索引、删素材连带删块）+ 全量回归。
