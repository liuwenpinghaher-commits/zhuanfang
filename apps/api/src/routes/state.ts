import type { FastifyInstance } from "fastify";
import { buildBackupRestoreRehearsalReport } from "../../../../src/domain/backup";
import { buildPrivacyReport, createPurgedProductState, createScopedPurge, type PurgeScope } from "../../../../src/domain/privacy";
import { normalizeProductState } from "../../../../src/domain/storage";
import { withAuditEvent } from "../../../../src/domain/utils";
import { purgeLocalObjectArtifactsForState } from "../local-object-artifacts";
import type { ProductStateRepository } from "../product-state-repository";
import type { RawMaterialRepository } from "../raw-material-repository";
import type { AudioRepository } from "../audio-repository";
import type { KnowledgeIndexRepository } from "../knowledge-index-repository";
import type { InterviewAudio, InterviewRawMaterial } from "../../../../src/domain/types";

interface StateRouteOptions {
  env?: Record<string, string | undefined>;
  /**
   * Cold-layer raw-material store. Export bundles it into the package (`rawMaterials`),
   * import restores it, and a full purge wipes it — so the privacy loop covers the cold
   * layer, not just hot ProductState. Optional so existing call sites without a repo keep
   * working (export simply omits `rawMaterials`, purge skips the cold wipe).
   */
  rawMaterialRepository?: RawMaterialRepository;
  /**
   * Hot-layer audio store (recorded interview blobs). Export records which sessions have
   * audio (`audioSessions`), and a full/interviews purge wipes it — so the privacy loop
   * also covers recorded audio, not just transcripts. Optional so call sites without a
   * repo keep working (export emits `[]`, purge skips the audio wipe).
   */
  audioRepository?: AudioRepository;
  /**
   * Derived knowledge index (search/recall chunks built from interviews + materials). It's
   *派生、可重建 data, so a full/interviews purge wipes it too — otherwise indexed personal
   * text survives the "complete" purge. Optional so call sites without a repo keep working
   * (purge skips the index wipe). Same governance pattern as raw-material/audio (Task 12).
   */
  knowledgeIndexRepository?: KnowledgeIndexRepository;
}

export async function registerStateRoutes(
  server: FastifyInstance,
  repository: ProductStateRepository,
  options: StateRouteOptions = {}
) {
  const rawMaterialRepository = options.rawMaterialRepository;
  const audioRepository = options.audioRepository;
  const knowledgeIndexRepository = options.knowledgeIndexRepository;
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
    const report = buildBackupRestoreRehearsalReport(state);
    // Cold-layer raw material lives outside ProductState (its own SQLite store), so the
    // hot-state rehearsal report doesn't see it. Bundle it here so a downloaded export is a
    // complete backup and the matching import below can restore the cold layer too.
    const rawMaterials: InterviewRawMaterial[] = rawMaterialRepository?.list() ?? [];
    // Audio blobs are large; `audioSessions` records *which* sessions have audio (the full
    // set, by ID), so an operator can see the recorded-audio footprint and reconcile a purge.
    const audioSessions: string[] = audioRepository?.listSessionIds() ?? [];
    // Bundle the actual bytes (base64) so the export is restorable — but cap the total to stay
    // under the request body limit (28MB). We walk sessions in a stable order (createdAt asc,
    // matching the repo's listAll ordering) and accumulate base64 length; once a session would
    // push the running total over the budget it (and any later one) is omitted and recorded in
    // `audioOmittedSessions` instead, so a complete restore is still possible via re-export/sync.
    const AUDIO_EXPORT_BUDGET_BYTES = 18 * 1024 * 1024;
    const audios: Array<{
      sessionId: string;
      role: InterviewAudio["role"];
      mime: string;
      durationMs?: number;
      recordingStartedAt?: string;
      audioBase64: string;
    }> = [];
    const audioOmittedSessions: string[] = [];
    let audioBudgetUsed = 0;
    const allAudio = (audioRepository?.listAll() ?? []).slice().sort((a, b) =>
      a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0
    );
    for (const a of allAudio) {
      const audioBase64 = Buffer.from(a.audio).toString("base64");
      if (audioBudgetUsed + audioBase64.length > AUDIO_EXPORT_BUDGET_BYTES) {
        audioOmittedSessions.push(a.sessionId);
        continue;
      }
      audioBudgetUsed += audioBase64.length;
      const entry: {
        sessionId: string;
        role: InterviewAudio["role"];
        mime: string;
        durationMs?: number;
        recordingStartedAt?: string;
        audioBase64: string;
      } = { sessionId: a.sessionId, role: a.role, mime: a.mime, audioBase64 };
      if (a.durationMs !== undefined) {
        entry.durationMs = a.durationMs;
      }
      if (a.recordingStartedAt !== undefined) {
        entry.recordingStartedAt = a.recordingStartedAt;
      }
      audios.push(entry);
    }
    return { ...report, rawMaterials, audioSessions, audios, audioOmittedSessions };
  });

  // P0-2b: Import — restore a previously exported package (or a raw ProductState).
  // Accepts { exportPackage: { state } } (full export report shape) or { state } or a
  // bare ProductState. Normalizes before replacing so schema/field drift is healed.
  server.post("/api/state/import", async (request, reply) => {
    const body = request.body as
      | {
          state?: unknown;
          exportPackage?: { state?: unknown };
          confirm?: unknown;
          rawMaterials?: unknown;
          audios?: unknown;
        }
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
    const replaced = repository.replaceState(imported);
    // Restore the cold layer from the export bundle (Task 13). Each entry is upserted by
    // sessionId, so re-importing the same package is idempotent. Done after the hot-state
    // overwrite so a partial/legacy package without `rawMaterials` still imports cleanly.
    if (rawMaterialRepository && Array.isArray(body?.rawMaterials)) {
      for (const material of body.rawMaterials as InterviewRawMaterial[]) {
        if (material && typeof material.sessionId === "string") {
          rawMaterialRepository.put(material);
        }
      }
    }
    // Restore recorded audio bytes (base64) from the export bundle. Same defensive style as
    // rawMaterials: validate each entry, decode base64 to exact bytes, upsert by sessionId
    // (idempotent re-import). A legacy package without `audios` simply skips this.
    if (audioRepository && Array.isArray(body?.audios)) {
      for (const entry of body.audios as Array<{
        sessionId?: unknown;
        role?: unknown;
        audioBase64?: unknown;
        mime?: unknown;
        durationMs?: unknown;
        recordingStartedAt?: unknown;
      }>) {
        if (
          entry &&
          typeof entry.sessionId === "string" &&
          typeof entry.audioBase64 === "string" &&
          typeof entry.mime === "string"
        ) {
          const audio = new Uint8Array(Buffer.from(entry.audioBase64, "base64"));
          // role 缺省/非法 → interviewee（向后兼容旧的无 role 导出包）。
          const role: InterviewAudio["role"] = entry.role === "interviewer" ? "interviewer" : "interviewee";
          const restored: InterviewAudio = {
            sessionId: entry.sessionId,
            role,
            audio,
            mime: entry.mime,
            byteSize: audio.byteLength,
            createdAt: new Date().toISOString()
          };
          if (typeof entry.durationMs === "number") {
            restored.durationMs = entry.durationMs;
          }
          if (typeof entry.recordingStartedAt === "string") {
            restored.recordingStartedAt = entry.recordingStartedAt;
          }
          audioRepository.put(restored);
        }
      }
    }
    return replaced;
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
      // Cold layer (raw-material store) holds the verbatim interview transcripts. A full wipe
      // must clear it too, otherwise the original Q&A survives the "complete" purge (Task 13).
      rawMaterialRepository?.deleteAll();
      // Recorded audio is keyed by sessionId; a full wipe must clear it too, otherwise the
      // original voice survives the "complete" purge (Task 4).
      audioRepository?.deleteAll();
      // The knowledge index is derived (search/recall chunks built from the above). It's
      // rebuildable, so a full wipe clears it too — otherwise indexed personal text survives
      // the "complete" purge (Task 12).
      knowledgeIndexRepository?.deleteAll();
      return { ...nextState, artifactPurge, deletedScope: "all" as PurgeScope, deletedCount };
    }

    const { nextState: scopedState, deletedScope, deletedCount } = createScopedPurge(state, scope);
    const nextState = repository.replaceState(scopedState);
    // The interviews scope clears all sessions from hot state; their cold-layer raw materials
    // are keyed by sessionId and would otherwise be orphaned, so wipe the cold layer too.
    if (scope === "interviews") {
      rawMaterialRepository?.deleteAll();
      // Recorded audio is keyed by sessionId; clearing all sessions orphans it, so wipe it too.
      audioRepository?.deleteAll();
      // The derived knowledge index is built from those sessions/materials; clearing all
      // sessions orphans it, so wipe the whole rebuildable index too (Task 12).
      knowledgeIndexRepository?.deleteAll();
    }
    return { ...nextState, deletedScope, deletedCount };
  });
}
