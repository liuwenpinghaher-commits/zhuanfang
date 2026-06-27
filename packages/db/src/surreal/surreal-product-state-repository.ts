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
import { collectEdges, turnRecordsOf, MANAGED_EDGE_TABLES } from "./edge-mapper";

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
  "memoryEdges","podcastEpisodes","corpusImports","corpusInsights","playbookPatches",
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
}

export type SurrealRepoOptions = SurrealConnectionOptions;

export async function createSurrealProductStateRepository(opts: SurrealRepoOptions): Promise<SurrealRepoHandle> {
  const db = await createSurrealConnection(opts);
  await applySchema(db);

  // 内存工作副本:同步接口的真相源。
  let state: ProductState = await loadState(db);
  // 串行化落库队列(防并发 replaceState 的全量覆盖写交错);flush 等待它。
  let persistQueue: Promise<void> = Promise.resolve();

  function enqueuePersist(snapshot: ProductState) {
    persistQueue = persistQueue.then(() => persist(db, snapshot)).catch((err) => {
      // fail-loud:落库失败不静默(内存已前进,DB 落后——记录以便排查/告警)。
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
    query<T extends unknown[]>(surql: string, vars?: Record<string, unknown>) { return db.query<T>(surql, vars) as Promise<T>; }
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

/** 全量覆盖落库:单事务、原子无窗口(3.x 校正)。
 *  SurrealDB 3.x 不允许在同一事务内 DELETE 再 CREATE 同一 id 的记录(已验证),
 *  故节点/turn 用 `UPSERT ... CONTENT`(幂等、可覆盖同 id),删除多余记录用
 *  `DELETE <tbl> WHERE id NOT IN $keep`(keep = 本次该表所有记录的 RecordId 数组;空则整表删)。
 *  边没有稳定领域 id、RELATE 每次生成新 id,无同 id 冲突,故仍 `DELETE <edge>;` 再 RELATE。
 *  全部在一个 BEGIN/COMMIT 内提交 —— 替代旧的 TXN1(删)/TXN2(建)拆分,消除两事务间的非原子窗口。
 *  P1a 取最简正确(每写全表覆盖);diff-upsert 是 P1c。单用户小规模可接受。
 *  P1b 追加:turn 表正规化 + 四张受管边表全量覆盖(RELATE)。
 *  ⚠️ UPSERT CONTENT 不重跑列 DEFAULT,故节点/turn 记录先过 fillUpsertDefaults 补 rest + datetime 列。 */
async function persist(db: Surreal, snapshot: ProductState): Promise<void> {
  const meta: Record<string, unknown> = {};
  for (const k of META_KEYS) meta[k] = (snapshot as unknown as Record<string, unknown>)[k];

  let surql = "BEGIN TRANSACTION;\n";
  const vars: Record<string, unknown> = {};
  let i = 0;

  // 1) 节点表全量覆盖(P1a):UPSERT 每条 + DELETE WHERE id NOT IN keep。
  for (const m of NODE_MAPPINGS) {
    const arr = ((snapshot as unknown as Record<string, unknown>)[m.stateKey] as Array<{ id: string }>) ?? [];
    const keep: RecordId[] = [];
    for (const entity of arr) {
      const recVar = `r${i++}`;
      vars[recVar] = fillUpsertDefaults(m.table, toRecord(entity as Record<string, unknown>, m));
      vars[`${recVar}_id`] = entity.id;
      surql += `UPSERT type::record('${m.table}', $${recVar}_id) CONTENT $${recVar};\n`;
      keep.push(new RecordId(m.table, entity.id));
    }
    const keepVar = `keep_${m.table}`;
    vars[keepVar] = keep;
    surql += keep.length ? `DELETE ${m.table} WHERE id NOT IN $${keepVar};\n` : `DELETE ${m.table};\n`;
  }

  // 2) turn 表正规化(P1b):turns 同时仍在 session.rest(P1a 无损读),此处供边引用 + P2 图查询。
  //    3.x 校正:turn.timestamp/rest 均带 DEFAULT,UPSERT CONTENT 不重跑 → fillUpsertDefaults 补齐。
  const keepTurns: RecordId[] = [];
  for (const t of turnRecordsOf(snapshot)) {
    const tv = `t${i++}`;
    vars[tv] = fillUpsertDefaults("turn", { ...t });
    vars[`${tv}_id`] = t.id;
    surql += `UPSERT type::record('turn', $${tv}_id) CONTENT $${tv};\n`;
    keepTurns.push(new RecordId("turn", t.id as string));
  }
  vars.keepTurns = keepTurns;
  surql += keepTurns.length ? `DELETE turn WHERE id NOT IN $keepTurns;\n` : `DELETE turn;\n`;

  // 3) 边全量覆盖(P1b):边无稳定领域 id,先清四张受管边表再 RELATE(同事务无同 id 冲突)。
  //    (删节点不自动清边,A5 是 P3;此处全量重建保不留悬挂边。)
  //    3.x 校正:RELATE 端点用 RecordId JS 对象($from/$to 参数);
  //    边字段用 SET 替 CONTENT(derived_from.provenance);origin='llm_extracted' 合 002 ASSERT。
  for (const et of MANAGED_EDGE_TABLES) surql += `DELETE ${et};\n`;
  for (const e of collectEdges(snapshot)) {
    const ev = `e${i++}`;
    vars[`${ev}_f`] = new RecordId(e.fromTable, e.fromId);
    vars[`${ev}_t`] = new RecordId(e.toTable, e.toId);
    let rel = `RELATE $${ev}_f->${e.edge}->$${ev}_t`;
    if (e.data) {
      vars[`${ev}_d`] = e.data;
      rel += ` SET provenance = $${ev}_d.provenance`;
    }
    surql += rel + ";\n";
  }

  // 4) state_meta(P1a)
  vars.meta = meta;
  vars.rev = snapshot.revision ?? 0;
  surql += `UPSERT ${META_ID} SET revision = $rev, rest = $meta;\n`;
  surql += "COMMIT TRANSACTION;";

  await db.query(surql, vars);
}
