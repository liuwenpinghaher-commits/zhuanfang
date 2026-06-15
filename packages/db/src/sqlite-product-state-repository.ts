import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ProductStateRepository } from "../../../apps/api/src/product-state-repository";
import { createInitialProductState } from "../../../src/domain/engine";
import { normalizeProductState } from "../../../src/domain/storage";
import type { ProductState } from "../../../src/domain/types";

const SNAPSHOT_ID = "default";

type ProductStateEventType = "seed" | "replace" | "reset";

interface ProductStateSnapshotRow {
  state_json: string;
}

export interface SqliteProductStateRepositoryOptions {
  dbPath: string;
}

export function createSqliteProductStateRepository(options: SqliteProductStateRepositoryOptions): ProductStateRepository {
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

  function persistState(state: ProductState, eventType: ProductStateEventType) {
    // Server-authoritative: bump from the PERSISTED revision, never the incoming
    // state's revision (a PUT /api/state carries a client state whose revision may
    // be stale or forged). This keeps revision strictly monotonic on the server.
    const baseState = eventType === "replace"
      ? { ...state, revision: (readPersistedState()?.revision ?? 0) + 1 }
      : state;
    const normalizedState = normalizeProductState(baseState);
    const stateJson = JSON.stringify(normalizedState);
    const createdAt = new Date().toISOString();

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
      .run(eventType, stateJson, createdAt);

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
      return persistState(createInitialProductState(), "reset");
    },
    replaceState(state) {
      return persistState(state, "replace");
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
