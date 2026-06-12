import { buildProductStateMigrationManifest, type ProductStateMigrationManifest } from "./migration";
import { buildPrivacyReport, type PrivacyReport } from "./privacy";
import { buildStableDigest, measureUtf8Bytes, stableStringify } from "./stateDigest";
import { normalizeProductState } from "./storage";
import type { ProductState } from "./types";

export type BackupRehearsalStatus = "passed" | "warning" | "failed";

export interface BackupRehearsalCheck {
  id: string;
  label: string;
  status: BackupRehearsalStatus;
  detail: string;
  recommendation: string;
}

export interface BackupRehearsalPackageSummary {
  product: "interview-product-mvp";
  format: "product-state-json";
  exportedAt: string;
  stateBytes: number;
  stateDigest: string;
  restoredDigest: string;
  privacyReportIncluded: boolean;
  providerSecretsExcluded: boolean;
}

export interface BackupRestoreRehearsalReport {
  schemaVersion: 1;
  generatedAt: string;
  strategy: "json-export-import-rehearsal";
  summary: Record<BackupRehearsalStatus, number>;
  package: BackupRehearsalPackageSummary;
  privacyReport: PrivacyReport;
  migrationManifest: ProductStateMigrationManifest;
  checks: BackupRehearsalCheck[];
  runbook: string[];
}

interface ProductStateExportPackage {
  schemaVersion: 1;
  exportedAt: string;
  product: "interview-product-mvp";
  privacyReport: PrivacyReport;
  state: ProductState;
}

export function buildBackupRestoreRehearsalReport(
  state: ProductState,
  generatedAt = new Date().toISOString()
): BackupRestoreRehearsalReport {
  const normalizedState = normalizeProductState(state);
  const privacyReport = buildPrivacyReport(normalizedState, generatedAt);
  const exportPackage: ProductStateExportPackage = {
    schemaVersion: 1,
    exportedAt: generatedAt,
    product: "interview-product-mvp",
    privacyReport,
    state: normalizedState
  };
  const serializedPackage = stableStringify(exportPackage);
  const restoredState = normalizeProductState(exportPackage.state);
  const stateDigest = buildStableDigest(normalizedState);
  const restoredDigest = buildStableDigest(restoredState);
  const restoredPrivacyReport = buildPrivacyReport(restoredState, generatedAt);
  const migrationManifest = buildProductStateMigrationManifest(restoredState, generatedAt);
  const localObjectReferences = countLocalObjectReferences(restoredState);
  const providerSecretsExcluded = !containsProviderSecretMarkers(serializedPackage);
  const restoreMatches = stateDigest === restoredDigest;
  const privacyInventoryMatches = privacyReport.totalRecords === restoredPrivacyReport.totalRecords;
  const migrationBlockedCount = migrationManifest.checks.filter((check) => check.status === "blocked").length;
  const migrationWarningCount = migrationManifest.checks.filter((check) => check.status === "warning").length;
  const checks: BackupRehearsalCheck[] = [
    {
      id: "export-package",
      label: "JSON 导出包",
      status: serializedPackage.length > 0 ? "passed" : "failed",
      detail: `导出包可序列化，状态体积约 ${measureUtf8Bytes(serializedPackage)} bytes。`,
      recommendation: "生产备份应保存完整 JSON 导出包，并记录生成时间和摘要。"
    },
    {
      id: "restore-normalization",
      label: "恢复规范化",
      status: restoreMatches ? "passed" : "failed",
      detail: restoreMatches
        ? `恢复后 ProductState 摘要一致：${restoredDigest}。`
        : `恢复后摘要不一致：导出 ${stateDigest}，恢复 ${restoredDigest}。`,
      recommendation: "每次迁移或升级前，都应在独立环境执行导入并比较规范化摘要。"
    },
    {
      id: "privacy-inventory",
      label: "隐私库存一致",
      status: privacyInventoryMatches ? "passed" : "failed",
      detail: privacyInventoryMatches
        ? `恢复前后隐私库存均为 ${privacyReport.totalRecords} 条记录。`
        : `恢复前隐私库存 ${privacyReport.totalRecords}，恢复后 ${restoredPrivacyReport.totalRecords}。`,
      recommendation: "恢复演练必须同时校验隐私库存，避免只恢复业务数据而漏掉删除/导出边界。"
    },
    {
      id: "provider-secrets",
      label: "Provider 密钥排除",
      status: providerSecretsExcluded && privacyReport.operations.providerSecretsExcluded ? "passed" : "failed",
      detail: providerSecretsExcluded
        ? "导出包没有发现运行时 provider secret 标记。"
        : "导出包疑似包含 provider secret 标记。",
      recommendation: "API key 只应通过部署环境或系统配置页管理，不进入备份包和迁移包。"
    },
    {
      id: "local-object-artifacts",
      label: "对象文件跟随备份",
      status: localObjectReferences > 0 ? "warning" : "passed",
      detail:
        localObjectReferences > 0
          ? `发现 ${localObjectReferences} 个 local-object:// 引用；JSON 恢复不会自动恢复二进制原件。`
          : "没有发现 local-object:// 引用，JSON 包即可覆盖当前业务状态。",
      recommendation: "存在本地对象引用时，备份必须同时包含 CORPUS_UPLOAD_DIR 或对象存储桶快照。"
    },
    {
      id: "migration-readiness",
      label: "迁移清单复核",
      status: migrationBlockedCount > 0 ? "failed" : migrationWarningCount > 0 ? "warning" : "passed",
      detail:
        migrationBlockedCount > 0
          ? `迁移清单仍有 ${migrationBlockedCount} 个阻塞项。`
          : migrationWarningCount > 0
            ? `迁移清单有 ${migrationWarningCount} 个风险项，需要生产演练时确认。`
            : "迁移清单没有阻塞或风险项。",
      recommendation: "备份恢复演练通过后，再进入 PostgreSQL JSONB 或对象存储迁移。"
    }
  ];

  return {
    schemaVersion: 1,
    generatedAt,
    strategy: "json-export-import-rehearsal",
    summary: summarizeBackupRehearsalChecks(checks),
    package: {
      product: "interview-product-mvp",
      format: "product-state-json",
      exportedAt: generatedAt,
      stateBytes: measureUtf8Bytes(serializedPackage),
      stateDigest,
      restoredDigest,
      privacyReportIncluded: true,
      providerSecretsExcluded
    },
    privacyReport,
    migrationManifest,
    checks,
    runbook: [
      "1. 从 Product API 获取 /api/state/export，并保存 JSON 文件、生成时间和 stateDigest。",
      "2. 在隔离环境调用 /api/state/import，导入同一份 JSON 包并重新生成隐私库存。",
      "3. 比较 restore-normalization、privacy-inventory 和 provider-secrets 三项，失败时禁止切换生产状态库。",
      "4. 如存在 local-object:// 引用，同步备份 CORPUS_UPLOAD_DIR 或对象存储桶，并抽样验证音频可访问。",
      "5. 完成恢复演练后，再执行 PostgreSQL JSONB、托管数据库或对象存储迁移。"
    ]
  };
}

function summarizeBackupRehearsalChecks(checks: BackupRehearsalCheck[]) {
  return checks.reduce(
    (summary, check) => ({
      ...summary,
      [check.status]: summary[check.status] + 1
    }),
    { passed: 0, warning: 0, failed: 0 } as Record<BackupRehearsalStatus, number>
  );
}

function countLocalObjectReferences(state: ProductState) {
  const podcastAudioCount = state.podcastEpisodes.filter((episode) => episode.audioUrl.startsWith("local-object://")).length;
  const importSourceCount = state.importSources.filter((source) => source.sourceUrl?.startsWith("local-object://")).length;
  return podcastAudioCount + importSourceCount;
}

function containsProviderSecretMarkers(serializedPackage: string) {
  return [
    "DASHSCOPE_API_KEY=",
    "BAILIAN_API_KEY=",
    "ANYSEARCH_API_KEY=",
    "TAVILY_API_KEY=",
    "EXA_API_KEY=",
    "BRAVE_SEARCH_API_KEY=",
    "MASTRA_RUNTIME_API_KEY="
  ].some((marker) => serializedPackage.includes(marker));
}
