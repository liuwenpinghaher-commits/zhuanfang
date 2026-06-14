# V3 系统优化 — 执行进度

> 日期: 2026-06-14
> 分支: refactor/v3-system-optimization

---

## 整体进度

| Phase | 内容 | 状态 |
|-------|------|------|
| 1 | 移除 Mastra | ✅ 完成 |
| 2 | 拆分 engine.ts | ✅ 完成 |
| 3 | 语音管线清理 | ✅ 完成 |
| 4 | OpenTelemetry | ✅ 完成 |
| 5.2 | buildMonthlyReview 硬编码修复 | ✅ 完成 |
| 5.4 | realtime-voice 测试修复 | ✅ 完成 |
| 5.1 | 引导引擎升级 (expression-state) | ⏸ 延后（独立大计划） |
| 5.3 | types.ts 精简 | ⏸ 延后（独立大计划） |

---

## Phase 1: 移除 Mastra ✅

**删除的文件:**
- `apps/api/src/mastra-integration.ts` + test
- `apps/api/src/routes/mastra.ts`
- `apps/api/src/routes/observability.ts`
- `packages/mastra/` 整个目录（手动删除）

**修改的文件:**
- `apps/api/src/server.ts` — 移除 mastra/observability 路由引用
- `apps/api/src/routes/quality.ts` — scorers 内联（不再依赖 packages/mastra）

**Commit:** d3688bce

---

## Phase 2: 拆分 engine.ts ✅

**engine.ts:** 6150 → 1404 行

**新建 13 个模块:**

| 模块 | 行数 | 职责 |
|------|------|------|
| `utils.ts` | 218 | nowIso, makeId, extractAnchor, audit 辅助 |
| `voice-instructions.ts` | 47 | buildRealtimeVoiceInstructions |
| `context-pack.ts` | 1192 | buildInterviewCard/Guide/ContextPack |
| `strategy.ts` | 606 | decideInterviewStrategy, interviewEnginePolicy |
| `turn-builder.ts` | 197 | buildAssistantTurn, receiveUserTurn |
| `finalize.ts` | 291 | finalizeSession |
| `review.ts` | 83 | buildMonthlyReview, buildYearlyReview, buildCognitiveRadar |
| `signals.ts` | 277 | buildRealtimeTurnState, truncateAssistantTurn, trace 信号 |
| `search-brief.ts` | 733 | buildSearchBrief, 外部材料清洗 |
| `memory.ts` | 213 | 记忆候选 CRUD |
| `assets.ts` | 333 | searchProductAssets, 资产管理 |
| `corpus.ts` | 325 | analyzeImportedInterview, playbook patches |
| `podcast.ts` | 597 | generatePodcastEpisode 及变体 |

**Commit:** 971a92b9

---

## Phase 3: 语音管线清理 ✅

**删除的文件:**
- `src/realtime/bailianWebrtc.ts` + test
- `src/realtime/bailianWebsocket.ts` + test
- `src/realtime/turnDetectors/` 整个目录

**修改的文件:**
- `src/App.tsx` — 移除 bailian imports，只保留 LiveKit 语音路径

**Commit:** eb5e4011, aefc61e1

---

## Phase 4: OpenTelemetry ✅

**新建的文件:**
- `apps/api/src/telemetry.ts` — OTLP Trace Exporter, 自动检测 HTTP/Fastify

**修改的文件:**
- `apps/api/src/server.ts` — 第一个 import 初始化 telemetry

**环境变量:**
- `OTEL_EXPORTER_OTLP_ENDPOINT` — 目标 collector（默认 localhost:4318）
- `OTEL_SERVICE_NAME` — 服务名（默认 interview-api）

**Commit:** 548e82d8

---

## Phase 5: 进度

### 5.1 引导引擎升级 (expression-state 方案) — ⏸ 延后

- 文件: `src/domain/guidanceEngine.ts` (159行) 需要按 expression-state 方案升级
- 参考: `docs/superpowers/specs/2026-06-14-expression-state-interaction-engine-design.md`
- 核心: 关键词匹配 → 韵律特征 + 语义特征的表达状态感知
- 范围: ~600 行新增，4 个新文件，需独立 plan + worktree

### 5.2 buildMonthlyReview 硬编码修复 — ✅ 完成

- `changedView` 改为从 `state.points` 派生（最新 "已修正" / "被挑战中" 观点）
- `buildYearlyReview` 的 fallback 复用同一派生函数
- Commit: 57558081

### 5.3 types.ts 精简 — ⏸ 延后

- 删除 AuditEvent, AiRunEvent, WorkflowRun 等已被 OpenTelemetry 替代的类型
- 实际涉及 100+ 个调用点（utils, engine, finalize, memory, search-brief, podcast, corpus, signals, strategy, turn-builder, review, privacy）
- 需独立 plan，逐模块迁移

### 5.4 realtime-voice.test.ts 3 个失败 — ✅ 完成

- 新增 `createInterviewSession({id,title,createdAt})` — 含完整空 card/guide
- 新增 `addTurn(session, {role, content, strategy?})`
- 新增 `buildInterviewAgentContext(session)` — 供 LiveKit Python agent 拉取
- Commit: 78c1dc3a

### 5.5 App.tsx L242 buildRealtimeTurnState 调用修复 — ✅ 完成

- 已修复并提交 (cf680744)

---

## 当前状态总览

| 指标 | 值 |
|------|-----|
| 编译错误 | **0** |
| 测试通过 | **230/230** ✅ |
| Git 提交 | 9 个工作提交 + 1 个文档提交 |
| engine.ts 缩减 | 6150 → 1404 行 (77%) |

---

## Git 提交历史

```
5cb43401 fix(review): address code-review issues from phase 5.2/5.4 review
57558081 fix(review): derive changedView from product state instead of hardcoding
78c1dc3a feat(domain): add createInterviewSession/addTurn/buildInterviewAgentContext
548e82d8 feat: add OpenTelemetry tracing to API server
cf680744 fix: remove extra 3rd argument from buildRealtimeTurnState call
aefc61e1 fix: remove all bailian imports from App.tsx, simplify to LiveKit-only voice path
eb5e4011 refactor: remove old S2S voice pipeline, keep only LiveKit
d3688bce fix: restore memory-candidates/memory-corrections imports in server.ts
971a92b9 refactor: split engine.ts (6150→1404 lines) into 13 domain modules
```
