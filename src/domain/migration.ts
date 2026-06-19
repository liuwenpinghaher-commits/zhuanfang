import { normalizeProductState } from "./storage";
import type { ProductState } from "./types";

export type MigrationReadinessStatus = "ready" | "warning" | "blocked";

export interface MigrationEntityCount {
  id:
    | "profile"
    | "interviews"
    | "assets"
    | "memory"
    | "external_knowledge"
    | "corpus_learning"
    | "generated_media"
    | "intel"
    | "operations";
  label: string;
  count: number;
}

export interface MigrationReadinessCheck {
  id: string;
  label: string;
  status: MigrationReadinessStatus;
  detail: string;
  recommendation: string;
}

export interface ProductStateMigrationManifest {
  schemaVersion: 1;
  format: "product-state-json";
  generatedAt: string;
  recommendedTarget: "postgres-jsonb-first";
  sourceTables: string[];
  entityCounts: MigrationEntityCount[];
  checks: MigrationReadinessCheck[];
  targetPlan: string[];
}

export function buildProductStateMigrationManifest(
  state: ProductState,
  generatedAt = new Date().toISOString()
): ProductStateMigrationManifest {
  const normalizedState = normalizeProductState(state);
  const entityCounts = buildMigrationEntityCounts(normalizedState);
  const pendingMemoryCandidates = normalizedState.memoryCandidates.filter((candidate) => candidate.status === "pending").length;
  const localObjectAudioCount = normalizedState.podcastEpisodes.filter((episode) => episode.audioUrl.startsWith("local-object://")).length;
  const localImportSourceCount = normalizedState.importSources.filter((source) => source.sourceUrl?.startsWith("local-object://")).length;

  return {
    schemaVersion: 1,
    format: "product-state-json",
    generatedAt,
    recommendedTarget: "postgres-jsonb-first",
    sourceTables: ["product_state_snapshots", "product_state_events"],
    entityCounts,
    checks: [
      {
        id: "normalized-state",
        label: "ProductState 规范化",
        status: "ready",
        detail: "迁移前会通过 normalizeProductState 补齐字段、兼容旧导出并清理 legacy profile confirmedMemories。",
        recommendation: "迁移脚本应始终先执行 normalizeProductState，再写入目标库。"
      },
      {
        id: "jsonb-first-target",
        label: "PostgreSQL JSONB 首阶段",
        status: "ready",
        detail: "当前状态天然是单租户 ProductState JSON；第一阶段可迁移到 JSONB snapshot/event 表，不需要先拆全量关系表。",
        recommendation: "先建立 product_state_snapshots / product_state_events JSONB 表；稳定后再按查询热点拆 assets、memory、sessions。"
      },
      {
        id: "pending-memory-review",
        label: "待审核记忆",
        status: pendingMemoryCandidates > 0 ? "warning" : "ready",
        detail:
          pendingMemoryCandidates > 0
            ? `还有 ${pendingMemoryCandidates} 条待审核候选记忆，迁移后仍不得作为确认事实进入 ContextPack。`
            : "没有待审核候选记忆阻塞迁移。",
        recommendation: "迁移前不强制清空候选，但目标库必须保留 status、reviewScore、sensitivity 和 evidenceQuote。"
      },
      {
        id: "local-object-audio",
        label: "本地对象音频",
        status: localObjectAudioCount + localImportSourceCount > 0 ? "warning" : "ready",
        detail:
          localObjectAudioCount + localImportSourceCount > 0
            ? `发现 ${localObjectAudioCount + localImportSourceCount} 个 local-object:// 引用，迁移数据库不会自动迁移二进制原件。`
            : "没有发现 local-object:// 音频引用。",
        recommendation: "生产迁移需要同时迁移 CORPUS_UPLOAD_DIR 或将对象复制到 OSS/S3/R2/MinIO，并更新公开访问前缀。"
      },
      {
        id: "provider-secrets",
        label: "Provider 密钥隔离",
        status: "ready",
        detail: "ProductState、JSON 导出和迁移清单不包含 .env.local 或 provider API key。",
        recommendation: "密钥仍通过部署环境或系统配置页写入 .env.local，不随业务状态迁移包移动。"
      }
    ],
    targetPlan: [
      "1. 创建 product_state_snapshots(id text primary key, state_json jsonb not null, created_at timestamptz, updated_at timestamptz)。",
      "2. 创建 product_state_events(id bigserial primary key, event_type text, state_json jsonb not null, created_at timestamptz)。",
      "3. 从 SQLite snapshot 读取 state_json，执行 normalizeProductState 后写入 PostgreSQL snapshot，并追加 replace event。",
      "4. 迁移对象文件目录或对象存储，再校验 local-object:// 与公网音频 URL 映射。",
      "5. 通过 Product API /api/state/export 和 /api/state/import 做一次备份恢复演练，再切换生产读写。"
    ]
  };
}

function buildMigrationEntityCounts(state: ProductState): MigrationEntityCount[] {
  return [
    {
      id: "profile",
      label: "显性档案",
      count: 1 + state.profile.explicitBoundaries.length + state.profile.inferredMemories.length
    },
    {
      id: "interviews",
      label: "专访与笔记",
      count: state.sessions.length + state.notes.length
    },
    {
      id: "assets",
      label: "认知资产",
      count: state.points.length + state.questions.length + state.decisions.length + state.debts.length + state.themes.length
    },
    {
      id: "memory",
      label: "长期记忆",
      count: state.memoryCorrections.length + state.memoryRecords.length + state.memoryCandidates.length + state.memoryEdges.length
    },
    {
      id: "external_knowledge",
      label: "联网/RAG 资料",
      count: state.searchBriefs.length + state.importSources.length + state.ragChunks.length
    },
    {
      id: "corpus_learning",
      label: "语料学习",
      count: state.corpusImports.length + state.corpusInsights.length + state.playbookPatches.length
    },
    {
      id: "generated_media",
      label: "播客生成物",
      count: state.podcastEpisodes.length
    },
    {
      id: "intel",
      label: "情报监控",
      count: state.intelTasks.length + state.intelItems.length
    },
    {
      id: "operations",
      label: "运行与审计",
      count:
        state.auditEvents.length +
        state.aiRunEvents.length +
        state.workflowRuns.length +
        state.operationalChecks.length +
        state.configVersions.length
    }
  ];
}
