import { replaceStateDurable } from "../product-state-repository";
import type { FastifyInstance } from "fastify";
import { assessStateExportCompleteness, buildBackupRestoreRehearsalReport } from "../../../../src/domain/backup";
import { fnv1aDigest } from "../../../../src/domain/stateDigest";
import { buildPrivacyReport, createPurgedProductState, createScopedPurge, type PurgeScope } from "../../../../src/domain/privacy";
import { normalizeProductState } from "../../../../src/domain/storage";
import { withAuditEvent } from "../../../../src/domain/utils";
import { purgeLocalObjectArtifactsForState } from "../local-object-artifacts";
import { asGovernanceTx, type GovernanceColdSpec } from "../governance/governance-tx-capability";
import type { ProductStateRepository } from "../product-state-repository";
import type { RawMaterialRepository } from "../raw-material-repository";
import type { AudioRepository } from "../audio-repository";
import type { KnowledgeIndexRepository } from "../knowledge-index-repository";
import type { InterviewAudio, InterviewRawMaterial, ProductState } from "../../../../src/domain/types";
import type { BailianEmbeddingClient } from "../providers/bailian";
import { createLlmBudget, type LlmBudget } from "../llm-budget";
import { rebuildKnowledgeIndex } from "./knowledge";

// 审计修复(P1-8):import 恢复通道的独立体限(默认全局 28MB 会让大备份"导出成功、恢复 413")。
const IMPORT_BODY_LIMIT_BYTES = 64 * 1024 * 1024;

/**
 * N-11:治理路由 500 错误详情门控。SurrealDB coerce/ASSERT 报文形如 `Found '<实际字段值>' for field…`
 * ——可能夹带用户数据值片段。治理事务(reset/purge/import)失败时,原始 message 绝不能直透客户端
 * (与 server.ts 全局 handler 对内部 5xx 只回 generic body 的承诺一致;细节始终留服务端 console)。
 * 照 health.ts:56-60 同款门控:非生产回 detail 便于调试,生产只回 generic 中文 error。
 * 完整 message 由各调用点自行 console.error(已有),此处只决定"是否附 detail 给客户端"。
 */
const governanceErrorDetail = (message: string): { detail: string } | Record<string, never> =>
  (process.env.DEPLOYMENT_PROFILE ?? "").trim().toLowerCase() !== "production" ? { detail: message } : {};

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

  // ═══ R2b · 治理事务(真 ACID)共用小工具 ══════════════════════════════════════════════
  // "清空三冷层"的治理冷层规格 + 成功回执 stores(与既有 best-effort 三态口径一致:配置了的库标
  // cleared、未注入的标 not-configured)。治理事务只对已注入的冷层库发 wipe——surreal 档三库恒注入,
  // 但仍按 presence 构建,保持契约与回落路径逐字一致。
  const buildWipeColdSpec = (): { cold: GovernanceColdSpec; stores: Record<string, string> } => {
    const cold: GovernanceColdSpec = {};
    const stores: Record<string, string> = {};
    if (rawMaterialRepository) { cold.rawMaterial = { action: "wipe" }; stores["raw-material"] = "cleared"; } else stores["raw-material"] = "not-configured";
    if (audioRepository) { cold.audio = { action: "wipe" }; stores["audio"] = "cleared"; } else stores["audio"] = "not-configured";
    if (knowledgeIndexRepository) { cold.knowledgeIndex = { action: "wipe" }; stores["knowledge-index"] = "cleared"; } else stores["knowledge-index"] = "not-configured";
    return { cold, stores };
  };
  // 整体回滚回执的 stores:配置了的库标 rolled-back(而非 cleared/failed),未注入标 not-configured。
  const rolledBackStores = (): Record<string, string> => ({
    "raw-material": rawMaterialRepository ? "rolled-back" : "not-configured",
    audio: audioRepository ? "rolled-back" : "not-configured",
    "knowledge-index": knowledgeIndexRepository ? "rolled-back" : "not-configured",
  });

  server.get("/api/state", async () => repository.getState());
  server.put("/api/state", async (request, reply) => {
    const stored = repository.getState();
    const incomingRevision = (request.body as { revision?: unknown })?.revision;
    // Require revision field to be present and exactly equal to stored.
    // Absent revision is treated as a conflict (409) to prevent zero-cost optimistic-lock bypass.
    if (typeof incomingRevision !== "number" || incomingRevision !== stored.revision) {
      return reply.code(409).send({ error: "stale revision", current: stored });
    }
    // A-19:PUT 是外部畸形数据的主要入口——clamp 若需要改写(非法枚举/坏日期/坏向量等),
    // 如实 422 列明细拒收,不再静默把用户数据钳成默认值(1970 哨兵/空串/丢向量)落库。
    const violations: string[] = [];
    const normalized = normalizeProductState(request.body, { onClamped: (v) => violations.push(...v) });
    if (violations.length > 0) {
      return reply.code(422).send({
        error: "状态包含无法持久化的非法字段值，已整体拒绝写入（未做任何变更）。",
        violations
      });
    }
    const next = repository.replaceState(normalized);
    // A-18:主写通道等待本笔真实落库结果。失败 → 503 + 附权威内存态(客户端同步 revision 用),
    // 明确告知"已接受但未落库、重启会丢";repo 侧已熔断后续写并后台自动重试。
    // (N-02 的 health 轮询 banner 继续覆盖其余"200+异步落库"细粒度路由。)
    try {
      await repository.confirmPersisted?.();
    } catch (err) {
      // P1-12: do not splice raw Surreal field values into the client-facing error.
      const message = err instanceof Error ? err.message : String(err);
      console.error(JSON.stringify({ event: "state_put_confirm_failed", error: message }));
      const isProduction = (process.env.DEPLOYMENT_PROFILE ?? "").trim().toLowerCase() === "production";
      return reply.code(503).send({
        error: "写入已被接受但未能落库。服务端已暂停接受新写并在后台自动重试；在恢复前的改动重启会丢失。",
        ...(isProduction ? {} : { detail: message }),
        state: next
      });
    }
    return next;
  });
  server.post("/api/state/reset", async (request, reply) => {
    const body = request.body as { confirm?: unknown } | undefined;
    if (body?.confirm !== "RESET_ALL_DATA") {
      return reply.code(422).send({
        error: "Reset requires explicit confirmation: send confirm=\"RESET_ALL_DATA\"."
      });
    }

    // ═══ R2b · 真事务路径(surreal 档:热态 + 三冷层同连接)═══════════════════════════════
    // 探到治理事务能力 → 热态清空 + 冷层清空在单个 BEGIN...COMMIT 内原子完成。成功=全清并推进基线;
    // 失败=整体回滚(DB/内存/基线全不动),500 + resetReceipt 标注 rolled-back(无部分提交)。
    // 回落档(memory)探不到能力,走下方既有 best-effort 逐库路径(行为完全不变)。
    const resetGov = asGovernanceTx(repository);
    if (resetGov) {
      const { cold, stores } = buildWipeColdSpec();
      try {
        const next = await resetGov.runGovernanceTransaction({ kind: "reset" }, cold);
        return { ...next, resetReceipt: { partialFailure: false, stores } };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(JSON.stringify({ event: "reset_governance_tx_rolled_back", error: message }));
        // 整体回滚:不带 state(热态未提交,绝不让前端采纳"已清空"的假象)。前端 500 分支因缺
        // body.state 不触发"采纳已清热态",按硬错误如实展示"清空失败",本地状态与服务端(均未变)一致。
        // N-11:error 为 generic 中文;SurrealDB 原始 message(可含字段值)仅非生产经 detail 回传。
        return reply.code(500).send({
          error: "清空失败(已整体回滚,无部分提交),请查看服务端日志。",
          ...governanceErrorDetail(message),
          rolledBack: true,
          resetReceipt: { partialFailure: false, rolledBack: true, hotStateCommitted: false, stores: rolledBackStores() },
        });
      }
    }

    // 顺序:先清热态、后清冷层。热态 resetState() 是原子必选步骤,失败让异常自然冒泡成 500
    // (此时冷层未动,用户重试即可整体重来);冷层随后逐库"尽力而为"清(隐私删除要最大化,
    // 一库 IO 故障不该挡住其余库),清理结果逐库如实记入 resetReceipt 返回给前端。
    const next = repository.resetState();
    // 审计修复(P1-1):reset 此前只清热态,冷层逐字稿/录音/派生知识索引全部残留——
    // 实测 25/26 份冷层材料为跨 reset 孤儿,且 chat 继续召回"已清空"的私人内容。
    // 与 purge 对齐:重置即三库同清(索引是派生可重建的,清空即语义正确的空索引)。
    // 回归审查 R4-2:每库独立 try/catch 尽力清——某库 deleteAll 抛错(sqlite IO 故障)不该跳过
    // 后续库(尤其知识索引残留=可召回私人数据泄漏);逐库告警,不让一处失败掩盖其余未清。
    // 审计修复 F-03(P1):此前任一冷层清理失败仍无条件 200——用户看到"全部数据已清空"
    // 但私密逐字稿/录音/索引仍残留(隐私假成功)。改为逐库记录结构化结果并回执:
    // 任一库 failed → 500 + resetReceipt(热态已清的事实随 state 一并带回,前端可采纳);
    // repo 未注入记 "not-configured",不算失败(嵌入式/测试场景三库常不注入)。
    const stores: Record<string, string> = {};
    for (const [name, repo] of [
      ["raw-material", rawMaterialRepository],
      ["audio", audioRepository],
      ["knowledge-index", knowledgeIndexRepository]
    ] as const) {
      if (!repo) {
        stores[name] = "not-configured";
        continue;
      }
      try {
        await repo.deleteAll();   // R2a:仓库接口已异步化
        stores[name] = "cleared";
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        stores[name] = `failed: ${message}`;
        // F-03:从 warn 升级为 error——这是隐私删除失败(残留可召回的私人数据),不是可忽略的告警。
        console.error(JSON.stringify({ event: "reset_cold_layer_clear_failed", store: name, error: message }));
      }
    }
    const failedStores = Object.entries(stores)
      .filter(([, outcome]) => outcome.startsWith("failed"))
      .map(([name]) => name);
    const resetReceipt = { partialFailure: failedStores.length > 0, stores };
    if (resetReceipt.partialFailure) {
      return reply.code(500).send({
        error: `reset partial failure: ${failedStores.join(", ")}`,
        state: next,
        resetReceipt
      });
    }
    return { ...next, resetReceipt };
  });

  // P0-1: Privacy report
  server.get("/api/state/privacy-report", async () => {
    const state = repository.getState();
    return buildPrivacyReport(state);
  });

  // P0-2: Export. The rehearsal report now carries `exportPackage` (full ProductState),
  // so the downloaded JSON is genuinely restorable via POST /api/state/import below.
  server.get("/api/state/export", async (request, reply) => {
    const state = repository.getState();
    const report = buildBackupRestoreRehearsalReport(state);
    // N-09:冷层读 per-store fail-safe。此前三处冷层读任一抛错 → 整个导出 500,恰在最需要
    // 备份时(冷层表损坏)把内存里完好的热态也一并挡在导出之外。灾难恢复语义是"能导多少导多少":
    // 每个冷层读各自 try/catch,失败置空 + 记名到 coldReadFailures,completeness 据此判 partial。
    const coldReadFailures: string[] = [];
    const readCold = async <T>(name: string, read: () => Promise<T>, empty: T): Promise<T> => {
      try {
        return await read();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        // audio 读两次(listSessionIds + listAll),任一失败去重记名一次。
        if (!coldReadFailures.includes(name)) coldReadFailures.push(name);
        console.error(JSON.stringify({ event: "export_cold_layer_read_failed", store: name, error: message }));
        return empty;
      }
    };
    // Cold-layer raw material lives outside ProductState (its own store), so the hot-state
    // rehearsal report doesn't see it. Bundle it here so a downloaded export is a complete backup.
    const rawMaterials: InterviewRawMaterial[] = rawMaterialRepository
      ? await readCold("raw-material", () => rawMaterialRepository.list(), [])   // R2a:仓库接口已异步化
      : [];
    // `audioSessions` records *which* sessions have audio (the full set, by ID), so an operator
    // can see the recorded-audio footprint and reconcile a purge.
    const audioSessions: string[] = audioRepository
      ? await readCold("audio", () => audioRepository.listSessionIds(), [])
      : [];
    // N-08:音频分卷导出。R7 删同步 sqlite 冷备后,此 JSON export 是唯一备份;单包 18MB 音频预算
    // (受 28MB 体限约束)会把超出部分【确定性】省略——旧注释声称"re-export/sync 仍可完整恢复"是
    // 假的(重新导出用同一预算、同一 createdAt asc 顺序,省略的是同一批)。改为真正的分卷通道:
    // ?audioVolume=N 把音频按预算切成连续分卷,运维可逐卷下载拿到【全部】音频字节;不属于本卷的
    // 会话记入 audioOmittedSessions(completeness 判 partial 并提示用分卷/逐会话下载补全)。
    // 缺省 18MB(留在 28MB 体限内);PRODUCT_AUDIO_EXPORT_BUDGET_BYTES 可调小(测试/运维分卷粒度)。
    const budgetEnv = Number(process.env.PRODUCT_AUDIO_EXPORT_BUDGET_BYTES);
    const AUDIO_EXPORT_BUDGET_BYTES = Number.isFinite(budgetEnv) && budgetEnv > 0
      ? Math.floor(budgetEnv)
      : 18 * 1024 * 1024;
    const requestedVolumeRaw = Number((request.query as { audioVolume?: unknown } | undefined)?.audioVolume);
    const requestedVolume = Number.isFinite(requestedVolumeRaw) && requestedVolumeRaw > 0
      ? Math.floor(requestedVolumeRaw)
      : 0;
    const audios: Array<{
      sessionId: string;
      role: InterviewAudio["role"];
      mime: string;
      durationMs?: number;
      recordingStartedAt?: string;
      audioBase64: string;
    }> = [];
    const audioOmittedSessions: string[] = [];
    const allAudio = (audioRepository
      ? await readCold("audio", () => audioRepository.listAll(), [] as InterviewAudio[])   // R2a:仓库接口已异步化
      : []
    ).slice().sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
    // 把排好序的音频切成连续分卷:每装满一份预算进下一卷。单条超预算的音频独占一卷(不会被
    // 永久锁在备份外)。只有落在 requestedVolume 的会话进本包,其余记为本包未含(omitted)。
    let currentVolume = 0;
    let volumeBytesUsed = 0;
    for (const a of allAudio) {
      const audioBase64 = Buffer.from(a.audio).toString("base64");
      if (volumeBytesUsed > 0 && volumeBytesUsed + audioBase64.length > AUDIO_EXPORT_BUDGET_BYTES) {
        currentVolume += 1;
        volumeBytesUsed = 0;
      }
      volumeBytesUsed += audioBase64.length;
      if (currentVolume !== requestedVolume) {
        audioOmittedSessions.push(a.sessionId);
        continue;
      }
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
    // allAudio 非空时卷数 = 最后卷号 + 1;为空时 0 卷。
    const audioVolumeCount = allAudio.length > 0 ? currentVolume + 1 : 0;
    const audioVolumes = { total: audioVolumeCount, current: requestedVolume };
    const bundleCore = { ...report, rawMaterials, audioSessions, audios, audioOmittedSessions, audioVolumes };
    // F-06:摘要覆盖热态 + 冷层清单 + 实际打包音频,不只沿用 report.package.stateDigest
    // (后者只证明 ProductState,无法发现冷层/音频导出损坏)。compat/completeness 是摘要的
    // 派生元数据,为避免自引用不纳入 digest。
    // C2#1:digest 不再走 buildStableDigest(bundleCore)——那会对含全部音频 base64 的对象做
    // 键排序深拷贝 + 第二次全量序列化,恰好违背下方 R4-5"大对象只序列化一次"的初衷(瞬时
    // 内存峰值随导出包翻倍)。改为:核心包只 JSON.stringify 一次,对该字符串做单遍 FNV-1a
    // (fnv1aDigest,格式 fnv1a-xxxxxxxx 不变)。语义不变:仍是"对导出包主体内容(除
    // bundleDigest/importCompatibility/completeness 外)的稳定摘要"——同一内容经同一构造
    // 路径序列化的键序确定,摘要即确定;仅哈希输入从"键排序 JSON"换成"响应实际字节的 JSON"。
    const coreStr = JSON.stringify(bundleCore);
    const bundleDigest = fnv1aDigest(coreStr);
    // 审计修复(P1-8 对偶):导出侧如实预警包体积与导入体限的兼容性——"备份成功恢复失败"
    // 必须在备份时就可见,而不是恢复时才 413。
    // 回归审查 R4-5:大对象只序列化一次。此前 JSON.stringify(bundle) 算字节 + return 对象让 Fastify
    // 再序列化整包一次 → 导出包(可达 ~28MB,含音频 base64)双序列化=瞬时内存峰值翻倍。改为手动序列化
    // bundle 一次、复用该字符串,bundleDigest/importCompatibility/completeness 都以字符串拼接追加
    // (bundle 由对象字面量构成,其 JSON 必以 } 结尾,slice(0,-1) 去尾后拼入字段安全)。
    const bundleStr = `${coreStr.slice(0, -1)},"bundleDigest":${JSON.stringify(bundleDigest)}}`;
    const prefix = bundleStr.slice(0, -1);
    const buildCandidate = (bytes: number) => {
      const importCompatibility = {
        bytes,
        importBodyLimitBytes: IMPORT_BODY_LIMIT_BYTES,
        exceedsImportLimit: bytes > IMPORT_BODY_LIMIT_BYTES
      };
      const completeness = assessStateExportCompleteness({
        audioSessions,
        audios,
        audioOmittedSessions,
        importCompatibility,
        checks: report.checks,
        coldStoreFailures: coldReadFailures   // N-09:冷层读失败纳入完整性判定(partial + reason)
      });
      return `${prefix},"importCompatibility":${JSON.stringify(importCompatibility)},"completeness":${JSON.stringify(completeness)}}`;
    };
    let finalBytes = Buffer.byteLength(bundleStr);
    let finalPayload = bundleStr;
    // bytes 字段包含在最终 JSON 内,其十进制位数又会影响最终字节数。只迭代极小的尾部
    // 元数据,不重复序列化可达数十 MB 的 bundle 主体；通常 2 次即稳定。
    let converged = false;
    for (let i = 0; i < 8; i += 1) {
      const candidate = buildCandidate(finalBytes);
      const candidateBytes = Buffer.byteLength(candidate);
      finalPayload = candidate;
      if (candidateBytes === finalBytes) {
        converged = true;
        break;
      }
      finalBytes = candidateBytes;
    }
    if (!converged) {
      // C2#6:定点迭代耗尽的理论残缺收尾。8 轮不收敛只可能发生在 64MB 边界 ± 几百字节、
      // exceedsImportLimit 在相邻两轮间反复翻转的构造性场景——旧实现此时直接返回最后一轮
      // candidate,其内嵌 bytes 还是上一轮的值,与响应实际字节数不符("页面说可导入、实际
      // 413"的窗口)。收尾:以最后一轮实测的 candidateBytes(此刻已在 finalBytes 中)再构建
      // 一次,让内嵌 bytes 等于"上一轮 payload 的实测字节数";相邻两轮 payload 只差 bytes
      // 数字与 exceedsImportLimit/completeness 文案,量级相同,收尾值即为最忠实的可得值。
      // 若极端到收尾轮字节数仍与内嵌值不等,如实留下结构化告警而不是静默返回。
      finalPayload = buildCandidate(finalBytes);
      const settledBytes = Buffer.byteLength(finalPayload);
      if (settledBytes !== finalBytes) {
        console.warn(JSON.stringify({
          event: "export_bytes_fixed_point_not_converged",
          embeddedBytes: finalBytes,
          actualBytes: settledBytes,
          detail: "导出包 importCompatibility.bytes 与实际响应字节数存在微小偏差(64MB 边界振荡),导入前请以实际文件大小为准。"
        }));
      }
    }
    return reply.type("application/json").send(finalPayload);
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
          audioSessions?: unknown;
          audioOmittedSessions?: unknown;
          coldLayerMode?: unknown;
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

    // ═══ 审计修复 F-04(P1)阶段一:纯校验/构建,不动任何存储 ═══════════════════════
    // 此前 build-then-swap(R4-1)只覆盖"校验失败",不覆盖"存储执行失败":先 replaceState
    // 再清冷层 → raw delete 抛错时 500,但 profile 已是导入值、旧冷层仍在(热态与冷层来自
    // 两个世代)。另两处一并根治:legacy 裸 state 静默保留旧冷层却仍以"替换全部状态"语义
    // 返回 200;音频非法条目静默 continue,用户以为全量恢复实际缺条目且无从知晓。
    const hasRawArray = Array.isArray(body?.rawMaterials);
    const hasAudioArray = Array.isArray(body?.audios);
    let coldLayerMode: "preserve-cold" | "replace-all" | undefined;
    if (!hasRawArray && !hasAudioArray) {
      // F-04:legacy/裸 ProductState 包没有冷层声明,旧行为是静默保留旧冷层(隐式混合两个
      // 世代)。改为强制调用方显式二选一——语义必须由用户决定,而不是由代码默认。
      const mode = body?.coldLayerMode;
      if (mode !== "preserve-cold" && mode !== "replace-all") {
        return reply.code(422).send({
          error:
            "Import 包不含 rawMaterials/audios 数组(legacy 备份),必须显式指定 coldLayerMode:" +
            "\"preserve-cold\"=只替换热态,现有冷层(逐字稿/录音)原样保留;" +
            "\"replace-all\"=热态替换且旧冷层一并清空。"
        });
      }
      coldLayerMode = mode;
    } else if (!hasRawArray || !hasAudioArray) {
      // F-04:半截包(只带其一)既不是完整冷层声明也不是 legacy——拒绝,避免缺席的那一半
      // 冷层被静默保留成跨世代混合。完整导出包永远同时携带两个数组(见 export)。
      return reply.code(422).send({
        error: "Import 包必须同时携带 rawMaterials 与 audios 数组(完整导出包),或两者都不带并显式指定 coldLayerMode。"
      });
    }

    // 校验能安全 put 的形状,收集全部非法条目(条目下标+缺失字段)后整体 422——一起拒绝,
    // 绝不部分恢复(F-04:音频此前静默跳过;raw 此前只报第一条,现在两者同口径出完整清单)。
    const invalidRawMaterials: Array<{ index: number; error: string }> = [];
    let restoredRawMaterials: InterviewRawMaterial[] | undefined;
    if (rawMaterialRepository && hasRawArray) {
      const built: InterviewRawMaterial[] = [];
      (body!.rawMaterials as InterviewRawMaterial[]).forEach((material, index) => {
        // sessionId + turns(数组) + createdAt(string)——冷层存储对缺失/undefined 字段会抛,
        // 必须在动存储前挡住。
        const missing: string[] = [];
        if (!material || typeof material.sessionId !== "string") missing.push("sessionId");
        if (!material || !Array.isArray(material.turns)) missing.push("turns");
        if (!material || typeof material.createdAt !== "string") missing.push("createdAt");
        if (missing.length > 0) {
          invalidRawMaterials.push({ index, error: `缺失/类型错误字段: ${missing.join(", ")}` });
          return;
        }
        built.push(material);
      });
      restoredRawMaterials = built;
    }

    const invalidAudios: Array<{ index: number; error: string }> = [];
    let restoredAudios: InterviewAudio[] | undefined;
    if (audioRepository && hasAudioArray) {
      const built: InterviewAudio[] = [];
      (body!.audios as Array<{
        sessionId?: unknown; role?: unknown; audioBase64?: unknown; mime?: unknown; durationMs?: unknown; recordingStartedAt?: unknown;
      }>).forEach((entry, index) => {
        const missing: string[] = [];
        if (!entry || typeof entry.sessionId !== "string") missing.push("sessionId");
        if (!entry || typeof entry.audioBase64 !== "string") missing.push("audioBase64");
        if (!entry || typeof entry.mime !== "string") missing.push("mime");
        if (missing.length > 0) {
          invalidAudios.push({ index, error: `缺失/类型错误字段: ${missing.join(", ")}` });
          return;
        }
        const audio = new Uint8Array(Buffer.from(entry.audioBase64 as string, "base64"));
        const role: InterviewAudio["role"] = entry.role === "interviewer" ? "interviewer" : "interviewee";
        const restored: InterviewAudio = { sessionId: entry.sessionId as string, role, audio, mime: entry.mime as string, byteSize: audio.byteLength, createdAt: new Date().toISOString() };
        if (typeof entry.durationMs === "number") restored.durationMs = entry.durationMs;
        if (typeof entry.recordingStartedAt === "string") restored.recordingStartedAt = entry.recordingStartedAt;
        built.push(restored);
      });
      restoredAudios = built;
    }
    if (invalidRawMaterials.length > 0 || invalidAudios.length > 0) {
      return reply.code(422).send({
        error: "Import 包含非法条目,已整体拒绝以保护现有数据(绝不部分恢复)。",
        ...(invalidRawMaterials.length > 0 ? { invalidRawMaterials } : {}),
        ...(invalidAudios.length > 0 ? { invalidAudios } : {})
      });
    }

    // legacy replace-all:冷层清空 = "恢复为空集",与完整包共用同一条 journal 执行/补偿路径。
    if (coldLayerMode === "replace-all") {
      if (rawMaterialRepository) restoredRawMaterials = [];
      if (audioRepository) restoredAudios = [];
    }

    // replaced:两条执行路径(R2b 真事务 / 回落 journal)共同产出的"落库后热态",供阶段三消费。
    let replaced: ProductState | undefined;

    // ═══ R2b · 真事务路径(surreal 档:热态替换 + 冷层 raw/audio 单事务)═════════════════════
    // 探到治理事务能力 → imported 热态 + 冷层 raw/audio(replace 或 preserve-cold 时不触碰)在单个
    // BEGIN...COMMIT 原子完成。知识索引不入事务(与回落 journal 一致:提交后阶段三 best-effort 全量
    // 重建)。失败=整体回滚(DB/内存/基线全不动),500 + rolledBack;成功后落到阶段三,与 journal 汇流。
    const importGov = asGovernanceTx(repository);
    if (importGov) {
      const cold: GovernanceColdSpec = {};
      if (restoredRawMaterials !== undefined) cold.rawMaterial = { action: "replace", materials: restoredRawMaterials };
      if (restoredAudios !== undefined) cold.audio = { action: "replace", audios: restoredAudios };
      try {
        replaced = await importGov.runGovernanceTransaction({ kind: "replace", next: imported }, cold);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(JSON.stringify({ event: "import_governance_tx_rolled_back", error: message }));
        // 整体回滚:steps 全 rolled-back,不带 state(热态未提交,绝不让前端采纳半截恢复)。
        // 出口形状与既有 journal 500 一致(failedStep/rolledBack/steps),productApi/ProfileView 照旧消费。
        const steps: Array<{ store: string; status: string }> = [];
        if (restoredRawMaterials !== undefined) steps.push({ store: "raw-material", status: "rolled-back" });
        if (restoredAudios !== undefined) steps.push({ store: "audio", status: "rolled-back" });
        steps.push({ store: "hot-state", status: "rolled-back" });
        // N-11:generic 中文 + 非生产 detail(SurrealDB 原始 message 可含字段值)。
        return reply.code(500).send({
          error: "导入失败(已整体回滚,无部分提交),请查看服务端日志。",
          ...governanceErrorDetail(message),
          failedStep: "transaction",
          rolledBack: true,
          steps,
        });
      }
    } else {

    // ═══ F-04 阶段二:执行协议(journal + 补偿)═══════════════════════════════════
    // 执行前对将被改写的冷层做全量内存快照:import 体限 64MB,快照峰值与包体同量级,一次性
    // 恢复操作可接受——用这份内存开销换"任一步失败都不丢旧数据"的确定性。
    // 顺序:raw 清+恢复 → audio 清+恢复 → 热态 replaceState 最后。热态排最后是关键:前面
    // 任何一步失败时热态尚未写入,不需要"热态回滚"这种做不到的操作(replaceState 无逆操作)。
    // R2a:冷层仓库接口已异步化,快照读取 await。
    const rawSnapshot = restoredRawMaterials !== undefined ? await rawMaterialRepository!.list() : undefined;
    const audioSnapshot = restoredAudios !== undefined ? await audioRepository!.listAll() : undefined;

    type ImportStore = "raw-material" | "audio" | "hot-state";
    type ImportStepStatus = "pending" | "completed" | "compensated" | "failed";
    interface ImportStep {
      store: ImportStore;
      status: ImportStepStatus;
      // R2a:run/compensate 允许返回 Promise(冷层写异步);执行处逐个 await。
      run: () => void | Promise<void>;
      /** 逆序补偿:把快照放回去。hot-state 最后一步失败即未提交,无需(也无法)补偿。 */
      compensate?: () => void | Promise<void>;
    }
    // 注:replaced 已在 R2b 分支上方 hoist(两路共用),此处不再声明。
    const steps: ImportStep[] = [];
    if (rawSnapshot !== undefined) {
      steps.push({
        store: "raw-material",
        status: "pending",
        run: async () => {
          await rawMaterialRepository!.deleteAll();
          for (const material of restoredRawMaterials!) await rawMaterialRepository!.put(material);
        },
        compensate: async () => {
          await rawMaterialRepository!.deleteAll();
          for (const material of rawSnapshot) await rawMaterialRepository!.put(material);
        }
      });
    }
    if (audioSnapshot !== undefined) {
      steps.push({
        store: "audio",
        status: "pending",
        run: async () => {
          await audioRepository!.deleteAll();
          for (const restored of restoredAudios!) await audioRepository!.put(restored);
        },
        compensate: async () => {
          await audioRepository!.deleteAll();
          for (const audio of audioSnapshot) await audioRepository!.put(audio);
        }
      });
    }
    steps.push({
      store: "hot-state",
      status: "pending",
      run: async () => {
        // 回归审查 R4-3(保留):跳过包装层增量重索引——下方显式 rebuildKnowledgeIndex 全量
        // 重建(含冷层逐字稿),增量与全量并跑是重复嵌入(浪费预算)。
        replaced = await replaceStateDurable(repository, imported, { skipReindex: true });
      }
    });

    for (let i = 0; i < steps.length; i += 1) {
      try {
        await steps[i]!.run();   // R2a:step 可能异步
        steps[i]!.status = "completed";
      } catch (err) {
        const failedStep = steps[i]!.store;
        const message = err instanceof Error ? err.message : String(err);
        steps[i]!.status = "failed";
        console.error(JSON.stringify({ event: "import_journal_step_failed", step: failedStep, error: message }));
        // 逆序补偿:失败步骤自身可能已部分执行(deleteAll 成功、put 中途抛),它的快照同样
        // 要恢复,所以补偿从 i(含)往前扫。补偿成功的已完成步骤记 compensated;补偿自身再
        // 抛错则如实记 rolledBack:false——绝不谎报"已回滚",不一致细节进 body + console.error。
        const compensationFailures: Array<{ store: ImportStore; error: string }> = [];
        for (let j = i; j >= 0; j -= 1) {
          const step = steps[j]!;
          if (!step.compensate) continue;
          try {
            await step.compensate();   // R2a:补偿可能异步
            if (step.status === "completed") step.status = "compensated";
          } catch (compensationErr) {
            const compensationMessage = compensationErr instanceof Error ? compensationErr.message : String(compensationErr);
            compensationFailures.push({ store: step.store, error: compensationMessage });
            console.error(JSON.stringify({
              event: "import_journal_compensation_failed",
              step: step.store,
              error: compensationMessage,
              detail: "该库停在导入世代且回滚失败,与其余库/热态不一致,需人工介入或重试 import。"
            }));
          }
        }
        // N-11:generic 中文 error(failedStep 是库名、非敏感,保留);原始 message 仅非生产经 detail 回传。
        return reply.code(500).send({
          error: "导入失败,请查看服务端日志。",
          ...governanceErrorDetail(message),
          failedStep,
          rolledBack: compensationFailures.length === 0,
          steps: steps.map((step) => ({ store: step.store, status: step.status })),
          ...(compensationFailures.length > 0 ? { compensationFailures } : {})
        });
      }
    }
    } // ← R2b:回落 journal 路径(else)结束;两路在此汇流到阶段三

    // ═══ F-04 阶段三:post-commit 装饰(尽力而为,不影响已成功的恢复本身)═══════════
    // 审计修复(P3-39,保留):恢复后自动重建知识索引——material/transcript 块此前只在 import
    // 端点/ /end 补点,备份恢复路径两者都不经过 → 恢复后资料明明在、chat/召回却查无此块。
    // 同步清空+关键词重建立即生效,嵌入后台补;失败仅 warn,但结果如实记入 importReceipt。
    let knowledgeIndexOutcome: "rebuilt" | "failed" | "skipped" = "skipped";
    if (knowledgeIndexRepository) {
      try {
        await rebuildKnowledgeIndex(replaced!, {   // R2a:rebuildKnowledgeIndex 已异步化
          knowledgeRepo: knowledgeIndexRepository,
          ...(rawMaterialRepository ? { rawMaterialRepo: rawMaterialRepository } : {}),
          ...(options.embeddingClient ? { embeddingClient: options.embeddingClient } : {}),
          budget: options.llmBudget ?? createLlmBudget()
        });
        knowledgeIndexOutcome = "rebuilt";
      } catch (err) {
        knowledgeIndexOutcome = "failed";
        console.warn(JSON.stringify({ event: "import_knowledge_rebuild_failed", error: err instanceof Error ? err.message : String(err) }));
      }
    }
    // F-04:成功回执(与 purge/reset 的装饰键 spread 模式一致,前端 productApi 会剥离)。
    const importReceipt = {
      ...(coldLayerMode ? { coldLayerMode } : {}),
      partial: false,
      restored: {
        rawMaterials: restoredRawMaterials?.length ?? 0,
        audios: restoredAudios?.length ?? 0
      },
      skipped: {
        rawMaterials:
          hasRawArray && !rawMaterialRepository
            ? (body!.rawMaterials as unknown[]).map((_, index) => ({ index, reason: "raw-material store not configured" }))
            : [],
        audios:
          hasAudioArray && !audioRepository
            ? (body!.audios as unknown[]).map((_, index) => ({ index, reason: "audio store not configured" }))
            : []
      },
      missing: {
        // C2#7:restoredAudios 的 sessionId Set 只建一次——此前写在 filter 回调里,每个已声明
        // 的 audioSession 都重建一遍整份 Set,O(n²)(大包数百会话 × 数百音频时白耗 CPU)。
        audioSessions: (() => {
          const restoredAudioIds = new Set((restoredAudios ?? []).map((audio) => audio.sessionId));
          return [...new Set([
            ...(Array.isArray(body?.audioOmittedSessions)
              ? body.audioOmittedSessions.filter((id): id is string => typeof id === "string")
              : []),
            ...(Array.isArray(body?.audioSessions)
              ? body.audioSessions.filter((id): id is string => typeof id === "string")
              : []).filter((id) => !restoredAudioIds.has(id))
          ])];
        })()
      },
      knowledgeIndex: knowledgeIndexOutcome
    };
    importReceipt.partial =
      importReceipt.skipped.rawMaterials.length > 0 ||
      importReceipt.skipped.audios.length > 0 ||
      importReceipt.missing.audioSessions.length > 0 ||
      knowledgeIndexOutcome === "failed";
    return { ...replaced!, importReceipt };
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

    // 审计修复 F-04(P1):冷层三库"尽力而为"清理 + 三态回执(与 B1 reset/F-03 同口径:
    // cleared / not-configured / failed: <原因>)。此前 purge(all) 任一 deleteAll 抛错就 500
    // 且热态不动,但注入实测第二库失败时第一库已删——前序删除无法恢复,"热态未变"的响应
    // 语义与实际不符;一库故障还会挡住其余库(隐私残留)。purge 是隐私删除:目标是删得
    // 尽量多,而不是假装原子。两个涉及冷层的档位(all/interviews)共用这段逐库清理。
    const clearColdStoresBestEffort = async (): Promise<Record<string, string>> => {   // R2a:冷层异步化
      const stores: Record<string, string> = {};
      for (const [name, repo] of [
        ["raw-material", rawMaterialRepository],
        ["audio", audioRepository],
        ["knowledge-index", knowledgeIndexRepository]
      ] as const) {
        if (!repo) {
          stores[name] = "not-configured";
          continue;
        }
        try {
          await repo.deleteAll();   // R2a:仓库接口已异步化
          stores[name] = "cleared";
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          stores[name] = `failed: ${message}`;
          // 隐私删除失败(残留可召回的私人数据),用 error 级结构化日志,不是可忽略的告警。
          console.error(JSON.stringify({ event: "purge_cold_layer_clear_failed", store: name, error: message }));
        }
      }
      return stores;
    };
    const listFailedStores = (stores: Record<string, string>): string[] =>
      Object.entries(stores)
        .filter(([, outcome]) => outcome.startsWith("failed"))
        .map(([name]) => name);

    // N-12:scoped purge 会 wipe 整张 knowledge_chunk 表(八源全清),但只有 transcript 源的块
    // 该随专访清空——存活来源(已确认记忆/导入语料/资产派生)的块也被清了,且增量重索引不会补
    // (存活来源未变更)。assets 档早有此同步全量重建先例(P3-38);interviews 两条成功路径此前
    // 遗漏 → 清空后 chat 不再引用任何存活素材,零信号。这里抽出共用重建,wipe 后从存活热态重建。
    const rebuildSurvivingKnowledge = async (nextState: ProductState): Promise<void> => {
      if (!knowledgeIndexRepository) return;
      try {
        await rebuildKnowledgeIndex(nextState, {   // R2a:rebuildKnowledgeIndex 已异步化
          knowledgeRepo: knowledgeIndexRepository,
          ...(rawMaterialRepository ? { rawMaterialRepo: rawMaterialRepository } : {}),
          ...(options.embeddingClient ? { embeddingClient: options.embeddingClient } : {}),
          budget: options.llmBudget ?? createLlmBudget()
        });
      } catch (err) {
        console.warn(JSON.stringify({ event: "purge_knowledge_rebuild_failed", error: err instanceof Error ? err.message : String(err) }));
      }
    };

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
      // ═══ R2b · 真事务路径(surreal 档:热态 purge + 冷层三库单事务)═══════════════════════
      // 探到治理事务能力 → 热态 purged + 冷层三库清空在单个 BEGIN...COMMIT 原子完成。
      // local-object 文件删除(artifactPurge)已在上方执行,属**文件层、非事务**(文件系统无法入
      // 事务):保持现状。回滚时热态/冷层整体回退,但文件已删(隐私删除方向,过删不过留);receipt
      // 如实带 artifactPurge。成功回执与既有 200 逐字一致(partialFailure:false/hotStateCommitted/stores)。
      const purgeGovAll = asGovernanceTx(repository);
      if (purgeGovAll) {
        const { cold, stores } = buildWipeColdSpec();
        try {
          const nextState = await purgeGovAll.runGovernanceTransaction({ kind: "replace", next: purged }, cold);
          return { ...nextState, artifactPurge, deletedScope: "all" as PurgeScope, deletedCount, purgeReceipt: { partialFailure: false, hotStateCommitted: true, stores } };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          console.error(JSON.stringify({ event: "purge_governance_tx_rolled_back", scope: "all", error: message }));
          // 整体回滚(热态/冷层未提交):不带 state。带 artifactPurge(文件层非事务,已删)。
          // N-11:generic 中文 + 非生产 detail(SurrealDB 原始 message 可含字段值)。
          return reply.code(500).send({
            error: "清空失败(已整体回滚,无部分提交),请查看服务端日志。",
            ...governanceErrorDetail(message),
            rolledBack: true,
            artifactPurge,
            purgeReceipt: { partialFailure: false, rolledBack: true, hotStateCommitted: false, stores: rolledBackStores() },
          });
        }
      }

      // Cold layer (raw transcripts / recorded audio / derived knowledge index) must go with a
      // full wipe, otherwise the original Q&A / voice / indexed personal text survives the
      // "complete" purge (Task 13 / Task 4 / Task 12)。F-04:逐库尽力而为,一库失败不挡其余库。
      // F-04:热态 purge 无论冷层成败都提交——隐私删除最大化(冷层某库 IO 故障不该让热态的
      // 私人数据也留下来);冷层失败以 500 + purgeReceipt 如实回执,让前端明确"删了什么、
      // 哪里还残留、该重试什么",而不是假装什么都没发生。
      // 回归审查 R4-3(保留):跳过增量重索引——上方已直接清空整个知识索引。
      const stores = await clearColdStoresBestEffort();   // R2a:已异步化
      const nextState = await replaceStateDurable(repository, purged, { skipReindex: true });
      const failedStores = listFailedStores(stores);
      const purgeReceipt = { partialFailure: failedStores.length > 0, hotStateCommitted: true, stores };
      if (purgeReceipt.partialFailure) {
        return reply.code(500).send({
          error: `purge partial failure: ${failedStores.join(", ")}`,
          state: nextState,
          artifactPurge,
          purgeReceipt
        });
      }
      return { ...nextState, artifactPurge, deletedScope: "all" as PurgeScope, deletedCount, purgeReceipt };
    }

    // ═══ R2b · 真事务路径(surreal 档,interviews:热态 scoped-purge + 冷层三库单事务)═══════
    // interviews 清空全部会话,其冷层逐字稿/录音/派生知识按会话键关联,须随之清空。探到治理事务能力
    // → 热态 + 冷层三库单事务原子完成;失败=整体回滚,500 + rolledBack。profile/assets 档不涉及冷层
    // 事务(assets 的索引一致性由下方 rebuild 负责),永远走通用路径。
    const purgeGovInterviews = scope === "interviews" ? asGovernanceTx(repository) : undefined;
    if (purgeGovInterviews) {
      const { nextState: iScopedState, deletedScope: iScope, deletedCount: iCount } = createScopedPurge(state, scope);
      const { cold, stores } = buildWipeColdSpec();
      try {
        const nextState = await purgeGovInterviews.runGovernanceTransaction({ kind: "replace", next: iScopedState }, cold);
        // N-12:wipe 清了整张 knowledge_chunk 表(八源),从存活热态重建存活来源的块(事务已提交,
        // inFlightCount 归零,重建的冷层 put 不再被 N-03 守卫挡)。
        await rebuildSurvivingKnowledge(nextState);
        return { ...nextState, deletedScope: iScope, deletedCount: iCount, purgeReceipt: { partialFailure: false, hotStateCommitted: true, stores } };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(JSON.stringify({ event: "purge_governance_tx_rolled_back", scope: "interviews", error: message }));
        // N-11:generic 中文 + 非生产 detail(SurrealDB 原始 message 可含字段值)。
        return reply.code(500).send({
          error: "清空失败(已整体回滚,无部分提交),请查看服务端日志。",
          ...governanceErrorDetail(message),
          rolledBack: true,
          purgeReceipt: { partialFailure: false, rolledBack: true, hotStateCommitted: false, stores: rolledBackStores() },
        });
      }
    }

    const { nextState: scopedState, deletedScope, deletedCount } = createScopedPurge(state, scope);
    const nextState = await replaceStateDurable(repository, scopedState);
    // 审计修复(P3-38):assets 档的知识索引清理此前只靠异步增量 diff(失败/进程退出即永久残留
    // 已清资产的可召回块)。与 all/interviews 对齐:同步全量重建(存活的会话/素材块随重建回来)。
    if (scope === "assets") {
      await rebuildSurvivingKnowledge(nextState);
    }
    // The interviews scope clears all sessions from hot state; their cold-layer raw materials /
    // recorded audio / derived knowledge index are keyed by those sessions and would otherwise
    // be orphaned, so wipe the cold layer too (Task 13 / Task 4 / Task 12)。
    // 审计修复 F-04(P1):热态在上方已先提交(既有顺序保持),但此前任一冷层 deleteAll 抛错
    // 会裸 500——热态其实已变、也没有回执说明哪库残留。改为逐库尽力而为 + purgeReceipt,
    // 失败时 receipt 注明 hotStateCommitted,让前端明白 500≠什么都没发生。
    if (scope === "interviews") {
      const stores = await clearColdStoresBestEffort();   // R2a:已异步化
      const failedStores = listFailedStores(stores);
      const purgeReceipt = { partialFailure: failedStores.length > 0, hotStateCommitted: true, stores };
      if (purgeReceipt.partialFailure) {
        return reply.code(500).send({
          error: `purge partial failure: ${failedStores.join(", ")}`,
          state: nextState,
          purgeReceipt
        });
      }
      // N-12:与 assets/governance 路径对齐——wipe 清了整张 knowledge_chunk 表,从存活热态重建
      // 存活来源(记忆/语料/资产)的块,否则清空后 chat 不再引用任何存活素材且零信号。
      await rebuildSurvivingKnowledge(nextState);
      return { ...nextState, deletedScope, deletedCount, purgeReceipt };
    }
    // 其余分档(profile/assets)不涉及冷层三库(assets 的索引一致性由上方同步 rebuild 负责,
    // 失败已有 warn),维持原响应形状,不强加 receipt。
    return { ...nextState, deletedScope, deletedCount };
  });
}
