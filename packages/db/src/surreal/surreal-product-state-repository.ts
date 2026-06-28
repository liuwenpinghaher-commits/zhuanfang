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
import { collectEdges, turnRecordsOf } from "./edge-mapper";
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

export interface SurrealRepoHandle extends ProductStateRepository {
  /** 等待所有挂起的异步落库完成(测试/优雅关闭用)。 */
  flush(): Promise<void>;
  /** 关闭底层连接(测试/关闭用)。 */
  close(): Promise<void>;
  /** 仅测试/诊断用:直查底层 db(读边等)。生产路径不应依赖。 */
  query<T extends unknown[]>(surql: string, vars?: Record<string, unknown>): Promise<T>;
  /** 主题聚合:指向该 theme 的所有资产 id(图入边,含曾漏 decisions)。仅 surreal。 */
  recallThemeAssets(themeId: string): Promise<{ points: string[]; decisions: string[]; questions: string[]; memories: string[] }>;
  /** 溯源:沿 derived_from 取某资产的证据 turn。 */
  recallProvenanceTurns(table: string, id: string): Promise<Array<{ id: string; content: string; sessionId: string; role: string }>>;
  /** 记忆混合召回(HNSW 语义 + BM25 关键词,search::rrf 倒数排名融合)。
   *  传 queryText → 叠加 BM25(补 HNSW 对专名/精确词的盲区);无/空 queryText 或 BM25 在 3.x 不可用
   *  → 退化为纯 HNSW(现状)。A4 门控始终:默认仅 confirmed+normal;includeSensitive 含 sensitive。 */
  recallMemoriesByVector(embedding: number[], k: number, opts?: { includeSensitive?: boolean; queryText?: string }): Promise<Array<{ id: string; text: string }>>;
}

export type SurrealRepoOptions = SurrealConnectionOptions;

export async function createSurrealProductStateRepository(opts: SurrealRepoOptions): Promise<SurrealRepoHandle> {
  const db = await createSurrealConnection(opts);
  await applySchema(db);

  // 内存工作副本:同步接口的真相源。
  let state: ProductState = await loadState(db);
  // diff 基线:上次成功落库的状态(非内存 state)。失败不更新 → 下次 diff 自动补回漏掉的增量(自愈)。
  let lastPersisted: ProductState = state;
  let persistQueue: Promise<void> = Promise.resolve();

  function enqueuePersist(snapshot: ProductState) {
    persistQueue = persistQueue
      .then(async () => {
        await persist(db, lastPersisted, snapshot);
        lastPersisted = snapshot;                 // 仅成功后推进基线
      })
      .catch((err) => {
        // fail-loud:基线不动,下次 persist 以旧基线 diff、补回本次漏写(自愈)。
        console.error(JSON.stringify({ event: "surreal_persist_failed", error: String(err) }));
      });
  }

  return {
    getState() { return structuredClone(state); },
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
    async recallProvenanceTurns(table: string, id: string) {
      const from = new RecordId(table, id);
      const [rows] = await db.query<[Array<Record<string, unknown>>]>(
        "SELECT VALUE ->derived_from->turn.* FROM $from;", { from }
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
  };
}

/** 从 SurrealDB 读全部节点表 + state_meta,重建 ProductState(规范化)。空库 → 初始态。 */
async function loadState(db: Surreal): Promise<ProductState> {
  const [metaRows] = await db.query<[Array<{ revision: number; rest: Record<string, unknown> }>]>(
    `SELECT revision, rest FROM ${META_ID};`
  );
  const meta = metaRows?.[0];
  if (!meta) return createInitialProductState();

  const assembled: Record<string, unknown> = { ...(meta.rest ?? {}), revision: meta.revision };
  for (const m of NODE_MAPPINGS) {
    const [rows] = await db.query<[Array<Record<string, unknown>>]>(`SELECT * FROM ${m.table};`);
    assembled[m.stateKey] = (rows ?? []).map((r) => {
      const { id, ...rec } = r;
      return fromRecord(recordIdToDomainId(id), rec);
    });
  }
  return normalizeProductState(assembled);
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
  for (const m of NODE_MAPPINGS) {
    const prevArr = ((prev as unknown as Record<string, unknown>)[m.stateKey] as Array<{ id: string }>) ?? [];
    const nextArr = ((next as unknown as Record<string, unknown>)[m.stateKey] as Array<{ id: string }>) ?? [];
    const { upsert, removeIds } = diffById(prevArr, nextArr);
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
  {
    const { upsert, removeIds } = diffById(
      turnRecordsOf(prev) as Array<Record<string, unknown> & { id: string }>,
      turnRecordsOf(next) as Array<Record<string, unknown> & { id: string }>,
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
    const { added, removed } = diffEdges(collectEdges(prev), collectEdges(next));
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
