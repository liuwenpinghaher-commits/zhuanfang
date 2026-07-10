import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { InterviewRawMaterial } from "../../../src/domain/types";
import type { RawMaterialRepository } from "../../../apps/api/src/raw-material-repository";

export interface SqliteRawMaterialRepositoryOptions {
  dbPath: string;
}

interface RawMaterialRow {
  session_id: string;
  turns_json: string;
  strategy_trace_json: string | null;
  created_at: string;
}

export function createSqliteRawMaterialRepository(
  options: SqliteRawMaterialRepositoryOptions
): RawMaterialRepository {
  // ":memory:" has no directory to create; only mkdir for real file paths.
  if (options.dbPath !== ":memory:") {
    mkdirSync(dirname(options.dbPath), { recursive: true });
  }
  const database = new DatabaseSync(options.dbPath);
  database.exec(`
    CREATE TABLE IF NOT EXISTS interview_raw_material (
      session_id          TEXT PRIMARY KEY,
      turns_json          TEXT NOT NULL,
      strategy_trace_json TEXT,
      created_at          TEXT NOT NULL
    );
  `);

  const upsert = database.prepare(
    `INSERT INTO interview_raw_material (session_id, turns_json, strategy_trace_json, created_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(session_id) DO UPDATE SET
       turns_json = excluded.turns_json,
       strategy_trace_json = excluded.strategy_trace_json,
       created_at = excluded.created_at`
  );
  const selectOne = database.prepare("SELECT * FROM interview_raw_material WHERE session_id = ?");
  const selectAll = database.prepare("SELECT * FROM interview_raw_material ORDER BY created_at ASC");
  const deleteOne = database.prepare("DELETE FROM interview_raw_material WHERE session_id = ?");
  const deleteAllStmt = database.prepare("DELETE FROM interview_raw_material");

  // R2a 接口异步化:同步 sqlite 实现机械包装为 async(语义不变),对齐异步化后的接口。
  return {
    async get(sessionId) {
      const row = selectOne.get(sessionId) as RawMaterialRow | undefined;
      if (!row) {
        return undefined;
      }
      return {
        sessionId: row.session_id,
        turns: JSON.parse(row.turns_json),
        strategyTrace: row.strategy_trace_json ? JSON.parse(row.strategy_trace_json) : [],
        createdAt: row.created_at
      };
    },
    async list() {
      const rows = selectAll.all() as unknown as RawMaterialRow[];
      return rows.map((row) => ({
        sessionId: row.session_id,
        turns: JSON.parse(row.turns_json),
        strategyTrace: row.strategy_trace_json ? JSON.parse(row.strategy_trace_json) : [],
        createdAt: row.created_at
      }));
    },
    async put(material) {
      upsert.run(
        material.sessionId,
        JSON.stringify(material.turns),
        JSON.stringify(material.strategyTrace ?? []),
        material.createdAt
      );
    },
    async delete(sessionId) {
      deleteOne.run(sessionId);
    },
    async deleteAll() {
      deleteAllStmt.run();
    }
  };
}
