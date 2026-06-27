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

/** 全量覆盖落库:两阶段写入(3.x 校正)。
 *  SurrealDB 3.x 不允许在同一事务内 DELETE 再 CREATE 同一 id 的记录(已验证);
 *  故拆为两个独立事务:TXN1 先清所有受管表,TXN2 再建节点 + turn + 边 + state_meta。
 *  两事务之间的窗口极短(内存/单用户),与 P1a 的全量覆盖风险等级相同;diff-upsert 是 P1c。
 *  P1b 追加:turn 表正规化 + 四张受管边表全量覆盖(RELATE)。 */
async function persist(db: Surreal, snapshot: ProductState): Promise<void> {
  const meta: Record<string, unknown> = {};
  for (const k of META_KEYS) meta[k] = (snapshot as unknown as Record<string, unknown>)[k];

  // ── TXN1: 清空所有受管表(节点表 + turn + 四张边表)────────────────────────────
  let delSurql = "BEGIN TRANSACTION;\n";
  for (const m of NODE_MAPPINGS) delSurql += `DELETE ${m.table};\n`;
  delSurql += "DELETE turn;\n";
  for (const et of MANAGED_EDGE_TABLES) delSurql += `DELETE ${et};\n`;
  delSurql += "COMMIT TRANSACTION;";
  await db.query(delSurql);

  // ── TXN2: 建节点 + turn + RELATE 边 + state_meta ─────────────────────────────
  let surql = "BEGIN TRANSACTION;\n";
  const vars: Record<string, unknown> = {};
  let i = 0;

  // 1) 节点表重建(P1a)
  for (const m of NODE_MAPPINGS) {
    const arr = ((snapshot as unknown as Record<string, unknown>)[m.stateKey] as Array<{ id: string }>) ?? [];
    for (const entity of arr) {
      const recVar = `r${i++}`;
      vars[recVar] = toRecord(entity as Record<string, unknown>, m);
      vars[`${recVar}_id`] = entity.id;
      surql += `CREATE type::record('${m.table}', $${recVar}_id) CONTENT $${recVar};\n`;
    }
  }

  // 2) turn 表正规化(P1b):turns 同时仍在 session.rest(P1a 无损读),此处供边引用 + P2 图查询。
  //    3.x 校正:turn.timestamp DEFINE 为 datetime,turnRecordsOf 已转换为 Date 对象。
  for (const t of turnRecordsOf(snapshot)) {
    const tv = `t${i++}`;
    vars[tv] = t;
    vars[`${tv}_id`] = t.id;
    surql += `CREATE type::record('turn', $${tv}_id) CONTENT $${tv};\n`;
  }

  // 3) RELATE 边(P1b):3.x 校正:RELATE 端点用 RecordId JS 对象($from/$to 参数);
  //    边字段用 SET 替 CONTENT(derived_from.provenance);origin='llm_extracted' 合 002 ASSERT。
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
