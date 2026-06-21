import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { InterviewAudio } from "../../../src/domain/types";
import type { AudioRepository } from "../../../apps/api/src/audio-repository";

export interface SqliteAudioRepositoryOptions {
  dbPath: string;
}

interface AudioRow {
  session_id: string;
  audio: Uint8Array;
  mime: string;
  byte_size: number;
  duration_ms: number | null;
  created_at: string;
}

export function createSqliteAudioRepository(
  options: SqliteAudioRepositoryOptions
): AudioRepository {
  // ":memory:" has no directory to create; only mkdir for real file paths.
  if (options.dbPath !== ":memory:") {
    mkdirSync(dirname(options.dbPath), { recursive: true });
  }
  const database = new DatabaseSync(options.dbPath);
  database.exec(`
    CREATE TABLE IF NOT EXISTS interview_audio (
      session_id  TEXT PRIMARY KEY,
      audio       BLOB NOT NULL,
      mime        TEXT NOT NULL,
      byte_size   INTEGER NOT NULL,
      duration_ms INTEGER,
      created_at  TEXT NOT NULL
    );
  `);

  const upsert = database.prepare(
    `INSERT INTO interview_audio (session_id, audio, mime, byte_size, duration_ms, created_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(session_id) DO UPDATE SET
       audio = excluded.audio,
       mime = excluded.mime,
       byte_size = excluded.byte_size,
       duration_ms = excluded.duration_ms,
       created_at = excluded.created_at`
  );
  const selectOne = database.prepare("SELECT * FROM interview_audio WHERE session_id = ?");
  const existsOne = database.prepare("SELECT 1 FROM interview_audio WHERE session_id = ?");
  const deleteOne = database.prepare("DELETE FROM interview_audio WHERE session_id = ?");
  const deleteAllStmt = database.prepare("DELETE FROM interview_audio");

  return {
    get(sessionId) {
      const row = selectOne.get(sessionId) as AudioRow | undefined;
      if (!row) {
        return undefined;
      }
      // node:sqlite hands back BLOB columns as Uint8Array; normalize defensively
      // (a Buffer is a Uint8Array subclass, so wrapping keeps bytes exact).
      const audio = row.audio instanceof Uint8Array ? row.audio : new Uint8Array(row.audio);
      const result: InterviewAudio = {
        sessionId: row.session_id,
        audio,
        mime: row.mime,
        byteSize: row.byte_size,
        createdAt: row.created_at
      };
      if (row.duration_ms !== null && row.duration_ms !== undefined) {
        result.durationMs = row.duration_ms;
      }
      return result;
    },
    has(sessionId) {
      return existsOne.get(sessionId) !== undefined;
    },
    put(a) {
      upsert.run(
        a.sessionId,
        a.audio,
        a.mime,
        a.byteSize ?? a.audio.byteLength,
        a.durationMs ?? null,
        a.createdAt
      );
    },
    delete(sessionId) {
      deleteOne.run(sessionId);
    },
    deleteAll() {
      deleteAllStmt.run();
    }
  };
}
