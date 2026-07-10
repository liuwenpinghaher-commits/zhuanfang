import { buildProductStateMigrationManifest, type ProductStateMigrationManifest } from "./migration";
import { buildPrivacyReport, type PrivacyReport } from "./privacy";
import { buildStableDigest, measureUtf8Bytes, stableStringify } from "./stateDigest";
import { normalizeProductState } from "./storage";
import type { InterviewAudioRole, InterviewRawMaterial, ProductState } from "./types";

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
  /**
   * The actual recoverable package (full ProductState). Previously this report only
   * carried the *summary* (bytes/digest), so a downloaded export wasn't restorable and
   * the matching /api/state/import had nothing to ingest. Now it's included so the
   * export → import round-trip is real.
   */
  exportPackage: ProductStateExportPackage;
  privacyReport: PrivacyReport;
  migrationManifest: ProductStateMigrationManifest;
  checks: BackupRehearsalCheck[];
  runbook: string[];
}

export interface ProductStateExportPackage {
  schemaVersion: 1;
  exportedAt: string;
  product: "interview-product-mvp";
  privacyReport: PrivacyReport;
  state: ProductState;
}

export interface StateExportAudioEntry {
  sessionId: string;
  role: InterviewAudioRole;
  mime: string;
  durationMs?: number;
  recordingStartedAt?: string;
  audioBase64: string;
}

export interface StateImportCompatibility {
  /** 最终 JSON 响应的 UTF-8 字节数。 */
  bytes: number;
  importBodyLimitBytes: number;
  exceedsImportLimit: boolean;
}

export type StateExportCompletenessStatus = "complete" | "partial" | "not-directly-importable";

export interface StateExportCompleteness {
  status: StateExportCompletenessStatus;
  complete: boolean;
  directlyImportable: boolean;
  reasons: string[];
  audioSessions: number;
  includedAudioSessions: number;
  omittedAudioSessions: number;
  failedChecks: number;
  externalArtifactWarnings: number;
}

/** Product API `/api/state/export` 的真实响应，而非仅含热态的演练报告窄类型。 */
export interface StateExportBundle extends BackupRestoreRehearsalReport {
  rawMaterials: InterviewRawMaterial[];
  /** 所有拥有录音的 session，包含因导出预算而未打包音频字节的 session。 */
  audioSessions: string[];
  audios: StateExportAudioEntry[];
  audioOmittedSessions: string[];
  /** 除 bundleDigest / importCompatibility / completeness 外主体的稳定摘要。 */
  bundleDigest: string;
  importCompatibility: StateImportCompatibility;
  completeness: StateExportCompleteness;
}

export function assessStateExportCompleteness(input: {
  audioSessions: string[];
  audios: Array<{ sessionId: string }>;
  audioOmittedSessions: string[];
  importCompatibility: StateImportCompatibility;
  checks?: BackupRehearsalCheck[];
}): StateExportCompleteness {
  const declaredAudioIds = new Set(input.audioSessions);
  const includedAudioIds = new Set(input.audios.map((audio) => audio.sessionId));
  const explicitlyOmittedIds = new Set(input.audioOmittedSessions);
  const unaccountedAudioIds = [...declaredAudioIds].filter(
    (id) => !includedAudioIds.has(id) && !explicitlyOmittedIds.has(id)
  );
  const omittedAudioIds = new Set([...explicitlyOmittedIds, ...unaccountedAudioIds]);
  const audioSessions = declaredAudioIds.size;
  const includedAudioSessions = includedAudioIds.size;
  const omittedAudioSessions = omittedAudioIds.size;
  const checks = input.checks ?? [];
  const failed = checks.filter((check) => check.status === "failed");
  const externalArtifactWarnings = checks.filter(
    (check) => check.id === "local-object-artifacts" && check.status !== "passed"
  );
  const reasons: string[] = [];
  if (explicitlyOmittedIds.size > 0) {
    reasons.push(`有 ${explicitlyOmittedIds.size} 段录音因导出预算未写入 JSON 包。`);
  }
  if (unaccountedAudioIds.length > 0) {
    reasons.push(`有 ${unaccountedAudioIds.length} 个录音会话已声明但音频未打包、也未记录省略原因。`);
  }
  if (input.importCompatibility.exceedsImportLimit) {
    reasons.push(
      `包体 ${input.importCompatibility.bytes} bytes 超过直接导入上限 ${input.importCompatibility.importBodyLimitBytes} bytes。`
    );
  }
  for (const check of externalArtifactWarnings) {
    reasons.push(`${check.label}：${check.detail}`);
  }
  for (const check of failed) {
    reasons.push(`备份演练失败（${check.label}）：${check.detail}`);
  }
  const status: StateExportCompletenessStatus = input.importCompatibility.exceedsImportLimit || failed.length > 0
    ? "not-directly-importable"
    : omittedAudioSessions > 0 || externalArtifactWarnings.length > 0
      ? "partial"
      : "complete";
  return {
    status,
    complete: status === "complete",
    // C2#3:与 status 同源推导。此前 directlyImportable 只看 exceedsImportLimit——演练 check
    // failed 时 status 已是 not-directly-importable,boolean 却仍 true,两字段互相矛盾,
    // 消费方信哪个全凭运气。凡 status 判定"不可直接导入",boolean 必须一致为 false。
    directlyImportable: status !== "not-directly-importable",
    reasons,
    audioSessions,
    includedAudioSessions,
    omittedAudioSessions,
    failedChecks: failed.length,
    externalArtifactWarnings: externalArtifactWarnings.length
  };
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
    exportPackage,
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
