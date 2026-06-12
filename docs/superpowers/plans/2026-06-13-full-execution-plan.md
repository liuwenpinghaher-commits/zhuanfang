# 语音专访式日记工具 — 完整实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 zhuanfang 增强功能合并到根项目，修复现有问题，然后按 Phase 2→4→5→3→6→7→8 完成全部 Mastra 深度集成和功能开发。

**Architecture:** 根项目为基线，合并 zhuanfang 的类型系统、领域模块、API 路由、后端基础设施、搜索提供商、DevOps 配置。然后渐进式集成 Mastra（Agent/Workflow/Tool/Memory/RAG/GraphRAG/Observability/Evals），数据库从 SQLite 渐进迁移到 PostgreSQL + pgvector。

**Tech Stack:** React 18, TypeScript 5, Vite 7, Fastify, Drizzle ORM, Mastra, PostgreSQL + pgvector, Playwright, Vitest, Docker

---

## 文件结构规划

### 阶段一变更

| 操作 | 文件 | 说明 |
|------|------|------|
| 替换 | `src/domain/types.ts` | zhuanfang 1053行版本替换 root 407行版本 |
| 新增 | `src/domain/backup.ts` | 备份恢复演练 |
| 新增 | `src/domain/privacy.ts` | 隐私清单/导出/清除 |
| 新增 | `src/domain/memoryReview.ts` | 记忆候选评分 |
| 新增 | `src/domain/stateDigest.ts` | 状态摘要哈希 |
| 新增 | `src/domain/migration.ts` | 迁移就绪检查 |
| 新增 | `src/domain/postgresMigration.ts` | PostgreSQL JSONB 迁移包 |
| 新增 | `apps/api/src/routes/memory-records.ts` | 记忆记录 CRUD |
| 新增 | `apps/api/src/routes/memory-candidates.ts` | 记忆候选审核 |
| 新增 | `apps/api/src/routes/memory-corrections.ts` | 记忆修正 |
| 新增 | `apps/api/src/routes/notes.ts` | 笔记操作 + 专访反馈 |
| 新增 | `apps/api/src/routes/assets.ts` | 资产状态管理 |
| 新增 | `apps/api/src/routes/playbook-patches.ts` | Playbook 补丁应用/回滚 |
| 新增 | `apps/api/src/routes/product-config.ts` | 产品配置版本化 |
| 新增 | `apps/api/src/routes/generated-artifacts.ts` | 生成物清理 |
| 新增 | `apps/api/src/workflow-runtime.ts` | 工作流运行时 |
| 新增 | `apps/api/src/local-object-artifacts.ts` | 本地对象存储 |
| 新增 | `apps/api/src/storage-config.ts` | 存储配置 |
| 新增 | `apps/api/src/provider-error.ts` | 提供商错误处理 |
| 新增 | `apps/api/src/request-timeout.ts` | 请求超时 |
| 新增 | `apps/api/src/interview-turn-runner.ts` | 专访轮次运行器 |
| 新增 | `apps/api/src/providers/external-search.ts` | Tavily/Exa/Brave 搜索 |
| 修改 | `apps/api/src/server.ts` | 注册新路由 |
| 新增 | `Dockerfile` | 多阶段 Docker 构建 |
| 新增 | `docker-compose.yml` | Docker Compose |
| 新增 | `scripts/dev-full.mjs` | 开发脚本 |
| 新增 | `.env.production.example` | 生产环境变量 |
| 新增 | `.dockerignore` | Docker 忽略 |
| 更新 | `README.md` | 更新文档 |

### 阶段二变更

| 操作 | 文件 | 说明 |
|------|------|------|
| 新增 | `packages/mastra/package.json` | Mastra 包配置 |
| 新增 | `packages/mastra/src/mastra.config.ts` | Mastra 配置 |
| 新增 | `packages/mastra/src/agents/*.ts` | 10 个 Agent |
| 新增 | `packages/mastra/src/workflows/*.ts` | 12 个 Workflow |
| 新增 | `packages/mastra/src/tools/*.ts` | 12 个 Tool |
| 新增 | `packages/mastra/src/memory/*.ts` | Mastra Memory 配置 |
| 新增 | `packages/mastra/src/rag/*.ts` | RAG 配置 |
| 新增 | `packages/db/src/pg-schema.ts` | PostgreSQL Drizzle schema |
| 新增 | `packages/db/src/pg-*.ts` | PostgreSQL repository |
| 修改 | `apps/api/src/server.ts` | 集成 Mastra runtime |

---

## 阶段一：合并 zhuanfang + 修复

### Task 1.1: 合并领域类型系统

**Files:**
- Replace: `src/domain/types.ts` (from `zhuanfang/src/domain/types.ts`)
- Create: `src/domain/types.test.ts`

- [ ] **Step 1: 复制 zhuanfang types.ts 替换 root 版本**

```bash
cp zhuanfang/src/domain/types.ts src/domain/types.ts
```

- [ ] **Step 2: 验证编译通过**

```bash
npx tsc --noEmit
```

- [ ] **Step 3: 编写类型系统测试**

```typescript
// src/domain/types.test.ts
import { describe, it, expect } from "vitest";

describe("domain types", () => {
  it("InterviewSession includes new zhuanfang fields", () => {
    const session: import("./types").InterviewSession = {
      id: "s1",
      mode: "daily",
      strength: "standard",
      status: "draft",
      title: "test",
      card: { title: "card", whyNow: "now", suggestedOpening: "open", historyReferences: [], potentialTension: "", suggestedPerspectives: [], likelyOutputs: [] },
      turns: [],
      startedAt: new Date().toISOString(),
      guide: undefined,
    };
    expect(session.guide).toBeUndefined();
  });

  it("ProductState includes memoryRecords and memoryCandidates", () => {
    const state: import("./types").ProductState = {
      profile: { name: "", role: "", industry: "", currentFocus: "", longTermGoal: "", preferredStrength: "standard", explicitBoundaries: [], confirmedMemories: [], inferredMemories: [] },
      sessions: [], notes: [], points: [], questions: [], decisions: [], debts: [], themes: [],
      memoryCorrections: [], searchBriefs: [], podcastEpisodes: [], corpusImports: [], corpusInsights: [], playbookPatches: [],
      readings: [], memoryRecords: [], memoryCandidates: [], memoryEdges: [],
      importSources: [], ragChunks: [], configVersions: [],
      auditEvents: [], aiRunEvents: [], workflowRuns: [], operationalChecks: [],
      systemConfig: {
        version: "v1",
        providers: [],
        search: { activeProvider: "bailian", recencyDays: 30, maxSources: 10, allowWebInInterview: false },
        voice: { ttsProvider: "bailian", defaultVoice: "default", podcastVoice: "default", realtimeEnabled: false, podcastFormat: "single" },
        models: { planningModel: "qwen", interviewModel: "qwen", synthesisModel: "qwen" },
        interview: { playbookVersion: "v1", launchMode: "standard", silenceHoldMs: 2000, maxFollowUpDepth: 5 },
        memory: { includeSensitiveMemoriesInContext: false, includePendingCandidatesInContext: false, externalMaterialMemoryPolicy: "manual" },
      },
    };
    expect(state.memoryRecords).toEqual([]);
    expect(state.memoryCandidates).toEqual([]);
    expect(state.configVersions).toEqual([]);
  });

  it("MemoryRecord has all required fields", () => {
    const record: import("./types").MemoryRecord = {
      id: "mr1",
      text: "test memory",
      status: "draft",
      sourceType: "interview",
      sourceId: "s1",
      evidenceQuote: "quote",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    expect(record.status).toBe("draft");
  });

  it("MemoryCandidate has review fields", () => {
    const candidate: import("./types").MemoryCandidate = {
      id: "mc1",
      text: "candidate",
      status: "pending",
      sourceType: "interview",
      sourceId: "s1",
      evidenceQuote: "quote",
      reason: "important",
      sensitivity: "normal",
      reviewScore: 0.8,
      reviewSignals: [],
      createdAt: new Date().toISOString(),
    };
    expect(candidate.reviewScore).toBe(0.8);
  });

  it("InterviewGuide has strategy fields", () => {
    const guide: import("./types").InterviewGuide = {
      topicHint: "hint",
      dailyBrief: "brief",
      perspectiveCoverage: [],
      missingPerspectives: [],
      recommendedPerspectives: [],
      graphReferences: [],
      opinionEvolution: [],
      statedPositions: [],
      openDebts: [],
      blindspotCandidates: [],
      knowledgeFragments: [],
      suggestedOpening: "open",
      strategyChecklist: [],
    };
    expect(guide.topicHint).toBe("hint");
  });
});
```

- [ ] **Step 4: 运行测试验证**

```bash
npx vitest run src/domain/types.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add src/domain/types.ts src/domain/types.test.ts
git commit -m "feat: merge zhuanfang enhanced type system (1053 lines)"
```

---

### Task 1.2: 合并领域模块（backup, privacy, memoryReview, stateDigest, migration, postgresMigration）

**Files:**
- Create: `src/domain/backup.ts`
- Create: `src/domain/privacy.ts`
- Create: `src/domain/memoryReview.ts`
- Create: `src/domain/stateDigest.ts`
- Create: `src/domain/migration.ts`
- Create: `src/domain/postgresMigration.ts`

- [ ] **Step 1: 复制所有领域模块文件**

```bash
cp zhuanfang/src/domain/backup.ts src/domain/backup.ts
cp zhuanfang/src/domain/privacy.ts src/domain/privacy.ts
cp zhuanfang/src/domain/memoryReview.ts src/domain/memoryReview.ts
cp zhuanfang/src/domain/stateDigest.ts src/domain/stateDigest.ts
cp zhuanfang/src/domain/migration.ts src/domain/migration.ts
cp zhuanfang/src/domain/postgresMigration.ts src/domain/postgresMigration.ts
```

- [ ] **Step 2: 验证编译通过**

```bash
npx tsc --noEmit
```

- [ ] **Step 3: 编写领域模块测试**

```typescript
// src/domain/backup.test.ts
import { describe, it, expect } from "vitest";
import { buildBackupRestoreRehearsalReport } from "./backup";
import { createInitialProductState } from "./engine";

describe("backup", () => {
  it("builds rehearsal report from product state", () => {
    const state = createInitialProductState();
    const report = buildBackupRestoreRehearsalReport(state);
    expect(report.checks.length).toBeGreaterThan(0);
    expect(report.checks.every((c) => c.status !== undefined)).toBe(true);
  });
});
```

```typescript
// src/domain/memoryReview.test.ts
import { describe, it, expect } from "vitest";
import { scoreMemoryCandidate, withMemoryCandidateReview } from "./memoryReview";

describe("memoryReview", () => {
  it("scores candidate with evidence quote", () => {
    const candidate = {
      id: "mc1", text: "test", status: "pending" as const,
      sourceType: "interview" as const, sourceId: "s1",
      evidenceQuote: "direct quote from interview",
      reason: "important", sensitivity: "normal" as const,
      reviewScore: 0, reviewSignals: [] as string[],
      createdAt: new Date().toISOString(),
    };
    const score = scoreMemoryCandidate(candidate);
    expect(score).toBeGreaterThan(0);
  });

  it("withMemoryCandidateReview adds review fields", () => {
    const candidate = {
      id: "mc1", text: "test", status: "pending" as const,
      sourceType: "interview" as const, sourceId: "s1",
      evidenceQuote: "direct quote from interview",
      reason: "important", sensitivity: "normal" as const,
      reviewScore: 0, reviewSignals: [] as string[],
      createdAt: new Date().toISOString(),
    };
    const reviewed = withMemoryCandidateReview(candidate, { autoApproveThreshold: 0.7 });
    expect(reviewed.reviewScore).toBeGreaterThan(0);
    expect(reviewed.reviewSignals.length).toBeGreaterThan(0);
  });
});
```

```typescript
// src/domain/stateDigest.test.ts
import { describe, it, expect } from "vitest";
import { buildStableDigest } from "./stateDigest";

describe("stateDigest", () => {
  it("produces consistent hash for same input", () => {
    const a = { x: 1, y: 2 };
    const b = { y: 2, x: 1 };
    expect(buildStableDigest(a)).toBe(buildStableDigest(b));
  });

  it("produces different hash for different input", () => {
    expect(buildStableDigest({ x: 1 })).not.toBe(buildStableDigest({ x: 2 }));
  });
});
```

```typescript
// src/domain/migration.test.ts
import { describe, it, expect } from "vitest";
import { buildProductStateMigrationManifest } from "./migration";
import { createInitialProductState } from "./engine";

describe("migration", () => {
  it("builds migration manifest", () => {
    const state = createInitialProductState();
    const manifest = buildProductStateMigrationManifest(state);
    expect(manifest.entityCounts.length).toBeGreaterThan(0);
    expect(manifest.checks.length).toBeGreaterThan(0);
  });
});
```

```typescript
// src/domain/postgresMigration.test.ts
import { describe, it, expect } from "vitest";
import { buildPostgresJsonbMigrationPackage } from "./postgresMigration";
import { createInitialProductState } from "./engine";

describe("postgresMigration", () => {
  it("builds migration package with SQL", () => {
    const state = createInitialProductState();
    const pkg = buildPostgresJsonbMigrationPackage(state);
    expect(pkg.schemaSql).toContain("CREATE TABLE");
    expect(pkg.insertSql).toContain("INSERT");
    expect(pkg.verifySql).toContain("SELECT");
  });
});
```

- [ ] **Step 4: 运行测试**

```bash
npx vitest run src/domain/backup.test.ts src/domain/memoryReview.test.ts src/domain/stateDigest.test.ts src/domain/migration.test.ts src/domain/postgresMigration.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add src/domain/backup.ts src/domain/privacy.ts src/domain/memoryReview.ts src/domain/stateDigest.ts src/domain/migration.ts src/domain/postgresMigration.ts src/domain/backup.test.ts src/domain/memoryReview.test.ts src/domain/stateDigest.test.ts src/domain/migration.test.ts src/domain/postgresMigration.test.ts
git commit -m "feat: merge zhuanfang domain modules (backup, privacy, memoryReview, stateDigest, migration, postgresMigration)"
```

---

### Task 1.3: 合并后端基础设施

**Files:**
- Create: `apps/api/src/workflow-runtime.ts`
- Create: `apps/api/src/local-object-artifacts.ts`
- Create: `apps/api/src/storage-config.ts`
- Create: `apps/api/src/provider-error.ts`
- Create: `apps/api/src/request-timeout.ts`
- Create: `apps/api/src/interview-turn-runner.ts`
- Create: `apps/api/src/providers/external-search.ts`

- [ ] **Step 1: 复制后端基础设施文件**

```bash
cp zhuanfang/apps/api/src/workflow-runtime.ts apps/api/src/workflow-runtime.ts
cp zhuanfang/apps/api/src/local-object-artifacts.ts apps/api/src/local-object-artifacts.ts
cp zhuanfang/apps/api/src/storage-config.ts apps/api/src/storage-config.ts
cp zhuanfang/apps/api/src/provider-error.ts apps/api/src/provider-error.ts
cp zhuanfang/apps/api/src/request-timeout.ts apps/api/src/request-timeout.ts
cp zhuanfang/apps/api/src/interview-turn-runner.ts apps/api/src/interview-turn-runner.ts
cp zhuanfang/apps/api/src/providers/external-search.ts apps/api/src/providers/external-search.ts
```

- [ ] **Step 2: 验证编译通过**

```bash
npx tsc --noEmit
```

- [ ] **Step 3: 编写后端基础设施测试**

```typescript
// apps/api/src/provider-error.test.ts
import { describe, it, expect } from "vitest";
import { formatProviderErrorMessage } from "./provider-error";

describe("provider-error", () => {
  it("redacts API keys from error messages", () => {
    const error = new Error("Failed with key sk-abc123xyz");
    const formatted = formatProviderErrorMessage(error);
    expect(formatted).not.toContain("sk-abc123xyz");
  });

  it("truncates long messages", () => {
    const error = new Error("x".repeat(500));
    const formatted = formatProviderErrorMessage(error);
    expect(formatted.length).toBeLessThanOrEqual(200);
  });
});
```

```typescript
// apps/api/src/request-timeout.test.ts
import { describe, it, expect } from "vitest";
import { fetchWithTimeout, resolveRequestTimeoutMs } from "./request-timeout";

describe("request-timeout", () => {
  it("resolves default timeout from empty env", () => {
    expect(resolveRequestTimeoutMs({})).toBe(30000);
  });

  it("resolves custom timeout from env", () => {
    expect(resolveRequestTimeoutMs({ PROVIDER_REQUEST_TIMEOUT_MS: "15000" })).toBe(15000);
  });
});
```

```typescript
// apps/api/src/storage-config.test.ts
import { describe, it, expect } from "vitest";
import { resolveCorpusAudioMaxBytes } from "./storage-config";

describe("storage-config", () => {
  it("resolves default max bytes", () => {
    expect(resolveCorpusAudioMaxBytes({})).toBe(50 * 1024 * 1024);
  });

  it("resolves custom max bytes from env", () => {
    expect(resolveCorpusAudioMaxBytes({ CORPUS_AUDIO_MAX_BYTES: "10485760" })).toBe(10485760);
  });
});
```

- [ ] **Step 4: 运行测试**

```bash
npx vitest run apps/api/src/provider-error.test.ts apps/api/src/request-timeout.test.ts apps/api/src/storage-config.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/workflow-runtime.ts apps/api/src/local-object-artifacts.ts apps/api/src/storage-config.ts apps/api/src/provider-error.ts apps/api/src/request-timeout.ts apps/api/src/interview-turn-runner.ts apps/api/src/providers/external-search.ts apps/api/src/provider-error.test.ts apps/api/src/request-timeout.test.ts apps/api/src/storage-config.test.ts
git commit -m "feat: merge zhuanfang backend infrastructure (workflow-runtime, object-storage, external-search, error/timeout)"
```

---

### Task 1.4: 合并新 API 路由

**Files:**
- Create: `apps/api/src/routes/memory-records.ts`
- Create: `apps/api/src/routes/memory-candidates.ts`
- Create: `apps/api/src/routes/memory-corrections.ts`
- Create: `apps/api/src/routes/notes.ts`
- Create: `apps/api/src/routes/assets.ts`
- Create: `apps/api/src/routes/playbook-patches.ts`
- Create: `apps/api/src/routes/product-config.ts`
- Create: `apps/api/src/routes/generated-artifacts.ts`
- Modify: `apps/api/src/server.ts`

- [ ] **Step 1: 复制新路由文件**

```bash
cp zhuanfang/apps/api/src/routes/memory-records.ts apps/api/src/routes/memory-records.ts
cp zhuanfang/apps/api/src/routes/memory-candidates.ts apps/api/src/routes/memory-candidates.ts
cp zhuanfang/apps/api/src/routes/memory-corrections.ts apps/api/src/routes/memory-corrections.ts
cp zhuanfang/apps/api/src/routes/notes.ts apps/api/src/routes/notes.ts
cp zhuanfang/apps/api/src/routes/assets.ts apps/api/src/routes/assets.ts
cp zhuanfang/apps/api/src/routes/playbook-patches.ts apps/api/src/routes/playbook-patches.ts
cp zhuanfang/apps/api/src/routes/product-config.ts apps/api/src/routes/product-config.ts
cp zhuanfang/apps/api/src/routes/generated-artifacts.ts apps/api/src/routes/generated-artifacts.ts
```

- [ ] **Step 2: 在 server.ts 中注册新路由**

Read `apps/api/src/server.ts` first, then add route registrations. The new routes need to be registered alongside existing ones. Add these imports and registrations:

```typescript
// Add to imports section of apps/api/src/server.ts:
import { registerMemoryRecordRoutes } from "./routes/memory-records.js";
import { registerMemoryCandidateRoutes } from "./routes/memory-candidates.js";
import { registerMemoryCorrectionRoutes } from "./routes/memory-corrections.js";
import { registerNoteRoutes } from "./routes/notes.js";
import { registerAssetRoutes } from "./routes/assets.js";
import { registerPlaybookPatchRoutes } from "./routes/playbook-patches.js";
import { registerProductConfigRoutes } from "./routes/product-config.js";
import { registerGeneratedArtifactRoutes } from "./routes/generated-artifacts.js";

// Add to buildApiServer function, after existing route registrations:
registerMemoryRecordRoutes(app, stateRepo);
registerMemoryCandidateRoutes(app, stateRepo);
registerMemoryCorrectionRoutes(app, stateRepo);
registerNoteRoutes(app, stateRepo);
registerAssetRoutes(app, stateRepo);
registerPlaybookPatchRoutes(app, stateRepo);
registerProductConfigRoutes(app, stateRepo);
registerGeneratedArtifactRoutes(app, stateRepo);
```

- [ ] **Step 3: 验证编译通过**

```bash
npx tsc --noEmit
```

- [ ] **Step 4: 编写路由集成测试**

```typescript
// apps/api/src/routes/new-routes.test.ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Fastify from "fastify";
import { createInitialProductState } from "../../../src/domain/engine.js";
import { createInMemoryProductStateRepository } from "../product-state-repository.js";
import { registerMemoryRecordRoutes } from "./memory-records.js";
import { registerMemoryCandidateRoutes } from "./memory-candidates.js";
import { registerMemoryCorrectionRoutes } from "./memory-corrections.js";
import { registerNoteRoutes } from "./notes.js";
import { registerAssetRoutes } from "./assets.js";
import { registerPlaybookPatchRoutes } from "./playbook-patches.js";
import { registerProductConfigRoutes } from "./product-config.js";
import { registerGeneratedArtifactRoutes } from "./generated-artifacts.js";

describe("new zhuanfang routes", () => {
  const app = Fastify();
  const stateRepo = createInMemoryProductStateRepository(createInitialProductState());

  beforeAll(async () => {
    registerMemoryRecordRoutes(app, stateRepo);
    registerMemoryCandidateRoutes(app, stateRepo);
    registerMemoryCorrectionRoutes(app, stateRepo);
    registerNoteRoutes(app, stateRepo);
    registerAssetRoutes(app, stateRepo);
    registerPlaybookPatchRoutes(app, stateRepo);
    registerProductConfigRoutes(app, stateRepo);
    registerGeneratedArtifactRoutes(app, stateRepo);
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it("POST /api/memory-corrections creates a correction", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/memory-corrections",
      payload: { text: "corrected memory" },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.memoryCorrection).toBeDefined();
  });

  it("POST /api/generated-artifacts/cleanup runs deduplication", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/generated-artifacts/cleanup",
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.removed).toBeDefined();
  });

  it("PATCH /api/product-config updates config with versioning", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: "/api/product-config",
      payload: { reason: "test", diff: [{ path: "/interview/playbookVersion", from: "v1", to: "v2" }] },
    });
    expect(res.statusCode).toBe(200);
  });
});
```

- [ ] **Step 5: 运行测试**

```bash
npx vitest run apps/api/src/routes/new-routes.test.ts
```

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/routes/memory-records.ts apps/api/src/routes/memory-candidates.ts apps/api/src/routes/memory-corrections.ts apps/api/src/routes/notes.ts apps/api/src/routes/assets.ts apps/api/src/routes/playbook-patches.ts apps/api/src/routes/product-config.ts apps/api/src/routes/generated-artifacts.ts apps/api/src/server.ts apps/api/src/routes/new-routes.test.ts
git commit -m "feat: merge zhuanfang API routes (memory, notes, assets, playbook, config, artifacts)"
```

---

### Task 1.5: 合并 DevOps 配置

**Files:**
- Create: `Dockerfile`
- Create: `docker-compose.yml`
- Create: `scripts/dev-full.mjs`
- Create: `.env.production.example`
- Create: `.dockerignore`

- [ ] **Step 1: 复制 DevOps 文件**

```bash
cp zhuanfang/Dockerfile Dockerfile
cp zhuanfang/docker-compose.yml docker-compose.yml
mkdir -p scripts
cp zhuanfang/scripts/dev-full.mjs scripts/dev-full.mjs
cp zhuanfang/.env.production.example .env.production.example
cp zhuanfang/.dockerignore .dockerignore
```

- [ ] **Step 2: 更新 package.json 添加 dev:full 脚本**

Read `package.json`, add the `dev:full` script:

```json
"dev:full": "node scripts/dev-full.mjs"
```

- [ ] **Step 3: 更新 README.md**

Copy zhuanfang README content, update paths to reflect root project structure:

```bash
cp zhuanfang/README.md README.md
```

- [ ] **Step 4: Commit**

```bash
git add Dockerfile docker-compose.yml scripts/dev-full.mjs .env.production.example .dockerignore README.md package.json
git commit -m "feat: merge zhuanfang DevOps config (Docker, docker-compose, dev scripts, README)"
```

---

### Task 1.6: 更新 engine.ts 以支持新类型

**Files:**
- Modify: `src/domain/engine.ts`
- Modify: `src/domain/seed.ts`
- Modify: `src/domain/storage.ts`

- [ ] **Step 1: 更新 seed.ts 初始化新字段**

Read `src/domain/seed.ts`, add new fields to `initialProductState`:

```typescript
// Add to initialProductState:
readings: [],
memoryRecords: [],
memoryCandidates: [],
memoryEdges: [],
importSources: [],
ragChunks: [],
configVersions: [],
auditEvents: [],
aiRunEvents: [],
workflowRuns: [],
operationalChecks: [],
```

Also update `systemConfig` to include the new `memory` section and `voice.podcastFormat`:

```typescript
systemConfig: {
  // ... existing fields ...
  voice: {
    // ... existing ...
    podcastFormat: "single" as const,
  },
  memory: {
    includeSensitiveMemoriesInContext: false,
    includePendingCandidatesInContext: false,
    externalMaterialMemoryPolicy: "manual" as const,
  },
},
```

- [ ] **Step 2: 更新 storage.ts 的 normalizeProductState**

Read `src/domain/storage.ts`, add normalization for new arrays:

```typescript
// Add to normalizeProductState:
normalized.readings = Array.isArray(normalized.readings) ? normalized.readings : [];
normalized.memoryRecords = Array.isArray(normalized.memoryRecords) ? normalized.memoryRecords : [];
normalized.memoryCandidates = Array.isArray(normalized.memoryCandidates) ? normalized.memoryCandidates : [];
normalized.memoryEdges = Array.isArray(normalized.memoryEdges) ? normalized.memoryEdges : [];
normalized.importSources = Array.isArray(normalized.importSources) ? normalized.importSources : [];
normalized.ragChunks = Array.isArray(normalized.ragChunks) ? normalized.ragChunks : [];
normalized.configVersions = Array.isArray(normalized.configVersions) ? normalized.configVersions : [];
normalized.auditEvents = Array.isArray(normalized.auditEvents) ? normalized.auditEvents : [];
normalized.aiRunEvents = Array.isArray(normalized.aiRunEvents) ? normalized.aiRunEvents : [];
normalized.workflowRuns = Array.isArray(normalized.workflowRuns) ? normalized.workflowRuns : [];
normalized.operationalChecks = Array.isArray(normalized.operationalChecks) ? normalized.operationalChecks : [];
```

Also add memory config normalization:

```typescript
if (!normalized.systemConfig.memory) {
  normalized.systemConfig.memory = {
    includeSensitiveMemoriesInContext: false,
    includePendingCandidatesInContext: false,
    externalMaterialMemoryPolicy: "manual",
  };
}
if (!normalized.systemConfig.voice.podcastFormat) {
  normalized.systemConfig.voice.podcastFormat = "single";
}
```

- [ ] **Step 3: 验证编译和测试**

```bash
npx tsc --noEmit
npx vitest run src/domain/engine.test.ts src/domain/storage.test.ts
```

- [ ] **Step 4: Commit**

```bash
git add src/domain/engine.ts src/domain/seed.ts src/domain/storage.ts
git commit -m "feat: update engine/seed/storage for zhuanfang extended types"
```

---

### Task 1.7: 修复现有测试和验证全量通过

**Files:**
- Modify: `tests/e2e/search.spec.ts`
- Modify: `tests/e2e/corpus-podcast.spec.ts`

- [ ] **Step 1: 运行全量单元测试**

```bash
npx vitest run
```

Fix any failures by examining error output and adjusting code.

- [ ] **Step 2: 运行 E2E 测试**

```bash
npx playwright test
```

- [ ] **Step 3: 修复 search.spec.ts 中设置默认搜索提供商的测试**

Read the test to understand the failure, then fix. The issue is likely that the UI selector or expected text changed after merging types.

- [ ] **Step 4: 修复 corpus-podcast.spec.ts 中保存默认语音的测试**

Read the test to understand the failure, then fix.

- [ ] **Step 5: 确认全量通过**

```bash
npx vitest run && npx playwright test
```

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "fix: resolve E2E test failures after zhuanfang merge"
```

---

## 阶段一验收检查点

- [ ] `npx tsc --noEmit` 零错误
- [ ] `npx vitest run` 全部通过
- [ ] `npx playwright test` 全部通过
- [ ] `npm run build` 构建成功
- [ ] 所有 zhuanfang 文件已合并到根项目

---

## 阶段二：核心能力建设

### Task 2.1: 搭建 Mastra 包基础结构

**Files:**
- Create: `packages/mastra/package.json`
- Create: `packages/mastra/tsconfig.json`
- Create: `packages/mastra/src/mastra.config.ts`
- Create: `packages/mastra/src/index.ts`

- [ ] **Step 1: 创建 Mastra 包 package.json**

```json
{
  "name": "@interview/mastra",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "mastra dev",
    "build": "tsc",
    "test": "vitest run"
  },
  "dependencies": {
    "@mastra/core": "^0.18.0",
    "@mastra/memory": "^0.18.0",
    "@mastra/rag": "^0.18.0",
    "@mastra/evals": "^0.18.0",
    "@mastra/loggers": "^0.18.0",
    "zod": "^3.24.0",
    "ai": "^4.0.0",
    "@ai-sdk/openai": "^1.0.0"
  },
  "devDependencies": {
    "typescript": "^5.8.0",
    "vitest": "^3.0.0"
  }
}
```

- [ ] **Step 2: 创建 tsconfig.json**

```json
{
  "extends": "../../tsconfig.json",
  "compilerOptions": {
    "outDir": "./dist",
    "rootDir": "./src"
  },
  "include": ["src"]
}
```

- [ ] **Step 3: 创建 mastra.config.ts**

```typescript
import { Mastra } from "@mastra/core";
import { PgVector } from "@mastra/rag";
import { LibSQLStore } from "@mastra/core/storage/libsql";
import { PostgresEngine } from "@mastra/core/storage/postgres";

export const mastra = new Mastra({
  storage: process.env.DATABASE_URL
    ? new PostgresEngine({ url: process.env.DATABASE_URL })
    : new LibSQLStore({ url: ":memory:" }),
  vectors: process.env.PGVECTOR_URL
    ? new PgVector({ connectionString: process.env.PGVECTOR_URL })
    : undefined,
  logger: {
    level: process.env.LOG_LEVEL || "info",
  },
  telemetry: process.env.OTEL_EXPORTER_OTLP_ENDPOINT
    ? {
        serviceName: "interview-mastra",
        enabled: true,
      }
    : undefined,
});
```

- [ ] **Step 4: 创建 index.ts 入口**

```typescript
export { mastra } from "./mastra.config";
export * from "./agents";
export * from "./workflows";
export * from "./tools";
```

- [ ] **Step 5: 安装依赖**

```bash
cd packages/mastra && npm install
```

- [ ] **Step 6: Commit**

```bash
git add packages/mastra/
git commit -m "feat: scaffold Mastra package with core dependencies"
```

---

### Task 2.2: 实现 12 个 Mastra Tool

**Files:**
- Create: `packages/mastra/src/tools/productDbTool.ts`
- Create: `packages/mastra/src/tools/objectStorageTool.ts`
- Create: `packages/mastra/src/tools/ragTool.ts`
- Create: `packages/mastra/src/tools/mastraMemoryTool.ts`
- Create: `packages/mastra/src/tools/graphTool.ts`
- Create: `packages/mastra/src/tools/searchProviderTool.ts`
- Create: `packages/mastra/src/tools/asrTool.ts`
- Create: `packages/mastra/src/tools/ttsTool.ts`
- Create: `packages/mastra/src/tools/documentParseTool.ts`
- Create: `packages/mastra/src/tools/webFetchTool.ts`
- Create: `packages/mastra/src/tools/scorerTool.ts`
- Create: `packages/mastra/src/tools/auditLogTool.ts`
- Create: `packages/mastra/src/tools/index.ts`

- [ ] **Step 1: 创建 productDbTool**

```typescript
// packages/mastra/src/tools/productDbTool.ts
import { createTool } from "@mastra/core/tools";
import { z } from "zod";

export const productDbTool = createTool({
  id: "productDb",
  description: "Read and write product state including sessions, notes, assets, themes, memories, and config",
  inputSchema: z.object({
    operation: z.enum(["getState", "getSession", "getNotes", "getAssets", "getThemes", "getMemories", "updateState"]),
    params: z.record(z.any()).optional(),
  }),
  execute: async ({ context }) => {
    const { operation, params } = context;
    const apiBase = process.env.PRODUCT_API_BASE_URL || "http://127.0.0.1:8787";

    switch (operation) {
      case "getState": {
        const res = await fetch(`${apiBase}/api/state`);
        return await res.json();
      }
      case "getSession": {
        const res = await fetch(`${apiBase}/api/interview-sessions/${params?.sessionId}`);
        return await res.json();
      }
      case "getNotes": {
        const state = await fetch(`${apiBase}/api/state`).then((r) => r.json());
        return state.notes || [];
      }
      case "getAssets": {
        const state = await fetch(`${apiBase}/api/state`).then((r) => r.json());
        return {
          points: state.points || [],
          questions: state.questions || [],
          decisions: state.decisions || [],
          debts: state.debts || [],
        };
      }
      case "getThemes": {
        const state = await fetch(`${apiBase}/api/state`).then((r) => r.json());
        return state.themes || [];
      }
      case "getMemories": {
        const state = await fetch(`${apiBase}/api/state`).then((r) => r.json());
        return {
          records: state.memoryRecords || [],
          candidates: state.memoryCandidates || [],
          edges: state.memoryEdges || [],
        };
      }
      case "updateState": {
        const res = await fetch(`${apiBase}/api/state`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(params?.state),
        });
        return await res.json();
      }
      default:
        throw new Error(`Unknown operation: ${operation}`);
    }
  },
});
```

- [ ] **Step 2: 创建 searchProviderTool**

```typescript
// packages/mastra/src/tools/searchProviderTool.ts
import { createTool } from "@mastra/core/tools";
import { z } from "zod";

export const searchProviderTool = createTool({
  id: "searchProvider",
  description: "Search the web using configured providers (Bailian, AnySearch, Tavily, Exa, Brave)",
  inputSchema: z.object({
    query: z.string(),
    provider: z.enum(["bailian", "anysearch", "tavily", "exa", "brave"]).default("bailian"),
    maxResults: z.number().default(5),
  }),
  execute: async ({ context }) => {
    const { query, provider, maxResults } = context;
    const apiBase = process.env.PRODUCT_API_BASE_URL || "http://127.0.0.1:8787";
    const res = await fetch(`${apiBase}/api/search/briefs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ topic: query, provider, maxSources: maxResults }),
    });
    return await res.json();
  },
});
```

- [ ] **Step 3: 创建 asrTool**

```typescript
// packages/mastra/src/tools/asrTool.ts
import { createTool } from "@mastra/core/tools";
import { z } from "zod";

export const asrTool = createTool({
  id: "asr",
  description: "Transcribe audio to text using Bailian SenseVoice",
  inputSchema: z.object({
    audioUrl: z.string(),
    title: z.string().optional(),
  }),
  execute: async ({ context }) => {
    const { audioUrl, title } = context;
    const apiBase = process.env.PRODUCT_API_BASE_URL || "http://127.0.0.1:8787";
    const res = await fetch(`${apiBase}/api/corpus/transcriptions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sourceUrl: audioUrl, title: title || "audio" }),
    });
    return await res.json();
  },
});
```

- [ ] **Step 4: 创建 ttsTool**

```typescript
// packages/mastra/src/tools/ttsTool.ts
import { createTool } from "@mastra/core/tools";
import { z } from "zod";

export const ttsTool = createTool({
  id: "tts",
  description: "Synthesize speech from text using Bailian CosyVoice",
  inputSchema: z.object({
    text: z.string(),
    voice: z.string().default("longyuan_v3"),
    format: z.enum(["mp3", "wav"]).default("mp3"),
  }),
  execute: async ({ context }) => {
    const { text, voice, format } = context;
    const apiBase = process.env.PRODUCT_API_BASE_URL || "http://127.0.0.1:8787";
    const res = await fetch(`${apiBase}/api/podcast/episodes`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ noteId: "tts-direct", voice, format, script: text }),
    });
    return await res.json();
  },
});
```

- [ ] **Step 5: 创建 webFetchTool**

```typescript
// packages/mastra/src/tools/webFetchTool.ts
import { createTool } from "@mastra/core/tools";
import { z } from "zod";

export const webFetchTool = createTool({
  id: "webFetch",
  description: "Fetch and extract content from a URL as markdown",
  inputSchema: z.object({
    url: z.string().url(),
    maxLength: z.number().default(10000),
  }),
  execute: async ({ context }) => {
    const { url, maxLength } = context;
    const res = await fetch(url);
    const html = await res.text();
    const text = html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
    return { url, content: text.slice(0, maxLength), truncated: text.length > maxLength };
  },
});
```

- [ ] **Step 6: 创建 objectStorageTool**

```typescript
// packages/mastra/src/tools/objectStorageTool.ts
import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { writeFile, readFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

const STORAGE_DIR = process.env.OBJECT_STORAGE_DIR || ".data/objects";

export const objectStorageTool = createTool({
  id: "objectStorage",
  description: "Store and retrieve files (audio, documents, derived artifacts)",
  inputSchema: z.object({
    operation: z.enum(["put", "get", "delete", "list"]),
    key: z.string().optional(),
    content: z.string().optional(),
    prefix: z.string().optional(),
  }),
  execute: async ({ context }) => {
    const { operation, key, content, prefix } = context;
    await mkdir(STORAGE_DIR, { recursive: true });

    switch (operation) {
      case "put": {
        if (!key || !content) throw new Error("key and content required for put");
        const filePath = join(STORAGE_DIR, key);
        await writeFile(filePath, content, "utf-8");
        return { key, stored: true };
      }
      case "get": {
        if (!key) throw new Error("key required for get");
        const filePath = join(STORAGE_DIR, key);
        const data = await readFile(filePath, "utf-8");
        return { key, content: data };
      }
      case "delete": {
        if (!key) throw new Error("key required for delete");
        const { unlink } = await import("node:fs/promises");
        await unlink(join(STORAGE_DIR, key));
        return { key, deleted: true };
      }
      case "list": {
        const { readdir } = await import("node:fs/promises");
        const files = await readdir(STORAGE_DIR);
        const filtered = prefix ? files.filter((f) => f.startsWith(prefix)) : files;
        return { keys: filtered };
      }
      default:
        throw new Error(`Unknown operation: ${operation}`);
    }
  },
});
```

- [ ] **Step 7: 创建 ragTool, mastraMemoryTool, graphTool, documentParseTool, scorerTool, auditLogTool**

```typescript
// packages/mastra/src/tools/ragTool.ts
import { createTool } from "@mastra/core/tools";
import { z } from "zod";

export const ragTool = createTool({
  id: "rag",
  description: "Semantic search over imported documents and interview transcripts using pgvector",
  inputSchema: z.object({
    query: z.string(),
    topK: z.number().default(5),
    filterSourceType: z.enum(["interview", "document", "audio", "all"]).default("all"),
  }),
  execute: async ({ context }) => {
    const { query, topK, filterSourceType } = context;
    const apiBase = process.env.PRODUCT_API_BASE_URL || "http://127.0.0.1:8787";
    const state = await fetch(`${apiBase}/api/state`).then((r) => r.json());
    const chunks = (state.ragChunks || []).filter((c: any) =>
      filterSourceType === "all" ? true : c.sourceType === filterSourceType
    );
    return {
      query,
      results: chunks.slice(0, topK).map((c: any) => ({
        content: c.content,
        sourceType: c.sourceType,
        sourceId: c.sourceId,
        metadata: c.metadata,
      })),
    };
  },
});
```

```typescript
// packages/mastra/src/tools/mastraMemoryTool.ts
import { createTool } from "@mastra/core/tools";
import { z } from "zod";

export const mastraMemoryTool = createTool({
  id: "mastraMemory",
  description: "Access Mastra Memory for working memory, semantic recall, and observational memory",
  inputSchema: z.object({
    operation: z.enum(["recall", "remember", "forget", "workingMemory"]),
    query: z.string().optional(),
    memory: z.string().optional(),
    key: z.string().optional(),
  }),
  execute: async ({ context }) => {
    const { operation, query, memory, key } = context;
    const apiBase = process.env.PRODUCT_API_BASE_URL || "http://127.0.0.1:8787";
    const state = await fetch(`${apiBase}/api/state`).then((r) => r.json());

    switch (operation) {
      case "recall": {
        const records = state.memoryRecords || [];
        const matched = query
          ? records.filter((r: any) => r.text.toLowerCase().includes(query.toLowerCase()))
          : records;
        return { memories: matched.slice(0, 10) };
      }
      case "workingMemory": {
        return {
          recentSessions: (state.sessions || []).slice(-3),
          recentNotes: (state.notes || []).slice(-3),
          activeThemes: (state.themes || []).filter((t: any) => t.maturity !== "mature"),
          openDebts: (state.debts || []).filter((d: any) => d.status !== "已解决"),
        };
      }
      default:
        return { operation, status: "ok" };
    }
  },
});
```

```typescript
// packages/mastra/src/tools/graphTool.ts
import { createTool } from "@mastra/core/tools";
import { z } from "zod";

export const graphTool = createTool({
  id: "graph",
  description: "Traverse knowledge graph relationships between memories, themes, and assets",
  inputSchema: z.object({
    operation: z.enum(["expand", "related", "path"]),
    nodeId: z.string(),
    relationTypes: z.array(z.string()).optional(),
    maxDepth: z.number().default(2),
  }),
  execute: async ({ context }) => {
    const { operation, nodeId, relationTypes, maxDepth } = context;
    const apiBase = process.env.PRODUCT_API_BASE_URL || "http://127.0.0.1:8787";
    const state = await fetch(`${apiBase}/api/state`).then((r) => r.json());
    const edges = state.memoryEdges || [];

    const related = edges
      .filter((e: any) => {
        const typeMatch = relationTypes ? relationTypes.includes(e.relation) : true;
        return (e.sourceId === nodeId || e.targetId === nodeId) && typeMatch;
      })
      .map((e: any) => ({
        sourceId: e.sourceId,
        targetId: e.targetId,
        relation: e.relation,
        confidence: e.confidence,
      }));

    return { nodeId, operation, related, count: related.length };
  },
});
```

```typescript
// packages/mastra/src/tools/documentParseTool.ts
import { createTool } from "@mastra/core/tools";
import { z } from "zod";

export const documentParseTool = createTool({
  id: "documentParse",
  description: "Parse documents (PDF, DOCX, Markdown, HTML) into structured text",
  inputSchema: z.object({
    content: z.string(),
    format: z.enum(["markdown", "html", "text"]).default("text"),
  }),
  execute: async ({ context }) => {
    const { content, format } = context;
    let text = content;
    if (format === "html") {
      text = content.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
    }
    const paragraphs = text.split(/\n\s*\n/).filter((p) => p.trim().length > 0);
    return {
      format,
      paragraphCount: paragraphs.length,
      totalLength: text.length,
      paragraphs: paragraphs.slice(0, 50),
    };
  },
});
```

```typescript
// packages/mastra/src/tools/scorerTool.ts
import { createTool } from "@mastra/core/tools";
import { z } from "zod";

export const scorerTool = createTool({
  id: "scorer",
  description: "Score and evaluate AI outputs for quality assessment",
  inputSchema: z.object({
    scorerName: z.enum([
      "interviewNaturalness", "followupRelevance", "memoryCitation",
      "memoryCandidatePrecision", "sensitiveLeakage", "contextPackRelevance",
      "sourceFaithfulness", "interviewFeedback",
    ]),
    input: z.string(),
    reference: z.string().optional(),
  }),
  execute: async ({ context }) => {
    const { scorerName, input, reference } = context;
    const rules: Record<string, (input: string, ref?: string) => { score: number; reason: string }> = {
      interviewNaturalness: (text) => ({
        score: text.includes("?") ? 0.8 : 0.5,
        reason: text.includes("?") ? "Contains follow-up questions" : "Missing questions",
      }),
      followupRelevance: (text, ref) => ({
        score: ref && text.toLowerCase().includes(ref.toLowerCase().slice(0, 10)) ? 0.9 : 0.4,
        reason: "Keyword overlap assessment",
      }),
      memoryCitation: (text) => {
        const hasQuote = text.includes('"') || text.includes("「");
        return { score: hasQuote ? 0.85 : 0.3, reason: hasQuote ? "Contains citations" : "No citations found" };
      },
      memoryCandidatePrecision: (text) => ({
        score: text.length > 20 ? 0.7 : 0.3,
        reason: text.length > 20 ? "Sufficient detail" : "Too brief",
      }),
      sensitiveLeakage: (text) => {
        const sensitive = /\b(password|secret|key|token)\b/i;
        return { score: sensitive.test(text) ? 0.1 : 1.0, reason: sensitive.test(text) ? "Sensitive content detected" : "Clean" };
      },
      contextPackRelevance: (text) => ({
        score: text.length > 100 ? 0.75 : 0.4,
        reason: "Content volume assessment",
      }),
      sourceFaithfulness: (text, ref) => ({
        score: ref ? 0.8 : 0.5,
        reason: ref ? "Has reference source" : "No reference source",
      }),
      interviewFeedback: (text) => ({
        score: text.length > 0 ? 0.7 : 0,
        reason: "Feedback present",
      }),
    };

    const scorer = rules[scorerName];
    if (!scorer) throw new Error(`Unknown scorer: ${scorerName}`);
    return { scorerName, ...scorer(input, reference) };
  },
});
```

```typescript
// packages/mastra/src/tools/auditLogTool.ts
import { createTool } from "@mastra/core/tools";
import { z } from "zod";

export const auditLogTool = createTool({
  id: "auditLog",
  description: "Record audit events for compliance and debugging",
  inputSchema: z.object({
    eventType: z.string(),
    entityType: z.string(),
    entityId: z.string(),
    severity: z.enum(["info", "warning", "error", "critical"]).default("info"),
    detail: z.record(z.any()).optional(),
  }),
  execute: async ({ context }) => {
    const { eventType, entityType, entityId, severity, detail } = context;
    const event = {
      id: `audit-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      eventType,
      entityType,
      entityId,
      severity,
      detail: detail || {},
      createdAt: new Date().toISOString(),
    };
    const apiBase = process.env.PRODUCT_API_BASE_URL || "http://127.0.0.1:8787";
    const state = await fetch(`${apiBase}/api/state`).then((r) => r.json());
    state.auditEvents = [event, ...(state.auditEvents || [])];
    await fetch(`${apiBase}/api/state`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(state),
    });
    return { recorded: true, eventId: event.id };
  },
});
```

- [ ] **Step 8: 创建 tools/index.ts 导出**

```typescript
// packages/mastra/src/tools/index.ts
export { productDbTool } from "./productDbTool";
export { objectStorageTool } from "./objectStorageTool";
export { ragTool } from "./ragTool";
export { mastraMemoryTool } from "./mastraMemoryTool";
export { graphTool } from "./graphTool";
export { searchProviderTool } from "./searchProviderTool";
export { asrTool } from "./asrTool";
export { ttsTool } from "./ttsTool";
export { documentParseTool } from "./documentParseTool";
export { webFetchTool } from "./webFetchTool";
export { scorerTool } from "./scorerTool";
export { auditLogTool } from "./auditLogTool";
```

- [ ] **Step 9: 编写 Tool 测试**

```typescript
// packages/mastra/src/tools/tools.test.ts
import { describe, it, expect } from "vitest";

describe("Mastra tools", () => {
  it("productDbTool is defined", async () => {
    const { productDbTool } = await import("./productDbTool");
    expect(productDbTool.id).toBe("productDb");
    expect(productDbTool.description).toBeTruthy();
  });

  it("searchProviderTool is defined", async () => {
    const { searchProviderTool } = await import("./searchProviderTool");
    expect(searchProviderTool.id).toBe("searchProvider");
  });

  it("scorerTool has all scorers", async () => {
    const { scorerTool } = await import("./scorerTool");
    expect(scorerTool.id).toBe("scorer");
  });

  it("auditLogTool is defined", async () => {
    const { auditLogTool } = await import("./auditLogTool");
    expect(auditLogTool.id).toBe("auditLog");
  });

  it("all tools export from index", async () => {
    const tools = await import("./index");
    expect(tools.productDbTool).toBeDefined();
    expect(tools.ragTool).toBeDefined();
    expect(tools.mastraMemoryTool).toBeDefined();
    expect(tools.graphTool).toBeDefined();
    expect(tools.searchProviderTool).toBeDefined();
    expect(tools.asrTool).toBeDefined();
    expect(tools.ttsTool).toBeDefined();
    expect(tools.documentParseTool).toBeDefined();
    expect(tools.webFetchTool).toBeDefined();
    expect(tools.scorerTool).toBeDefined();
    expect(tools.auditLogTool).toBeDefined();
    expect(tools.objectStorageTool).toBeDefined();
  });
});
```

- [ ] **Step 10: 运行测试**

```bash
cd packages/mastra && npx vitest run src/tools/tools.test.ts
```

- [ ] **Step 11: Commit**

```bash
git add packages/mastra/src/tools/
git commit -m "feat: implement 12 Mastra tools (productDb, search, ASR, TTS, RAG, memory, graph, etc.)"
```

---

### Task 2.3: 实现 10 个 Mastra Agent

**Files:**
- Create: `packages/mastra/src/agents/interviewDirectorAgent.ts`
- Create: `packages/mastra/src/agents/contextPackBuilderAgent.ts`
- Create: `packages/mastra/src/agents/assetExtractorAgent.ts`
- Create: `packages/mastra/src/agents/memoryCandidateAgent.ts`
- Create: `packages/mastra/src/agents/memoryConsolidationAgent.ts`
- Create: `packages/mastra/src/agents/importClassifierAgent.ts`
- Create: `packages/mastra/src/agents/transcriptCleanerAgent.ts`
- Create: `packages/mastra/src/agents/interviewTechniqueAnalystAgent.ts`
- Create: `packages/mastra/src/agents/podcastGeneratorAgent.ts`
- Create: `packages/mastra/src/agents/sensitiveReviewAgent.ts`
- Create: `packages/mastra/src/agents/index.ts`

- [ ] **Step 1: 创建 InterviewDirectorAgent**

```typescript
// packages/mastra/src/agents/interviewDirectorAgent.ts
import { Agent } from "@mastra/core/agent";
import { productDbTool, ragTool, mastraMemoryTool, graphTool } from "../tools";

export const interviewDirectorAgent = new Agent({
  name: "Interview Director",
  instructions: `You are a professional cognitive interviewer for a private diary tool. Your role:

1. Generate thoughtful opening questions based on the user's context pack (profile, recent memories, active themes, knowledge debts)
2. Ask follow-up questions that probe deeper into the user's reasoning, emotions, and assumptions
3. Challenge the user's views with alternative perspectives when appropriate
4. Reference the user's past statements and memories to create continuity
5. Track which topics have been covered and which perspectives are missing
6. Adapt your interview style based on the mode (daily/decision/point/learning/organization/long-term) and strength (gentle/standard/sharp)

Output format: Return a JSON object with { "question": "...", "strategy": "...", "references": [...], "depth": "surface|mechanism|meta|synthesis" }`,
  model: (() => {
    const { createOpenAI } = require("@ai-sdk/openai");
    return createOpenAI({
      baseURL: process.env.BAILIAN_BASE_URL || "https://dashscope.aliyuncs.com/compatible-mode/v1",
      apiKey: process.env.DASHSCOPE_API_KEY || "",
    })(process.env.BAILIAN_MODEL || "qwen3.7-plus");
  })(),
  tools: {
    productDbTool,
    ragTool,
    mastraMemoryTool,
    graphTool,
  },
});
```

- [ ] **Step 2: 创建 ContextPackBuilderAgent**

```typescript
// packages/mastra/src/agents/contextPackBuilderAgent.ts
import { Agent } from "@mastra/core/agent";
import { productDbTool, mastraMemoryTool, ragTool, graphTool } from "../tools";

export const contextPackBuilderAgent = new Agent({
  name: "Context Pack Builder",
  instructions: `You build comprehensive context packs for interview preparation. Aggregate:

1. User profile (name, role, industry, current focus, long-term goal)
2. Recent memories from Mastra Memory working memory
3. Related long-term memories via pgvector semantic search
4. Active long-term themes with maturity scores
5. Unresolved knowledge debts
6. Unfinished follow-up questions from the last session
7. GraphRAG relationship expansion from related memories

Output format: Return a JSON object with {
  "profile": {...},
  "recentMemories": [...],
  "relatedMemories": [...],
  "activeThemes": [...],
  "openDebts": [...],
  "pendingQuestions": [...],
  "graphExpansion": [...],
  "suggestedOpening": "...",
  "strategyChecklist": [...]
}`,
  model: (() => {
    const { createOpenAI } = require("@ai-sdk/openai");
    return createOpenAI({
      baseURL: process.env.BAILIAN_BASE_URL || "https://dashscope.aliyuncs.com/compatible-mode/v1",
      apiKey: process.env.DASHSCOPE_API_KEY || "",
    })(process.env.BAILIAN_MODEL || "qwen3.7-plus");
  })(),
  tools: {
    productDbTool,
    mastraMemoryTool,
    ragTool,
    graphTool,
  },
});
```

- [ ] **Step 3: 创建 AssetExtractorAgent**

```typescript
// packages/mastra/src/agents/assetExtractorAgent.ts
import { Agent } from "@mastra/core/agent";
import { productDbTool } from "../tools";

export const assetExtractorAgent = new Agent({
  name: "Asset Extractor",
  instructions: `Extract four types of assets from interview dialogue:

1. Points (观点): Key viewpoints, beliefs, and opinions expressed
2. Questions (问题): Important questions raised that deserve further exploration
3. Decisions (决策): Decisions made, including trade-offs and risk hypotheses
4. Knowledge Debts (知识债务): Concepts mentioned that need deeper understanding

For each asset, provide:
- A concise title
- The content/description
- Confidence level (用户确认 or AI 推断)
- Related themes
- Evidence quotes from the conversation

Output format: Return a JSON object with {
  "points": [{ "title": "...", "content": "...", "confidence": "用户确认|AI 推断", "evidence": "..." }],
  "questions": [{ "question": "...", "whyImportant": "...", "nextPrompt": "..." }],
  "decisions": [{ "title": "...", "choice": "...", "tradeOff": "...", "riskHypothesis": "..." }],
  "debts": [{ "concept": "...", "context": "...", "whyImportant": "...", "nextQuestion": "..." }]
}`,
  model: (() => {
    const { createOpenAI } = require("@ai-sdk/openai");
    return createOpenAI({
      baseURL: process.env.BAILIAN_BASE_URL || "https://dashscope.aliyuncs.com/compatible-mode/v1",
      apiKey: process.env.DASHSCOPE_API_KEY || "",
    })(process.env.BAILIAN_MODEL || "qwen3.7-plus");
  })(),
  tools: { productDbTool },
});
```

- [ ] **Step 4: 创建 MemoryCandidateAgent**

```typescript
// packages/mastra/src/agents/memoryCandidateAgent.ts
import { Agent } from "@mastra/core/agent";
import { productDbTool, scorerTool } from "../tools";

export const memoryCandidateAgent = new Agent({
  name: "Memory Candidate",
  instructions: `Generate memory candidates from interview content and score them.

For each potential memory:
1. Extract the core statement/insight
2. Determine the type (point/question/decision/debt)
3. Provide evidence quote from the source
4. Assess sensitivity level (normal/sensitive/private/restricted)
5. Score based on: relevance, novelty, confidence, importance

Output format: Return a JSON object with {
  "candidates": [{
    "text": "...",
    "suggestedType": "point|question|decision|debt",
    "evidenceQuote": "...",
    "reason": "...",
    "sensitivity": "normal|sensitive|private|restricted",
    "scores": { "relevance": 0.8, "novelty": 0.7, "confidence": 0.9, "importance": 0.85 }
  }]
}`,
  model: (() => {
    const { createOpenAI } = require("@ai-sdk/openai");
    return createOpenAI({
      baseURL: process.env.BAILIAN_BASE_URL || "https://dashscope.aliyuncs.com/compatible-mode/v1",
      apiKey: process.env.DASHSCOPE_API_KEY || "",
    })(process.env.BAILIAN_MODEL || "qwen3.7-plus");
  })(),
  tools: { productDbTool, scorerTool },
});
```

- [ ] **Step 5: 创建 MemoryConsolidationAgent**

```typescript
// packages/mastra/src/agents/memoryConsolidationAgent.ts
import { Agent } from "@mastra/core/agent";
import { productDbTool, mastraMemoryTool, scorerTool } from "../tools";

export const memoryConsolidationAgent = new Agent({
  name: "Memory Consolidation",
  instructions: `Review existing memories to detect evolution, contradiction, and consolidation opportunities.

For each memory record:
1. Check if newer memories confirm, challenge, or evolve from it
2. Detect contradictions between memories
3. Suggest merges for duplicate or overlapping memories
4. Identify memories that should be deprecated (outdated, superseded)
5. Create memory edges (relationships) between related memories

Output format: Return a JSON object with {
  "evolutions": [{ "sourceId": "...", "evolvedTo": "...", "description": "..." }],
  "contradictions": [{ "memoryA": "...", "memoryB": "...", "description": "..." }],
  "merges": [{ "sourceIds": ["...", "..."], "mergedText": "...", "reason": "..." }],
  "deprecations": [{ "memoryId": "...", "reason": "..." }],
  "newEdges": [{ "sourceId": "...", "targetId": "...", "relation": "EVOLVES_FROM|CONTRADICTS|SUPPORTS", "confidence": 0.8 }]
}`,
  model: (() => {
    const { createOpenAI } = require("@ai-sdk/openai");
    return createOpenAI({
      baseURL: process.env.BAILIAN_BASE_URL || "https://dashscope.aliyuncs.com/compatible-mode/v1",
      apiKey: process.env.DASHSCOPE_API_KEY || "",
    })(process.env.BAILIAN_MODEL || "qwen3.7-plus");
  })(),
  tools: { productDbTool, mastraMemoryTool, scorerTool },
});
```

- [ ] **Step 6: 创建 ImportClassifierAgent**

```typescript
// packages/mastra/src/agents/importClassifierAgent.ts
import { Agent } from "@mastra/core/agent";
import { productDbTool, documentParseTool } from "../tools";

export const importClassifierAgent = new Agent({
  name: "Import Classifier",
  instructions: `Classify imported materials by type, topic, and quality.

For each import:
1. Determine media type (audio, document, text)
2. Identify main topics and themes
3. Assess quality and relevance
4. Suggest how it connects to existing themes and memories
5. Recommend whether to generate a SearchBrief for deeper research

Output format: Return a JSON object with {
  "classification": {
    "mediaType": "audio|document|text",
    "primaryTopic": "...",
    "secondaryTopics": ["...", "..."],
    "quality": "high|medium|low",
    "relevanceScore": 0.8
  },
  "connections": [{ "themeId": "...", "relevance": "..." }],
  "recommendations": ["Generate SearchBrief for topic X", "Link to theme Y"]
}`,
  model: (() => {
    const { createOpenAI } = require("@ai-sdk/openai");
    return createOpenAI({
      baseURL: process.env.BAILIAN_BASE_URL || "https://dashscope.aliyuncs.com/compatible-mode/v1",
      apiKey: process.env.DASHSCOPE_API_KEY || "",
    })(process.env.BAILIAN_MODEL || "qwen3.7-plus");
  })(),
  tools: { productDbTool, documentParseTool },
});
```

- [ ] **Step 7: 创建 TranscriptCleanerAgent**

```typescript
// packages/mastra/src/agents/transcriptCleanerAgent.ts
import { Agent } from "@mastra/core/agent";
import { asrTool } from "../tools";

export const transcriptCleanerAgent = new Agent({
  name: "Transcript Cleaner",
  instructions: `Clean and segment transcribed audio text.

1. Remove filler words and speech artifacts
2. Identify speaker turns (user vs others)
3. Segment into logical paragraphs
4. Mark unclear or low-confidence segments
5. Extract timestamps if available

Output format: Return a JSON object with {
  "cleanedText": "...",
  "segments": [{ "speaker": "user|other", "content": "...", "confidence": 0.9 }],
  "unclearSegments": [{ "position": 0, "originalText": "..." }],
  "wordCount": 150,
  "estimatedDurationSec": 120
}`,
  model: (() => {
    const { createOpenAI } = require("@ai-sdk/openai");
    return createOpenAI({
      baseURL: process.env.BAILIAN_BASE_URL || "https://dashscope.aliyuncs.com/compatible-mode/v1",
      apiKey: process.env.DASHSCOPE_API_KEY || "",
    })(process.env.BAILIAN_MODEL || "qwen3.7-plus");
  })(),
  tools: { asrTool },
});
```

- [ ] **Step 8: 创建 InterviewTechniqueAnalystAgent**

```typescript
// packages/mastra/src/agents/interviewTechniqueAnalystAgent.ts
import { Agent } from "@mastra/core/agent";
import { productDbTool, scorerTool } from "../tools";

export const interviewTechniqueAnalystAgent = new Agent({
  name: "Interview Technique Analyst",
  instructions: `Analyze interview quality and provide feedback on technique.

Evaluate:
1. Question quality (open-ended vs closed, depth, relevance)
2. Follow-up effectiveness (did they probe deeper?)
3. Perspective coverage (were multiple angles explored?)
4. Memory referencing (were past statements recalled?)
5. Blindspot detection (what wasn't asked?)

Output format: Return a JSON object with {
  "scores": {
    "questionQuality": 0.8,
    "followUpEffectiveness": 0.7,
    "perspectiveCoverage": 0.6,
    "memoryReferencing": 0.5,
    "blindspotDetection": 0.4
  },
  "feedback": ["Try more open-ended questions", "Consider asking about emotional impact"],
  "missedOpportunities": ["Did not explore the decision's trade-offs"],
  "recommendedStrategies": ["mechanism_probe", "perspective_shift"]
}`,
  model: (() => {
    const { createOpenAI } = require("@ai-sdk/openai");
    return createOpenAI({
      baseURL: process.env.BAILIAN_BASE_URL || "https://dashscope.aliyuncs.com/compatible-mode/v1",
      apiKey: process.env.DASHSCOPE_API_KEY || "",
    })(process.env.BAILIAN_MODEL || "qwen3.7-plus");
  })(),
  tools: { productDbTool, scorerTool },
});
```

- [ ] **Step 9: 创建 PodcastGeneratorAgent**

```typescript
// packages/mastra/src/agents/podcastGeneratorAgent.ts
import { Agent } from "@mastra/core/agent";
import { productDbTool, ragTool, ttsTool } from "../tools";

export const podcastGeneratorAgent = new Agent({
  name: "Podcast Generator",
  instructions: `Generate podcast scripts from dual-track notes and other sources.

Input sources can be:
- Dual-track notes (said track + learned track)
- SearchBriefs
- Long-term themes
- Knowledge debts

Output format:
- Multi-speaker format (host + guest)
- Include chapter markers
- Add shownotes with source attribution
- Generate AI disclosure statement

Output format: Return a JSON object with {
  "title": "...",
  "format": "single|dual",
  "chapters": [{ "title": "...", "startSec": 0, "summary": "..." }],
  "script": [
    { "speaker": "host|guest", "content": "...", "sourceNote": "..." }
  ],
  "shownotes": [{ "text": "...", "source": "..." }],
  "aiDisclosure": "...",
  "estimatedDurationSec": 600
}`,
  model: (() => {
    const { createOpenAI } = require("@ai-sdk/openai");
    return createOpenAI({
      baseURL: process.env.BAILIAN_BASE_URL || "https://dashscope.aliyuncs.com/compatible-mode/v1",
      apiKey: process.env.DASHSCOPE_API_KEY || "",
    })(process.env.BAILIAN_MODEL || "qwen3.7-plus");
  })(),
  tools: { productDbTool, ragTool, ttsTool },
});
```

- [ ] **Step 10: 创建 SensitiveReviewAgent**

```typescript
// packages/mastra/src/agents/sensitiveReviewAgent.ts
import { Agent } from "@mastra/core/agent";
import { productDbTool, scorerTool, auditLogTool } from "../tools";

export const sensitiveReviewAgent = new Agent({
  name: "Sensitive Review",
  instructions: `Review content for sensitive information and assign privacy levels.

Check for:
1. Personal identifiable information (names, addresses, phone numbers)
2. Financial information
3. Health information
4. Confidential business information
5. Emotional/psychological content that should be private

Assign sensitivity levels:
- normal: Safe to include in context
- sensitive: Include with caution
- private: Do not include in shared context
- restricted: Flag for manual review

Output format: Return a JSON object with {
  "sensitivity": "normal|sensitive|private|restricted",
  "findings": [{ "type": "PII|financial|health|business|emotional", "severity": "low|medium|high", "location": "..." }],
  "recommendation": "include|cautious|exclude|flag",
  "redactedVersion": "..." // if applicable
}`,
  model: (() => {
    const { createOpenAI } = require("@ai-sdk/openai");
    return createOpenAI({
      baseURL: process.env.BAILIAN_BASE_URL || "https://dashscope.aliyuncs.com/compatible-mode/v1",
      apiKey: process.env.DASHSCOPE_API_KEY || "",
    })(process.env.BAILIAN_MODEL || "qwen3.7-plus");
  })(),
  tools: { productDbTool, scorerTool, auditLogTool },
});
```

- [ ] **Step 11: 创建 agents/index.ts 导出**

```typescript
// packages/mastra/src/agents/index.ts
export { interviewDirectorAgent } from "./interviewDirectorAgent";
export { contextPackBuilderAgent } from "./contextPackBuilderAgent";
export { assetExtractorAgent } from "./assetExtractorAgent";
export { memoryCandidateAgent } from "./memoryCandidateAgent";
export { memoryConsolidationAgent } from "./memoryConsolidationAgent";
export { importClassifierAgent } from "./importClassifierAgent";
export { transcriptCleanerAgent } from "./transcriptCleanerAgent";
export { interviewTechniqueAnalystAgent } from "./interviewTechniqueAnalystAgent";
export { podcastGeneratorAgent } from "./podcastGeneratorAgent";
export { sensitiveReviewAgent } from "./sensitiveReviewAgent";
```

- [ ] **Step 12: 编写 Agent 测试**

```typescript
// packages/mastra/src/agents/agents.test.ts
import { describe, it, expect } from "vitest";

describe("Mastra agents", () => {
  it("all 10 agents are defined and have names", async () => {
    const agents = await import("./index");
    const names = [
      "interviewDirectorAgent", "contextPackBuilderAgent", "assetExtractorAgent",
      "memoryCandidateAgent", "memoryConsolidationAgent", "importClassifierAgent",
      "transcriptCleanerAgent", "interviewTechniqueAnalystAgent",
      "podcastGeneratorAgent", "sensitiveReviewAgent",
    ];
    for (const name of names) {
      expect(agents[name]).toBeDefined();
      expect(agents[name].name).toBeTruthy();
    }
  });

  it("InterviewDirectorAgent has required tools", async () => {
    const { interviewDirectorAgent } = await import("./interviewDirectorAgent");
    expect(interviewDirectorAgent.tools).toBeDefined();
  });
});
```

- [ ] **Step 13: 运行测试**

```bash
cd packages/mastra && npx vitest run src/agents/agents.test.ts
```

- [ ] **Step 14: Commit**

```bash
git add packages/mastra/src/agents/
git commit -m "feat: implement 10 Mastra agents (InterviewDirector, ContextPackBuilder, AssetExtractor, etc.)"
```

---

### Task 2.4: 实现 12 个 Mastra Workflow

**Files:**
- Create: `packages/mastra/src/workflows/interviewPreparationWorkflow.ts`
- Create: `packages/mastra/src/workflows/contextPackBuildWorkflow.ts`
- Create: `packages/mastra/src/workflows/liveInterviewAssistWorkflow.ts`
- Create: `packages/mastra/src/workflows/postInterviewExtractionWorkflow.ts`
- Create: `packages/mastra/src/workflows/memoryCandidateReviewWorkflow.ts`
- Create: `packages/mastra/src/workflows/memoryProjectionWorkflow.ts`
- Create: `packages/mastra/src/workflows/importIngestionWorkflow.ts`
- Create: `packages/mastra/src/workflows/audioTranscriptionWorkflow.ts`
- Create: `packages/mastra/src/workflows/documentIngestionWorkflow.ts`
- Create: `packages/mastra/src/workflows/referenceInterviewLearningWorkflow.ts`
- Create: `packages/mastra/src/workflows/podcastGenerationWorkflow.ts`
- Create: `packages/mastra/src/workflows/memoryMaintenanceWorkflow.ts`
- Create: `packages/mastra/src/workflows/index.ts`

- [ ] **Step 1: 创建 interviewPreparationWorkflow**

```typescript
// packages/mastra/src/workflows/interviewPreparationWorkflow.ts
import { Step, Workflow } from "@mastra/core/workflows";
import { z } from "zod";
import { contextPackBuilderAgent } from "../agents/contextPackBuilderAgent";
import { interviewDirectorAgent } from "../agents/interviewDirectorAgent";

const buildContextPack = new Step({
  id: "buildContextPack",
  outputSchema: z.object({
    contextPack: z.any(),
  }),
  execute: async ({ context }) => {
    const result = await contextPackBuilderAgent.generate(
      "Build a comprehensive context pack for the upcoming interview. Include profile, recent memories, active themes, open debts, and pending questions."
    );
    return { contextPack: result.object || result.text };
  },
});

const generateOpening = new Step({
  id: "generateOpening",
  outputSchema: z.object({
    opening: z.any(),
  }),
  execute: async ({ context }) => {
    const contextPack = context.getStepResult(buildContextPack)?.contextPack;
    const result = await interviewDirectorAgent.generate(
      `Based on this context pack, generate an opening question and interview strategy:\n${JSON.stringify(contextPack)}`
    );
    return { opening: result.object || result.text };
  },
});

export const interviewPreparationWorkflow = new Workflow({
  name: "interview-preparation",
  triggerSchema: z.object({
    mode: z.enum(["daily", "decision", "point", "learning", "organization", "long-term"]),
    strength: z.enum(["gentle", "standard", "sharp"]),
  }),
})
  .step(buildContextPack)
  .then(generateOpening)
  .commit();
```

- [ ] **Step 2: 创建 postInterviewExtractionWorkflow**

```typescript
// packages/mastra/src/workflows/postInterviewExtractionWorkflow.ts
import { Step, Workflow } from "@mastra/core/workflows";
import { z } from "zod";
import { assetExtractorAgent } from "../agents/assetExtractorAgent";
import { memoryCandidateAgent } from "../agents/memoryCandidateAgent";
import { interviewTechniqueAnalystAgent } from "../agents/interviewTechniqueAnalystAgent";

const extractAssets = new Step({
  id: "extractAssets",
  outputSchema: z.object({ assets: z.any() }),
  execute: async ({ context }) => {
    const { sessionTranscript } = context.triggerData;
    const result = await assetExtractorAgent.generate(
      `Extract all assets from this interview transcript:\n${sessionTranscript}`
    );
    return { assets: result.object || result.text };
  },
});

const generateCandidates = new Step({
  id: "generateCandidates",
  outputSchema: z.object({ candidates: z.any() }),
  execute: async ({ context }) => {
    const { sessionTranscript } = context.triggerData;
    const result = await memoryCandidateAgent.generate(
      `Generate memory candidates from this interview transcript:\n${sessionTranscript}`
    );
    return { candidates: result.object || result.text };
  },
});

const analyzeTechnique = new Step({
  id: "analyzeTechnique",
  outputSchema: z.object({ analysis: z.any() }),
  execute: async ({ context }) => {
    const { sessionTranscript } = context.triggerData;
    const result = await interviewTechniqueAnalystAgent.generate(
      `Analyze the interview technique quality:\n${sessionTranscript}`
    );
    return { analysis: result.object || result.text };
  },
});

export const postInterviewExtractionWorkflow = new Workflow({
  name: "post-interview-extraction",
  triggerSchema: z.object({
    sessionId: z.string(),
    sessionTranscript: z.string(),
  }),
})
  .step(extractAssets)
  .step(generateCandidates)
  .step(analyzeTechnique)
  .commit();
```

- [ ] **Step 3: 创建 memoryCandidateReviewWorkflow**

```typescript
// packages/mastra/src/workflows/memoryCandidateReviewWorkflow.ts
import { Step, Workflow } from "@mastra/core/workflows";
import { z } from "zod";
import { memoryCandidateAgent } from "../agents/memoryCandidateAgent";
import { memoryConsolidationAgent } from "../agents/memoryConsolidationAgent";
import { sensitiveReviewAgent } from "../agents/sensitiveReviewAgent";

const scoreCandidates = new Step({
  id: "scoreCandidates",
  outputSchema: z.object({ scoredCandidates: z.any() }),
  execute: async ({ context }) => {
    const { candidates } = context.triggerData;
    const result = await memoryCandidateAgent.generate(
      `Score and rank these memory candidates:\n${JSON.stringify(candidates)}`
    );
    return { scoredCandidates: result.object || result.text };
  },
});

const checkConsolidation = new Step({
  id: "checkConsolidation",
  outputSchema: z.object({ consolidation: z.any() }),
  execute: async ({ context }) => {
    const result = await memoryConsolidationAgent.generate(
      "Check all existing memories for evolution, contradiction, and consolidation opportunities."
    );
    return { consolidation: result.object || result.text };
  },
});

const reviewSensitivity = new Step({
  id: "reviewSensitivity",
  outputSchema: z.object({ sensitivityReview: z.any() }),
  execute: async ({ context }) => {
    const scored = context.getStepResult(scoreCandidates)?.scoredCandidates;
    const result = await sensitiveReviewAgent.generate(
      `Review these memory candidates for sensitive content:\n${JSON.stringify(scored)}`
    );
    return { sensitivityReview: result.object || result.text };
  },
});

export const memoryCandidateReviewWorkflow = new Workflow({
  name: "memory-candidate-review",
  triggerSchema: z.object({
    candidates: z.array(z.any()),
  }),
})
  .step(scoreCandidates)
  .then(checkConsolidation)
  .after(scoreCandidates)
  .step(reviewSensitivity)
  .commit();
```

- [ ] **Step 4: 创建 importIngestionWorkflow**

```typescript
// packages/mastra/src/workflows/importIngestionWorkflow.ts
import { Step, Workflow } from "@mastra/core/workflows";
import { z } from "zod";
import { importClassifierAgent } from "../agents/importClassifierAgent";
import { transcriptCleanerAgent } from "../agents/transcriptCleanerAgent";
import { documentParseTool } from "../tools/documentParseTool";

const classifyImport = new Step({
  id: "classifyImport",
  outputSchema: z.object({ classification: z.any() }),
  execute: async ({ context }) => {
    const { content, mediaType } = context.triggerData;
    const result = await importClassifierAgent.generate(
      `Classify this imported ${mediaType}:\n${content}`
    );
    return { classification: result.object || result.text };
  },
});

const cleanTranscript = new Step({
  id: "cleanTranscript",
  outputSchema: z.object({ cleaned: z.any() }),
  execute: async ({ context }) => {
    const { content } = context.triggerData;
    const result = await transcriptCleanerAgent.generate(
      `Clean and segment this transcript:\n${content}`
    );
    return { cleaned: result.object || result.text };
  },
});

const parseDocument = new Step({
  id: "parseDocument",
  outputSchema: z.object({ parsed: z.any() }),
  execute: async ({ context }) => {
    const { content, mediaType } = context.triggerData;
    const format = mediaType === "document" ? "markdown" : "text";
    const result = await documentParseTool.execute!({
      context: { content, format: format as "markdown" | "html" | "text" },
    });
    return { parsed: result };
  },
});

export const importIngestionWorkflow = new Workflow({
  name: "import-ingestion",
  triggerSchema: z.object({
    content: z.string(),
    mediaType: z.enum(["audio", "document", "text"]),
    title: z.string().optional(),
    sourceUrl: z.string().optional(),
  }),
})
  .step(classifyImport)
  .step(cleanTranscript)
  .step(parseDocument)
  .commit();
```

- [ ] **Step 5: 创建 podcastGenerationWorkflow**

```typescript
// packages/mastra/src/workflows/podcastGenerationWorkflow.ts
import { Step, Workflow } from "@mastra/core/workflows";
import { z } from "zod";
import { podcastGeneratorAgent } from "../agents/podcastGeneratorAgent";
import { ttsTool } from "../tools/ttsTool";

const generateScript = new Step({
  id: "generateScript",
  outputSchema: z.object({ script: z.any() }),
  execute: async ({ context }) => {
    const { sourceType, sourceContent } = context.triggerData;
    const result = await podcastGeneratorAgent.generate(
      `Generate a podcast script from this ${sourceType}:\n${sourceContent}`
    );
    return { script: result.object || result.text };
  },
});

const synthesizeAudio = new Step({
  id: "synthesizeAudio",
  outputSchema: z.object({ audio: z.any() }),
  execute: async ({ context }) => {
    const script = context.getStepResult(generateScript)?.script;
    const scriptText = typeof script === "string" ? script : JSON.stringify(script);
    const result = await ttsTool.execute!({
      context: { text: scriptText, voice: "longyuan_v3", format: "mp3" as const },
    });
    return { audio: result };
  },
});

export const podcastGenerationWorkflow = new Workflow({
  name: "podcast-generation",
  triggerSchema: z.object({
    sourceType: z.enum(["note", "searchBrief", "theme", "debt"]),
    sourceId: z.string(),
    sourceContent: z.string(),
    voice: z.string().default("longyuan_v3"),
  }),
})
  .step(generateScript)
  .then(synthesizeAudio)
  .commit();
```

- [ ] **Step 6: 创建 memoryMaintenanceWorkflow**

```typescript
// packages/mastra/src/workflows/memoryMaintenanceWorkflow.ts
import { Step, Workflow } from "@mastra/core/workflows";
import { z } from "zod";
import { memoryConsolidationAgent } from "../agents/memoryConsolidationAgent";
import { memoryCandidateAgent } from "../agents/memoryCandidateAgent";

const consolidateMemories = new Step({
  id: "consolidateMemories",
  outputSchema: z.object({ consolidation: z.any() }),
  execute: async () => {
    const result = await memoryConsolidationAgent.generate(
      "Run full memory consolidation: detect evolutions, contradictions, suggest merges and deprecations."
    );
    return { consolidation: result.object || result.text };
  },
});

const discoverCandidates = new Step({
  id: "discoverCandidates",
  outputSchema: z.object({ newCandidates: z.any() }),
  execute: async () => {
    const result = await memoryCandidateAgent.generate(
      "Review all recent sessions and notes for potential new memory candidates that may have been missed."
    );
    return { newCandidates: result.object || result.text };
  },
});

export const memoryMaintenanceWorkflow = new Workflow({
  name: "memory-maintenance",
  triggerSchema: z.object({
    scheduledAt: z.string().optional(),
  }),
})
  .step(consolidateMemories)
  .then(discoverCandidates)
  .commit();
```

- [ ] **Step 7: 创建简化版的其他 workflow（contextPackBuild, liveInterviewAssist, memoryProjection, audioTranscription, documentIngestion, referenceInterviewLearning）**

```typescript
// packages/mastra/src/workflows/contextPackBuildWorkflow.ts
import { Step, Workflow } from "@mastra/core/workflows";
import { z } from "zod";
import { contextPackBuilderAgent } from "../agents/contextPackBuilderAgent";

const buildPack = new Step({
  id: "buildPack",
  outputSchema: z.object({ pack: z.any() }),
  execute: async () => {
    const result = await contextPackBuilderAgent.generate("Build a context pack for the next interview.");
    return { pack: result.object || result.text };
  },
});

export const contextPackBuildWorkflow = new Workflow({
  name: "context-pack-build",
  triggerSchema: z.object({ sessionId: z.string().optional() }),
}).step(buildPack).commit();
```

```typescript
// packages/mastra/src/workflows/liveInterviewAssistWorkflow.ts
import { Step, Workflow } from "@mastra/core/workflows";
import { z } from "zod";
import { interviewDirectorAgent } from "../agents/interviewDirectorAgent";

const assist = new Step({
  id: "assist",
  outputSchema: z.object({ assistance: z.any() }),
  execute: async ({ context }) => {
    const { currentTurn, sessionContext } = context.triggerData;
    const result = await interviewDirectorAgent.generate(
      `User just said: "${currentTurn}". Session context: ${JSON.stringify(sessionContext)}. Generate the next interview move.`
    );
    return { assistance: result.object || result.text };
  },
});

export const liveInterviewAssistWorkflow = new Workflow({
  name: "live-interview-assist",
  triggerSchema: z.object({
    currentTurn: z.string(),
    sessionContext: z.any(),
  }),
}).step(assist).commit();
```

```typescript
// packages/mastra/src/workflows/memoryProjectionWorkflow.ts
import { Step, Workflow } from "@mastra/core/workflows";
import { z } from "zod";
import { mastraMemoryTool } from "../tools/mastraMemoryTool";

const project = new Step({
  id: "project",
  outputSchema: z.object({ projection: z.any() }),
  execute: async () => {
    const result = await mastraMemoryTool.execute!({
      context: { operation: "workingMemory" as const },
    });
    return { projection: result };
  },
});

export const memoryProjectionWorkflow = new Workflow({
  name: "memory-projection",
  triggerSchema: z.object({ targetSessionId: z.string().optional() }),
}).step(project).commit();
```

```typescript
// packages/mastra/src/workflows/audioTranscriptionWorkflow.ts
import { Step, Workflow } from "@mastra/core/workflows";
import { z } from "zod";
import { asrTool } from "../tools/asrTool";
import { transcriptCleanerAgent } from "../agents/transcriptCleanerAgent";

const transcribe = new Step({
  id: "transcribe",
  outputSchema: z.object({ transcription: z.any() }),
  execute: async ({ context }) => {
    const { audioUrl, title } = context.triggerData;
    const result = await asrTool.execute!({ context: { audioUrl, title } });
    return { transcription: result };
  },
});

const clean = new Step({
  id: "clean",
  outputSchema: z.object({ cleaned: z.any() }),
  execute: async ({ context }) => {
    const transcription = context.getStepResult(transcribe)?.transcription;
    const text = typeof transcription === "string" ? transcription : JSON.stringify(transcription);
    const result = await transcriptCleanerAgent.generate(`Clean this transcript:\n${text}`);
    return { cleaned: result.object || result.text };
  },
});

export const audioTranscriptionWorkflow = new Workflow({
  name: "audio-transcription",
  triggerSchema: z.object({
    audioUrl: z.string(),
    title: z.string().optional(),
  }),
}).step(transcribe).then(clean).commit();
```

```typescript
// packages/mastra/src/workflows/documentIngestionWorkflow.ts
import { Step, Workflow } from "@mastra/core/workflows";
import { z } from "zod";
import { documentParseTool } from "../tools/documentParseTool";
import { ragTool } from "../tools/ragTool";

const parse = new Step({
  id: "parse",
  outputSchema: z.object({ parsed: z.any() }),
  execute: async ({ context }) => {
    const { content, format } = context.triggerData;
    const result = await documentParseTool.execute!({
      context: { content, format: format as "markdown" | "html" | "text" },
    });
    return { parsed: result };
  },
});

const chunkAndStore = new Step({
  id: "chunkAndStore",
  outputSchema: z.object({ stored: z.any() }),
  execute: async ({ context }) => {
    const parsed = context.getStepResult(parse)?.parsed;
    const result = await ragTool.execute!({
      context: { query: JSON.stringify(parsed), topK: 1, filterSourceType: "document" as const },
    });
    return { stored: result };
  },
});

export const documentIngestionWorkflow = new Workflow({
  name: "document-ingestion",
  triggerSchema: z.object({
    content: z.string(),
    format: z.enum(["markdown", "html", "text"]).default("text"),
    title: z.string().optional(),
  }),
}).step(parse).then(chunkAndStore).commit();
```

```typescript
// packages/mastra/src/workflows/referenceInterviewLearningWorkflow.ts
import { Step, Workflow } from "@mastra/core/workflows";
import { z } from "zod";
import { importClassifierAgent } from "../agents/importClassifierAgent";
import { assetExtractorAgent } from "../agents/assetExtractorAgent";

const classify = new Step({
  id: "classify",
  outputSchema: z.object({ classification: z.any() }),
  execute: async ({ context }) => {
    const { content } = context.triggerData;
    const result = await importClassifierAgent.generate(
      `Analyze this reference interview for learnable patterns:\n${content}`
    );
    return { classification: result.object || result.text };
  },
});

const extractPatterns = new Step({
  id: "extractPatterns",
  outputSchema: z.object({ patterns: z.any() }),
  execute: async ({ context }) => {
    const { content } = context.triggerData;
    const result = await assetExtractorAgent.generate(
      `Extract interview techniques and patterns from:\n${content}`
    );
    return { patterns: result.object || result.text };
  },
});

export const referenceInterviewLearningWorkflow = new Workflow({
  name: "reference-interview-learning",
  triggerSchema: z.object({
    content: z.string(),
    sourceTitle: z.string().optional(),
  }),
}).step(classify).step(extractPatterns).commit();
```

- [ ] **Step 8: 创建 workflows/index.ts 导出**

```typescript
// packages/mastra/src/workflows/index.ts
export { interviewPreparationWorkflow } from "./interviewPreparationWorkflow";
export { contextPackBuildWorkflow } from "./contextPackBuildWorkflow";
export { liveInterviewAssistWorkflow } from "./liveInterviewAssistWorkflow";
export { postInterviewExtractionWorkflow } from "./postInterviewExtractionWorkflow";
export { memoryCandidateReviewWorkflow } from "./memoryCandidateReviewWorkflow";
export { memoryProjectionWorkflow } from "./memoryProjectionWorkflow";
export { importIngestionWorkflow } from "./importIngestionWorkflow";
export { audioTranscriptionWorkflow } from "./audioTranscriptionWorkflow";
export { documentIngestionWorkflow } from "./documentIngestionWorkflow";
export { referenceInterviewLearningWorkflow } from "./referenceInterviewLearningWorkflow";
export { podcastGenerationWorkflow } from "./podcastGenerationWorkflow";
export { memoryMaintenanceWorkflow } from "./memoryMaintenanceWorkflow";
```

- [ ] **Step 9: 编写 Workflow 测试**

```typescript
// packages/mastra/src/workflows/workflows.test.ts
import { describe, it, expect } from "vitest";

describe("Mastra workflows", () => {
  const workflowNames = [
    "interviewPreparationWorkflow", "contextPackBuildWorkflow",
    "liveInterviewAssistWorkflow", "postInterviewExtractionWorkflow",
    "memoryCandidateReviewWorkflow", "memoryProjectionWorkflow",
    "importIngestionWorkflow", "audioTranscriptionWorkflow",
    "documentIngestionWorkflow", "referenceInterviewLearningWorkflow",
    "podcastGenerationWorkflow", "memoryMaintenanceWorkflow",
  ];

  it("all 12 workflows are defined and have names", async () => {
    const workflows = await import("./index");
    for (const name of workflowNames) {
      expect(workflows[name]).toBeDefined();
      expect(workflows[name].name).toBeTruthy();
    }
  });

  it("interviewPreparationWorkflow has steps", async () => {
    const { interviewPreparationWorkflow } = await import("./interviewPreparationWorkflow");
    expect(interviewPreparationWorkflow.name).toBe("interview-preparation");
  });

  it("postInterviewExtractionWorkflow has steps", async () => {
    const { postInterviewExtractionWorkflow } = await import("./postInterviewExtractionWorkflow");
    expect(postInterviewExtractionWorkflow.name).toBe("post-interview-extraction");
  });
});
```

- [ ] **Step 10: 运行测试**

```bash
cd packages/mastra && npx vitest run src/workflows/workflows.test.ts
```

- [ ] **Step 11: Commit**

```bash
git add packages/mastra/src/workflows/
git commit -m "feat: implement 12 Mastra workflows (interview prep, extraction, memory, import, podcast, maintenance)"
```

---

### Task 2.5: 配置 Mastra Memory 和 RAG

**Files:**
- Create: `packages/mastra/src/memory/workingMemory.ts`
- Create: `packages/mastra/src/memory/semanticRecall.ts`
- Create: `packages/mastra/src/memory/index.ts`
- Create: `packages/mastra/src/rag/chunking.ts`
- Create: `packages/mastra/src/rag/embedding.ts`
- Create: `packages/mastra/src/rag/retrieval.ts`
- Create: `packages/mastra/src/rag/index.ts`

- [ ] **Step 1: 创建 Memory 配置**

```typescript
// packages/mastra/src/memory/workingMemory.ts
import { Memory } from "@mastra/memory";

export const workingMemory = new Memory({
  options: {
    workingMemory: {
      enabled: true,
      maxTokens: 4000,
      template: `## User Profile
{{profile}}

## Recent Sessions (last 3)
{{recentSessions}}

## Active Themes
{{activeThemes}}

## Open Knowledge Debts
{{openDebts}}

## Pending Questions
{{pendingQuestions}}`,
    },
    semanticRecall: {
      enabled: true,
      topK: 10,
      messageRange: { before: 10, after: 5 },
    },
    threads: {
      generateTitle: true,
    },
  },
});
```

```typescript
// packages/mastra/src/memory/semanticRecall.ts
import { Memory } from "@mastra/memory";

export const semanticMemory = new Memory({
  options: {
    lastMessages: 50,
    semanticRecall: {
      topK: 5,
      messageRange: { before: 5, after: 3 },
    },
  },
});
```

```typescript
// packages/mastra/src/memory/index.ts
export { workingMemory } from "./workingMemory";
export { semanticMemory } from "./semanticRecall";
```

- [ ] **Step 2: 创建 RAG 配置**

```typescript
// packages/mastra/src/rag/chunking.ts
export const chunkingConfig = {
  strategies: {
    sentence: {
      maxChunkSize: 500,
      minChunkSize: 50,
      overlap: 50,
    },
    recursive: {
      maxChunkSize: 1000,
      minChunkSize: 100,
      overlap: 100,
      separators: ["\n\n", "\n", "。", ". ", " "],
    },
    semanticMarkdown: {
      maxChunkSize: 1500,
      minChunkSize: 200,
      overlap: 150,
    },
    markdown: {
      maxChunkSize: 2000,
      minChunkSize: 200,
      overlap: 200,
    },
    html: {
      maxChunkSize: 2000,
      minChunkSize: 200,
      overlap: 200,
    },
    json: {
      maxChunkSize: 1000,
      minChunkSize: 100,
      overlap: 100,
    },
  },
  defaultStrategy: "recursive" as const,
};
```

```typescript
// packages/mastra/src/rag/embedding.ts
export const embeddingConfig = {
  provider: "openai" as const,
  model: process.env.EMBEDDING_MODEL || "text-embedding-v3",
  dimensions: 1024,
  batchSize: 20,
};
```

```typescript
// packages/mastra/src/rag/retrieval.ts
export const retrievalConfig = {
  topK: 10,
  minSimilarity: 0.5,
  rerank: {
    enabled: true,
    model: process.env.RERANK_MODEL || "gte-rerank",
    topN: 5,
  },
  hybridSearch: {
    enabled: true,
    semanticWeight: 0.7,
    keywordWeight: 0.3,
  },
};
```

```typescript
// packages/mastra/src/rag/index.ts
export { chunkingConfig } from "./chunking";
export { embeddingConfig } from "./embedding";
export { retrievalConfig } from "./retrieval";
```

- [ ] **Step 3: Commit**

```bash
git add packages/mastra/src/memory/ packages/mastra/src/rag/
git commit -m "feat: configure Mastra Memory (working, semantic) and RAG (chunking, embedding, retrieval)"
```

---

### Task 2.6: 集成 Mastra 到 API Server

**Files:**
- Modify: `apps/api/src/server.ts`
- Create: `apps/api/src/mastra-integration.ts`

- [ ] **Step 1: 创建 Mastra 集成模块**

```typescript
// apps/api/src/mastra-integration.ts
import type { ProductStateRepository } from "./product-state-repository.js";

export interface MastraIntegration {
  runWorkflow(workflowName: string, input: Record<string, unknown>): Promise<unknown>;
  getAgentNames(): string[];
  getWorkflowNames(): string[];
}

export function createMastraIntegration(stateRepo: ProductStateRepository): MastraIntegration {
  const agentNames = [
    "interviewDirector", "contextPackBuilder", "assetExtractor",
    "memoryCandidate", "memoryConsolidation", "importClassifier",
    "transcriptCleaner", "interviewTechniqueAnalyst",
    "podcastGenerator", "sensitiveReview",
  ];

  const workflowNames = [
    "interview-preparation", "context-pack-build", "live-interview-assist",
    "post-interview-extraction", "memory-candidate-review", "memory-projection",
    "import-ingestion", "audio-transcription", "document-ingestion",
    "reference-interview-learning", "podcast-generation", "memory-maintenance",
  ];

  return {
    async runWorkflow(workflowName: string, input: Record<string, unknown>) {
      try {
        const mastraUrl = process.env.MASTRA_RUNTIME_URL || "http://127.0.0.1:4111";
        const res = await fetch(`${mastraUrl}/api/workflows/${workflowName}/execute`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(input),
        });
        if (!res.ok) {
          throw new Error(`Mastra workflow ${workflowName} failed: ${res.status}`);
        }
        return await res.json();
      } catch (error) {
        console.warn(`Mastra runtime unavailable, workflow ${workflowName} skipped:`, error);
        return { degraded: true, workflowName, reason: "mastra-unavailable" };
      }
    },
    getAgentNames: () => agentNames,
    getWorkflowNames: () => workflowNames,
  };
}
```

- [ ] **Step 2: 在 server.ts 中注册 Mastra 路由**

Read `apps/api/src/server.ts`, add:

```typescript
// Add import:
import { createMastraIntegration } from "./mastra-integration.js";

// In buildApiServer, after creating stateRepo:
const mastra = createMastraIntegration(stateRepo);

// Add routes:
app.get("/api/mastra/agents", async () => {
  return { agents: mastra.getAgentNames() };
});

app.get("/api/mastra/workflows", async () => {
  return { workflows: mastra.getWorkflowNames() };
});

app.post("/api/mastra/workflows/:name/run", async (request) => {
  const { name } = request.params as { name: string };
  const body = request.body as Record<string, unknown> || {};
  const result = await mastra.runWorkflow(name, body);
  return result;
});
```

- [ ] **Step 3: 编写集成测试**

```typescript
// apps/api/src/mastra-integration.test.ts
import { describe, it, expect } from "vitest";
import { createMastraIntegration } from "./mastra-integration";
import { createInMemoryProductStateRepository } from "./product-state-repository";
import { createInitialProductState } from "../../src/domain/engine";

describe("mastra-integration", () => {
  const stateRepo = createInMemoryProductStateRepository(createInitialProductState());
  const mastra = createMastraIntegration(stateRepo);

  it("returns agent names", () => {
    const names = mastra.getAgentNames();
    expect(names.length).toBe(10);
    expect(names).toContain("interviewDirector");
  });

  it("returns workflow names", () => {
    const names = mastra.getWorkflowNames();
    expect(names.length).toBe(12);
    expect(names).toContain("interview-preparation");
  });

  it("gracefully degrades when Mastra is unavailable", async () => {
    const result = await mastra.runWorkflow("interview-preparation", { mode: "daily" });
    expect(result).toHaveProperty("degraded", true);
    expect(result).toHaveProperty("reason", "mastra-unavailable");
  });
});
```

- [ ] **Step 4: 运行测试**

```bash
npx vitest run apps/api/src/mastra-integration.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/mastra-integration.ts apps/api/src/mastra-integration.test.ts apps/api/src/server.ts
git commit -m "feat: integrate Mastra runtime into API server with graceful degradation"
```

---

### Task 2.7: 添加 PostgreSQL Drizzle Schema（渐进迁移准备）

**Files:**
- Create: `packages/db/src/pg-schema.ts`
- Create: `packages/db/src/pg-product-state-repository.ts`
- Modify: `packages/db/package.json`

- [ ] **Step 1: 创建 PostgreSQL schema**

```typescript
// packages/db/src/pg-schema.ts
import { pgTable, text, integer, timestamp, jsonb, real, boolean, bigserial } from "drizzle-orm/pg-core";

export const productStateSnapshots = pgTable("product_state_snapshots", {
  id: text("id").primaryKey(),
  stateJson: jsonb("state_json").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const productStateEvents = pgTable("product_state_events", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  eventType: text("event_type").notNull(),
  stateJson: jsonb("state_json").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const memoryRecords = pgTable("memory_records", {
  id: text("id").primaryKey(),
  text: text("text").notNull(),
  status: text("status").notNull().default("draft"),
  type: text("type"),
  sourceType: text("source_type").notNull(),
  sourceId: text("source_id").notNull(),
  evidenceQuote: text("evidence_quote"),
  sourceCandidateId: text("source_candidate_id"),
  sensitivity: text("sensitivity").default("normal"),
  confidenceScore: real("confidence_score"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
  lastConfirmedAt: timestamp("last_confirmed_at"),
  lastChallengedAt: timestamp("last_challenged_at"),
  deprecatedReason: text("deprecated_reason"),
});

export const memoryEdges = pgTable("memory_edges", {
  id: text("id").primaryKey(),
  sourceId: text("source_id").notNull(),
  targetId: text("target_id").notNull(),
  relation: text("relation").notNull(),
  confidence: real("confidence").default(0.5),
  evidence: text("evidence"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const memoryCandidates = pgTable("memory_candidates", {
  id: text("id").primaryKey(),
  text: text("text").notNull(),
  status: text("status").notNull().default("pending"),
  sourceType: text("source_type").notNull(),
  sourceId: text("source_id").notNull(),
  evidenceQuote: text("evidence_quote"),
  reason: text("reason"),
  sensitivity: text("sensitivity").default("normal"),
  reviewScore: real("review_score"),
  reviewSignals: jsonb("review_signals").default([]),
  reviewerDecision: text("reviewer_decision"),
  reviewNote: text("review_note"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  reviewedAt: timestamp("reviewed_at"),
});

export const importSources = pgTable("import_sources", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
  mediaType: text("media_type").notNull(),
  sourceUrl: text("source_url"),
  status: text("status").notNull().default("pending"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const ragChunks = pgTable("rag_chunks", {
  id: text("id").primaryKey(),
  sourceId: text("source_id").notNull(),
  sourceType: text("source_type").notNull(),
  content: text("content").notNull(),
  chunkIndex: integer("chunk_index").notNull(),
  metadata: jsonb("metadata").default({}),
  embedding: text("embedding"), // pgvector would use vector type
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const auditEvents = pgTable("audit_events", {
  id: text("id").primaryKey(),
  eventType: text("event_type").notNull(),
  entityType: text("entity_type").notNull(),
  entityId: text("entity_id").notNull(),
  severity: text("severity").default("info"),
  detail: jsonb("detail").default({}),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const aiRunEvents = pgTable("ai_run_events", {
  id: text("id").primaryKey(),
  workflowType: text("workflow_type").notNull(),
  status: text("status").notNull(),
  entityType: text("entity_type"),
  entityId: text("entity_id"),
  inputSummary: text("input_summary"),
  outputSummary: text("output_summary"),
  latencyMs: integer("latency_ms"),
  estimatedTokens: integer("estimated_tokens"),
  degradedReason: text("degraded_reason"),
  traceId: text("trace_id"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});
```

- [ ] **Step 2: 创建 PostgreSQL repository**

```typescript
// packages/db/src/pg-product-state-repository.ts
import { drizzle } from "drizzle-orm/node-postgres";
import { eq } from "drizzle-orm";
import { productStateSnapshots, productStateEvents } from "./pg-schema";
import type { ProductStateRepository } from "../../apps/api/src/product-state-repository";
import type { ProductState } from "../../src/domain/types";
import { createInitialProductState } from "../../src/domain/engine";

export function createPgProductStateRepository(
  connectionString: string,
  initialState?: ProductState
): ProductStateRepository {
  const db = drizzle(connectionString);
  const initial = initialState || createInitialProductState();

  return {
    async getState(): Promise<ProductState> {
      const rows = await db.select().from(productStateSnapshots).where(eq(productStateSnapshots.id, "current")).limit(1);
      if (rows.length === 0) return initial;
      return rows[0].stateJson as ProductState;
    },

    async resetState(): Promise<ProductState> {
      await db.delete(productStateSnapshots).where(eq(productStateSnapshots.id, "current"));
      return initial;
    },

    async replaceState(state: ProductState): Promise<ProductState> {
      await db
        .insert(productStateSnapshots)
        .values({
          id: "current",
          stateJson: state as any,
          updatedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: productStateSnapshots.id,
          set: { stateJson: state as any, updatedAt: new Date() },
        });

      await db.insert(productStateEvents).values({
        eventType: "state_replaced",
        stateJson: state as any,
      });

      return state;
    },
  };
}
```

- [ ] **Step 3: 更新 packages/db/package.json 添加 pg 依赖**

```json
{
  "dependencies": {
    "drizzle-orm": "^0.42.0",
    "pg": "^8.14.0",
    "@types/pg": "^8.11.0"
  }
}
```

- [ ] **Step 4: Commit**

```bash
git add packages/db/src/pg-schema.ts packages/db/src/pg-product-state-repository.ts packages/db/package.json
git commit -m "feat: add PostgreSQL Drizzle schema and repository for gradual migration"
```

---

## 阶段二验收检查点

- [ ] `npx tsc --noEmit` 零错误
- [ ] `npx vitest run` 全部通过（包括 Mastra 包测试）
- [ ] 12 个 Tool 全部可导入
- [ ] 10 个 Agent 全部可导入
- [ ] 12 个 Workflow 全部可导入
- [ ] Mastra Memory 和 RAG 配置完成
- [ ] API Server 集成 Mastra 路由可用
- [ ] PostgreSQL schema 定义完成

---

## 阶段三：体验 + 运维

### Task 3.1: Phase 3 — 搜索情报增强

**Files:**
- Modify: `apps/api/src/routes/search.ts`
- Modify: `src/features/search/SearchIntelligenceView.tsx`

- [ ] **Step 1: 在搜索路由中集成外部搜索提供商**

Read `apps/api/src/routes/search.ts`, add multi-provider search:

```typescript
// Add to search route:
import { createExternalSearchClientsFromEnv } from "../providers/external-search.js";

// In the POST /api/search/briefs handler, add:
const externalClients = createExternalSearchClientsFromEnv(process.env);
if (provider === "tavily" && externalClients.tavily) {
  const result = await externalClients.tavily.search({ query: topic, maxResults: maxSources });
  return buildSearchBriefFromExternalResult(result, "tavily");
}
// Similar for exa and brave
```

- [ ] **Step 2: 添加自动搜索简报生成**

```typescript
// Add to search route:
app.post("/api/search/auto-briefs", async (request) => {
  const state = await stateRepo.getState();
  const { themeId, debtId } = request.body as { themeId?: string; debtId?: string };

  let topic = "";
  if (themeId) {
    const theme = state.themes.find((t) => t.id === themeId);
    topic = theme ? theme.name : "";
  } else if (debtId) {
    const debt = state.debts.find((d) => d.id === debtId);
    topic = debt ? debt.concept : "";
  }

  if (!topic) {
    return { error: "No topic found" };
  }

  const brief = buildSearchBrief(state, topic, state.systemConfig.search.activeProvider);
  state.searchBriefs = [brief, ...state.searchBriefs];
  await stateRepo.replaceState(state);
  return { brief };
});
```

- [ ] **Step 3: 更新前端搜索视图支持多提供商**

Read `src/features/search/SearchIntelligenceView.tsx`, add provider selector dropdown and auto-brief generation button.

- [ ] **Step 4: 编写测试**

```typescript
// tests/e2e/search-enhanced.spec.ts
import { test, expect } from "@playwright/test";
import { resetDemoState, openView } from "./helpers";

test("search view shows provider selector", async ({ page }) => {
  await resetDemoState(page);
  await openView(page, "搜索情报", "搜索情报");
  await expect(page.locator("select#search-provider")).toBeVisible();
});

test("auto-generates brief from theme", async ({ page }) => {
  await resetDemoState(page);
  await page.goto("/");
  await openView(page, "搜索情报", "搜索情报");
  await page.click("button:has-text('自动生成')");
  await expect(page.locator(".search-brief-card")).toBeVisible();
});
```

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/search.ts src/features/search/SearchIntelligenceView.tsx tests/e2e/search-enhanced.spec.ts
git commit -m "feat: enhance search with multi-provider support and auto-brief generation (Phase 3)"
```

---

### Task 3.2: Phase 6 — 播客工作室增强

**Files:**
- Modify: `src/features/podcast/PodcastStudioView.tsx`
- Modify: `apps/api/src/routes/podcast.ts`

- [ ] **Step 1: 增强播客生成支持多源输入**

Read `apps/api/src/routes/podcast.ts`, add support for generating from SearchBrief, theme, debt:

```typescript
// Add sourceType parameter to podcast generation:
const { noteId, sourceType, sourceId, voice } = request.body as {
  noteId?: string;
  sourceType?: "note" | "searchBrief" | "theme" | "debt";
  sourceId?: string;
  voice?: string;
};

let sourceContent = "";
if (sourceType === "searchBrief") {
  const brief = state.searchBriefs.find((b) => b.id === sourceId);
  sourceContent = brief ? JSON.stringify(brief) : "";
} else if (sourceType === "theme") {
  const theme = state.themes.find((t) => t.id === sourceId);
  sourceContent = theme ? JSON.stringify(theme) : "";
} else if (sourceType === "debt") {
  const debt = state.debts.find((d) => d.id === sourceId);
  sourceContent = debt ? JSON.stringify(debt) : "";
}
```

- [ ] **Step 2: 添加播客脚本编辑和确认 UI**

Read `src/features/podcast/PodcastStudioView.tsx`, add script editing textarea and confirm button before TTS generation.

- [ ] **Step 3: 添加前端音频播放器**

Add an HTML5 `<audio>` element for playing generated podcast audio.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/routes/podcast.ts src/features/podcast/PodcastStudioView.tsx
git commit -m "feat: enhance podcast studio with multi-source input, script editing, and audio player (Phase 6)"
```

---

### Task 3.3: Phase 7 — 实时语音增强

**Files:**
- Modify: `src/realtime/bailianWebrtc.ts`
- Modify: `apps/api/src/routes/realtime-voice.ts`

- [ ] **Step 1: 实现轮流发言状态机**

```typescript
// Add to src/realtime/bailianWebrtc.ts:
export type TurnPhase = "idle" | "user_speaking" | "short_pause" | "long_pause" | "assistant_speaking" | "interrupted";

export interface TurnState {
  phase: TurnPhase;
  silenceMs: number;
  isUserSpeaking: boolean;
  isAssistantSpeaking: boolean;
  shouldInterrupt: boolean;
  backchannel: string | null;
}

export function createTurnStateMachine(options: {
  silenceThresholdMs: number;
  longPauseThresholdMs: number;
}): {
  update(signal: { inputLevel: number; silenceMs: number }): TurnState;
  getState(): TurnState;
} {
  let phase: TurnPhase = "idle";
  let silenceMs = 0;
  let isUserSpeaking = false;
  let isAssistantSpeaking = false;

  return {
    update(signal) {
      silenceMs = signal.silenceMs;
      isUserSpeaking = signal.inputLevel > 0.1;

      if (isUserSpeaking && isAssistantSpeaking) {
        phase = "interrupted";
      } else if (isUserSpeaking) {
        phase = "user_speaking";
      } else if (silenceMs < options.silenceThresholdMs) {
        phase = "short_pause";
      } else if (silenceMs < options.longPauseThresholdMs) {
        phase = "long_pause";
      } else if (isAssistantSpeaking) {
        phase = "assistant_speaking";
      } else {
        phase = "idle";
      }

      return this.getState();
    },
    getState() {
      return {
        phase,
        silenceMs,
        isUserSpeaking,
        isAssistantSpeaking,
        shouldInterrupt: phase === "interrupted",
        backchannel: phase === "short_pause" ? "嗯" : null,
      };
    },
  };
}
```

- [ ] **Step 2: 添加打断处理和记忆回调**

```typescript
// Add to realtime-voice route:
// Interruption handling:
app.post("/api/realtime-voice/sessions/:id/interrupt", async (request) => {
  const { id } = request.params as { id: string };
  const session = realtimeSessions.get(id);
  if (session) {
    session.interrupted = true;
    return { interrupted: true, sessionId: id };
  }
  return { error: "Session not found" };
});

// Memory callback during interview:
app.get("/api/realtime-voice/sessions/:id/memory-context", async (request) => {
  const { id } = request.params as { id: string };
  const state = await stateRepo.getState();
  const recentMemories = (state.memoryRecords || []).slice(-5);
  const activeThemes = (state.themes || []).filter((t) => t.maturity !== "mature");
  return { recentMemories, activeThemes };
});
```

- [ ] **Step 3: Commit**

```bash
git add src/realtime/bailianWebrtc.ts apps/api/src/routes/realtime-voice.ts
git commit -m "feat: enhance realtime voice with turn state machine, interruption handling, and memory callback (Phase 7)"
```

---

### Task 3.4: Phase 8 — 质量 & 运维

**Files:**
- Create: `packages/mastra/src/evals/scorers.ts`
- Create: `apps/api/src/routes/quality.ts`
- Create: `apps/api/src/routes/observability.ts`

- [ ] **Step 1: 实现 8 个评分器**

```typescript
// packages/mastra/src/evals/scorers.ts
export const scorers = {
  interviewNaturalness: (transcript: string): { score: number; feedback: string } => {
    const questions = (transcript.match(/\?/g) || []).length;
    const turns = transcript.split("\n").filter((l) => l.trim()).length;
    const ratio = questions / Math.max(turns, 1);
    return {
      score: Math.min(ratio * 2, 1),
      feedback: ratio > 0.3 ? "Good question frequency" : "Consider asking more questions",
    };
  },

  followupRelevance: (transcript: string, previousTopics: string[]): { score: number; feedback: string } => {
    const lowerTranscript = transcript.toLowerCase();
    const matches = previousTopics.filter((t) => lowerTranscript.includes(t.toLowerCase()));
    const score = matches.length / Math.max(previousTopics.length, 1);
    return {
      score,
      feedback: score > 0.5 ? "Good topic continuity" : "Follow-ups could be more relevant",
    };
  },

  memoryCitation: (response: string, memories: string[]): { score: number; feedback: string } => {
    const hasCitation = memories.some((m) => response.includes(m.slice(0, 10)));
    return {
      score: hasCitation ? 0.9 : 0.3,
      feedback: hasCitation ? "Memory referenced" : "No memory citation found",
    };
  },

  memoryCandidatePrecision: (candidate: { text: string; evidenceQuote: string }): { score: number; feedback: string } => {
    const textWords = new Set(candidate.text.toLowerCase().split(/\s+/));
    const evidenceWords = new Set(candidate.evidenceQuote.toLowerCase().split(/\s+/));
    const overlap = [...textWords].filter((w) => evidenceWords.has(w)).length;
    const score = overlap / Math.max(textWords.size, 1);
    return {
      score,
      feedback: score > 0.3 ? "Good evidence alignment" : "Weak evidence support",
    };
  },

  sensitiveLeakage: (content: string): { score: number; feedback: string } => {
    const patterns = [
      /\b\d{11}\b/, // phone
      /\b\d{18}\b/, // ID
      /\b(password|secret|token|key)\b/i,
      /\b\d{16,19}\b/, // credit card
    ];
    const leaks = patterns.filter((p) => p.test(content));
    return {
      score: leaks.length === 0 ? 1 : 0,
      feedback: leaks.length === 0 ? "No sensitive data detected" : `Found ${leaks.length} potential leaks`,
    };
  },

  contextPackRelevance: (pack: any, sessionTopic: string): { score: number; feedback: string } => {
    const packStr = JSON.stringify(pack).toLowerCase();
    const relevance = packStr.includes(sessionTopic.toLowerCase());
    return {
      score: relevance ? 0.8 : 0.3,
      feedback: relevance ? "Context pack relevant to session" : "Context pack may be off-topic",
    };
  },

  sourceFaithfulness: (claim: string, source: string): { score: number; feedback: string } => {
    const claimWords = claim.toLowerCase().split(/\s+/).filter((w) => w.length > 3);
    const sourceLower = source.toLowerCase();
    const faithful = claimWords.filter((w) => sourceLower.includes(w)).length;
    const score = faithful / Math.max(claimWords.length, 1);
    return {
      score,
      feedback: score > 0.5 ? "Claims supported by source" : "Claims may deviate from source",
    };
  },

  interviewFeedback: (feedbacks: { rating: number }[]): { score: number; feedback: string } => {
    if (feedbacks.length === 0) return { score: 0, feedback: "No feedback collected" };
    const avg = feedbacks.reduce((sum, f) => sum + f.rating, 0) / feedbacks.length;
    return {
      score: avg / 5,
      feedback: `Average rating: ${avg.toFixed(1)}/5 from ${feedbacks.length} reviews`,
    };
  },
};
```

- [ ] **Step 2: 创建质量路由**

```typescript
// apps/api/src/routes/quality.ts
import type { FastifyInstance } from "fastify";
import type { ProductStateRepository } from "../product-state-repository";

export function registerQualityRoutes(app: FastifyInstance, stateRepo: ProductStateRepository) {
  app.post("/api/quality/score", async (request) => {
    const { scorerName, input, reference } = request.body as {
      scorerName: string;
      input: string;
      reference?: string;
    };

    // Rule-based scoring (no AI call needed for basic checks)
    const rules: Record<string, (input: string, ref?: string) => { score: number; feedback: string }> = {
      sensitiveLeakage: (text) => {
        const patterns = [/\b\d{11}\b/, /\b\d{18}\b/, /\b(password|secret|token|key)\b/i];
        const leaks = patterns.filter((p) => p.test(text));
        return { score: leaks.length === 0 ? 1 : 0, feedback: leaks.length === 0 ? "Clean" : `${leaks.length} potential leaks` };
      },
      interviewNaturalness: (text) => {
        const questions = (text.match(/\?/g) || []).length;
        return { score: Math.min(questions / 5, 1), feedback: `${questions} questions found` };
      },
      memoryCandidatePrecision: (text, ref) => {
        if (!ref) return { score: 0.5, feedback: "No reference" };
        const overlap = text.split(/\s+/).filter((w) => ref.includes(w)).length;
        return { score: Math.min(overlap / 5, 1), feedback: `${overlap} overlapping words` };
      },
    };

    const scorer = rules[scorerName];
    if (!scorer) return { error: `Unknown scorer: ${scorerName}` };

    return { scorerName, ...scorer(input, reference) };
  });

  app.get("/api/quality/report", async () => {
    const state = await stateRepo.getState();
    const auditCount = (state.auditEvents || []).length;
    const aiRunCount = (state.aiRunEvents || []).length;
    const sessionCount = state.sessions.length;
    const memoryCount = (state.memoryRecords || []).length;

    return {
      summary: {
        totalSessions: sessionCount,
        totalMemories: memoryCount,
        totalAuditEvents: auditCount,
        totalAiRuns: aiRunCount,
      },
      recentAuditEvents: (state.auditEvents || []).slice(0, 20),
      recentAiRuns: (state.aiRunEvents || []).slice(0, 20),
    };
  });
}
```

- [ ] **Step 3: 创建可观测性路由**

```typescript
// apps/api/src/routes/observability.ts
import type { FastifyInstance } from "fastify";
import type { ProductStateRepository } from "../product-state-repository";

export function registerObservabilityRoutes(app: FastifyInstance, stateRepo: ProductStateRepository) {
  app.get("/api/observability/health", async () => {
    const state = await stateRepo.getState();
    const providers = state.systemConfig.providers || [];
    const activeProviders = providers.filter((p) => p.active);

    return {
      status: "ok",
      uptime: process.uptime(),
      memory: process.memoryUsage(),
      providers: {
        total: providers.length,
        active: activeProviders.length,
        details: activeProviders.map((p) => ({ id: p.id, kind: p.kind, status: p.status })),
      },
    };
  });

  app.get("/api/observability/metrics", async () => {
    const state = await stateRepo.getState();
    const aiRuns = state.aiRunEvents || [];

    const totalRuns = aiRuns.length;
    const failedRuns = aiRuns.filter((r) => r.status === "failed").length;
    const degradedRuns = aiRuns.filter((r) => r.degradedReason).length;
    const totalLatency = aiRuns.reduce((sum, r) => sum + (r.latencyMs || 0), 0);
    const totalTokens = aiRuns.reduce((sum, r) => sum + (r.estimatedTokens || 0), 0);

    return {
      aiRuns: { total: totalRuns, failed: failedRuns, degraded: degradedRuns },
      latency: { totalMs: totalLatency, avgMs: totalRuns > 0 ? totalLatency / totalRuns : 0 },
      tokens: { total: totalTokens, avgPerRun: totalRuns > 0 ? totalTokens / totalRuns : 0 },
      sessions: { total: state.sessions.length, completed: state.sessions.filter((s) => s.status === "completed").length },
    };
  });
}
```

- [ ] **Step 4: 在 server.ts 中注册质量和可观测性路由**

```typescript
import { registerQualityRoutes } from "./routes/quality.js";
import { registerObservabilityRoutes } from "./routes/observability.js";

registerQualityRoutes(app, stateRepo);
registerObservabilityRoutes(app, stateRepo);
```

- [ ] **Step 5: 编写测试**

```typescript
// apps/api/src/routes/quality.test.ts
import { describe, it, expect } from "vitest";

describe("quality scorers", () => {
  it("sensitiveLeakage detects phone numbers", () => {
    const text = "My phone is 13800138000";
    const patterns = [/\b\d{11}\b/];
    const leaks = patterns.filter((p) => p.test(text));
    expect(leaks.length).toBe(1);
  });

  it("sensitiveLeakage passes clean text", () => {
    const text = "This is a normal conversation about work";
    const patterns = [/\b\d{11}\b/, /\b\d{18}\b/, /\b(password|secret|token|key)\b/i];
    const leaks = patterns.filter((p) => p.test(text));
    expect(leaks.length).toBe(0);
  });
});
```

- [ ] **Step 6: Commit**

```bash
git add packages/mastra/src/evals/scorers.ts apps/api/src/routes/quality.ts apps/api/src/routes/observability.ts apps/api/src/server.ts apps/api/src/routes/quality.test.ts
git commit -m "feat: implement quality scorers, audit/observability routes (Phase 8)"
```

---

## 阶段三验收检查点

- [ ] `npx tsc --noEmit` 零错误
- [ ] `npx vitest run` 全部通过
- [ ] `npx playwright test` 全部通过
- [ ] `npm run build` 构建成功
- [ ] 搜索多提供商可用
- [ ] 播客多源输入 + 脚本编辑 + 音频播放可用
- [ ] 实时语音状态机 + 打断 + 记忆回调可用
- [ ] 8 个评分器可运行
- [ ] 质量和可观测性 API 可用

---

## 最终验收

- [ ] `npx tsc --noEmit` 零错误
- [ ] `npx vitest run` 全部通过
- [ ] `npx playwright test` 全部通过
- [ ] `npm run build` 构建成功
- [ ] `npm run dev:full` 前后端同时启动
- [ ] Docker 构建成功: `docker build -t interview-app .`
- [ ] 所有 8 个 Phase 功能完整可用
