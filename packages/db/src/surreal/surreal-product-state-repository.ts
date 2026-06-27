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
    async close() { await persistQueue; await db.close(); }
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
 *  P1a 取最简正确(每写全表重写);diff-upsert 是 P1c。单用户小规模可接受。 */
async function persist(db: Surreal, snapshot: ProductState): Promise<void> {
  const meta: Record<string, unknown> = {};
  for (const k of META_KEYS) meta[k] = (snapshot as unknown as Record<string, unknown>)[k];

  // 组装事务:BEGIN → 各表 DELETE + CREATE → state_meta UPSERT → COMMIT。
  // 用参数化 query 传记录内容(避免手拼 SurrealQL 注入/转义问题)。
  let surql = "BEGIN TRANSACTION;\n";
  const vars: Record<string, unknown> = {};
  let i = 0;
  for (const m of NODE_MAPPINGS) {
    surql += `DELETE ${m.table};\n`;
    const arr = ((snapshot as unknown as Record<string, unknown>)[m.stateKey] as Array<{ id: string }>) ?? [];
    for (const entity of arr) {
      const recVar = `r${i++}`;
      vars[recVar] = toRecord(entity as Record<string, unknown>, m);
      // 用 type::record 构造记录 id,安全处理任意 id 字符串(3.x:type::thing 已更名 type::record)。
      surql += `CREATE type::record('${m.table}', $${recVar}_id) CONTENT $${recVar};\n`;
      vars[`${recVar}_id`] = entity.id;
    }
  }
  vars.meta = meta;
  vars.rev = snapshot.revision ?? 0;
  surql += `UPSERT ${META_ID} SET revision = $rev, rest = $meta;\n`;
  surql += "COMMIT TRANSACTION;";

  await db.query(surql, vars);
}
