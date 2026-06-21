import type { FastifyInstance } from "fastify";
import { buildBackupRestoreRehearsalReport } from "../../../../src/domain/backup";
import { buildPrivacyReport, createPurgedProductState, createScopedPurge, type PurgeScope } from "../../../../src/domain/privacy";
import { normalizeProductState } from "../../../../src/domain/storage";
import { withAuditEvent } from "../../../../src/domain/utils";
import { purgeLocalObjectArtifactsForState } from "../local-object-artifacts";
import type { ProductStateRepository } from "../product-state-repository";

interface StateRouteOptions {
  env?: Record<string, string | undefined>;
}

export async function registerStateRoutes(
  server: FastifyInstance,
  repository: ProductStateRepository,
  options: StateRouteOptions = {}
) {
  server.get("/api/state", async () => repository.getState());
  server.put("/api/state", async (request, reply) => {
    const stored = repository.getState();
    const incomingRevision = (request.body as { revision?: unknown })?.revision;
    // Require revision field to be present and exactly equal to stored.
    // Absent revision is treated as a conflict (409) to prevent zero-cost optimistic-lock bypass.
    if (typeof incomingRevision !== "number" || incomingRevision !== stored.revision) {
      return reply.code(409).send({ error: "stale revision", current: stored });
    }
    return repository.replaceState(normalizeProductState(request.body));
  });
  server.post("/api/state/reset", async () => repository.resetState());

  // P0-1: Privacy report
  server.get("/api/state/privacy-report", async () => {
    const state = repository.getState();
    return buildPrivacyReport(state);
  });

  // P0-2: Export. The rehearsal report now carries `exportPackage` (full ProductState),
  // so the downloaded JSON is genuinely restorable via POST /api/state/import below.
  server.get("/api/state/export", async () => {
    const state = repository.getState();
    return buildBackupRestoreRehearsalReport(state);
  });

  // P0-2b: Import — restore a previously exported package (or a raw ProductState).
  // Accepts { exportPackage: { state } } (full export report shape) or { state } or a
  // bare ProductState. Normalizes before replacing so schema/field drift is healed.
  server.post("/api/state/import", async (request, reply) => {
    const body = request.body as
      | { state?: unknown; exportPackage?: { state?: unknown }; confirm?: unknown }
      | undefined;
    // P0-B: import is a full-state overwrite — require an explicit confirm token so a stray /
    // CSRF POST can't silently replace all state. Accept the purge token or the import-specific
    // alias (both are spelled out in the README / governance UI).
    if (body?.confirm !== "PURGE_PERSONAL_DATA" && body?.confirm !== "REPLACE_ALL_STATE") {
      return reply.code(422).send({
        error: "Import requires explicit confirmation: send confirm=\"REPLACE_ALL_STATE\" (or \"PURGE_PERSONAL_DATA\")."
      });
    }
    const incoming = body?.exportPackage?.state ?? body?.state ?? body;
    if (!incoming || typeof incoming !== "object") {
      return reply
        .code(422)
        .send({ error: "Import payload must include a ProductState (as `state`, `exportPackage.state`, or the object itself)." });
    }
    // Import is a full-state overwrite (no revision lock by design — it's a restore). Stamp
    // an audit event so this destructive replace is recorded, like purge.
    const imported = withAuditEvent(normalizeProductState(incoming), {
      type: "state_imported",
      label: "已从备份导入并覆盖全部状态",
      detail: "用户通过 /api/state/import 用导入包整体替换了当前 ProductState。",
      severity: "warning",
      entityType: "privacy_operation",
      entityId: "local-product-state",
      createdAt: new Date().toISOString()
    });
    return repository.replaceState(imported);
  });

  // P0-3: Purge — clears personal data from the state store AND deletes the referenced
  // local-object audio files on disk (previously the files were left behind while the
  // audit claimed a complete wipe). artifactPurge accounts for deleted/missing/skipped.
  server.post("/api/state/purge", async (request, reply) => {
    // P0-B: purge is irreversible (clears personal data + deletes local audio files). Require
    // the explicit confirm token from README:186 so a stray / CSRF POST can't wipe everything.
    const body = request.body as { confirm?: unknown; scope?: unknown } | undefined;
    if (body?.confirm !== "PURGE_PERSONAL_DATA") {
      return reply.code(422).send({
        error: "Purge requires explicit confirmation: send confirm=\"PURGE_PERSONAL_DATA\"."
      });
    }
    // Scope selects WHICH personal data to delete. Absent → "all" (the historical full wipe).
    // An out-of-enum scope is a client error, not a silent full wipe — reject before deleting.
    const VALID_SCOPES: PurgeScope[] = ["all", "profile", "interviews", "assets"];
    const scope: PurgeScope = body?.scope === undefined ? "all" : (body.scope as PurgeScope);
    if (!VALID_SCOPES.includes(scope)) {
      return reply.code(422).send({
        error: `Unsupported purge scope. Use one of: ${VALID_SCOPES.join(", ")}.`
      });
    }

    const state = repository.getState();

    // Partial scopes don't touch on-disk audio (only interviews carry artifacts, and the
    // historical artifact-deletion behavior is tied to the full wipe). Keep full-wipe behavior
    // byte-for-byte (single audit event + artifact deletion) so existing restores/tests hold.
    if (scope === "all") {
      const { deletedCount } = createScopedPurge(state, "all");
      const artifactPurge = purgeLocalObjectArtifactsForState(state, { env: options.env });
      let purged = createPurgedProductState(state);
      if (artifactPurge.referenceCount > 0) {
        purged = withAuditEvent(purged, {
          type: "privacy_data_purged",
          label: "本地音频原件已删除",
          detail: `artifactPurge：删除 ${artifactPurge.deleted}、缺失 ${artifactPurge.missing}、跳过 ${artifactPurge.skipped}（共 ${artifactPurge.uniqueFileCount} 个文件）。`,
          severity: "warning",
          entityType: "privacy_operation",
          entityId: "local-object-artifacts",
          createdAt: new Date().toISOString()
        });
      }
      const nextState = repository.replaceState(purged);
      return { ...nextState, artifactPurge, deletedScope: "all" as PurgeScope, deletedCount };
    }

    const { nextState: scopedState, deletedScope, deletedCount } = createScopedPurge(state, scope);
    const nextState = repository.replaceState(scopedState);
    return { ...nextState, deletedScope, deletedCount };
  });
}
