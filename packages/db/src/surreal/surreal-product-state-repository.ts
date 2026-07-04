import { RecordId } from "surrealdb";
import type { Surreal } from "surrealdb";
import type { ProductStateRepository, ReplaceStateOptions } from "../../../../apps/api/src/product-state-repository";
import { StateRevisionConflictError } from "../../../../apps/api/src/product-state-repository";
import { createInitialProductState, createEmptyProductState } from "../../../../src/domain/engine";
import { normalizeProductState } from "../../../../src/domain/storage";
import type { ProductState } from "../../../../src/domain/types";
import { createSurrealConnection, type SurrealConnectionOptions } from "./connect";
import { applySchema } from "./apply-schema";
import { NODE_MAPPINGS, toRecord, fromRecord } from "./node-mapper";
import { collectEdges, turnRecordsOf, type EdgeSpec } from "./edge-mapper";
import { diffById, diffEdges } from "./diff";

const META_ID = "state_meta:main";

/** 各节点表上带 `DEFAULT time::now()` 的 datetime 列(对齐 001_nodes.surql)。
 *  3.x 坑:`UPSERT ... CONTENT` 覆盖已存在记录时**不重跑 DEFAULT**,这些 SCHEMAFULL
 *  datetime 列会变 NONE 而 coerce 失败。故 persist 用 UPSERT 全量覆盖时必须显式补值
 *  (从实体 rest 里的同名 ISO 取,转 Date;无则 now)。注:这些列的真值仍在 rest 内无损,
 *  typed 列只为满足 schema;loadState/fromRecord 行为不变(见该函数注释)。
 *  ⚠️ 新增带 DEFAULT 的 datetime 列时,务必同步此表,否则 UPSERT 覆盖会静默 coerce 失败。 */
export const DATETIME_DEFAULT_COLS: Record<string, readonly string[]> = {
  session: ["startedAt"],
  turn: ["timestamp"],
  note: ["createdAt"],
  point: ["updatedAt"],
  decision: ["updatedAt"],
  debt: ["updatedAt"],
  question: ["updatedAt"],
  theme: ["updatedAt"],
  memory: ["createdAt", "updatedAt"],
  memory_candidate: ["createdAt"],
  material: ["createdAt"],
  rag_chunk: ["createdAt"],
  search_brief: ["createdAt"],
};

/** 把记录补成"可被 UPSERT CONTENT 全量覆盖"的形态:
 *  ① `rest` 必有(turn 表 rest 也 DEFAULT {},CONTENT 覆盖不重跑 DEFAULT);
 *  ② 该表所有 DEFAULT datetime 列补成 Date(值取自 rest 里同名 ISO,无则 now)。 */
function fillUpsertDefaults(table: string, rec: Record<string, unknown>): Record<string, unknown> {
  if (rec.rest === undefined) rec.rest = {};
  const rest = (rec.rest && typeof rec.rest === "object") ? rec.rest as Record<string, unknown> : {};
  for (const col of DATETIME_DEFAULT_COLS[table] ?? []) {
    const existing = rec[col] ?? rest[col];
    rec[col] = existing instanceof Date ? existing
      : (typeof existing === "string" || typeof existing === "number") ? new Date(existing)
      : new Date();
  }
  return rec;
}

/** 运维尾巴:不进节点表、整体存 state_meta.rest 的 ProductState 键。
 *  导出供分区完整性守卫测试用(防将来新增 ProductState 数组未映射被静默丢弃)。 */
export const META_KEYS = [
  "profile","profileSuggestions","interviewAnnotations","chatSessions","memoryCorrections",
  "podcastEpisodes","corpusImports","corpusInsights","playbookPatches",
  "configVersions","auditEvents","aiRunEvents","workflowRuns","operationalChecks",
  "systemConfig","schemaVersion"
] as const;

/** E:权威库异步落库健康度。dual-surreal 下 surreal 是权威库,持续 persist 失败=静默丢数据,
 *  须经此暴露给 /api/health。consecutiveFailures>0 即上次落库未成功(基线未推进,正自愈重试)。 */
export interface PersistHealth {
  consecutiveFailures: number;
  lastError?: string;
  lastErrorAt?: string;
}

export interface SurrealRepoHandle extends ProductStateRepository {
  /** 等待所有挂起的异步落库完成(测试/优雅关闭用)。 */
  flush(): Promise<void>;
  /** E:权威库落库健康度(连续失败计数/最后错误)。/api/health 用以感知 dual-surreal 静默丢数据。 */
  getPersistHealth(): PersistHealth;
  /** 关闭底层连接(测试/关闭用)。 */
  close(): Promise<void>;
  /** 仅测试/诊断用:直查底层 db(读边等)。生产路径不应依赖。 */
  query<T extends unknown[]>(surql: string, vars?: Record<string, unknown>): Promise<T>;
  /** 主题聚合:指向该 theme 的所有资产 id(图入边,含曾漏 decisions)。仅 surreal。 */
  recallThemeAssets(themeId: string): Promise<{ points: string[]; decisions: string[]; questions: string[]; memories: string[] }>;
  /** 溯源:沿 derived_from 取某资产的证据 turn。敏感纵深门控:来源资产 sensitivity='sensitive'
   *  (memory/memory_candidate/material)默认不溯源——A4 挡住敏感记忆本体后,证据 turn 原话
   *  不该再经溯源这条侧路泄出;includeSensitive 显式放行。point/decision 无 sensitivity 列不受影响。 */
  recallProvenanceTurns(table: string, id: string, opts?: { includeSensitive?: boolean }): Promise<Array<{ id: string; content: string; sessionId: string; role: string }>>;
  /** 记忆混合召回(HNSW 语义 + BM25 关键词,search::rrf 倒数排名融合)。
   *  传 queryText → 叠加 BM25(补 HNSW 对专名/精确词的盲区);无/空 queryText 或 BM25 在 3.x 不可用
   *  → 退化为纯 HNSW(现状)。A4 门控始终:默认仅 confirmed+normal;includeSensitive 含 sensitive。 */
  recallMemoriesByVector(embedding: number[], k: number, opts?: { includeSensitive?: boolean; queryText?: string }): Promise<Array<{ id: string; text: string }>>;
  /** rag_chunk 原生混合召回(HNSW+BM25+search::rrf,镜像 recallMemoriesByVector;方案一)。
   *  usage 门控走参数绑定、只出现在纯 SELECT 的 WHERE(LET 子查询保持纯索引,P2a 教训);
   *  无 embedding → BM25-only(无嵌入的降级摄入块也因此可达);embedding/queryText 皆缺 → []。 */
  recallRagChunks(opts: { embedding?: number[]; queryText?: string; k: number; usage?: "interview-context" | "memory-candidate" }): Promise<Array<{ id: string; text: string }>>;
  /** 图↔软链一致性审计(方案二):collectEdges(lastPersisted) 期望边集 vs DB 实际边集。
   *  排除 append-only 豁免的 part_of(降冷后内存不投影但 DB 保留是 H1 契约的正确行为)。
   *  串入 persist 队列执行(不跨半个落库事务出暂态假差异);只读、不修复、不阻断。 */
  auditGraphConsistency(): Promise<GraphConsistencyReport>;
}

/** 方案二审计报告:missing=期望有而 DB 无(投影漏写),unexpected=DB 有而期望无(漏删/带外写入)。
 *  样本各截前 20 条(edgeKey 形如 `belongs_to_theme|point:pt_1->theme:th_1`),计数为全量。
 *  danglingProvenanceCount:④ 根修的对偶——内存 anchor 指向已被 A5 级联删除的 turn,持久层
 *  按 DB 真相未投影该 derived_from(非漂移,turn 真的不存在),在此单列而不进 missing。 */
export interface GraphConsistencyReport {
  ok: boolean;
  auditedEdgeTables: string[];
  expectedCount: number;
  actualCount: number;
  missingCount: number;
  unexpectedCount: number;
  missingInDb: string[];
  unexpectedInDb: string[];
  danglingProvenanceCount: number;
  /** P0-1 观测补盲(全系统审查):节点表内存↔DB 差异——此前只审 5 边表,rag_chunk 级联静默
   *  删除这类"节点在内存、不在 DB"的发散零信号。turn 表豁免(append-only,DB 合法多于内存)。 */
  nodeMissingCount: number;
  nodeUnexpectedCount: number;
  nodeMissingInDb: string[];
  nodeUnexpectedInDb: string[];
}

export type SurrealRepoOptions = SurrealConnectionOptions;

/** 瞬态 persist 冲突重试间隔(共 1+4 次尝试,累计 ~3.2s)。
 *  定性更正(E2E 根因闭环):此前观测到的 "failed transaction" 实为悬空溯源的确定性拒绝
 *  (H1×A5 碰撞,已由 keepOnlyLiveTurnProvenance 根修),重试对其无效也不再需要。
 *  本阶梯保留作纯保险:万一将来出现真正的时间性引擎冲突(并发读写/HNSW 维护),写侧自恢复;
 *  正常路径零开销(首试即成功不进阶梯)。 */
const PERSIST_RETRY_DELAYS_MS = [100, 300, 800, 2000] as const;

/** 瞬态可重试错误:嵌入式引擎乐观事务冲突的统一报文("The query was not executed due to a
 *  failed transaction")。schema ASSERT/字段 coerce 等数据形状错误不匹配 → 不重试(重试必然
 *  再失败,徒增延迟且掩盖真错)。导出供单测钉住判别口径。 */
export function isTransientPersistError(err: unknown): boolean {
  return /failed transaction/i.test(err instanceof Error ? err.message : String(err));
}

export async function createSurrealProductStateRepository(opts: SurrealRepoOptions): Promise<SurrealRepoHandle> {
  const db = await createSurrealConnection(opts);
  await applySchema(db);

  // 内存工作副本:同步接口的真相源。
  const loaded = await loadState(db);
  let state: ProductState = loaded.state;
  // diff 基线:上次成功落库的状态(非内存 state)。失败不更新 → 下次 diff 自动补回漏掉的增量(自愈)。
  // 处女库(无 state_meta):loadState 捏造 createInitialProductState 作内存态,但 DB 里并没有它——
  // 基线若也设成捏造态就是【基线谎言】:此后所有 diff 都以为种子实体已在库,演示资产/其边永不落库
  // (原生 recallThemeAssets 漏召回、dual 双写发散;图审计冒烟实测抓到)。基线设空 + 下方立即
  // enqueue 首次落库,让 DB 真实收敛到内存态。
  let lastPersisted: ProductState = loaded.fromDb ? loaded.state : createEmptyProductState();
  let persistQueue: Promise<void> = Promise.resolve();
  // E:权威库落库健康度。成功清零、失败累积——dual-surreal 下持续写不进=静默丢数据,必须可观测。
  let persistHealth: PersistHealth = { consecutiveFailures: 0 };

  function enqueuePersist(snapshot: ProductState) {
    persistQueue = persistQueue
      .then(async () => {
        // 瞬态冲突有界重试(P4 真实业务 E2E 实测):原生召回读(HNSW/BM25/图遍历)与 persist
        // 写事务在同一嵌入式连接上并发时,surrealkv 乐观事务偶发 "failed transaction"——
        // P4 修通生产可达性之前原生读不存在,故此前从未暴露。读绝不串行化(教训 6fca26b4:
        // 不把任何东西塞进写串行化),写侧立即有界重试即可;非瞬态错误(schema ASSERT 等)
        // 不重试直接 fail-loud。重试全败 → 基线不动,自愈兜底(下次写以旧基线 diff 补回)。
        let lastErr: unknown;
        for (let attempt = 0; attempt <= PERSIST_RETRY_DELAYS_MS.length; attempt++) {
          try {
            if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, PERSIST_RETRY_DELAYS_MS[attempt - 1]));
            await persist(db, lastPersisted, snapshot);
            lastPersisted = snapshot;                 // 仅成功后推进基线
            persistHealth = { consecutiveFailures: 0 };
            if (attempt > 0) console.warn(JSON.stringify({ event: "surreal_persist_retried_ok", attempt }));
            return;
          } catch (err) {
            lastErr = err;
            if (!isTransientPersistError(err)) break;
          }
        }
        throw lastErr;
      })
      .catch((err) => {
        // fail-loud:基线不动,下次 persist 以旧基线 diff、补回本次漏写(自愈)。
        // 连续失败计数随告警一起出——dual-surreal 下持续写不进权威库=静默丢数据,/api/health 须能感知。
        persistHealth = {
          consecutiveFailures: persistHealth.consecutiveFailures + 1,
          lastError: String(err),
          lastErrorAt: new Date().toISOString()
        };
        console.error(JSON.stringify({
          event: "surreal_persist_failed",
          consecutiveFailures: persistHealth.consecutiveFailures,
          error: persistHealth.lastError,
          // 诊断(E2E 实测:失败跨满整个重试阶梯=该笔 diff 形状确定性触发引擎约束,非时间性冲突;
          // 下一笔累积 diff 即成功、自愈不丢数据)。打 diff 摘要,把"哪种形状会触发"变成可观测。
          diff: summarizePersistDiff(lastPersisted, snapshot)
        }));
      });
  }

  // 处女库首次落库:把捏造的初始态真正写进 DB(见 lastPersisted 基线注释)。经正常串行队列,
  // 幂等(落库后 state_meta 存在,后续启动走 fromDb 分支)。
  if (!loaded.fromDb) enqueuePersist(state);

  return {
    getState() { return structuredClone(state); },
    getPersistHealth() { return { ...persistHealth }; },
    resetState() {
      state = createEmptyProductState();
      enqueuePersist(state);
      return structuredClone(state);
    },
    replaceState(next: ProductState, replaceOpts?: ReplaceStateOptions) {
      const currentRevision = state.revision ?? 0;
      if (replaceOpts?.expectedRevision !== undefined && replaceOpts.expectedRevision !== currentRevision) {
        throw new StateRevisionConflictError(replaceOpts.expectedRevision, currentRevision);
      }
      state = normalizeProductState({ ...next, revision: currentRevision + 1 });
      enqueuePersist(state);
      return structuredClone(state);
    },
    getInterviewSession(id: string) {
      return state.sessions.find((s) => s.id === id) ?? null;
    },
    async flush() { await persistQueue; },
    async close() { await persistQueue; await db.close(); },
    query<T extends unknown[]>(surql: string, vars?: Record<string, unknown>) { return db.query<T>(surql, vars) as Promise<T>; },
    async recallThemeAssets(themeId: string) {
      const t = new RecordId("theme", themeId);
      const pick = async (sql: string): Promise<string[]> => {
        const [rows] = await db.query<[unknown[]]>(sql, { t });
        const arr = (rows?.[0] as Array<unknown> | undefined) ?? [];
        return arr.map((r) => recordIdToDomainId((r as { id?: unknown })?.id ?? r));
      };
      const [points, decisions, questions, memories] = await Promise.all([
        pick("SELECT VALUE <-belongs_to_theme<-point FROM $t;"),
        pick("SELECT VALUE <-belongs_to_theme<-decision FROM $t;"),
        pick("SELECT VALUE <-belongs_to_theme<-question FROM $t;"),
        pick("SELECT VALUE <-about_theme<-memory FROM $t;")
      ]);
      return { points, decisions, questions, memories };
    },
    async recallProvenanceTurns(table: string, id: string, provOpts?: { includeSensitive?: boolean }) {
      const from = new RecordId(table, id);
      const includeSensitive = provOpts?.includeSensitive ?? false;
      // D 溯源门控:已放弃/已修正的观点、deprecated/deleted 的资产不再溯源——这些是用户或系统
      // 已废弃的认知,不该再把它们的证据 turn 原话喂进 LLM 引导。WHERE 作用在来源资产 $from 上,
      // 终态则查无、返回空。
      // 敏感纵深(方案三,审计报告 P2):sensitivity='sensitive' 的来源资产(memory/material 等)
      // 默认不溯源——A4 挡住敏感记忆本体后,其证据 turn 原话不该经溯源侧路泄出;
      // point/decision 等无 sensitivity 列的资产取值 NONE → IS NONE 放行,行为不变。
      const [rows] = await db.query<[Array<Record<string, unknown>>]>(
        "SELECT VALUE ->derived_from->turn.* FROM $from WHERE status NOT IN ['已放弃','已修正','deprecated','deleted'] AND (sensitivity IS NONE OR sensitivity = 'normal' OR $includeSensitive);",
        { from, includeSensitive }
      );
      const turns = (rows?.[0] as unknown as Array<Record<string, unknown>> | undefined) ?? [];
      return turns.map((t) => ({
        id: recordIdToDomainId(t.id), content: String(t.content ?? ""),
        sessionId: String(t.sessionId ?? ""), role: String(t.role ?? "")
      }));
    },
    async recallMemoriesByVector(embedding: number[], k: number, recallOpts?: { includeSensitive?: boolean; queryText?: string }) {
      const includeSensitive = recallOpts?.includeSensitive ?? false;
      const queryText = recallOpts?.queryText?.trim();

      // 纯 HNSW(现状 / 退化基线)。A4:status='confirmed' 必须;sensitivity 默认仅 normal。
      // 3.x:KNN 算子 <|k,ef|> 已按余弦相似度近似排序;ORDER BY 不能用函数表达式
      //      (报 "Missing order idiom vector"),故去掉 ORDER BY,靠 KNN 本身的近邻序。
      //      注:<|k,ef|> 只接受字面量($k 报 "expected an unsigned integer"),故 k/ef 插值。
      const ef = Math.max(k * 4, 40);
      const hnswOnly = async (): Promise<Array<{ id: string; text: string }>> => {
        const [rows] = await db.query<[Array<Record<string, unknown>>]>(
          `SELECT id, text FROM memory
             WHERE status = 'confirmed'
               AND (sensitivity = 'normal' OR $includeSensitive)
               AND embedding <|${k},${ef}|> $q;`,
          { q: embedding, includeSensitive }
        );
        const hits = (rows ?? []) as Array<{ id: unknown; text: unknown }>;
        return hits.map((h) => ({ id: recordIdToDomainId(h.id), text: String(h.text ?? "") }));
      };

      // fail-safe:无 queryText → 纯 HNSW(绝不破坏召回)。
      if (!queryText) return hnswOnly();

      try {
        // ③ 混合检索:HNSW(语义)+ BM25(关键词)→ search::rrf 倒数排名融合(实测 @3.0.2)。
        //
        // 3.0.2 实测要点(本轮 spike 锁定):
        //  · search::rrf([resultSetA, resultSetB], k, limit):入参是「结果集数组的数组」,每个
        //    结果集须为 [{id}, ...](即 `SELECT id`,不能 `SELECT VALUE id` 裸 RecordId,否则恒返 [])。
        //    返回 [{ id, rrf_score }],按融合名次降序。limit 必传(漏则报 "limit must be a number")。
        //  · BM25 用 ngram(2,2) analyzer 时,裸 `@@ '多字词'`(及 @AND@/@OR@)对**多 token** query
        //    恒不命中(token 切分后匹配条件不满足);**单 token `@@` 才命中**。故把 queryText 经
        //    `search::analyze` 切成 ngram,逐 token `text @@ $tN` 用 OR 串联,等价 OR 召回。
        //  · ⚠️ KNN/BM25 子查询里**不能再叠加额外 AND 过滤**:`... AND embedding <|k,ef|> $q` 放进
        //    `LET` 绑定时索引路径失效、子查询恒空(同 P2a 的 KNN 脆弱性)。故两路保持「纯索引」,
        //    A4 门控移到**最终取回 SELECT**(强度等同:confirmed + sensitivity)。
        const tokensRes = await db.query<[string[]]>("RETURN search::analyze('zh', $t);", { t: queryText });
        const tokens = Array.isArray(tokensRes?.[0]) ? (tokensRes[0] as unknown[]).map(String).filter(Boolean) : [];
        // fail-safe:query 切不出 token → 无 BM25 可加,退化纯 HNSW。
        if (tokens.length === 0) return hnswOnly();

        const tokenVars: Record<string, unknown> = {};
        const bmClause = tokens.map((tok, i) => { tokenVars[`t${i}`] = tok; return `text @@ $t${i}`; }).join(" OR ");

        const results = await db.query<Array<Array<Record<string, unknown>>>>(
          `LET $vec = (SELECT id FROM memory WHERE embedding <|${k},${ef}|> $q);
           LET $bm  = (SELECT id FROM memory WHERE ${bmClause});
           LET $fused = search::rrf([$vec, $bm], 60, ${k});
           SELECT id, text FROM memory
             WHERE id IN $fused.map(|$r| $r.id)
               AND status = 'confirmed'
               AND (sensitivity = 'normal' OR $includeSensitive);`,
          { q: embedding, includeSensitive, ...tokenVars }
        );
        // 多语句:前 3 个 LET 返回 null,取最后一条 SELECT 的结果集(不能取 results[0])。
        const fusedRows = results[results.length - 1];
        // fail-safe:融合空(rrf 在该 query 下无产出)→ 退化纯 HNSW,绝不返空召回。
        const fused = (fusedRows ?? []) as Array<{ id: unknown; text: unknown }>;
        if (fused.length === 0) return hnswOnly();
        return fused.map((h) => ({ id: recordIdToDomainId(h.id), text: String(h.text ?? "") }));
      } catch (err) {
        // fail-safe:search::rrf / BM25 在该环境不可用或报错 → 退化纯 HNSW(现状),记降级日志。
        console.warn(JSON.stringify({ event: "surreal_hybrid_recall_degraded", error: err instanceof Error ? err.message : String(err) }));
        return hnswOnly();
      }
    },
    async recallRagChunks(ragOpts: { embedding?: number[]; queryText?: string; k: number; usage?: "interview-context" | "memory-candidate" }) {
      const k = Math.max(1, Math.floor(ragOpts.k));
      const ef = Math.max(k * 4, 40);
      const embedding = Array.isArray(ragOpts.embedding) && ragOpts.embedding.length > 0 ? ragOpts.embedding : undefined;
      const queryText = ragOpts.queryText?.trim();
      // usage 门控:值走参数绑定;未指定 usage → $anyUsage 恒真放行(与 A4 `(…='normal' OR $includeSensitive)` 同型)。
      const usageGate = "(usage = $usage OR $anyUsage)";
      const gateVars: Record<string, unknown> = { usage: ragOpts.usage ?? "", anyUsage: !ragOpts.usage };
      const toHits = (rows: unknown): Array<{ id: string; text: string }> =>
        ((rows ?? []) as Array<{ id: unknown; text: unknown }>).map((h) => ({ id: recordIdToDomainId(h.id), text: String(h.text ?? "") }));

      // 纯 HNSW 基线:直接 SELECT 可叠 AND 过滤(镜像 memory hnswOnly,P2a 脆弱性仅在 LET 子查询)。
      // 无 embedding → [](调用方回落域层排序,绝不伪造)。
      const hnswOnly = async (): Promise<Array<{ id: string; text: string }>> => {
        if (!embedding) return [];
        const [rows] = await db.query<[Array<Record<string, unknown>>]>(
          `SELECT id, text FROM rag_chunk WHERE ${usageGate} AND embedding <|${k},${ef}|> $q;`,
          { q: embedding, ...gateVars }
        );
        return toHits(rows);
      };

      if (!queryText) return hnswOnly();

      try {
        const tokensRes = await db.query<[string[]]>("RETURN search::analyze('zh', $t);", { t: queryText });
        const tokens = Array.isArray(tokensRes?.[0]) ? (tokensRes[0] as unknown[]).map(String).filter(Boolean) : [];
        if (tokens.length === 0) return hnswOnly();

        const tokenVars: Record<string, unknown> = {};
        const bmClause = tokens.map((tok, i) => { tokenVars[`t${i}`] = tok; return `text @@ $t${i}`; }).join(" OR ");

        if (!embedding) {
          // BM25-only:无向量时关键词路单独可用——无嵌入的降级摄入块(HNSW 索引不含它们)由此可达。
          const [rows] = await db.query<[Array<Record<string, unknown>>]>(
            `SELECT id, text FROM rag_chunk WHERE ${usageGate} AND (${bmClause}) LIMIT ${k};`,
            { ...gateVars, ...tokenVars }
          );
          return toHits(rows);
        }

        // 混合:两路纯索引 LET → search::rrf 融合 → 最终 SELECT 叠 usage 门控(P2a:LET 内绝不加 AND)。
        // 末条 RETURN 融合名次:`WHERE id IN …` 取回不保序;memory 路径有域层三因子精排兜着可容忍,
        // rag 无精排、名次即最终序,必须按 rrf 名次在 JS 侧重排。
        const results = await db.query<Array<unknown>>(
          `LET $vec = (SELECT id FROM rag_chunk WHERE embedding <|${k},${ef}|> $q);
           LET $bm  = (SELECT id FROM rag_chunk WHERE ${bmClause});
           LET $fused = search::rrf([$vec, $bm], 60, ${k});
           SELECT id, text FROM rag_chunk WHERE id IN $fused.map(|$r| $r.id) AND ${usageGate};
           RETURN $fused.map(|$r| $r.id);`,
          { q: embedding, ...gateVars, ...tokenVars }
        );
        const rows = toHits(results[results.length - 2]);
        // fail-safe:融合为空 / 全被 usage 门控滤掉 → 退化纯 HNSW,绝不返空召回。
        if (rows.length === 0) return hnswOnly();
        const order = ((results[results.length - 1] ?? []) as unknown[]).map((rid) => recordIdToDomainId(rid));
        const rank = new Map(order.map((rid, idx) => [rid, idx] as const));
        return rows.sort((a, b) => (rank.get(a.id) ?? order.length) - (rank.get(b.id) ?? order.length));
      } catch (err) {
        // fail-safe:search::rrf / BM25 报错 → 退化纯 HNSW(有 embedding)或 [](无),记降级日志。
        console.warn(JSON.stringify({ event: "surreal_rag_recall_degraded", error: err instanceof Error ? err.message : String(err) }));
        return hnswOnly();
      }
    },
    async auditGraphConsistency() {
      // 串入 persist 队列:与落库事务互斥,五张边表的 SELECT 不会跨在半个 persist 中间(暂态假差异);
      // 基线取执行时刻的 lastPersisted(队列排空后 = 最新成功落库态,persist 失败时基线不动、
      // DB 也没动,比对依然成立)。审计只读、5 个小 SELECT 毫秒级——不构成写路径长阻塞
      // (教训 6fca26b4:长任务绝不进写串行化;这里刻意保持极小)。
      const run = persistQueue.then(() => runGraphAudit(db, lastPersisted));
      persistQueue = run.then(() => undefined, () => undefined); // 审计失败不毒化落库队列
      return run;
    },
  };
}

/** ④ 根修:过滤 turn 端点已不存在的 derived_from 新增边(端点在本事务 upsert 集 → 必然存在,跳过;
 *  其余批量查 DB 实存)。只在存在此类候选时多一个 ms 级 SELECT(降冷 finalize / 重引入场景),
 *  常规流(anchor 指向活跃会话 turn)零额外开销。
 *  P0-2:removedSessionIds = 本事务将删除的 session——其 turn 将被 A5 在同一事务内级联删除,
 *  预查时刻仍实存,必须按 provenance.sessionId 直接判死,不能只信 DB 预查。 */
async function keepOnlyLiveTurnProvenance(
  db: Surreal,
  added: EdgeSpec[],
  nextTurnIds: Set<string>,
  removedSessionIds: Set<string>
): Promise<EdgeSpec[]> {
  const candidates = added.filter((e) => e.edge === "derived_from" && e.toTable === "turn" && !nextTurnIds.has(e.toId));
  if (candidates.length === 0) return added;
  const doomed = (e: EdgeSpec) => {
    const sid = e.data?.provenance?.sessionId;
    return typeof sid === "string" && removedSessionIds.has(sid);
  };
  const toCheck = candidates.filter((e) => !doomed(e));
  const ids = [...new Set(toCheck.map((e) => e.toId))];
  const live = new Set<string>();
  if (ids.length > 0) {
    const [rows] = await db.query<[unknown[]]>("SELECT VALUE id FROM turn WHERE id IN $ids;", {
      ids: ids.map((id) => new RecordId("turn", id))
    });
    for (const r of rows ?? []) live.add(recordIdToDomainId(r));
  }
  const dropped = candidates.filter((e) => doomed(e) || !live.has(e.toId));
  if (dropped.length === 0) return added;
  console.warn(JSON.stringify({
    event: "surreal_dangling_provenance_dropped",
    count: dropped.length,
    sample: dropped.slice(0, 5).map((e) => `${e.fromTable}:${e.fromId}->turn:${e.toId}`)
  }));
  const droppedKeys = new Set(dropped.map((e) => `${e.fromTable}:${e.fromId}->${e.toId}`));
  return added.filter(
    (e) => !(e.edge === "derived_from" && e.toTable === "turn" && droppedKeys.has(`${e.fromTable}:${e.fromId}->${e.toId}`))
  );
}

/** persist 失败诊断:该笔 diff 的形状摘要(每表 upsert/delete 计数 + 边增删)。只在失败路径调用,
 *  正常路径零开销;计数足以定位"哪类 diff 触发引擎约束",不打内容(防敏感原话入日志)。 */
function summarizePersistDiff(prev: ProductState, next: ProductState): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  try {
    for (const m of NODE_MAPPINGS) {
      const prevArr = ((prev as unknown as Record<string, unknown>)[m.stateKey] as Array<{ id: string }>) ?? [];
      const nextArr = ((next as unknown as Record<string, unknown>)[m.stateKey] as Array<{ id: string }>) ?? [];
      const { upsert, removeIds } = diffById(prevArr, nextArr);
      if (upsert.length || removeIds.length) out[m.table] = `+${upsert.length}/-${removeIds.length}`;
    }
    const { added, removed } = diffEdges(collectEdges(prev), collectEdges(next));
    if (added.length || removed.length) {
      out.edges = `+${added.length}/-${removed.length}`;
      const byKind = (list: Array<{ edge: string }>) =>
        list.reduce<Record<string, number>>((acc, e) => { acc[e.edge] = (acc[e.edge] ?? 0) + 1; return acc; }, {});
      if (removed.length) out.edgesRemovedByKind = byKind(removed.filter((e) => e.edge !== "part_of"));
      if (added.length) out.edgesAddedByKind = byKind(added);
    }
  } catch {
    out.summaryError = true; // 诊断自身绝不再抛
  }
  return out;
}

/** 方案二:参与审计的边表 = edge-mapper 投影的全部边,排除 part_of(append-only 豁免,见接口注释)。
 *  promoted_from/corrects 是 schema 预留死表(edge-mapper 不投影、persist 不写),无审计意义。 */
const AUDITED_EDGE_TABLES = ["belongs_to_theme", "about_theme", "derived_from", "contradicts", "evolves_into"] as const;
const AUDIT_SAMPLE_LIMIT = 20;

function edgeKeyOf(edge: string, fromTable: string, fromId: string, toTable: string, toId: string): string {
  return `${edge}|${fromTable}:${fromId}->${toTable}:${toId}`;
}

function recordTableOf(id: unknown): string {
  // 3.x SDK:RecordId.table 是 Table 对象,String() 得表名(本库表名均为纯 ASCII,无转义差异)。
  if (id instanceof RecordId) return String(id.table);
  const s = String(id);
  return s.includes(":") ? s.slice(0, s.indexOf(":")) : s;
}

/** 图↔软链一致性核对:期望边集(collectEdges 投影,同 persist 用的同一函数 = 单一真值)
 *  vs DB 实际边集。用 persist 之外的独立读路径核对 persist 的写结果——公理引擎的图层对偶
 *  (A1 在应用层查 evidenceAnchors,这里在 DB 层核 derived_from 等边的完备性)。 */
async function runGraphAudit(db: Surreal, baseline: ProductState): Promise<GraphConsistencyReport> {
  const expected = new Set<string>();
  for (const e of collectEdges(baseline)) {
    if (e.edge === "part_of") continue;
    expected.add(edgeKeyOf(e.edge, e.fromTable, e.fromId, e.toTable, e.toId));
  }
  const actual = new Set<string>();
  for (const table of AUDITED_EDGE_TABLES) {
    const [rows] = await db.query<[Array<{ in: unknown; out: unknown }>]>(`SELECT in, out FROM ${table};`);
    for (const r of rows ?? []) {
      actual.add(edgeKeyOf(table, recordTableOf(r.in), recordIdToDomainId(r.in), recordTableOf(r.out), recordIdToDomainId(r.out)));
    }
  }
  let missingInDb = [...expected].filter((key) => !actual.has(key));
  const unexpectedInDb = [...actual].filter((key) => !expected.has(key));

  // ④ 对偶:missing 里的 derived_from|…->turn:X,若 turn:X 在 DB 已不存在(A5 级联删过),
  // 是持久层按 DB 真相的主动丢弃(keepOnlyLiveTurnProvenance),非投影漂移 → 归 dangling 单列。
  let danglingProvenanceCount = 0;
  const provenanceMisses = missingInDb.filter((key) => key.startsWith("derived_from|") && key.includes("->turn:"));
  if (provenanceMisses.length > 0) {
    const turnIds = [...new Set(provenanceMisses.map((key) => key.slice(key.lastIndexOf("->turn:") + "->turn:".length)))];
    const [rows] = await db.query<[unknown[]]>("SELECT VALUE id FROM turn WHERE id IN $ids;", {
      ids: turnIds.map((id) => new RecordId("turn", id))
    });
    const live = new Set((rows ?? []).map((r) => recordIdToDomainId(r)));
    const dangling = new Set(provenanceMisses.filter((key) => !live.has(key.slice(key.lastIndexOf("->turn:") + "->turn:".length))));
    danglingProvenanceCount = dangling.size;
    missingInDb = missingInDb.filter((key) => !dangling.has(key));
  }

  // P0-1 观测补盲:节点表核对(内存基线 vs DB 实际 id 集)。turn 豁免(append-only)。
  const nodeMissingInDb: string[] = [];
  const nodeUnexpectedInDb: string[] = [];
  for (const m of NODE_MAPPINGS) {
    const baselineIds = new Set(
      (((baseline as unknown as Record<string, unknown>)[m.stateKey] as Array<{ id: string }>) ?? []).map((e) => e.id)
    );
    const [rows] = await db.query<[unknown[]]>(`SELECT VALUE id FROM ${m.table};`);
    const dbIds = new Set((rows ?? []).map((r) => recordIdToDomainId(r)));
    for (const id of baselineIds) if (!dbIds.has(id)) nodeMissingInDb.push(`${m.table}:${id}`);
    for (const id of dbIds) if (!baselineIds.has(id)) nodeUnexpectedInDb.push(`${m.table}:${id}`);
  }

  return {
    ok:
      missingInDb.length === 0 && unexpectedInDb.length === 0 &&
      nodeMissingInDb.length === 0 && nodeUnexpectedInDb.length === 0,
    auditedEdgeTables: [...AUDITED_EDGE_TABLES],
    expectedCount: expected.size,
    actualCount: actual.size,
    missingCount: missingInDb.length,
    unexpectedCount: unexpectedInDb.length,
    missingInDb: missingInDb.slice(0, AUDIT_SAMPLE_LIMIT),
    unexpectedInDb: unexpectedInDb.slice(0, AUDIT_SAMPLE_LIMIT),
    danglingProvenanceCount,
    nodeMissingCount: nodeMissingInDb.length,
    nodeUnexpectedCount: nodeUnexpectedInDb.length,
    nodeMissingInDb: nodeMissingInDb.slice(0, AUDIT_SAMPLE_LIMIT),
    nodeUnexpectedInDb: nodeUnexpectedInDb.slice(0, AUDIT_SAMPLE_LIMIT)
  };
}

/** 从 SurrealDB 读全部节点表 + state_meta,重建 ProductState(规范化)。
 *  空库(无 state_meta)→ 捏造初始态并以 fromDb:false 标记——调用方必须据此把 diff 基线设空
 *  并立即首落库,否则初始态只存在于内存与基线、永不进 DB(基线谎言,见 createSurrealProductStateRepository)。 */
async function loadState(db: Surreal): Promise<{ state: ProductState; fromDb: boolean }> {
  const [metaRows] = await db.query<[Array<{ revision: number; rest: Record<string, unknown> }>]>(
    `SELECT revision, rest FROM ${META_ID};`
  );
  const meta = metaRows?.[0];
  if (!meta) return { state: createInitialProductState(), fromDb: false };

  const assembled: Record<string, unknown> = { ...(meta.rest ?? {}), revision: meta.revision };
  for (const m of NODE_MAPPINGS) {
    const [rows] = await db.query<[Array<Record<string, unknown>>]>(`SELECT * FROM ${m.table};`);
    assembled[m.stateKey] = (rows ?? []).map((r) => {
      const { id, ...rec } = r;
      return fromRecord(recordIdToDomainId(id), rec);
    });
  }
  return { state: normalizeProductState(assembled), fromDb: true };
}

/** SurrealDB 记录 id → 领域 id 字符串。
 *  3.x SDK 实际返回 RecordId 对象(instanceof RecordId);其 .id 段是领域 id。
 *  fallback:string 形如 `point:pt_1` 取冒号后段;其他 toString()。 */
function recordIdToDomainId(id: unknown): string {
  if (id instanceof RecordId) return String(id.id);
  if (typeof id === "string") return id.includes(":") ? id.slice(id.indexOf(":") + 1) : id;
  const anyId = id as { id?: unknown } | undefined;
  return anyId?.id !== undefined ? String(anyId.id) : String(id);
}

/** diff-upsert 落库:只写 prev→next 的增量(节点/turn 按 id diff,边按身份集差),单事务。
 *  prev = lastPersisted(上次成功落库态);最终 DB 态与全量覆盖等价,但写放大降到 O(变更)。
 *  ⚠️ UPSERT CONTENT 不重跑列 DEFAULT,故 upsert 记录先过 fillUpsertDefaults(同 P1b)。 */
async function persist(db: Surreal, prev: ProductState, next: ProductState): Promise<void> {
  let surql = "BEGIN TRANSACTION;\n";
  const vars: Record<string, unknown> = {};
  let i = 0;

  // 1) 节点表:diffById → UPSERT 变更 + DELETE 移除
  // P0-2 根修配套:收集本事务将删除的 session id——它们的 turn 会被 A5 级联在**同一事务内**
  // 删掉,新增的 derived_from 若指向这些 turn,事务前的实存预查(keepOnlyLiveTurnProvenance)
  // 会误放行 → RELATE ENFORCED 拒 → 整事务确定性失败(审查实测)。边过滤须感知本批删除集。
  const removedSessionIds = new Set<string>();
  for (const m of NODE_MAPPINGS) {
    const prevArr = ((prev as unknown as Record<string, unknown>)[m.stateKey] as Array<{ id: string }>) ?? [];
    const nextArr = ((next as unknown as Record<string, unknown>)[m.stateKey] as Array<{ id: string }>) ?? [];
    const { upsert, removeIds } = diffById(prevArr, nextArr);
    if (m.table === "session") for (const id of removeIds) removedSessionIds.add(id);
    for (const entity of upsert) {
      const rv = `r${i++}`;
      vars[rv] = fillUpsertDefaults(m.table, toRecord(entity as Record<string, unknown>, m));
      vars[`${rv}_id`] = entity.id;
      surql += `UPSERT type::record('${m.table}', $${rv}_id) CONTENT $${rv};\n`;
    }
    if (removeIds.length) {
      const dv = `del_${m.table}`;
      vars[dv] = removeIds.map((id) => new RecordId(m.table, id));
      surql += `DELETE ${m.table} WHERE id IN $${dv};\n`;
    }
  }

  // 2) turn 表:diffById,但**只 UPSERT 不 DELETE**(H1)。
  //    turn 是 append-only 冷层 occurrent:降冷(offloadCompletedSession)会从内存 state
  //    剥掉 session.turns,使 turnRecordsOf(next) 变空、diffById 把它们算进 removeIds。
  //    若执行该 DELETE,降冷会连带删掉 turn 节点 + derived_from/part_of 边 → 溯源召回失效。
  //    故 turn 永不删:只投影 upsert。`void removeIds` 显式弃用,避免 noUnusedLocals 报错。
  const nextTurnIds = new Set<string>();
  {
    const nextTurns = turnRecordsOf(next) as Array<Record<string, unknown> & { id: string }>;
    for (const t of nextTurns) nextTurnIds.add(String(t.id));
    const { upsert, removeIds } = diffById(
      turnRecordsOf(prev) as Array<Record<string, unknown> & { id: string }>,
      nextTurns,
    );
    void removeIds;
    for (const t of upsert) {
      const tv = `t${i++}`;
      vars[tv] = fillUpsertDefaults("turn", { ...t });
      vars[`${tv}_id`] = t.id;
      surql += `UPSERT type::record('turn', $${tv}_id) CONTENT $${tv};\n`;
    }
  }

  // 3) 边:diffEdges → DELETE 移除(WHERE in/out)+ RELATE 新增
  {
    const { added: addedRaw, removed } = diffEdges(collectEdges(prev), collectEdges(next));
    // ④ 根修(H1×A5 碰撞,E2E 复现+diff 形状诊断指认):derived_from 的 turn 端点在
    // "会话被真正删除(reset/purge,A5 级联按隐私语义删其 turn)后,其资产又被重新引入
    // (seed/备份导入,turns 已降冷不随行)"时不存在 → RELATE ENFORCED 拒 → 整事务确定性
    // 失败,该快照永不落库(自愈掩成'下一笔成功')。按 DB 真相过滤悬空溯源:turn 真的没了,
    // 不投影该边不是丢数据(recallProvenanceTurns 对它本就只能返回空);响亮记数。
    // P0-2 补盲(全系统审查实测):还须感知**本事务**将级联删除的 turn——removedSessionIds
    // 的 turn 在预查时刻仍"实存",单靠 DB 预查必误放行。
    const added = await keepOnlyLiveTurnProvenance(db, addedRaw, nextTurnIds, removedSessionIds);
    for (const e of removed) {
      // H1:part_of(turn→session)与 turn 同为 append-only,降冷剥 turns 时 collectEdges(next)
      //     不再投影它 → 进 removed,但不应删(turn 节点还在,part_of 是其归属事实)。跳过。
      //     derived_from 无需特判:edge-mapper #② 改为从资产 anchor 投影,降冷时资产仍在 →
      //     边仍被投影 → 不进 removed;只有资产被真正删除时其 anchor 消失,边才正确进 removed 被删。
      if (e.edge === "part_of") continue;
      const xv = `x${i++}`;
      vars[`${xv}_f`] = new RecordId(e.fromTable, e.fromId);
      vars[`${xv}_t`] = new RecordId(e.toTable, e.toId);
      surql += `DELETE ${e.edge} WHERE in = $${xv}_f AND out = $${xv}_t;\n`;
    }
    for (const e of added) {
      const ev = `e${i++}`;
      vars[`${ev}_f`] = new RecordId(e.fromTable, e.fromId);
      vars[`${ev}_t`] = new RecordId(e.toTable, e.toId);
      let rel = `RELATE $${ev}_f->${e.edge}->$${ev}_t`;
      if (e.data) { vars[`${ev}_d`] = e.data; rel += ` SET provenance = $${ev}_d.provenance`; }
      surql += rel + ";\n";
    }
  }

  // 4) state_meta:revision 每写必变,总是 UPSERT
  const meta: Record<string, unknown> = {};
  for (const k of META_KEYS) meta[k] = (next as unknown as Record<string, unknown>)[k];
  vars.meta = meta;
  vars.rev = next.revision ?? 0;
  surql += `UPSERT ${META_ID} SET revision = $rev, rest = $meta;\n`;
  surql += "COMMIT TRANSACTION;";

  await db.query(surql, vars);
}
