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
  // 当前持久化是 SQLite JSON snapshot/event 单租户库（Postgres 仓库已删除）。
  // 该清单描述「把当前 SQLite 状态安全搬到另一台机器/另一份库」的就绪度，不预设关系库目标。
  recommendedTarget: "sqlite-json-snapshot";
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
    recommendedTarget: "sqlite-json-snapshot",
    sourceTables: ["product_state_snapshots", "product_state_events"],
    entityCounts,
    checks: [
      {
        id: "normalized-state",
        label: "ProductState 规范化",
        status: "ready",
        detail: "迁移前会通过 normalizeProductState 补齐字段、兼容旧导出并清理 legacy 字段。",
        recommendation: "迁移脚本应始终先执行 normalizeProductState，再写入目标库。"
      },
      {
        id: "sqlite-snapshot-store",
        label: "SQLite JSON snapshot/event 存储",
        status: "ready",
        detail: "当前持久化是单租户 ProductState JSON，存放在 SQLite 的 product_state_snapshots / product_state_events 表中（Postgres 仓库已删除）。",
        recommendation: "搬迁时直接复制 SQLite 库文件（PRODUCT_STATE_DB_PATH），或用 /api/state/export 导出后在目标机 /api/state/import 恢复；两种方式都先过 normalizeProductState。"
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
      "1. 在源机停止写入（或确保无并发请求），定位 SQLite 库文件 PRODUCT_STATE_DB_PATH。",
      "2. 通过 Product API /api/state/export 导出当前 ProductState JSON（不含 provider 密钥），作为可移植备份。",
      "3. 在目标机配置同版本服务与 PRODUCT_STATE_DB_PATH，用 /api/state/import 导入导出包；导入会自动执行 normalizeProductState 并追加一条 replace event。",
      "4. 迁移对象文件目录（CORPUS_UPLOAD_DIR）或对象存储，再校验 local-object:// 与公网音频 URL 映射。",
      "5. 在目标机做一次 export→import 往返演练，核对实体计数与 checks 全绿后再切换生产读写。"
    ]
  };
}

function buildMigrationEntityCounts(state: ProductState): MigrationEntityCount[] {
  return [
    {
      id: "profile",
      label: "显性档案",
      count: 1 + state.profile.explicitBoundaries.length + (state.profileSuggestions ?? []).filter((s) => s.status === "pending").length
    },
    {
      id: "interviews",
      label: "专访与笔记",
      count: state.sessions.length + state.notes.length + (state.interviewAnnotations ?? []).length
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
      id: "operations",
      label: "运行与审计",
      // workflowRuns / operationalChecks are never produced — excluded to avoid implying coverage.
      count:
        state.auditEvents.length +
        state.aiRunEvents.length +
        state.configVersions.length
    }
  ];
}
