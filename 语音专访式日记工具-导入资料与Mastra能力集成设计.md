# 语音专访式日记工具 - 导入资料与 Mastra 能力集成设计

版本：v3.0  
日期：2026-06-10  
定位：Mastra-first 设计。详细设计参考资料、原始音频、访谈样本、网页资料的存储、解析、检索、审核、记忆化和长期召回方案。

---

## 0. 设计结论

导入资料与长期记忆系统尽量使用 Mastra 及其扩展能力：

```text
Mastra Workflows       管导入、转写、解析、审核、同步的确定性流水线
Mastra Agents          管语义判断、候选记忆、访谈技法、上下文构建
Mastra Tools           封装 Object Storage / ASR / Product DB / RAG / Qwen
Mastra Background Tasks 管长音频转写、大文档解析、批量 embedding、语料分析
Mastra Approval / HITL 管用户审核、删除、替换、敏感资料授权
Mastra RAG             管文档分块、embedding、pgvector 检索、rerank
Mastra GraphRAG        管资料片段之间的临时关系图和上下文扩展
Mastra Memory          管 agent message history、working memory、observational memory、semantic recall
Mastra Observability   管 traces、logs、metrics、成本、延迟、失败定位
Mastra Evals / Scorers 管候选记忆、引用、敏感泄漏、上下文质量评分
Mastra Studio          管 agent / workflow / tool / scorer 调试
Postgres + pgvector    管权威业务状态、长期记忆记录、向量索引、关系边
Object Storage         管原始音频、文档、派生大文件
```

最终边界：

```text
Object Storage = 原件仓库
Postgres = 产品权威状态机和长期记忆真相源
pgvector = 产品内可控语义检索
Mastra Storage = agent / workflow / memory / snapshot / observability 运行时存储
Mastra Memory = AI 运行时记忆，不是唯一业务记忆源
Mastra RAG / GraphRAG = 导入资料和历史资产的检索能力
```

---

## 1. Mastra 能力替代分析

### 1.1 Workflows

导入系统的主干应由 Mastra Workflows 承接，因为导入是明确、多阶段、强状态、可失败重试的流程。

使用场景：

```text
importIngestionWorkflow
audioTranscriptionWorkflow
documentIngestionWorkflow
referenceInterviewLearningWorkflow
memoryCandidateReviewWorkflow
memoryProjectionWorkflow
contextPackBuildWorkflow
memoryMaintenanceWorkflow
```

核心价值：

- 每一步有 schema。
- 步骤可串行、并行、分支。
- 可调用 agents 和 tools。
- 可 stream 进度给前端。
- 可 suspend/resume 等待用户审核。
- 可重试失败步骤。
- 可在 Studio 查看 workflow 图、输入、输出、日志。

### 1.2 Agents

Agents 负责语义判断，不负责权威写入。

建议 agents：

```text
ImportClassifierAgent
TranscriptCleanerAgent
MemoryCandidateAgent
SourceClaimExtractorAgent
InterviewTechniqueAnalystAgent
MemoryConsolidationAgent
ContextPackBuilderAgent
SensitiveReviewAgent
```

适合交给 agents：

- 判断导入资料类型。
- 判断资料用途。
- 清洗转写稿。
- 标记访谈 turn 类型。
- 提取候选记忆。
- 识别参考访谈技法。
- 发现观点冲突或记忆替换关系。
- 构建会前上下文包。

不交给 agents：

- 永久删除数据。
- 覆盖权威资产。
- 直接把候选写成确认记忆。
- 决定敏感资料是否可用于专访。

### 1.3 Tools

Tools 封装外部和内部能力，让 workflow/agent 可结构化调用。

建议 tools：

```text
objectStorageTool
productDbTool
mediaTool
asrTool
documentParseTool
urlFetchTool
ragTool
graphTool
memoryRecordTool
qwenOmniTool
qwenCharacterTool
scorerTool
auditLogTool
```

高风险 tools 必须 approval：

```text
deleteImportSource
deleteMemoryRecord
supersedeMemoryRecord
deprecateMemoryRecord
markSensitiveUsableInInterview
applyPlaybookPatch
purgeOriginalFile
```

### 1.4 Background Tasks

Mastra Background Tasks 用于长任务，避免阻塞 agent 交互。

适合：

```text
transcribeLongAudio
parseLargeDocument
embedLargeSource
analyzeInterviewCorpus
generateMemoryCandidates
runMemoryMaintenance
generatePodcastScript
```

边界：

- MVP 可直接使用 Mastra Background Tasks。
- 当媒体处理规模很大时，Mastra workflow 继续做业务编排，底层执行可换 BullMQ / Inngest / 云任务队列。

### 1.5 Approval / HITL

导入资料会影响长期记忆，必须强制引入 human-in-the-loop。

需要审核：

```text
记忆候选确认
候选内容修改后确认
候选拒绝
敏感资料授权
记忆替换
记忆废弃
删除原件
访谈技法进入 playbook
```

实现方式：

- workflow `suspend/resume` 管多阶段审核。
- tool `requireApproval` 管危险工具调用。
- 审核结果写 Product DB。
- Mastra trace 保存审核前后的上下文。

### 1.6 Memory

Mastra Memory 用于 AI 运行时记忆，但产品长期记忆的真相源仍是 Postgres。

分工：

```text
Product DB memory_records:
长期记忆权威记录、状态、来源、证据、用户确认、替换关系、敏感级别。

Mastra Memory:
agent message history、observational memory、working memory、semantic recall。
```

使用方式：

```text
resourceId = user:{userId}
threadId = import:{importId}
threadId = session:{sessionId}
threadId = memory-maintenance:{date}
```

Mastra Memory 可保存：

- 导入任务中的 agent 推理历史。
- 专访 session 的 message history。
- agent working memory，例如用户长期目标、当前关注、访谈边界。
- observational memory，用于压缩长对话和长任务过程。
- semantic recall，用于从历史 agent messages 中召回上下文。

不能只靠 Mastra Memory 保存：

- 用户确认记忆。
- 观点状态。
- 决策资产。
- 知识债。
- 删除记录。
- 证据引用。
- 敏感权限。

### 1.7 RAG

Mastra RAG 承接资料解析后的分块、embedding 和检索。

用法：

```text
MDocument.fromMarkdown / fromHTML / fromJSON / fromText
→ chunk
→ embedMany
→ @mastra/pg PgVector
→ retrieval
→ rerank
```

chunk 策略：

```text
访谈稿：sentence / recursive
Markdown 文档：semantic-markdown / markdown
网页 HTML：html
JSON 对话导出：json
普通文本：recursive
```

### 1.8 GraphRAG

不引入外部知识图谱服务时，关系能力由两层组成：

```text
Postgres memory_edges:
长期、可审核、可解释的关系边。

Mastra GraphRAG:
基于检索到的 chunks 临时构建关系图，用于扩展上下文。
```

长期关系边示例：

```text
EVIDENCED_BY
DERIVED_FROM
CONFIRMS
CHALLENGES
CONTRADICTS
EVOLVES
SUPERSEDES
DEPRECATES
MENTIONS
USES_TECHNIQUE
REVISITS
```

### 1.9 MCP

不引入独立外部记忆服务后，MCP 仍有价值：

- 把导入资料库暴露成内部 MCP Server。
- 让其他 agents 或工具查询本产品记忆。
- 在 Mastra Studio 里调试工具。
- 未来把播客、搜索、文档解析等外部能力用 MCP 接入。

建议：

```text
Phase 1: 直接使用 Mastra Tools
Phase 2: 将 productMemory / importLibrary 封装成 MCP Server
Phase 3: 用 MCP Apps 做图谱预览、记忆审核、资料回看 UI
```

### 1.10 Processors / Guardrails

建议实现：

```text
AttachmentExternalizationProcessor
SensitiveDataFilterProcessor
CitationRequiredProcessor
PromptInjectionGuardrail
MemoryPromotionGuardrail
SourceAttributionGuardrail
```

目的：

- 大附件自动进对象存储，agent 只拿 URL。
- 敏感资料默认不进入模型。
- 外部资料观点必须带来源。
- 未审核候选不能进入长期记忆。
- 文档里的 prompt injection 不能操控 agent。

### 1.11 Observability

Mastra Observability 默认启用。

记录：

```text
workflow_run_id
import_source_id
mastra_trace_id
agent_id
tool_call_id
model
tokens
latency
cost
failure reason
approval wait time
vector index ids
memory_record ids
```

### 1.12 Evals / Scorers

导入资料直接影响长期记忆，必须用 Mastra Scorers 做质量闸。

建议 scorers：

```text
TranscriptCleanupScorer
MemoryCandidatePrecisionScorer
CitationFaithfulnessScorer
SensitiveLeakageScorer
InterviewTechniqueScorer
ContextPackRelevanceScorer
SourceSummaryCoverageScorer
MemoryContradictionScorer
```

### 1.13 Studio

Mastra Studio 用于开发和运营阶段：

- 调试 agents。
- 单独跑 tools。
- 查看 workflows。
- 重放失败步骤。
- 查看 traces。
- 测试 scorers。
- 比较 prompt / model 改动。

---

## 2. 数据架构

### 2.1 存储分层

```text
Object Storage:
原始音频、原始文件、标准化音频、转写 JSON、波形 JSON、解析 Markdown、分析 JSON。

Postgres:
导入源、处理状态、转写片段、资产、记忆记录、关系边、审核状态、权限、审计。

pgvector:
资料 chunks、转写 chunks、记忆 records、资产摘要的 embedding。

Mastra Storage:
workflows、snapshots、background tasks、agent memory、observability、scores。
```

### 2.2 Object Storage 路径

```text
/users/{userId}/imports/{importId}/raw/original.{ext}
/users/{userId}/imports/{importId}/raw/source-metadata.json
/users/{userId}/imports/{importId}/derived/audio-normalized.wav
/users/{userId}/imports/{importId}/derived/transcript.json
/users/{userId}/imports/{importId}/derived/segments.json
/users/{userId}/imports/{importId}/derived/speaker-map.json
/users/{userId}/imports/{importId}/derived/waveform.json
/users/{userId}/imports/{importId}/derived/parsed.md
/users/{userId}/imports/{importId}/derived/analysis.json
```

### 2.3 Product DB 表

#### import_sources

```text
id
user_id
source_type
usage_type
title
description
original_file_url
original_external_url
mime_type
file_size_bytes
duration_sec
checksum_sha256
language
status
sensitivity_level
consent_scope
can_search
can_embed
can_extract_memory
can_use_in_interview
can_train_playbook
requires_review
mastra_workflow_id
mastra_run_id
mastra_trace_id
current_workflow_step
created_at
updated_at
deleted_at
```

#### import_artifacts

```text
id
import_source_id
kind
storage_url
content_hash
version
generated_by
generated_by_agent_id
generated_by_model
mastra_step_id
mastra_tool_call_id
score_summary_json
status
error_message
created_at
```

#### transcript_segments

```text
id
import_source_id
speaker_label
speaker_role
start_ms
end_ms
text
normalized_text
confidence
emotion
intent
turn_type
quote_quality
embedding_id
created_at
```

#### rag_chunks

```text
id
user_id
import_source_id
artifact_id
chunk_text
chunk_index
chunk_strategy
token_count
metadata_json
embedding_id
created_at
```

#### memory_candidates

```text
id
user_id
import_source_id
transcript_segment_id
candidate_type
title
content
evidence_quote
source_citation
confidence
suggested_importance
suggested_tags
suggested_relations_json
candidate_score
citation_score
sensitivity_score
review_status
reviewer_id
reviewed_at
created_at
```

#### memory_records

这是产品内长期记忆的权威记录表。

```text
id
user_id
memory_type
title
content
status
confidence
importance
sensitivity_level
allowed_in_interview
requires_attribution
evidence_quote
source_import_id
source_segment_id
source_asset_id
supersedes_memory_id
deprecated_reason
effective_from
effective_to
created_by
confirmed_by_user_at
created_at
updated_at
deleted_at
```

`status`：

```text
draft
candidate
confirmed
inferred
rejected
superseded
deprecated
deleted
```

`memory_type`：

```text
personal_fact
preference
stable_point
open_question
decision
knowledge_debt
long_term_theme
interview_technique
source_claim
event
procedure
context
```

#### memory_edges

这是替代外部知识图谱的产品内关系表。

```text
id
user_id
from_memory_id
to_memory_id
edge_type
reason
confidence
evidence
created_by
created_at
deleted_at
```

`edge_type`：

```text
EVIDENCED_BY
DERIVED_FROM
CONFIRMS
CHALLENGES
CONTRADICTS
EVOLVES
SUPERSEDES
DEPRECATES
MENTIONS
USES_TECHNIQUE
REVISITS
RELATED_TO
```

---

## 3. Workflows 设计

### 3.1 importIngestionWorkflow

总入口。

```text
validateImportRequest
→ externalizeAttachment
→ persistImportSource
→ classifyImport
→ routeToChildWorkflow
→ collectArtifacts
→ generateMemoryCandidates
→ scoreCandidates
→ suspendForUserReview
→ promoteApprovedCandidates
→ buildMemoryEdges
→ updateSearchIndexes
→ markImportReady
```

### 3.2 audioTranscriptionWorkflow

```text
loadOriginalAudio
→ normalizeAudio
→ transcribeAudio
→ diarizeSpeakers
→ cleanTranscript
→ segmentTurns
→ saveArtifacts
→ chunkTranscript
→ embedChunks
→ upsertPgVector
→ createConversationMemoryThread
```

这里的 `createConversationMemoryThread` 是写入 Mastra Memory 的 thread，不是外部服务。

### 3.3 documentIngestionWorkflow

```text
parseDocumentOrFetchUrl
→ normalizeMarkdown
→ createMDocument
→ selectChunkStrategy
→ chunk
→ embed
→ upsertPgVector
→ extractSourceClaims
→ generateCandidates
```

### 3.4 referenceInterviewLearningWorkflow

```text
parseOrTranscribeReferenceInterview
→ segmentTurns
→ InterviewTechniqueAnalystAgent
→ scoreTechniqueExtraction
→ createTechniqueCandidates
→ suspendForReview
→ promoteApprovedTechniquesToMemoryRecords
→ createPlaybookPatchCandidate
```

### 3.5 memoryCandidateReviewWorkflow

```text
loadCandidates
→ groupByType
→ suspendForReview
→ applyReviewActions
→ createOrUpdateMemoryRecords
→ createMemoryEdges
→ projectApprovedMemoriesToMastraWorkingMemory
```

### 3.6 memoryProjectionWorkflow

把产品权威记忆投影到 Mastra runtime 可用的上下文。

```text
loadConfirmedMemoryRecords
→ selectCurrentWorkingMemory
→ writeMastraWorkingMemory
→ embedMemoryRecords
→ upsertMemoryVectors
→ updateContextCache
```

### 3.7 contextPackBuildWorkflow

会前召回。

```text
loadProductAssets
→ loadMastraWorkingMemory
→ semanticRecallFromMastraMemory
→ retrievePgVectorChunks
→ queryMemoryRecords
→ queryMemoryEdges
→ runGraphRagExpansion
→ ContextPackBuilderAgent
→ scoreContextPack
→ output InterviewContextPack
```

---

## 4. Agents 设计

### 4.1 ImportClassifierAgent

输出：

```ts
{
  sourceType: "audio_interview" | "audio_note" | "document" | "web_url" | "conversation_export" | "manual_note";
  usageType: "reference_only" | "learn_interviewing" | "personal_memory" | "source_for_session" | "podcast_material" | "archive_only";
  language: string;
  sensitivityLevel: "normal" | "sensitive" | "private";
  recommendedPipeline: string;
  requiresReview: boolean;
  reasons: string[];
}
```

### 4.2 TranscriptCleanerAgent

职责：

- 修复 ASR 标点。
- 合并过碎片段。
- 标记 speaker role。
- 标记 turn type。
- 保留时间戳。
- 标记低置信度片段。

### 4.3 MemoryCandidateAgent

职责：

- 从资料中提取候选长期记忆。
- 区分用户事实、观点、问题、决策、知识债、外部资料观点、访谈技法。
- 每条候选必须带 evidence quote。
- 每条候选必须标注是否可用于专访。

### 4.4 MemoryConsolidationAgent

替代外部记忆服务的演化检测。

职责：

- 判断新候选是否确认旧记忆。
- 判断新候选是否挑战旧记忆。
- 判断是否应 supersede。
- 判断是否应 deprecate。
- 生成 memory_edges 候选。

注意：该 agent 只生成建议，最终由 workflow + 用户审核写入。

### 4.5 ContextPackBuilderAgent

职责：

- 汇总 Product DB 资产。
- 汇总 Mastra Working Memory。
- 汇总 pgvector 检索结果。
- 汇总 GraphRAG 扩展结果。
- 过滤敏感和废弃记忆。
- 生成实时专访可用的精简上下文。

---

## 5. Tools 设计

### 5.1 objectStorageTool

```ts
uploadOriginalFile
putDerivedArtifact
getSignedUrl
archiveObject
purgeObject
```

`purgeObject` 必须 approval。

### 5.2 productDbTool

```ts
createImportSource
updateImportStatus
createArtifact
upsertTranscriptSegments
createMemoryCandidates
createMemoryRecord
updateMemoryRecord
supersedeMemoryRecord
deprecateMemoryRecord
createMemoryEdges
writeAuditEvent
```

`supersedeMemoryRecord`、`deprecateMemoryRecord`、删除类操作必须 approval。

### 5.3 ragTool

基于 Mastra RAG 和 pgvector。

```ts
createDocument
chunkDocument
embedChunks
upsertVectors
retrieveChunks
rerankChunks
graphRagContext
```

### 5.4 mastraMemoryTool

封装 Mastra Memory 操作。

```ts
writeWorkingMemory
readWorkingMemory
appendThreadMessage
semanticRecall
writeObservation
compactThreadObservations
```

### 5.5 graphTool

产品内长期关系图。

```ts
createEdge
deleteEdge
findNeighbors
findContradictions
findEvolutionChain
buildGraphContext
```

### 5.6 mediaTool / asrTool / documentParseTool

```ts
normalizeAudio
extractAudioFromVideo
measureDuration
generateWaveform
transcribeAudio
diarizeSpeakers
parsePdf
parseDocx
parseMarkdown
parseHtml
fetchUrl
```

---

## 6. RAG、Memory、GraphRAG 协同

### 6.1 导入资料入库

```text
parsed markdown / transcript
→ MDocument
→ chunk
→ embed
→ rag_chunks + pgvector
```

### 6.2 用户确认记忆

```text
approved memory candidate
→ memory_records
→ memory_edges
→ embed memory record
→ pgvector memory index
→ project to Mastra Working Memory when relevant
```

### 6.3 会前上下文

```text
Product DB assets
+ memory_records
+ memory_edges
+ Mastra Working Memory
+ Mastra semantic recall
+ pgvector chunks
+ Mastra GraphRAG expansion
→ ContextPackBuilderAgent
→ InterviewContextPack
```

实时注入限制：

```text
最多 3 条确认记忆
最多 2 条外部来源观点
最多 1 条访谈技法
当前敏感边界
当前追问目标
```

---

## 7. 审核机制

### 7.1 记忆候选审核

workflow 暂停：

```text
suspend(waitForMemoryCandidateReview)
```

用户动作：

```text
approve
edit_and_approve
reject
reference_only
mark_sensitive
archive_only
```

### 7.2 记忆演化审核

`MemoryConsolidationAgent` 只生成建议：

```text
confirms
enriches
challenges
contradicts
supersedes
deprecates
```

需要用户确认后才写 `memory_edges` 或更新 `memory_records.status`。

### 7.3 敏感资料授权

敏感资料默认：

- 不进入 Mastra Working Memory。
- 不进入实时专访上下文。
- 不用于 playbook 学习。
- 只可用户手动查看。

---

## 8. Observability 与 Scorers

### 8.1 Trace metadata

```text
user_id
import_id
source_type
usage_type
workflow_run_id
agent_id
tool_call_id
memory_record_id
vector_index
approval_status
```

### 8.2 Metrics

```text
导入总耗时
ASR 耗时
文档解析耗时
embedding 成本
候选记忆数量
候选通过率
候选修改率
候选拒绝率
敏感拦截次数
上下文召回命中率
错误记忆回滚次数
```

### 8.3 Scorers

```text
TranscriptCleanupScorer
MemoryCandidatePrecisionScorer
CitationFaithfulnessScorer
SensitiveLeakageScorer
InterviewTechniqueScorer
ContextPackRelevanceScorer
MemoryContradictionScorer
```

验收规则：

- 候选记忆必须有 evidence quote。
- 外部资料观点必须有 source citation。
- 敏感资料默认不进入专访上下文。
- 用户拒绝过的候选不重复推荐。
- superseded / deprecated 记忆不默认召回。

---

## 9. API 设计

Product API 触发 Mastra workflows。

```http
POST /api/imports
POST /api/imports/:id/upload-url
POST /api/imports/:id/run
GET  /api/imports/:id
GET  /api/imports/:id/workflow-stream
GET  /api/imports/:id/artifacts
GET  /api/imports/:id/segments
GET  /api/imports/:id/memory-candidates
POST /api/imports/:id/review-memory-candidates
POST /api/imports/:id/review-memory-evolution
POST /api/imports/:id/retry-step
DELETE /api/imports/:id
```

内部调用：

```ts
const workflow = mastra.getWorkflow("importIngestionWorkflow");
const run = await workflow.createRun();
await run.stream({ inputData: { importId, userId } });
```

---

## 10. 代码目录建议

```text
src/mastra/index.ts
src/mastra/agents/import-classifier.ts
src/mastra/agents/transcript-cleaner.ts
src/mastra/agents/memory-candidate.ts
src/mastra/agents/memory-consolidation.ts
src/mastra/agents/technique-analyst.ts
src/mastra/agents/context-pack-builder.ts
src/mastra/workflows/import-ingestion.ts
src/mastra/workflows/audio-transcription.ts
src/mastra/workflows/document-ingestion.ts
src/mastra/workflows/memory-review.ts
src/mastra/workflows/memory-projection.ts
src/mastra/workflows/context-pack-build.ts
src/mastra/tools/object-storage.ts
src/mastra/tools/product-db.ts
src/mastra/tools/asr.ts
src/mastra/tools/document-parser.ts
src/mastra/tools/rag.ts
src/mastra/tools/mastra-memory.ts
src/mastra/tools/graph.ts
src/mastra/processors/attachment-externalization.ts
src/mastra/processors/sensitive-data-filter.ts
src/mastra/guardrails/memory-promotion.ts
src/mastra/scorers/memory-candidate-precision.ts
src/mastra/scorers/citation-faithfulness.ts
```

---

## 11. 推荐扩展包

```text
@mastra/core
@mastra/memory
@mastra/rag
@mastra/pg
@mastra/observability
@mastra/libsql              本地开发可选
@mastra/duckdb              本地 metrics 可选
@mastra/clickhouse          生产 metrics 可选
@mastra/mcp                 后续 MCP Server / Client 可选
@mastra/voice-openai-realtime 备用实时语音 provider 可选
```

Qwen-Omni-Realtime 暂按自定义 provider/tool 接入：

```text
qwenOmniRealtimeVoiceProvider
qwenOmniTool
```

---

## 12. 分期实现

### Phase A：Mastra workflow 骨架

- 配置 Mastra storage。
- 建 `importIngestionWorkflow`。
- 建 objectStorage / productDb tools。
- 前端可查看 workflow step 状态。

### Phase B：音频和文档导入

- 接 audioTranscriptionWorkflow。
- 接 documentIngestionWorkflow。
- 使用 Mastra RAG 做 chunk / embedding / pgvector。
- 保存 artifacts、segments、rag_chunks。

### Phase C：产品内长期记忆

- 建 `memory_candidates`。
- 建 `memory_records`。
- 建 `memory_edges`。
- MemoryCandidateAgent 生成候选。
- MemoryConsolidationAgent 生成演化建议。

### Phase D：HITL 与记忆投影

- workflow suspend/resume 做审核。
- approved candidates 写 memory_records。
- `memoryProjectionWorkflow` 写 Mastra Working Memory 和向量索引。

### Phase E：GraphRAG 与会前召回

- `contextPackBuildWorkflow` 联合 Product DB、Mastra Memory、pgvector、GraphRAG。
- 输出实时专访上下文。

### Phase F：Studio / MCP / Scorers 完善

- Studio 调试 workflows/tools/agents/scorers。
- 可选 MCP Server 暴露产品记忆和导入资料库。
- Scorers 进入 CI 和生产抽样。

---

## 13. 最终判断

采用 Mastra-first 后，方案更一致：

```text
Mastra = AI 编排运行时
Postgres = 权威业务和长期记忆数据库
pgvector = 可控语义检索
Mastra Memory = agent 运行时记忆
Mastra RAG / GraphRAG = 资料检索和关系扩展
Object Storage = 原件仓库
```

音频导入链路：

```text
raw audio
→ Mastra importIngestionWorkflow
→ audioTranscriptionWorkflow
→ transcript segments
→ Mastra RAG chunks + pgvector
→ MemoryCandidateAgent
→ Scorers
→ HITL review
→ memory_records + memory_edges
→ memoryProjectionWorkflow
→ Mastra Working Memory + semantic recall
→ contextPackBuildWorkflow
→ 更好的下一次专访
```

这个方案牺牲了外部现成个人知识图谱服务，但换来：

- 架构更统一。
- 数据控制更强。
- 隐私边界更清晰。
- 业务状态更可测。
- 与 Mastra Studio / Workflows / Memory / RAG / Observability / Evals 的集成更深。

---

## 14. 参考资料

- Mastra Agents: https://mastra.ai/docs/agents/overview
- Mastra Workflows: https://mastra.ai/docs/workflows/overview
- Mastra Background Tasks: https://mastra.ai/docs/agents/background-tasks
- Mastra Agent Approval: https://mastra.ai/docs/agents/agent-approval
- Mastra Memory: https://mastra.ai/docs/memory/overview
- Mastra Storage: https://mastra.ai/docs/memory/storage
- Mastra RAG: https://mastra.ai/docs/rag/overview
- Mastra Chunking and Embedding: https://mastra.ai/docs/rag/chunking-and-embedding
- Mastra Vector Databases: https://mastra.ai/docs/rag/vector-databases
- Mastra GraphRAG: https://mastra.ai/docs/rag/graph-rag
- Mastra MCP: https://mastra.ai/docs/mcp/overview
- Mastra Speech-to-Speech: https://mastra.ai/docs/voice/speech-to-speech
- Mastra Observability: https://mastra.ai/docs/observability/overview
- Mastra Evals / Scorers: https://mastra.ai/docs/evals/overview
