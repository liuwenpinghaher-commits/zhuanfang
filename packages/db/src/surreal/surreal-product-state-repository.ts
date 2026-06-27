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

/** 全量覆盖落库:事务内,每张本体表 delete-all + 重建;state_meta upsert(revision + 运维尾巴)。
 *  P1a 取最简正确(每写全表重写);diff-upsert 是 P1c。单用户小规模可接受。
 *  P1b 追加:turn 表正规化 + 四张受管边表全量覆盖(RELATE)。 */
async function persist(db: Surreal, snapshot: ProductState): Promise<void> {
  const meta: Record<string, unknown> = {};
  for (const k of META_KEYS) meta[k] = (snapshot as unknown as Record<string, unknown>)[k];

  let surql = "BEGIN TRANSACTION;\n";
  const vars: Record<string, unknown> = {};
  let i = 0;

  // 1) 节点表全量覆盖(P1a)
  for (const m of NODE_MAPPINGS) {
    surql += `DELETE ${m.table};\n`;
    const arr = ((snapshot as unknown as Record<string, unknown>)[m.stateKey] as Array<{ id: string }>) ?? [];
    for (const entity of arr) {
      const recVar = `r${i++}`;
      vars[recVar] = toRecord(entity as Record<string, unknown>, m);
      vars[`${recVar}_id`] = entity.id;
      surql += `CREATE type::record('${m.table}', $${recVar}_id) CONTENT $${recVar};\n`;
    }
  }

  // 2) turn 表正规化(P1b):全量覆盖。turns 同时仍在 session.rest(P1a,无损读),此处冗余写入供边引用 + P2 图查询。
  surql += `DELETE turn;\n`;
  for (const t of turnRecordsOf(snapshot)) {
    const tv = `t${i++}`;
    vars[tv] = t;
    vars[`${tv}_id`] = t.id;
    surql += `CREATE type::record('turn', $${tv}_id) CONTENT $${tv};\n`;
  }

  // 3) 边全量覆盖(P1b):先清四张受管边表,再按 collectEdges RELATE。
  //    (删节点不自动清边,A5 是 P3;此处全量重建保不留悬挂边。)
  //    3.x 校正:type::record 不被 RELATE 端点接受 → fallback 用 RecordId JS 对象作参数
  //    ($from/$to 形如 $e0_f/$e0_t),边字段用 SET 替 CONTENT(derived_from.provenance)。
  for (const et of MANAGED_EDGE_TABLES) surql += `DELETE ${et};\n`;
  for (const e of collectEdges(snapshot)) {
    const ev = `e${i++}`;
    vars[`${ev}_f`] = new RecordId(e.fromTable, e.fromId);
    vars[`${ev}_t`] = new RecordId(e.toTable, e.toId);
    let rel = `RELATE $${ev}_f->${e.edge}->$${ev}_t`;
    if (e.data) {
      // derived_from carries { provenance: {...} }; 3.x RELATE uses SET, not CONTENT
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
