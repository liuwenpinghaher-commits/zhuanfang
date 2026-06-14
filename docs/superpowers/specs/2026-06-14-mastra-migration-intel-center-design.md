# 系统底层彻底优化方案 v3

> 日期：2026-06-14
> 定位：全局客观审视系统现状，找出真正问题，给出最优解法
> 原则：**只做真正需要的事，不为了用框架而用框架**

---

## 0. 全局诊断

### 0.1 真的有问题的地方

| 问题 | 严重程度 | 证据 |
|------|----------|------|
| `engine.ts` 6150 行巨型文件 | 🔴 严重 | 违反单一职责，任何修改都要碰它。认知负荷极高 |
| 引导引擎是关键词匹配 | 🔴 严重 | `mentionsRescue = userText.includes("兜底")` — 这不是语义理解 |
| 零可观测性 | 🟡 中 | 出问题时只能靠 `console.log` 调试，无 Trace |
| 三套语音管线并存 | 🟡 中 | bailianWebrtc + bailianWebsocket + livekitVoice，冗余混乱 |
| `buildMonthlyReview` 硬编码文本 | 🟡 中 | `changedView: "你正在从...转向..."` — 写死的，非 AI 生成 |
| 3 个单元测试失败 | 🟢 低 | turnDetector 边界条件，易修复 |
| Mastra 包已装但未用 | 🟢 低 | packages/mastra/ 中 Agent/Workflow 都是硬编码 mock 数据 |

### 0.2 不是问题的问题

| 被误认为问题 | 真相 |
|-------------|------|
| "需要 Mastra Agent 替代规则引擎" | 专访追问逻辑**就是**确定性的规则选择（6 种策略 × 对话轮次），不需要 LLM Agent |
| "需要 Mastra Workflow 替代 workflow-runtime" | 专访流程是**线性的**：用户说 → 追问 → 再问。不需要 DAG 编排 |
| "需要 Mastra Memory 替代自研存储" | 现有 Drizzle + SQLite/pgvector 工作正常，Mastra Memory 有已知数据损坏 bug (#12253) |
| "需要 Mastra RAG 替代自研 RAG" | 已有 pgvector，Mastra RAG 只是换封装 |
| "需要 10 个 Mastra Agent" | 这是给一个**单用户线性专访工具**加的复杂度，完全过度设计 |

### 0.3 Mastra 判断

Mastra 在这个系统里的价值：

| 能做的 | 价值 | 风险评估 |
|--------|------|---------|
| Evals (LLM-as-judge 评估追问质量) | 有 | 但这个可以后面再加，不需要现在就依赖 |
| MCP Server (暴露记忆给外部 Agent) | 有 | 同上 |
| Agent 推理替代规则引擎 | **负** | 专访策略选择是确定性逻辑，用 LLM 会更慢、更贵、更不稳定 |
| Memory/RAG | **零** | 已有等价方案，换框架不会更好 |
| Voice | **负** | 没有阿里云 provider，还是要自己写 |
| Workflow 引擎 | **零** | 没有复杂 DAG 需求 |

**结论：移除 Mastra。** 它只是占用磁盘空间和认知负担的 dead weight。真正需要的能力（Evals, MCP）可以将来需要时再加回来，现在它唯一的贡献就是让 `packages/mastra/src/` 里的 mock 数据看起来像是在工作。

---

## 1. 真正要做的 7 件事

### 1.1 拆分 `engine.ts`（最高优先级，最有价值）

从 6150 行巨型文件按**领域职责**拆分为 10 个内聚模块：

```
src/domain/
  engine.ts            →  50 行（重新出口入口）
  types.ts             → 300 行（只保留 Mastra 替代不了的核心类型）

  // 新建模块
  context-pack.ts      → 550 行（buildInterviewContextPack, buildInterviewGuide, buildInterviewCard）
  strategy.ts          → 500 行（decideInterviewStrategy, buildInterviewEnginePolicy）
  turn-builder.ts      → 450 行（buildAssistantTurn, receiveUserTurn, receiveUserTurnWithAssistant）
  finalize.ts          → 550 行（finalizeSession, buildDualTrackNote, buildMemoryCandidates）
  review.ts            → 350 行（buildMonthlyReview, buildYearlyReview, buildCognitiveRadar）
  signals.ts           → 300 行（buildRealtimeTurnState, appendRealtimeSignalTrace, truncateAssistantTurn）
  search-brief.ts      → 550 行（buildSearchBrief, createSearchBriefFromInput 等）
  voice-instructions.ts → 400 行（buildRealtimeVoiceInstructions 等）
  memory.ts            → 450 行（collectConfirmedMemoryTexts, buildMemoryCandidates, 等）
  assets.ts            → 350 行（searchProductAssets, 等）
  corpus.ts            → 400 行（analyzeImportedInterview, 等）
  podcast.ts           → 350 行（generatePodcastEpisode, 等）
  utils.ts             → 100 行（nowIso, makeId, extractAnchor, isLongUserAnswer, 等）
```

**原则**：
- 每个模块 200-500 行（认知最佳范围）
- 按"这个文件会因为什么原因被修改"来划分边界
- `engine.ts` 变成纯 re-export 入口（向后兼容，所有现有 import 不破坏）
- 每个新模块有独立的测试文件

**预期收益**：
- 代码可读性提升 5x
- 修改不影响不相关功能
- 测试更独立、更快
- 新加入者可以按模块逐步理解系统

### 1.2 升级引导引擎（expression-state 方案实施）

这是你的 `2026-06-14-expression-state-interaction-engine-design.md` 中已经设计好的方案，核心是把当前的关键词匹配：

```typescript
// 当前：硬编码关键词
const mentionsRescue = userText.includes("兜底") || userText.includes("救火");
const mentionsLoss = userText.includes("失控") || userText.includes("延期");
```

升级为**韵律特征 + 语义特征**的表达状态感知：

```
ExpressionState =
  fluent | organizing | hesitating | circling | emotional | concluding

fluent/organizing/concluding → 不干预
hesitating → 读取预生成的 depthDirection 做轻度引导
circling → 阶段总结
emotional → 共情标记
```

具体实施参照已有设计文档。这个改动直接影响用户体验——AI 不会在用户流畅表达时打断，只在用户真正需要帮助时介入。

### 1.3 接入 OpenTelemetry（轻量可观测性）

**为什么不用 Mastra Observability**：需要 Mastra 框架锁定。OpenTelemetry 是开放标准，未来换任何后端都兼容。

**方案**：~100 行代码，3 个文件

```typescript
// src/telemetry.ts — ~60 行
import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';

const sdk = new NodeSDK({
  serviceName: 'interview-api',
  traceExporter: new OTLPTraceExporter({
    url: process.env.OTEL_EXPORTER_OTLP_ENDPOINT || 'http://localhost:4318/v1/traces',
  }),
  instrumentations: [getNodeAutoInstrumentations()],
});
sdk.start();
```

**自动获得**：
- 每个 HTTP 请求 → Span（Fastify auto-instrumentation）
- 每个 AI 调用 → Span（手动创建）
- 端到端追踪：前端 → API → LLM Provider

**导出目标**：本地 Jaeger（开发）/ Grafana Tempo（生产）/ 任何 OTLP 兼容后端

### 1.4 清理语音管线

**当前**：3 套方案并存

| 管线 | 状态 | 决定 |
|------|------|------|
| `livekitVoice.ts` + `agent/main.py` | LiveKit Python Agent，目前在用 | ✅ **保留**（功能最完整，有语义 VAD） |
| `bailianWebrtc.ts` | 自研 WebRTC + TurnStateMachine | ❌ **删除**（被 LiveKit 替代） |
| `bailianWebsocket.ts` | 自研 WebSocket 管线 | ❌ **删除**（被 LiveKit 替代） |
| `turnDetectors/` | 自研 silenceVAD | ❌ **删除**（LiveKit MultilingualModel 替代） |

LiveKit Python Agent 已经在用且工作正常（语义级 VAD、Paraformer STT、CosyVoice TTS）。不需要换。

### 1.5 精简 `types.ts`

当前 1139 行，其中 ~600 行是 Mastra 相关的类型（MemoryRecord, MemoryCandidate, MemoryEdge, RagChunk, AuditEvent, AiRunEvent, WorkflowRun 等）。移除 Mastra 后这些类型也可以简化：

- MemoryRecord/Candidate/Edge → 保留（这是业务需要的记忆系统，不依赖 Mastra）
- RagChunk → 保留或改为通用 DocumentChunk
- AuditEvent/AiRunEvent/WorkflowRun → 删除（由 OpenTelemetry Trace 替代）
- OperationalCheckEvidence → 删除（健康检查可以用标准工具）

**目标**：~700 行

### 1.6 修复 `buildMonthlyReview` 硬编码

```typescript
// 当前
changedView: "你正在从"团队不主动"转向"机制是否让团队承担判断"。",
```

**修正**：用真正的 LLM 调用生成月度综述。这不是 Mastra Agent 的工作，这是**一个 LLM prompt 调用**，放在 `review.ts` 中的 ~30 行函数。

### 1.7 移除 Mastra 并修复 3 个失败的测试

- 移除 `packages/mastra/` 目录和 `package.json` 中的 Mastra 依赖
- 修复 `silenceVadDetector.test.ts` 中的 3 个失败测试（边界值调整）
- 如果 turnDetectors 被删除（步骤 1.4），这自然解决

---

## 2. 文件改动清单

### 2.1 新建

| 文件 | 行数 | 来源 | 说明 |
|------|------|------|------|
| `src/domain/context-pack.ts` | ~550 | 从 engine.ts 提取 | buildInterviewContextPack, buildInterviewGuide, buildInterviewCard |
| `src/domain/strategy.ts` | ~500 | 从 engine.ts 提取 | decideInterviewStrategy, buildInterviewEnginePolicy |
| `src/domain/turn-builder.ts` | ~450 | 从 engine.ts 提取 | buildAssistantTurn, receiveUserTurn |
| `src/domain/finalize.ts` | ~550 | 从 engine.ts 提取 | finalizeSession, buildDualTrackNote |
| `src/domain/review.ts` | ~350 | 从 engine.ts 提取 | buildMonthlyReview, buildYearlyReview |
| `src/domain/signals.ts` | ~300 | 从 engine.ts 提取 | buildRealtimeTurnState, appendRealtimeSignalTrace |
| `src/domain/search-brief.ts` | ~550 | 从 engine.ts 提取 | buildSearchBrief 相关 |
| `src/domain/voice-instructions.ts` | ~400 | 从 engine.ts 提取 | buildRealtimeVoiceInstructions |
| `src/domain/memory.ts` | ~450 | 从 engine.ts 提取 | 记忆相关函数 |
| `src/domain/assets.ts` | ~350 | 从 engine.ts 提取 | searchProductAssets 相关 |
| `src/domain/corpus.ts` | ~400 | 从 engine.ts 提取 | analyzeImportedInterview 相关 |
| `src/domain/podcast.ts` | ~350 | 从 engine.ts 提取 | generatePodcastEpisode 相关 |
| `src/domain/utils.ts` | ~100 | 从 engine.ts 提取 | nowIso, makeId, extractAnchor 等 |
| `src/telemetry.ts` | ~60 | 新建 | OpenTelemetry SDK 初始化 |
| `src/telemetry.test.ts` | ~30 | 新建 | 验证 SDK 启动不崩溃 |

### 2.2 修改

| 文件 | 改动 | 说明 |
|------|------|------|
| `src/domain/engine.ts` | 6150 → 50 行 | 变为 re-export 入口 |
| `src/domain/types.ts` | 1139 → ~700 行 | 删除可观测性相关类型，保留业务类型 |
| `src/domain/guidanceEngine.ts` | 159 → ~300 行 | 按 expression-state 方案升级 |
| `src/App.tsx` | 1185 → ~800 行 | 移除 bailianWebrtc/bailianWebsocket 分支，只保留 livekit 路径 |
| `src/features/interview/InterviewView.tsx` | 284 → ~250 行 | 移除 transport badge 中的多余选项 |
| `apps/api/src/routes/realtime-voice.ts` | 606 → ~400 行 | 移除 s2s 相关端点，只保留 livekit 端点 |
| `apps/api/src/routes/system.ts` | 630 → ~600 行 | 移除 realtimeMode 选项 |
| `src/styles.css` | | 移除旧 transport 相关 CSS |

### 2.3 删除

| 文件 | 说明 |
|------|------|
| `src/realtime/bailianWebrtc.ts` + test | LiveKit 已替代 |
| `src/realtime/bailianWebsocket.ts` + test | LiveKit 已替代 |
| `src/realtime/turnDetectors/` | LiveKit MultilingualModel 已替代 |
| `src/realtime/livekitVoice.ts` + test | 检查是否可简化为 `@livekit/react-client` 直接调用 |
| `packages/mastra/` 整个目录 | 不用的框架 |
| `package.json` 中 Mastra 依赖 | 不用的框架 |
| `apps/api/src/routes/mastra.ts` | Mastra 相关路由 |
| `apps/api/src/routes/observability.ts` | 被 OpenTelemetry 替代 |

### 2.4 保持不变

| 文件 | 原因 |
|------|------|
| `agent/main.py` + `interview_tools.py` | LiveKit Python Agent，工作正常 |
| `src/domain/storage.ts` | 功能正常 |
| `src/domain/seed.ts` | 功能正常 |
| `apps/api/src/routes/` (assets, notes, search, corpus, podcast, etc.) | 功能正常 |
| `src/features/config/ConfigView.tsx` | 功能正常 |
| `docs/superpowers/specs/2026-06-14-expression-state-interaction-engine-design.md` | 引导引擎升级的执行参考 |

---

## 3. 净效果

| 指标 | 当前 | 优化后 |
|------|------|--------|
| 自研代码总行数 | ~14,000 | ~12,000（*包含新增模块的行数*） |
| engine.ts 行数 | 6,150 | **50**（re-export 入口） |
| 每个模块平均行数 | 单体 | **~350** |
| 语音管线数量 | 3 套 | **1 套**（LiveKit） |
| 引导引擎 | 关键词匹配 | **表达状态感知** |
| 可观测性 | 无 | **OpenTelemetry 全链路追踪** |
| Mastra 依赖 | 已装不用 | **移除** |
| Python 依赖 | LiveKit Agent | **保留**（无替代方案） |
| 失败测试 | 3 个 | 0 |

---

## 4. 执行计划（5 个 Phase）

### Phase 1: 移除 Mastra + 清理（0.5 天）

**完全不碰业务逻辑，纯删除。**

- [ ] 删除 `packages/mastra/` 目录
- [ ] 从 `package.json` 移除 Mastra 依赖
- [ ] 删除 `apps/api/src/routes/mastra.ts` 和 `observability.ts`
- [ ] `npm install` 更新 lockfile
- [ ] `npx tsc --noEmit` 验证无编译错误
- [ ] `npx vitest run` 确认 Mastra 相关测试不在了
- [ ] **Commit**: `chore: remove unused Mastra framework`

### Phase 2: 拆分 engine.ts（1.5 天）

**最核心的改动。每拆一个模块就跑一次测试，确保零回归。**

- [ ] **2.1** 提取 `utils.ts`（nowIso, makeId, extractAnchor, isLongUserAnswer 等 ~100 行）→ 其他模块的零依赖基础
- [ ] **2.2** 提取 `context-pack.ts`（~550 行）→ engine.ts 改为 re-export
- [ ] **2.3** 提取 `strategy.ts`（~500 行）→ engine.ts 改为 re-export
- [ ] **2.4** 提取 `turn-builder.ts`（~450 行）→ 验证所有 import 路径正确
- [ ] **2.5** 提取 `finalize.ts`（~550 行）
- [ ] **2.6** 提取 `review.ts`（~350 行）
- [ ] **2.7** 提取 `signals.ts`（~300 行）
- [ ] **2.8** 提取 `search-brief.ts`（~550 行）
- [ ] **2.9** 提取 `voice-instructions.ts`（~400 行）
- [ ] **2.10** 提取 `memory.ts`（~450 行）
- [ ] **2.11** 提取 `assets.ts`（~350 行）
- [ ] **2.12** 提取 `corpus.ts`（~400 行）
- [ ] **2.13** 提取 `podcast.ts`（~350 行）
- [ ] **2.14** engine.ts 改为纯 re-export 入口（~50 行）
- [ ] `npx vitest run` — 全量通过
- [ ] `npx tsc --noEmit` — 零错误
- [ ] **Commit**: `refactor: split engine.ts (6150 lines) into 14 domain modules`

### Phase 3: 语音管线清理 + 引导引擎升级（1 天）

- [ ] **3.1** 删除 `bailianWebrtc.ts` + test
- [ ] **3.2** 删除 `bailianWebsocket.ts` + test
- [ ] **3.3** 删除 `turnDetectors/`
- [ ] **3.4** App.tsx 中移除 webrtc/websocket 分支
- [ ] **3.5** realtime-voice.ts 中移除 s2s 端点
- [ ] **3.6** 升级 `guidanceEngine.ts`（按 expression-state 方案，基于韵律特征的表达状态感知）
- [ ] **3.7** `npx vitest run` — 全量通过（现在 turnDetectors 测试已删除）
- [ ] **Commit**: `refactor: simplify to single voice pipeline (LiveKit), upgrade guidance engine`

### Phase 4: 可观测性 + 硬编码修复（0.5 天）

- [ ] **4.1** 创建 `src/telemetry.ts`（OpenTelemetry SDK ~60 行）
- [ ] **4.2** 在 `apps/api/src/index.ts` 入口第一行 import telemetry
- [ ] **4.3** 在前端 `src/main.tsx` 加浏览器端 telemetry
- [ ] **4.4** 修复 `buildMonthlyReview` 中的硬编码文本 → LLM 生成
- [ ] **4.5** 精简 `types.ts`（删除 AuditEvent, AiRunEvent, WorkflowRun 等）
- [ ] **4.6** `npx vitest run` → 全量通过
- [ ] **Commit**: `feat: add OpenTelemetry tracing, fix hardcoded review text`

### Phase 5: 端到端验证（0.5 天）

- [ ] `npx vitest run` — 250 个测试全量通过
- [ ] `npx tsc --noEmit` — 零错误
- [ ] `npm run build` — 构建成功
- [ ] 启动全栈验证专访流程：创建 → AI 追问 → 语音追问 → 结束保存
- [ ] 验证 Jaeger/OTel Collector 中可见 Trace
- [ ] **Commit**: `chore: final verification, all tests pass, build succeeds`

---

## 5. 不改的东西（明确排除）

| 不改 | 原因 |
|------|------|
| LiveKit Python Agent | 功能正常，阿里云 STT/TTS 没有 TS 原生替代 |
| Drizzle + SQLite/pgvector 存储 | 功能正常，无已知问题 |
| React UI 结构 | 功能正常 |
| bailian.ts Provider 封装 | 功能正常 |
| zhuanfang 目录 | 合并工作已完成 |
| docs 下的参考方案 | 保留作为历史记录 |

---

## 6. 风险评估

| 风险 | 缓解 |
|------|------|
| engine.ts 拆分导致 import 路径大面积断裂 | 每个子步骤后立即运行 `tsc --noEmit` + 测试，逐模块验证 |
| App.tsx 移除 webrtc/websocket 分支可能影响降级路径 | LiveKit 连接失败时保留确定性规则引擎作为 fallback |
| guidanceEngine 升级后行为变化 | 保留原有关键词匹配作为 fallback，新逻辑可配置开关 |
| OpenTelemetry 影响性能 | 开发环境用 100% sampling，生产环境 10% |

---

## 7. 为什么这个方案优于 Mastra 方案

| 维度 | v2 Mastra 方案 | v3 优化方案 |
|------|---------------|-----------|
| 核心改动 | 引入外部框架替代自研 | **拆分自研代码**（组织问题） |
| engine.ts | 从 6150 → 600（内容迁移到 Mastra Agent） | **从 6150 → 50**（内容拆分到 14 个模块） |
| 依赖 | 增加 Mastra 全家桶 | **移除 Mastra，不增加任何框架** |
| 风险 | Working Memory 数据损坏、5 堵墙 | **零外部依赖风险** |
| 可观测性 | Mastra Observability（框架锁定） | **OpenTelemetry（开放标准）** |
| 语音 | 需自写 @mastra/voice-aliyun | **保留已验证可用的 LiveKit** |
| 升级后引导 | Agent LLM 调用（1-3 秒延迟，不可用于实时） | **韵律特征规则引擎（<10ms，可用于实时）** |
| 代码净减 | 39% | ~10%（但组织**大幅**改善） |
| 实现时间 | 8-10 天 | **4 天** |

核心区别：v2 试图用 Mastra **替代** 自研代码。v3 承认自研代码的主体**是好的**，只是组织方式不好。v3 通过**拆分**解决组织问题，通过**保留已验证的组件**（LiveKit, Drizzle, bailian.ts）避免重造轮子，通过**OpenTelemetry** 补齐可观测性缺口，通过**expression-state 方案**解决引导质量问题。

**v3 不是更保守 — 它是更高效的。**
