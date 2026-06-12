import { buildProductStateMigrationManifest, type ProductStateMigrationManifest } from "./migration";
import { buildStableDigest, measureUtf8Bytes, stableStringify } from "./stateDigest";
import { normalizeProductState } from "./storage";
import type { ProductState } from "./types";

export type PostgresMigrationCheckStatus = "ready" | "warning" | "blocked";

export interface PostgresMigrationCheck {
  id: string;
  label: string;
  status: PostgresMigrationCheckStatus;
  detail: string;
  recommendation: string;
}

export interface PostgresJsonbMigrationPackage {
  schemaVersion: 1;
  generatedAt: string;
  target: "postgres-jsonb-first";
  sourceFormat: "product-state-json";
  snapshotId: string;
  stateDigest: string;
  stateBytes: number;
  providerSecretsExcluded: boolean;
  migrationManifest: ProductStateMigrationManifest;
  checks: PostgresMigrationCheck[];
  sql: {
    schema: string;
    insertSnapshot: string;
    verify: string;
    transaction: string;
  };
  runbook: string[];
}

export function buildPostgresJsonbMigrationPackage(
  state: ProductState,
  generatedAt = new Date().toISOString()
): PostgresJsonbMigrationPackage {
  const normalizedState = normalizeProductState(state);
  const stateJson = stableStringify(normalizedState);
  const stateDigest = buildStableDigest(normalizedState);
  const snapshotId = `snapshot-${generatedAt.replace(/[^0-9]/g, "").slice(0, 14) || "manual"}`;
  const providerSecretsExcluded = !containsProviderSecretMarkers(stateJson);
  const manifest = buildProductStateMigrationManifest(normalizedState, generatedAt);
  const schemaSql = buildPostgresSchemaSql();
  const insertSql = buildPostgresInsertSql(snapshotId, stateJson, generatedAt);
  const verifySql = buildPostgresVerifySql(snapshotId);
  const transaction = ["begin;", schemaSql, insertSql, verifySql, "commit;"].join("\n\n");
  const checks = buildPostgresMigrationChecks(manifest, providerSecretsExcluded, stateJson);

  return {
    schemaVersion: 1,
    generatedAt,
    target: "postgres-jsonb-first",
    sourceFormat: "product-state-json",
    snapshotId,
    stateDigest,
    stateBytes: measureUtf8Bytes(stateJson),
    providerSecretsExcluded,
    migrationManifest: manifest,
    checks,
    sql: {
      schema: schemaSql,
      insertSnapshot: insertSql,
      verify: verifySql,
      transaction
    },
    runbook: [
      "1. 在目标 PostgreSQL 库先执行 sql.schema，创建 JSONB snapshot/event 表和更新时间触发器。",
      "2. 在维护窗口执行 sql.insertSnapshot，把规范化 ProductState 写入 snapshot，并追加 replace event。",
      "3. 执行 sql.verify，确认 profile、systemConfig、notes 三个顶层结构存在，摘要和状态体积符合迁移包记录。",
      "4. 如迁移清单存在 local-object:// 风险，同步迁移 CORPUS_UPLOAD_DIR 或对象存储原件。",
      "5. 应用切换后保留 SQLite/JSON 导出包，直到 PostgreSQL 恢复演练通过。"
    ]
  };
}

function buildPostgresMigrationChecks(
  manifest: ProductStateMigrationManifest,
  providerSecretsExcluded: boolean,
  stateJson: string
): PostgresMigrationCheck[] {
  const migrationWarnings = manifest.checks.filter((check) => check.status === "warning").length;
  const migrationBlocks = manifest.checks.filter((check) => check.status === "blocked").length;

  return [
    {
      id: "jsonb-schema",
      label: "JSONB 首阶段表结构",
      status: "ready",
      detail: "迁移包包含 product_state_snapshots 和 product_state_events 两张 JSONB 表的建表 SQL。",
      recommendation: "第一阶段保留 ProductState 聚合 JSON，稳定后再按高频查询拆分关系表。"
    },
    {
      id: "state-payload",
      label: "状态载荷",
      status: stateJson.length > 0 ? "ready" : "blocked",
      detail: `规范化状态载荷约 ${measureUtf8Bytes(stateJson)} bytes。`,
      recommendation: "执行迁移前先保存同一份 JSON 导出包，作为回滚输入。"
    },
    {
      id: "provider-secrets",
      label: "Provider 密钥隔离",
      status: providerSecretsExcluded ? "ready" : "blocked",
      detail: providerSecretsExcluded ? "迁移 SQL 没有发现 provider secret 标记。" : "迁移 SQL 疑似包含 provider secret 标记。",
      recommendation: "密钥必须留在部署环境或系统配置页，不进入 PostgreSQL 业务状态。"
    },
    {
      id: "migration-manifest",
      label: "迁移清单复核",
      status: migrationBlocks > 0 ? "blocked" : migrationWarnings > 0 ? "warning" : "ready",
      detail:
        migrationBlocks > 0
          ? `迁移清单存在 ${migrationBlocks} 个阻塞项。`
          : migrationWarnings > 0
            ? `迁移清单存在 ${migrationWarnings} 个风险项。`
            : "迁移清单没有风险或阻塞项。",
      recommendation: "风险项不一定阻止 dry-run，但生产切换前必须逐项确认。"
    }
  ];
}

function buildPostgresSchemaSql() {
  return [
    "create table if not exists product_state_snapshots (",
    "  id text primary key,",
    "  state_json jsonb not null,",
    "  created_at timestamptz not null default now(),",
    "  updated_at timestamptz not null default now()",
    ");",
    "",
    "create table if not exists product_state_events (",
    "  id bigserial primary key,",
    "  event_type text not null check (event_type in ('seed', 'replace', 'reset')),",
    "  state_json jsonb not null,",
    "  created_at timestamptz not null default now()",
    ");",
    "",
    "create index if not exists product_state_events_created_at_idx",
    "  on product_state_events (created_at desc);",
    "",
    "create or replace function set_product_state_snapshot_updated_at()",
    "returns trigger as $$",
    "begin",
    "  new.updated_at = now();",
    "  return new;",
    "end;",
    "$$ language plpgsql;",
    "",
    "drop trigger if exists product_state_snapshots_set_updated_at on product_state_snapshots;",
    "create trigger product_state_snapshots_set_updated_at",
    "before update on product_state_snapshots",
    "for each row execute function set_product_state_snapshot_updated_at();"
  ].join("\n");
}

function buildPostgresInsertSql(snapshotId: string, stateJson: string, generatedAt: string) {
  const stateLiteral = toPostgresDollarLiteral(stateJson, "product_state_json");
  const generatedAtLiteral = toSqlString(generatedAt);
  return [
    "insert into product_state_snapshots (id, state_json, created_at, updated_at)",
    `values (${toSqlString(snapshotId)}, ${stateLiteral}::jsonb, ${generatedAtLiteral}::timestamptz, ${generatedAtLiteral}::timestamptz)`,
    "on conflict (id) do update set",
    "  state_json = excluded.state_json,",
    "  updated_at = excluded.updated_at;",
    "",
    "insert into product_state_events (event_type, state_json, created_at)",
    `values ('replace', ${stateLiteral}::jsonb, ${generatedAtLiteral}::timestamptz);`
  ].join("\n");
}

function buildPostgresVerifySql(snapshotId: string) {
  return [
    "select",
    "  id,",
    "  octet_length(state_json::text) as state_bytes,",
    "  state_json ? 'profile' as has_profile,",
    "  state_json ? 'systemConfig' as has_system_config,",
    "  state_json ? 'notes' as has_notes",
    "from product_state_snapshots",
    `where id = ${toSqlString(snapshotId)};`
  ].join("\n");
}

function toPostgresDollarLiteral(value: string, baseTag: string) {
  let tag = baseTag.replace(/[^A-Za-z0-9_]/g, "_") || "json";
  while (value.includes(`$${tag}$`)) {
    tag = `${tag}_x`;
  }
  return `$${tag}$${value}$${tag}$`;
}

function toSqlString(value: string) {
  return `'${value.replace(/'/g, "''")}'`;
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
