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
import type { BailianEmbeddingClient } from "../providers/bailian";
import { createLlmBudget, type LlmBudget } from "../llm-budget";
import { rebuildKnowledgeIndex } from "./knowledge";

// 审计修复(P1-8):import 恢复通道的独立体限(默认全局 28MB 会让大备份"导出成功、恢复 413")。
const IMPORT_BODY_LIMIT_BYTES = 64 * 1024 * 1024;

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
  /** 审计修复 B2:import 恢复/assets purge 后全量重建知识索引所需(缺省则跳过重建,仅清空)。 */
  embeddingClient?: BailianEmbeddingClient;
  llmBudget?: LlmBudget;
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
  server.post("/api/state/reset", async () => {
    const next = repository.resetState();
    // 审计修复(P1-1):reset 此前只清热态,冷层逐字稿/录音/派生知识索引全部残留——
    // 实测 25/26 份冷层材料为跨 reset 孤儿,且 chat 继续召回"已清空"的私人内容。
    // 与 purge 对齐:重置即三库同清(索引是派生可重建的,清空即语义正确的空索引)。
    // 回归审查 R4-2:每库独立 try/catch 尽力清——某库 deleteAll 抛错(sqlite IO 故障)不该跳过
    // 后续库(尤其知识索引残留=可召回私人数据泄漏);逐库告警,不让一处失败掩盖其余未清。
    for (const [name, repo] of [
      ["raw-material", rawMaterialRepository],
      ["audio", audioRepository],
      ["knowledge-index", knowledgeIndexRepository]
    ] as const) {
      try {
        repo?.deleteAll();
      } catch (err) {
        console.warn(JSON.stringify({ event: "reset_cold_layer_clear_failed", store: name, error: err instanceof Error ? err.message : String(err) }));
      }
    }
    return next;
  });

  // P0-1: Privacy report
  server.get("/api/state/privacy-report", async () => {
    const state = repository.getState();
    return buildPrivacyReport(state);
  });

  // P0-2: Export. The rehearsal report now carries `exportPackage` (full ProductState),
  // so the downloaded JSON is genuinely restorable via POST /api/state/import below.
  server.get("/api/state/export", async (_request, reply) => {
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
    const bundle = { ...report, rawMaterials, audioSessions, audios, audioOmittedSessions };
    // 审计修复(P1-8 对偶):导出侧如实预警包体积与导入体限的兼容性——"备份成功恢复失败"
    // 必须在备份时就可见,而不是恢复时才 413。
    // 回归审查 R4-5:大对象只序列化一次。此前 JSON.stringify(bundle) 算字节 + return 对象让 Fastify
    // 再序列化整包一次 → 导出包(可达 ~28MB,含音频 base64)双序列化=瞬时内存峰值翻倍。改为手动序列化
    // bundle 一次、复用该字符串,只额外序列化极小的 importCompatibility 尾并拼接(bundle 由对象字面量
    // 构成,其 JSON 必以 } 结尾,slice(0,-1) 去尾后拼入兼容性字段安全)。
    const bundleStr = JSON.stringify(bundle);
    const bundleBytes = Buffer.byteLength(bundleStr);
    const compatStr = JSON.stringify({
      bytes: bundleBytes,
      importBodyLimitBytes: IMPORT_BODY_LIMIT_BYTES,
      exceedsImportLimit: bundleBytes > IMPORT_BODY_LIMIT_BYTES
    });
    return reply
      .type("application/json")
      .send(`${bundleStr.slice(0, -1)},"importCompatibility":${compatStr}}`);
  });

  // P0-2b: Import — restore a previously exported package (or a raw ProductState).
  // Accepts { exportPackage: { state } } (full export report shape) or { state } or a
  // bare ProductState. Normalizes before replacing so schema/field drift is healed.
  // 审计修复(P1-8):导出包(state+冷层+音频)可超默认 28MB 体限致"备份成功、恢复 413"。
  // import 是恢复通道,单独放宽到 64MB;导出侧同步给出兼容性预警(见 export)。
  server.post("/api/state/import", { bodyLimit: IMPORT_BODY_LIMIT_BYTES }, async (request, reply) => {
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
    // 回归审查 R4-3:跳过包装层增量重索引——下方 rebuildKnowledgeIndex 全量重建(含冷层逐字稿),
    // 增量与全量并跑是重复嵌入(浪费预算)。由显式 rebuild 负责索引一致性。
    const replaced = repository.replaceState(imported, { skipReindex: true });
    // 审计修复(P2-15 + 回归审查 R4-1):import 语义是"整体替换",热态 overwrite 而冷层此前是 upsert
    // 合并——上一世代逐字稿/录音会残留并随下次导出打进"新备份"。改为先清后恢复,三库口径一致。
    // ⚠️ R4-1 数据丢失窗口根治:此前"先 deleteAll 后逐条 put",若某 put 中途抛错(畸形/异构/截断包
    // 缺 turns/createdAt,node:sqlite 会抛)→旧冷层已清空且未恢复=比不清更糟,且 audio.deleteAll 先于
    // raw 恢复→raw 抛错则音频整体丢失。改为【先全量构建+校验合法条目,全部通过才 deleteAll+put】
    // (build-then-swap):任一条目非法直接 422 拒,绝不在清空后才发现坏数据。
    // legacy 包(无 rawMaterials/audios 字段)保持旧的纯热态导入行为(不清不恢复)。
    let restoredRawMaterials: InterviewRawMaterial[] | undefined;
    if (rawMaterialRepository && Array.isArray(body?.rawMaterials)) {
      const built: InterviewRawMaterial[] = [];
      for (const material of body.rawMaterials as InterviewRawMaterial[]) {
        // 校验能安全 put 的形状:sessionId + turns(数组) + createdAt(string)——node:sqlite 对
        // undefined/null 的 turns/createdAt 会抛,必须在 deleteAll 前挡住。
        if (
          !material ||
          typeof material.sessionId !== "string" ||
          !Array.isArray(material.turns) ||
          typeof material.createdAt !== "string"
        ) {
          return reply.code(422).send({ error: "Import rawMaterials 含非法条目(需 sessionId/turns/createdAt),已拒绝以保护现有冷层数据。" });
        }
        built.push(material);
      }
      restoredRawMaterials = built;
    }

    let restoredAudios: InterviewAudio[] | undefined;
    if (audioRepository && Array.isArray(body?.audios)) {
      const built: InterviewAudio[] = [];
      for (const entry of body.audios as Array<{
        sessionId?: unknown; role?: unknown; audioBase64?: unknown; mime?: unknown; durationMs?: unknown; recordingStartedAt?: unknown;
      }>) {
        // 跳过明显不完整的音频条目(与旧行为一致——音频缺失不阻断,但已校验的才恢复)。
        if (!entry || typeof entry.sessionId !== "string" || typeof entry.audioBase64 !== "string" || typeof entry.mime !== "string") {
          continue;
        }
        const audio = new Uint8Array(Buffer.from(entry.audioBase64, "base64"));
        const role: InterviewAudio["role"] = entry.role === "interviewer" ? "interviewer" : "interviewee";
        const restored: InterviewAudio = { sessionId: entry.sessionId, role, audio, mime: entry.mime, byteSize: audio.byteLength, createdAt: new Date().toISOString() };
        if (typeof entry.durationMs === "number") restored.durationMs = entry.durationMs;
        if (typeof entry.recordingStartedAt === "string") restored.recordingStartedAt = entry.recordingStartedAt;
        built.push(restored);
      }
      restoredAudios = built;
    }

    // 全部条目已校验/构建完毕(上面任何非法都已 422 返回),现在才动既有冷层——clear+put 无中途失败风险。
    if (restoredRawMaterials) {
      rawMaterialRepository!.deleteAll();
      for (const material of restoredRawMaterials) rawMaterialRepository!.put(material);
    }
    if (restoredAudios) {
      audioRepository!.deleteAll();
      for (const restored of restoredAudios) audioRepository!.put(restored);
    }
    // 审计修复(P3-39):恢复后自动重建知识索引——material/transcript 块此前只在 import 端点/
    // /end 补点,备份恢复路径两者都不经过 → 恢复后资料明明在、chat/召回却查无此块。
    // 同步清空+关键词重建立即生效,嵌入后台补;失败仅 warn 不影响恢复本身。
    if (knowledgeIndexRepository) {
      try {
        rebuildKnowledgeIndex(replaced, {
          knowledgeRepo: knowledgeIndexRepository,
          ...(rawMaterialRepository ? { rawMaterialRepo: rawMaterialRepository } : {}),
          ...(options.embeddingClient ? { embeddingClient: options.embeddingClient } : {}),
          budget: options.llmBudget ?? createLlmBudget()
        });
      } catch (err) {
        console.warn(JSON.stringify({ event: "import_knowledge_rebuild_failed", error: err instanceof Error ? err.message : String(err) }));
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
      // 回归审查 R4-3:跳过增量重索引——下方 knowledgeIndexRepository.deleteAll() 直接清空整个索引,
      // 包装层的增量重索引纯属白做(且与 deleteAll 竞态,靠 R8-1 epoch 守卫才不残留)。
      const nextState = repository.replaceState(purged, { skipReindex: true });
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
    // 审计修复(P3-38):assets 档的知识索引清理此前只靠异步增量 diff(失败/进程退出即永久残留
    // 已清资产的可召回块)。与 all/interviews 对齐:同步全量重建(存活的会话/素材块随重建回来)。
    if (scope === "assets" && knowledgeIndexRepository) {
      try {
        rebuildKnowledgeIndex(nextState, {
          knowledgeRepo: knowledgeIndexRepository,
          ...(rawMaterialRepository ? { rawMaterialRepo: rawMaterialRepository } : {}),
          ...(options.embeddingClient ? { embeddingClient: options.embeddingClient } : {}),
          budget: options.llmBudget ?? createLlmBudget()
        });
      } catch (err) {
        console.warn(JSON.stringify({ event: "purge_knowledge_rebuild_failed", error: err instanceof Error ? err.message : String(err) }));
      }
    }
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
