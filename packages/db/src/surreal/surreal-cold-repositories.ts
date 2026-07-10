import { RecordId } from "surrealdb";
import type { Surreal } from "surrealdb";
import type {
  InterviewAudio,
  InterviewAudioRole,
  InterviewRawMaterial,
  KnowledgeChunk,
  KnowledgeSourceType,
} from "../../../../src/domain/types";
import type { RawMaterialRepository } from "../../../../apps/api/src/raw-material-repository";
import type { AudioRepository } from "../../../../apps/api/src/audio-repository";
import type { KnowledgeIndexRepository } from "../../../../apps/api/src/knowledge-index-repository";
import { createSurrealConnection, type SurrealConnectionOptions } from "./connect";
import { applySchema } from "./apply-schema";
import {
  buildSurrealProductStateRepositoryOnConnection,
  runWithTransientRetry,
  type SurrealRepoHandle,
} from "./surreal-product-state-repository";

/**
 * R2a · 三冷层(raw-material / audio / knowledge-index)的 SurrealDB 实现(009_r2a_cold.surql)。
 *
 * 设计要点(与热态 surreal-product-state-repository 的差异,均刻意):
 * - **直读直写,无内存工作副本**:冷层没有"同步接口"约束(接口已 R2a 异步化),读写直接 await db。
 *   尤其 audio 是 MB 级 bytes 大对象,绝不进任何内存缓存(热态那套"内存副本 + persist queue"是为
 *   满足 ProductState 的同步 getState 契约而生;冷层无此契约,缓存只会白占内存)。
 * - **共用同一嵌入式连接**:createSurrealStores 打开一个连接给热态 + 三冷层共用(嵌入式 surrealkv
 *   同进程独占文件锁,第二连接会挂死;且 R2b 治理事务要跨冷热单事务)。
 * - **瞬态冲突有界重试**:冷层写与热态 persist 事务在同一连接上交错,surrealkv 乐观事务偶发写写
 *   冲突(P8/R0-S3 实测)。写路径统一走 runWithTransientRetry(与热态 persist 复用同一阶梯,不复制
 *   第二份);非瞬态错误(schema ASSERT 等)立即抛。读路径不重试(读不触发写写冲突)。
 * - **epoch 语义照搬 sqlite/in-memory**:进程内单调计数,deleteAll 递增(索引是派生可重建的进程态,
 *   epoch 无需持久化;reset/purge 竞态守卫据此丢弃陈旧后台嵌入,见 knowledge.ts R8-1)。
 */

const DEFAULT_ROLE: InterviewAudioRole = "interviewee";

/** SurrealDB 记录 id → 领域 id 字符串(复合 id 取整个 .id;单段取字符串)。 */
function domainIdOf(id: unknown): string {
  if (id instanceof RecordId) return String(id.id);
  if (typeof id === "string") return id.includes(":") ? id.slice(id.indexOf(":") + 1) : id;
  return String(id);
}

/** SurrealDB datetime(DateTime 包装) / string / Date → ISO 字符串(冷层的 createdAt 等回读)。 */
function toIso(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "string") return v;
  if (v instanceof Date) return v.toISOString();
  const anyV = v as { toISOString?: () => string };
  if (typeof anyV.toISOString === "function") return anyV.toISOString();
  const d = new Date(String(v));
  return Number.isNaN(d.getTime()) ? String(v) : d.toISOString();
}

/** bytes 列回读是 ArrayBuffer(R2a spike 实测,非 R0 文档所述 Uint8Array)→ 规范化为 Uint8Array。 */
function toBytes(v: unknown): Uint8Array {
  if (v instanceof Uint8Array) return v;      // 含 Buffer(Uint8Array 子类)
  if (v instanceof ArrayBuffer) return new Uint8Array(v);
  // 仅理论兜底:R2a spike 实测嵌入式 3.0.2 回读 bytes 列恒为 ArrayBuffer(上一分支已命中),
  // 此路正常不会走到。防御未来 SDK 变体回读成 ArrayBufferView(TypedArray/DataView)——取其
  // 底层 buffer 保字节;拿不到就返回空,绝不 as 谎报类型。
  const view = v as ArrayBufferView | null | undefined;
  return view && ArrayBuffer.isView(view) ? new Uint8Array(view.buffer, view.byteOffset, view.byteLength) : new Uint8Array(0);
}

// ─────────────────────────────── raw_material ───────────────────────────────

export function createSurrealRawMaterialRepository(db: Surreal): RawMaterialRepository {
  const idOf = (sessionId: string) => new RecordId("raw_material", sessionId);
  const mapRow = (row: Record<string, unknown>): InterviewRawMaterial => ({
    sessionId: domainIdOf(row.id),
    turns: (Array.isArray(row.turns) ? row.turns : []) as InterviewRawMaterial["turns"],
    strategyTrace: (Array.isArray(row.strategyTrace) ? row.strategyTrace : []) as InterviewRawMaterial["strategyTrace"],
    createdAt: toIso(row.createdAt),
  });
  return {
    async get(sessionId) {
      const [rows] = await db.query<[Array<Record<string, unknown>>]>("SELECT * FROM $rid;", { rid: idOf(sessionId) });
      const row = rows?.[0];
      return row ? mapRow(row) : undefined;
    },
    async list() {
      const [rows] = await db.query<[Array<Record<string, unknown>>]>("SELECT * FROM raw_material ORDER BY createdAt ASC;");
      return (rows ?? []).map(mapRow);
    },
    async put(material) {
      await runWithTransientRetry(async () => {
        await db.query("UPSERT $rid CONTENT $c;", {
          rid: idOf(material.sessionId),
          c: {
            turns: material.turns ?? [],
            strategyTrace: material.strategyTrace ?? [],
            createdAt: new Date(material.createdAt),
          },
        });
      });
    },
    async delete(sessionId) {
      await runWithTransientRetry(() => db.query("DELETE $rid;", { rid: idOf(sessionId) }) as Promise<unknown>);
    },
    async deleteAll() {
      await runWithTransientRetry(() => db.query("DELETE raw_material;") as Promise<unknown>);
    },
  };
}

// ─────────────────────────────────── audio ──────────────────────────────────

export function createSurrealAudioRepository(db: Surreal): AudioRepository {
  const idOf = (sessionId: string, role: InterviewAudioRole) => new RecordId("audio", [sessionId, role]);
  const mapRow = (row: Record<string, unknown>): InterviewAudio => {
    const result: InterviewAudio = {
      sessionId: String(row.sessionId ?? ""),
      role: (row.role as InterviewAudioRole) ?? DEFAULT_ROLE,
      audio: toBytes(row.data),
      mime: String(row.mime ?? ""),
      byteSize: typeof row.byteSize === "number" ? row.byteSize : toBytes(row.data).byteLength,
      createdAt: toIso(row.createdAt),
    };
    if (row.durationMs !== null && row.durationMs !== undefined) result.durationMs = Number(row.durationMs);
    if (row.recordingStartedAt !== null && row.recordingStartedAt !== undefined) {
      result.recordingStartedAt = toIso(row.recordingStartedAt);
    }
    return result;
  };
  return {
    async get(sessionId, role = DEFAULT_ROLE) {
      const [rows] = await db.query<[Array<Record<string, unknown>>]>("SELECT * FROM $rid;", { rid: idOf(sessionId, role) });
      const row = rows?.[0];
      return row ? mapRow(row) : undefined;
    },
    async has(sessionId, role = DEFAULT_ROLE) {
      const [rows] = await db.query<[unknown[]]>("SELECT VALUE id FROM $rid;", { rid: idOf(sessionId, role) });
      return (rows?.length ?? 0) > 0;
    },
    async put(a) {
      const role = a.role ?? DEFAULT_ROLE;
      // 大对象(MB 级 bytes)直接落库,绝不缓存内存(见文件头注释)。
      const content: Record<string, unknown> = {
        sessionId: a.sessionId,
        role,
        data: a.audio,
        mime: a.mime,
        byteSize: a.byteSize ?? a.audio.byteLength,
        createdAt: new Date(a.createdAt),
      };
      if (a.durationMs !== undefined) content.durationMs = a.durationMs;
      if (a.recordingStartedAt !== undefined) content.recordingStartedAt = new Date(a.recordingStartedAt);
      await runWithTransientRetry(async () => { await db.query("UPSERT $rid CONTENT $c;", { rid: idOf(a.sessionId, role), c: content }); });
    },
    async delete(sessionId, role) {
      await runWithTransientRetry(() =>
        (role
          ? db.query("DELETE $rid;", { rid: idOf(sessionId, role) })
          : db.query("DELETE audio WHERE sessionId = $s;", { s: sessionId })) as Promise<unknown>
      );
    },
    async deleteAll() {
      await runWithTransientRetry(() => db.query("DELETE audio;") as Promise<unknown>);
    },
    async listSessionIds() {
      const [rows] = await db.query<[unknown[]]>("SELECT VALUE sessionId FROM audio;");
      return [...new Set((rows ?? []).map((r) => String(r)))].sort();
    },
    async listAll() {
      const [rows] = await db.query<[Array<Record<string, unknown>>]>("SELECT * FROM audio ORDER BY createdAt ASC;");
      return (rows ?? []).map(mapRow);
    },
  };
}

// ────────────────────────────── knowledge_chunk ─────────────────────────────

export function createSurrealKnowledgeIndexRepository(db: Surreal): KnowledgeIndexRepository {
  // epoch 照搬 sqlite/in-memory:进程内单调计数,deleteAll 递增(不持久化)。
  let epoch = 0;
  const idOf = (chunkId: string) => new RecordId("knowledge_chunk", chunkId);
  const mapRow = (row: Record<string, unknown>): KnowledgeChunk => {
    const chunk: KnowledgeChunk = {
      id: domainIdOf(row.id),
      sourceType: row.sourceType as KnowledgeSourceType,
      sourceId: String(row.sourceId ?? ""),
      title: String(row.title ?? ""),
      text: String(row.text ?? ""),
      keywords: (Array.isArray(row.keywords) ? row.keywords.map(String) : []),
      createdAt: toIso(row.createdAt),
    };
    // 仅在持久化了 embedding/provider 时挂字段,保持类型上的可选语义(对齐 sqlite mapRow)。
    if (Array.isArray(row.embedding)) chunk.embedding = (row.embedding as number[]).map(Number);
    if (row.embeddingProvider !== null && row.embeddingProvider !== undefined) {
      chunk.embeddingProvider = String(row.embeddingProvider);
    }
    return chunk;
  };
  // chunk → UPSERT CONTENT 载荷。embedding/provider 缺省则不写该键 → schema option 列保持 NONE
  // (与 sqlite 存 null 语义一致)。
  const contentOf = (c: KnowledgeChunk): Record<string, unknown> => {
    const content: Record<string, unknown> = {
      sourceType: c.sourceType,
      sourceId: c.sourceId,
      title: c.title ?? "",
      text: c.text,
      keywords: c.keywords ?? [],
      createdAt: new Date(c.createdAt),
    };
    if (Array.isArray(c.embedding) && c.embedding.length > 0) content.embedding = c.embedding;
    if (c.embeddingProvider !== undefined) content.embeddingProvider = c.embeddingProvider;
    return content;
  };
  const putChunk = (c: KnowledgeChunk): Promise<unknown> =>
    db.query("UPSERT $rid CONTENT $c;", { rid: idOf(c.id), c: contentOf(c) });
  return {
    async put(c) {
      await runWithTransientRetry(() => putChunk(c));
    },
    async replaceSource(sourceType, sourceId, chunks) {
      // 单事务原子替换,与 sqlite 的 BEGIN/COMMIT 契约一致——中途崩溃/并发读绝不会看到"该来源被
      // 清空"的中间态。规避 3.x「同事务删建同 id」坑(R1b 已验证手法):不先全删再建,而是
      // DELETE ... AND id NOT IN $keep(只删本次不保留的旧块)+ 逐条 UPSERT(keep=本次 chunkId 集,
      // 复用同 id 的块只被 UPSERT 覆盖、从不在同事务里先删后建)。chunks 为空时 keep=[],退化为
      // "删该来源全部",语义正确。整段走瞬态重试,与热态在同一连接上并发时对写写冲突自恢复。
      await runWithTransientRetry(async () => {
        const vars: Record<string, unknown> = { t: sourceType, s: sourceId, keep: chunks.map((c) => idOf(c.id)) };
        let surql = "BEGIN TRANSACTION;\n";
        surql += "DELETE knowledge_chunk WHERE sourceType = $t AND sourceId = $s AND id NOT IN $keep;\n";
        chunks.forEach((c, i) => {
          vars[`id${i}`] = idOf(c.id);
          vars[`c${i}`] = contentOf(c);
          surql += `UPSERT $id${i} CONTENT $c${i};\n`;
        });
        surql += "COMMIT TRANSACTION;";
        await db.query(surql, vars);
      });
    },
    async deleteBySource(sourceType, sourceId) {
      await runWithTransientRetry(() =>
        db.query("DELETE knowledge_chunk WHERE sourceType = $t AND sourceId = $s;", { t: sourceType, s: sourceId }) as Promise<unknown>
      );
    },
    async deleteAll() {
      await runWithTransientRetry(() => db.query("DELETE knowledge_chunk;") as Promise<unknown>);
      epoch += 1;   // R8-1:清空递增代际,丢弃陈旧后台嵌入
    },
    async listAll() {
      const [rows] = await db.query<[Array<Record<string, unknown>>]>("SELECT * FROM knowledge_chunk ORDER BY createdAt ASC;");
      return (rows ?? []).map(mapRow);
    },
    async epoch() { return epoch; },
  };
}

// ─────────────────────────────── 共享连接工厂 ───────────────────────────────

export interface SurrealStores {
  productState: SurrealRepoHandle;
  rawMaterial: RawMaterialRepository;
  audio: AudioRepository;
  knowledgeIndex: KnowledgeIndexRepository;
  /** 关闭共享连接(先 flush 热态 persist 队列)。冷热仓库都不再可用。 */
  close(): Promise<void>;
}

/**
 * R2a:在一个共享的嵌入式连接上装配「热态产品仓库 + 三冷层仓库」。
 * 打开一个连接、applySchema 一次,热态与三冷层全部挂上去——嵌入式 surrealkv 同进程独占锁,
 * 决不能开第二连接;R2b 治理事务也要跨冷热在同一连接单事务。
 * 向后兼容:standalone 的 createSurrealProductStateRepository 仍可单独调用(自开自关连接)。
 */
export async function createSurrealStores(opts: SurrealConnectionOptions): Promise<SurrealStores> {
  const db = await createSurrealConnection(opts);
  await applySchema(db);
  // 热态仓库不拥有连接(ownsConnection=false),由本工厂 close() 统一关一次。
  const productState = await buildSurrealProductStateRepositoryOnConnection(db, { ownsConnection: false });
  return {
    productState,
    rawMaterial: createSurrealRawMaterialRepository(db),
    audio: createSurrealAudioRepository(db),
    knowledgeIndex: createSurrealKnowledgeIndexRepository(db),
    async close() {
      await productState.flush();   // 排空 persist 队列后再关连接
      await db.close();
    },
  };
}
