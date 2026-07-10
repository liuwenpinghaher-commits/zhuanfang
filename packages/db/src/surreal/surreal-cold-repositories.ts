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
import {
  audioContentOf,
  audioRecordId,
  KNOWLEDGE_CHUNK_TABLE,
  rawMaterialContentOf,
  rawMaterialRecordId,
} from "./cold-shapes";

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
  const idOf = (sessionId: string) => rawMaterialRecordId(sessionId);   // R2b:与治理事务共用 cold-shapes
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
        // R2b:载荷形状由 cold-shapes 单一真值提供(治理事务复用同一形状)。
        await db.query("UPSERT $rid CONTENT $c;", {
          rid: idOf(material.sessionId),
          c: rawMaterialContentOf(material),
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
  const idOf = (sessionId: string, role: InterviewAudioRole) => audioRecordId(sessionId, role);   // R2b:与治理事务共用 cold-shapes
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
      // 大对象(MB 级 bytes)直接落库,绝不缓存内存(见文件头注释)。
      // R2b:载荷形状由 cold-shapes 单一真值提供(治理事务复用同一形状)。
      const { role, content } = audioContentOf(a);
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

/** R2b:Surreal 知识索引仓库额外暴露 bumpEpoch——治理事务用一条 SQL 直接 `DELETE knowledge_chunk`
 *  清空(不经仓库 deleteAll),故 epoch 不会自增;提交成功后须显式 bump,让 R8-1 竞态守卫
 *  (knowledge.ts:epochAtEmbed)照常丢弃"清空前构建、清空后才落库"的陈旧后台嵌入。 */
export interface SurrealKnowledgeIndexRepository extends KnowledgeIndexRepository {
  bumpEpoch(): void;
  /** R2c:原生混合召回在 Surreal 档必有(基接口上是可选能力,此处收紧为必选)。 */
  searchHybrid(query: { text: string; embedding?: number[]; limit: number }): Promise<KnowledgeChunk[]>;
}

/** R2c:searchHybrid 的 BM25 query token 上限。chat 的 message 是用户自由输入(上限 3 万余字),
 *  zh analyzer ngram(2,2) 会切出海量 token——逐 token OR 的 SurrealQL 语句不能无界膨胀。
 *  去重后取前 32 个(范例 recallRagChunks 的 queryText 是受控短议程文本,无需此钳制;这里必须有)。
 *  量化锚点:32 个 `text @@ $tN` 谓词 ≈ 语句体积数百字节 + 每次召回至多 32 次全文索引查找(毫秒级),
 *  覆盖 query 头部约 33 个汉字的去重 bigram(连续 n 字产 n-1 个 2-gram)——足以覆盖一句真实提问;
 *  超长 query 的语义信号主要由 HNSW 向量路承担,BM25 取前缀 token 已足够拉回关键词降级块。 */
const MAX_BM25_QUERY_TOKENS = 32;

export function createSurrealKnowledgeIndexRepository(db: Surreal): SurrealKnowledgeIndexRepository {
  // epoch 照搬 sqlite/in-memory:进程内单调计数,deleteAll 递增(不持久化)。
  let epoch = 0;
  const idOf = (chunkId: string) => new RecordId(KNOWLEDGE_CHUNK_TABLE, chunkId);
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
    bumpEpoch() { epoch += 1; },   // R2b:治理事务清空知识表后调用(SQL 直清不经 deleteAll,须显式代际递增)
    /** R2c · 原生混合召回(P6 收敛):HNSW(kc_emb)+ BM25(kc_ft)+ search::rrf 融合,
     *  照 recallRagChunks 的成熟模式(packages/db surreal-product-state-repository.ts),含全部坑规避:
     *  - KNN 的 k/ef **只接受字面量插值**(参数绑定会让索引路径失效)→ 数字钳制后模板插值,防注入;
     *  - LET 子查询里**不能叠加额外 AND 过滤**(索引路径失效、子查询恒空)→ 两路保持纯索引。
     *    knowledge_chunk 无行级门控列(敏感/未确认内容在摄入侧就不切进索引,见域层 buildKnowledgeChunks),
     *    故最终 SELECT 也无需门控 WHERE——P2a「门控移到最终 SELECT」在本表没有门控可移;
     *  - search::rrf 入参须 `SELECT id`(非 VALUE);
     *  - `WHERE id IN …` 取回不保序 → 末条 RETURN rrf 名次,JS 侧按名次重排(混合路按 rrf 名次降序
     *    返回;BM25-only 路是**无序候选截断**,见分支注释——最终排序一律归消费点精排);
     *  - 三级降级:混合失败/为空 → 纯 HNSW → [];无 embedding → BM25-only(无嵌入的关键词降级块
     *    HNSW 索引不含,由 BM25 路可达);query 切不出 token → 纯 HNSW。
     *  epoch 是进程内计数、不落库(表无 epoch 列),召回无需也无法按代际过滤——清空即物理删,
     *  陈旧代际的块不可能存在于表内(R8-1 守卫拦的是"清空后回写",与读路径无关)。
     *  记档(rule-of-three 已触发,独立小重构,不在 R2c 面内):memory / rag_chunk / knowledge_chunk
     *  三实例的混合召回机械件(search::analyze 切 token→bmClause 拼接、rrf 名次 JS 重排、k/ef 钳制)
     *  已是第三份手抄——宜提炼共享纯函数 helper(如 buildBm25Clause/orderByRrfRank),三处消费。 */
    async searchHybrid({ text, embedding, limit }) {
      // k/ef 走字面量插值(KNN 坑)→ 必须先数字化钳制(NaN/0/负数/小数 → 合法正整数)。
      const k = Math.max(1, Math.floor(Number.isFinite(limit) ? limit : 1));
      const ef = Math.max(k * 4, 40);
      const emb = Array.isArray(embedding) && embedding.length > 0 ? embedding : undefined;
      const queryText = text.trim();

      // 纯 HNSW 基线:直接 SELECT 可用(P2a 脆弱性仅在 LET 子查询);无 embedding → [](由消费点回落)。
      const hnswOnly = async (): Promise<KnowledgeChunk[]> => {
        if (!emb) return [];
        const [rows] = await db.query<[Array<Record<string, unknown>>]>(
          `SELECT * FROM knowledge_chunk WHERE embedding <|${k},${ef}|> $q;`,
          { q: emb }
        );
        return (rows ?? []).map(mapRow);
      };

      if (!queryText) return hnswOnly();

      try {
        const tokensRes = await db.query<[string[]]>("RETURN search::analyze('zh', $t);", { t: queryText });
        const rawTokens = Array.isArray(tokensRes?.[0]) ? (tokensRes[0] as unknown[]).map(String).filter(Boolean) : [];
        // 去重 + 钳制(见 MAX_BM25_QUERY_TOKENS):去重不改 OR 语义,钳制防用户长文本撑爆语句。
        const tokens = [...new Set(rawTokens)].slice(0, MAX_BM25_QUERY_TOKENS);
        // fail-safe:query 切不出 token(纯符号/emoji 等)→ 无 BM25 可加,退化纯 HNSW。
        if (tokens.length === 0) return hnswOnly();

        const tokenVars: Record<string, unknown> = {};
        const bmClause = tokens.map((tok, i) => { tokenVars[`t${i}`] = tok; return `text @@ $t${i}`; }).join(" OR ");

        if (!emb) {
          // BM25-only:无向量时关键词路单独可用——嵌入失败/离线摄入的无嵌入块由此可达。
          // ⚠️ 无序候选截断:LIMIT 无 ORDER BY(3.x ORDER BY 不能用函数表达式,无法按 BM25 分排),
          // 截掉的是候选集本身而非"BM25 top-k"——返回序不承诺分数序,排序契约归消费点精排。
          const [rows] = await db.query<[Array<Record<string, unknown>>]>(
            `SELECT * FROM knowledge_chunk WHERE (${bmClause}) LIMIT ${k};`,
            tokenVars
          );
          return (rows ?? []).map(mapRow);
        }

        // 混合:两路纯索引 LET → search::rrf 融合 → SELECT * 取回完整块 + RETURN 名次供 JS 重排。
        const results = await db.query<Array<unknown>>(
          `LET $vec = (SELECT id FROM knowledge_chunk WHERE embedding <|${k},${ef}|> $q);
           LET $bm  = (SELECT id FROM knowledge_chunk WHERE ${bmClause});
           LET $fused = search::rrf([$vec, $bm], 60, ${k});
           SELECT * FROM knowledge_chunk WHERE id IN $fused.map(|$r| $r.id);
           RETURN $fused.map(|$r| $r.id);`,
          { q: emb, ...tokenVars }
        );
        const rows = ((results[results.length - 2] ?? []) as Array<Record<string, unknown>>).map(mapRow);
        // fail-safe:融合为空(rrf 在该 query 下无产出)→ 退化纯 HNSW,绝不无声空召回。
        if (rows.length === 0) return hnswOnly();
        const order = ((results[results.length - 1] ?? []) as unknown[]).map((rid) => domainIdOf(rid));
        const rank = new Map(order.map((rid, idx) => [rid, idx] as const));
        return rows.sort((a, b) => (rank.get(a.id) ?? order.length) - (rank.get(b.id) ?? order.length));
      } catch (err) {
        // fail-safe:search::rrf / BM25 在该环境不可用或报错 → 退化纯 HNSW,记降级日志。
        console.warn(JSON.stringify({ event: "surreal_knowledge_recall_degraded", error: err instanceof Error ? err.message : String(err) }));
        return hnswOnly();
      }
    },
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
  // 冷层三库(与热态同连接;R2b 治理事务要跨冷热单事务)。knowledgeIndex 先建,好把 bumpEpoch
  // 交给治理事务(SQL 直清知识表后须显式代际递增,见 SurrealKnowledgeIndexRepository)。
  const rawMaterial = createSurrealRawMaterialRepository(db);
  const audio = createSurrealAudioRepository(db);
  const knowledgeIndex = createSurrealKnowledgeIndexRepository(db);
  // 热态仓库不拥有连接(ownsConnection=false),由本工厂 close() 统一关一次。
  // R2b:传入 governance 配置 → 热态 handle 暴露 runGovernanceTransaction(治理事务能力)。
  // 只有 createSurrealStores 这条装配路径(冷热共用一个嵌入式连接)才配得治理事务能力;
  // standalone 的 createSurrealProductStateRepository(dual-surreal 走它、冷层却是 sqlite)不传,
  // 故其 handle 无此方法 → asGovernanceTx 探测不到 → 路由回落既有 journal/best-effort 路径。
  const productState = await buildSurrealProductStateRepositoryOnConnection(db, {
    ownsConnection: false,
    governance: { onKnowledgeIndexWiped: () => knowledgeIndex.bumpEpoch() },
  });
  return {
    productState,
    rawMaterial,
    audio,
    knowledgeIndex,
    async close() {
      await productState.flush();   // 排空 persist 队列后再关连接
      await db.close();
    },
  };
}
