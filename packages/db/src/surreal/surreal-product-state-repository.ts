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

  // 2) turn 表:同样 diffById(turnRecordsOf)
  {
    const { upsert, removeIds } = diffById(
      turnRecordsOf(prev) as Array<Record<string, unknown> & { id: string }>,
      turnRecordsOf(next) as Array<Record<string, unknown> & { id: string }>,
    );
    for (const t of upsert) {
      const tv = `t${i++}`;
      vars[tv] = fillUpsertDefaults("turn", { ...t });
      vars[`${tv}_id`] = t.id;
      surql += `UPSERT type::record('turn', $${tv}_id) CONTENT $${tv};\n`;
    }
    if (removeIds.length) {
      vars.del_turn = removeIds.map((id) => new RecordId("turn", id));
      surql += `DELETE turn WHERE id IN $del_turn;\n`;
    }
  }

  // 3) 边:diffEdges → DELETE 移除(WHERE in/out)+ RELATE 新增
  {
    const { added, removed } = diffEdges(collectEdges(prev), collectEdges(next));
    for (const e of removed) {
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
