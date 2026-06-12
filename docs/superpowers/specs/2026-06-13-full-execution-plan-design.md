# 语音专访式日记工具 — 完整执行计划

> 日期: 2026-06-13
> 状态: 已确认

---

## 一、策略总览

| 决策 | 选择 |
|------|------|
| 基线版本 | 根项目为主，合并 zhuanfang 增强功能 |
| 覆盖范围 | 完整实现全部 8 个 Phase |
| Mastra 深度 | 完整深度集成（Agent/Workflow/Tool/Memory/RAG/GraphRAG/Observability/Evals） |
| 数据库 | 渐进式迁移：SQLite → PostgreSQL（Phase 5 时迁移） |
| 执行顺序 | 先合并 zhuanfang + 修复 → Phase 2→4→5→3→6→7→8 |

---

## 二、执行阶段

### 阶段一：合并 zhuanfang + 修复现有问题

**目标**：将 zhuanfang 分支的增强功能合并到根项目，修复 2 个 E2E 测试失败。

#### 2.1 合并清单

| 模块 | zhuanfang 源文件 | 根项目目标 |
|------|-----------------|-----------|
| 类型系统 | `zhuanfang/src/domain/types.ts` (1053行) | 替换 `src/domain/types.ts` (407行) |
| 备份 | `zhuanfang/src/domain/backup.ts` | 新增 `src/domain/backup.ts` |
| 隐私 | `zhuanfang/src/domain/privacy.ts` | 新增 `src/domain/privacy.ts` |
| 记忆审查 | `zhuanfang/src/domain/memoryReview.ts` | 新增 `src/domain/memoryReview.ts` |
| 状态摘要 | `zhuanfang/src/domain/stateDigest.ts` | 新增 `src/domain/stateDigest.ts` |
| 迁移检查 | `zhuanfang/src/domain/migration.ts` | 新增 `src/domain/migration.ts` |
| PG 迁移包 | `zhuanfang/src/domain/postgresMigration.ts` | 新增 `src/domain/postgresMigration.ts` |
| 记忆记录路由 | `zhuanfang/apps/api/src/routes/memory-records.ts` | 新增 |
| 记忆候选路由 | `zhuanfang/apps/api/src/routes/memory-candidates.ts` | 新增 |
| 记忆修正路由 | `zhuanfang/apps/api/src/routes/memory-corrections.ts` | 新增 |
| 笔记路由 | `zhuanfang/apps/api/src/routes/notes.ts` | 新增 |
| 资产路由 | `zhuanfang/apps/api/src/routes/assets.ts` | 新增 |
| Playbook 路由 | `zhuanfang/apps/api/src/routes/playbook-patches.ts` | 新增 |
| 产品配置路由 | `zhuanfang/apps/api/src/routes/product-config.ts` | 新增 |
| 生成物路由 | `zhuanfang/apps/api/src/routes/generated-artifacts.ts` | 新增 |
| 工作流运行时 | `zhuanfang/apps/api/src/workflow-runtime.ts` | 新增 |
| 本地对象存储 | `zhuanfang/apps/api/src/local-object-artifacts.ts` | 新增 |
| 存储配置 | `zhuanfang/apps/api/src/storage-config.ts` | 新增 |
| 提供商错误 | `zhuanfang/apps/api/src/provider-error.ts` | 新增 |
| 请求超时 | `zhuanfang/apps/api/src/request-timeout.ts` | 新增 |
| 专访轮次运行器 | `zhuanfang/apps/api/src/interview-turn-runner.ts` | 新增 |
| 外部搜索 | `zhuanfang/apps/api/src/providers/external-search.ts` | 新增 |
| Docker | `zhuanfang/Dockerfile` | 新增 |
| Docker Compose | `zhuanfang/docker-compose.yml` | 新增 |
| 开发脚本 | `zhuanfang/scripts/dev-full.mjs` | 新增 `scripts/` |
| 生产环境变量 | `zhuanfang/.env.production.example` | 新增 |
| Docker 忽略 | `zhuanfang/.dockerignore` | 新增 |
| README | `zhuanfang/README.md` | 更新 |

#### 2.2 修复项

- 修复 E2E 测试：`corpus-podcast` (保存默认语音) 和 `search` (设置默认搜索提供商)
- 合并后运行全量测试确保无回归

---

### 阶段二：核心能力建设

#### 3.1 Phase 2: Mastra 深度集成

##### 3.1.1 Agent 体系（10 个）

| Agent | 职责 | 依赖工具 |
|-------|------|---------|
| InterviewDirectorAgent | 主持专访：生成问题、追问、挑战、回调 | productDbTool, ragTool, mastraMemoryTool, graphTool |
| ContextPackBuilderAgent | 构建上下文包：聚合用户画像、历史观点、长期主题 | productDbTool, mastraMemoryTool, ragTool, graphTool |
| AssetExtractorAgent | 从对话中提取观点/问题/决策/知识债务 | productDbTool |
| MemoryCandidateAgent | 生成记忆候选并评分 | productDbTool, scorerTool |
| MemoryConsolidationAgent | 检测记忆演化/矛盾，合并/更新记忆 | productDbTool, mastraMemoryTool, scorerTool |
| ImportClassifierAgent | 分类导入资料类型和主题 | productDbTool, documentParseTool |
| TranscriptCleanerAgent | 清洗转写文本、分段、去噪 | asrTool |
| InterviewTechniqueAnalystAgent | 分析专访技巧质量，生成反馈 | productDbTool, scorerTool |
| PodcastGeneratorAgent | 从双轨笔记生成播客脚本 | productDbTool, ragTool, ttsTool |
| SensitiveReviewAgent | 审查敏感内容，标记隐私级别 | productDbTool, scorerTool, auditLogTool |

##### 3.1.2 Workflow 体系（12 个）

```
interviewPreparationWorkflow
  ├── ContextPackBuilderAgent → 构建上下文包
  └── InterviewDirectorAgent → 生成开场问题和引导策略

contextPackBuildWorkflow
  ├── productDbTool → 获取用户画像
  ├── mastraMemoryTool → 获取近期记忆
  ├── ragTool → 语义检索相关记忆
  └── graphTool → GraphRAG 关系扩展

liveInterviewAssistWorkflow
  ├── InterviewDirectorAgent → 实时生成追问/挑战
  ├── ContextPackBuilderAgent → 动态更新上下文
  └── MemoryCandidateAgent → 实时标记潜在记忆

postInterviewExtractionWorkflow
  ├── AssetExtractorAgent → 提取四类资产
  ├── MemoryCandidateAgent → 生成记忆候选
  └── InterviewTechniqueAnalystAgent → 生成技巧反馈

memoryCandidateReviewWorkflow
  ├── MemoryCandidateAgent → 评分排序
  ├── MemoryConsolidationAgent → 检测演化/矛盾
  └── SensitiveReviewAgent → 敏感度标记

memoryProjectionWorkflow
  ├── mastraMemoryTool → 投影到工作记忆
  └── graphTool → 构建关系图

importIngestionWorkflow
  ├── ImportClassifierAgent → 分类
  ├── TranscriptCleanerAgent → 清洗（音频）
  └── documentParseTool → 解析（文档）

audioTranscriptionWorkflow
  ├── asrTool → 语音转文字
  └── TranscriptCleanerAgent → 清洗分段

documentIngestionWorkflow
  ├── documentParseTool → 解析文档
  └── ragTool → 分块 + embedding + 存储

referenceInterviewLearningWorkflow
  ├── ImportClassifierAgent → 分析参考专访
  └── AssetExtractorAgent → 提取可学习模式

podcastGenerationWorkflow
  ├── PodcastGeneratorAgent → 生成脚本
  └── ttsTool → 合成音频

memoryMaintenanceWorkflow（定时/Background Task）
  ├── MemoryConsolidationAgent → 定期整理
  └── MemoryCandidateAgent → 发现新候选
```

##### 3.1.3 Tool 体系（12 个）

| Tool | 用途 | 实现方式 |
|------|------|---------|
| productDbTool | 读写产品状态 | 封装 Product API |
| objectStorageTool | 音频/文档存储 | 本地文件系统 → S3 |
| ragTool | 语义检索 | pgvector + embedding |
| mastraMemoryTool | 工作记忆/语义记忆 | Mastra Memory API |
| graphTool | 知识图谱关系扩展 | Mastra GraphRAG |
| searchProviderTool | 外部搜索 | Bailian/AnySearch/Tavily/Exa/Brave |
| asrTool | 语音识别 | Bailian ASR |
| ttsTool | 语音合成 | Bailian CosyVoice |
| documentParseTool | 文档解析 | PDF/DOCX/Markdown/HTML |
| webFetchTool | 网页抓取 | HTTP + HTML→Markdown |
| scorerTool | 评分/评估 | Mastra Evals |
| auditLogTool | 审计日志 | audit_events 表 |

##### 3.1.4 Mastra 能力矩阵

| 能力 | 用途 | 优先级 |
|------|------|--------|
| Memory | 工作记忆 + 语义回忆 + 观察记忆 | P0 |
| RAG | 分块 + embedding + pgvector 检索 + 重排序 | P0 |
| Studio | 本地调试 | P0 |
| GraphRAG | 关系扩展，连接相关记忆 | P1 |
| Observability | 追踪、成本、延迟 | P1 |
| Evals/Scorers | 8 个评分器 | P1 |
| Background Tasks | 长时运行操作（导入、记忆维护） | P1 |
| Approval/HITL | 危险操作人工审批 | P2 |
| MCP | 暴露产品记忆为 MCP 服务 | P2 |

---

#### 3.2 Phase 4: 长期记忆系统

##### 3.2.1 数据模型

```
memory_records
├── id, content, type (point/question/decision/debt)
├── status: draft → candidate → confirmed → superseded → deprecated
├── sensitivity: normal | sensitive | private | restricted
├── confidence_score, source_session_ids, evidence_count
├── created_at, last_confirmed_at, last_challenged_at

memory_edges
├── source_id → target_id
├── relation: EVIDENCED_BY | DERIVED_FROM | CONFIRMS | CHALLENGES
│             | CONTRADICTS | EVOLVES_FROM | SUPPORTS | WEAKENS
├── confidence, evidence

memory_candidates
├── content, suggested_type, source_context
├── scores: relevance/novelty/confidence/importance
├── reviewer_decision: pending | approved | rejected | merged
```

##### 3.2.2 生命周期

```
用户发言 → AssetExtractor 提取资产
  → MemoryCandidateAgent 生成候选 + 评分
    → HITL 审核（approve/reject/merge）
      → 确认后写入 memory_records
        → MemoryConsolidationAgent 定期检测演化/矛盾
          → 创建 memory_edges 关系
            → 过期记忆标记 superseded/deprecated
```

##### 3.2.3 上下文包构建（每次专访前）

```
ContextPackBuilderAgent 聚合：
├── 用户画像（profile）
├── 近期记忆（Mastra Memory 工作记忆）
├── 相关长期记忆（pgvector 语义检索 top-K）
├── 活跃主题（long_term_themes）
├── 未解决的知识债务（knowledge_debts）
├── 上次专访未完成的追问
└── GraphRAG 关系扩展（从相关记忆展开关联记忆）
```

---

#### 3.3 Phase 5: 导入 & RAG 系统

##### 3.3.1 导入管道

```
用户上传 → 类型检测
  ├── 音频 → ASR 转写 → TranscriptCleanerAgent 清洗分段
  └── 文档 → documentParseTool 解析 → 分段

→ ImportClassifierAgent 分类（主题、类型、质量）
  → 分块策略（semantic-markdown / recursive / sentence）
    → embedding 生成 → pgvector 存储
      → 生成 CorpusInsight（摘要、关键观点、与现有记忆的关联）
```

##### 3.3.2 RAG 检索流程

```
用户提问/专访上下文
  → embedding 查询
    → pgvector 混合检索（语义 + 关键词）
      → 重排序（rerank）
        → GraphRAG 关系扩展
          → 返回结构化上下文
```

##### 3.3.3 存储策略

| 层级 | 技术 | 内容 |
|------|------|------|
| 对象存储 | 本地文件系统 → S3 | 原始音频、文档、衍生文件 |
| 向量数据库 | pgvector | embedding + 元数据 |
| 关系数据库 | PostgreSQL | memory_records, import_sources, rag_chunks 等 |
| 图数据库 | GraphRAG | 知识图谱关系 |

---

### 阶段三：体验 + 运维

#### 4.1 Phase 3: 搜索情报增强

| 能力 | 当前状态 | 增强目标 |
|------|---------|---------|
| 搜索提供商 | Bailian + AnySearch | 新增 Tavily、Exa、Brave（从 zhuanfang 合并） |
| SearchBrief 生成 | 手动触发 | 自动从用户主题/知识债务生成搜索简报 |
| 来源管理 | 无 | 去重、新鲜度评分、可信度标记 |
| 话题发现 | 无 | 自动聚类 + 热点趋势发现 |

**搜索工作流**：

```
用户主题/知识债务
  → 自动生成 SearchBrief（问题 + 搜索策略）
    → 多提供商并行搜索
      → 结果聚合 + 去重 + 排序
        → 生成结构化简报（摘要 + 来源 + 可信度）
          → 关联到对应主题/债务
```

#### 4.2 Phase 6: 播客工作室增强

| 能力 | 当前状态 | 增强目标 |
|------|---------|---------|
| 脚本生成 | 本地 demo 规则 | Mastra PodcastGeneratorAgent 驱动 |
| 输入源 | 双轨笔记 | 扩展：SearchBrief、长期主题、知识债务 |
| 多说话人 | 无 | 主持人 + 嘉宾双人格式 |
| 来源标注 | 无 | shownotes 带来源归属 |
| 脚本编辑 | 无 | 生成后确认编辑 UI |
| 音频播放 | 无 | 前端内嵌播放器 |

#### 4.3 Phase 7: 实时语音增强

| 能力 | 当前状态 | 增强目标 |
|------|---------|---------|
| WebRTC 连接 | SDP 代理骨架 | 完整信令 + 媒体传输 |
| 轮流发言 | 无 | 状态机：user_speaking → short_pause → long_pause → assistant_speaking → interrupted |
| 反向通道 | 无 | 短反馈（"嗯"、"明白了"、"继续"） |
| 打断处理 | 无 | 用户打断时立即停止 TTS |
| 记忆回调 | 无 | 专访中实时检索相关记忆 |
| 上下文预算 | 无 | 动态管理 token 预算 |
| InterviewDirector | 无 | Agent 实时控制专访节奏 |

#### 4.4 Phase 8: 质量 & 运维

##### 4.4.1 8 个评分器

| 评分器 | 评估维度 | 类型 |
|--------|---------|------|
| InterviewNaturalnessScorer | 对话自然度 | 模型评分 |
| FollowupRelevanceScorer | 追问相关性 | 模型评分 |
| MemoryCitationScorer | 记忆引用准确性 | 规则 + 模型 |
| MemoryCandidatePrecisionScorer | 记忆候选精确度 | 规则评分 |
| SensitiveLeakageScorer | 敏感信息泄露 | 规则评分 |
| ContextPackRelevanceScorer | 上下文包相关性 | 模型评分 |
| SourceFaithfulnessScorer | 来源忠实度 | 规则评分 |
| InterviewFeedbackScorer | 用户反馈聚合 | 规则评分 |

##### 4.4.2 运维基础设施

```
audit_events 表 → 关键操作审计追踪
ai_run_events → 成本、延迟、失败率监控
Langfuse / OpenTelemetry → 可观测性
CI 集成 → 规则评分器自动运行
生产采样 → 模型评分器定期评估
```

---

## 三、数据库渐进式迁移策略

```
当前: SQLite (Drizzle ORM)
  ↓
阶段二开始: 添加 PostgreSQL 支持（Drizzle pg）
  ├── 新增表: memory_records, memory_edges, memory_candidates,
  │           import_sources, import_artifacts, rag_chunks,
  │           audit_events, ai_run_events
  ├── 现有表: product_state_snapshots 保持 SQLite（渐进迁移）
  └── pgvector 扩展: 向量检索
  ↓
阶段三: 全量迁移 product_state 到 PostgreSQL JSONB
```

---

## 四、依赖关系

```
阶段一（合并 + 修复）
  └── 阶段二
        ├── Phase 2 (Mastra) ───────────── 基础设施，最先
        ├── Phase 4 (记忆) ─────────────── 依赖 Phase 2 的 Memory/RAG
        └── Phase 5 (导入 & RAG) ──────── 依赖 Phase 2 的 RAG/pgvector
              └── 阶段三
                    ├── Phase 3 (搜索增强) ── 依赖 Phase 2 的 searchProviderTool
                    ├── Phase 6 (播客) ────── 依赖 Phase 2 的 PodcastGeneratorAgent
                    ├── Phase 7 (语音) ────── 依赖 Phase 2 的 InterviewDirectorAgent
                    └── Phase 8 (质量) ────── 依赖 Phase 2 的 Evals/Scorers
```

---

## 五、验收标准

| 阶段 | 验收标准 |
|------|---------|
| 阶段一 | 所有现有测试通过，zhuanfang 功能完整合并，E2E 全部绿色 |
| Phase 2 | Mastra Studio 可调试，10 个 Agent 可独立运行，12 个 Workflow 端到端通过 |
| Phase 4 | 记忆候选生成→审核→确认→演化检测全链路通过 |
| Phase 5 | 音频/文档导入→分块→embedding→检索→RAG 上下文生成全链路通过 |
| Phase 3 | 多提供商搜索→去重→简报生成→自动话题发现通过 |
| Phase 6 | 播客脚本生成→编辑→TTS 合成→前端播放全链路通过 |
| Phase 7 | WebRTC 连接→轮流发言→打断→记忆回调全链路通过 |
| Phase 8 | 8 个评分器可运行，审计日志正常，可观测性面板可用 |
