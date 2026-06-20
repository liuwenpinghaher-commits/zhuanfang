import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ProductStateRepository, ReplaceStateOptions } from "../../../apps/api/src/product-state-repository";
import { StateRevisionConflictError } from "../../../apps/api/src/product-state-repository";
import { createInitialProductState, createEmptyProductState } from "../../../src/domain/engine";
import { normalizeProductState } from "../../../src/domain/storage";
import type { ProductState } from "../../../src/domain/types";

const SNAPSHOT_ID = "default";

// ponytail: 固定保留窗口 500;需要按时间裁剪再说
const MAX_PERSISTED_EVENTS = 500;

type ProductStateEventType = "seed" | "replace" | "reset";

interface ProductStateSnapshotRow {
  state_json: string;
}

interface EventCountRow {
  count: number;
}

export interface SqliteProductStateRepositoryOptions {
  dbPath: string;
  /** 可注入最大事件行数,默认 MAX_PERSISTED_EVENTS(500);用于测试 */
  maxEvents?: number;
}

export function createSqliteProductStateRepository(options: SqliteProductStateRepositoryOptions): ProductStateRepository & { getEventCount: () => number } {
  const maxEvents = options.maxEvents ?? MAX_PERSISTED_EVENTS;
  mkdirSync(dirname(options.dbPath), { recursive: true });
  const database = new DatabaseSync(options.dbPath);
  initializeSchema(database);

  function readPersistedState() {
    const row = database
      .prepare("SELECT state_json FROM product_state_snapshots WHERE id = ?")
      .get(SNAPSHOT_ID) as ProductStateSnapshotRow | undefined;

    if (!row) {
      return undefined;
    }

    try {
      return normalizeProductState(JSON.parse(row.state_json));
    } catch {
      return createInitialProductState();
    }
  }

  function persistState(state: ProductState, eventType: ProductStateEventType, opts?: ReplaceStateOptions) {
    // Server-authoritative: bump from the PERSISTED revision, never the incoming
    // state's revision (a PUT /api/state carries a client state whose revision may
    // be stale or forged). This keeps revision strictly monotonic on the server.
    const persistedRevision = readPersistedState()?.revision ?? 0;
    // P1-14: optimistic-concurrency guard (opt-in via expectedRevision). Only the
    // "replace" path carries an external client state worth guarding; seed/reset are
    // server-internal. node:sqlite is synchronous, so this read-then-check-then-write
    // cannot interleave with another in-process write.
    if (eventType === "replace" && opts?.expectedRevision !== undefined && opts.expectedRevision !== persistedRevision) {
      throw new StateRevisionConflictError(opts.expectedRevision, persistedRevision);
    }
    const baseState = eventType === "replace"
      ? { ...state, revision: persistedRevision + 1 }
      : state;
    const normalizedState = normalizeProductState(baseState);
    const stateJson = JSON.stringify(normalizedState);
    const createdAt = new Date().toISOString();

    // The events table is an append-only audit trail; its content is never read back
    // (only getEventCount reads it). Storing the FULL state per event amplified every
    // write by ~state-size × the 500-row window (a near-empty DB hit 12 MB). Store only
    // compact metadata instead — the `state_json` column is reused for it (NOT NULL,
    // no schema migration needed).
    const eventMeta = JSON.stringify({ revision: normalizedState.revision, bytes: stateJson.length });

    // NEW-2: wrap the snapshot UPSERT + event INSERT + retention DELETE in one
    // transaction so a crash between writes can't leave the snapshot and the
    // events audit trail momentarily inconsistent. node:sqlite has no managed
    // transaction helper, so drive it with explicit BEGIN/COMMIT and ROLLBACK on
    // failure (then rethrow so the caller still sees the error).
    database.exec("BEGIN");
    try {
      database
        .prepare(
          `INSERT INTO product_state_snapshots (id, state_json, created_at, updated_at)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             state_json = excluded.state_json,
             updated_at = excluded.updated_at`
        )
        .run(SNAPSHOT_ID, stateJson, createdAt, createdAt);

      database
        .prepare("INSERT INTO product_state_events (event_type, state_json, created_at) VALUES (?, ?, ?)")
        .run(eventType, eventMeta, createdAt);

      // 固定保留窗口裁剪:保留最近 maxEvents 条,其余删除
      database
        .prepare(
          `DELETE FROM product_state_events
           WHERE id NOT IN (
             SELECT id FROM product_state_events ORDER BY id DESC LIMIT ?
           )`
        )
        .run(maxEvents);

      database.exec("COMMIT");
    } catch (err) {
      database.exec("ROLLBACK");
      throw err;
    }

    return normalizedState;
  }

  return {
    getState() {
      const persistedState = readPersistedState();
      if (persistedState) {
        return persistedState;
      }
      return persistState(createInitialProductState(), "seed");
    },
    resetState() {
      return persistState(createEmptyProductState(), "reset");
    },
    replaceState(state, opts) {
      return persistState(state, "replace", opts);
    },
    getInterviewSession(id) {
      const state = readPersistedState() ?? createInitialProductState();
      return state.sessions.find((s) => s.id === id) ?? null;
    },
    getEventCount() {
      const row = database
        .prepare("SELECT COUNT(*) AS count FROM product_state_events")
        .get() as unknown as EventCountRow;
      return row.count;
    }
  };
}

function initializeSchema(database: DatabaseSync) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS product_state_snapshots (
      id TEXT PRIMARY KEY,
      state_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS product_state_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_type TEXT NOT NULL CHECK(event_type IN ('seed', 'replace', 'reset')),
      state_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `);
}
