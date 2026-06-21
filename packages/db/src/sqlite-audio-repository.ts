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
  recording_started_at: string | null;
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
      session_id           TEXT PRIMARY KEY,
      audio                BLOB NOT NULL,
      mime                 TEXT NOT NULL,
      byte_size            INTEGER NOT NULL,
      duration_ms          INTEGER,
      recording_started_at TEXT,
      created_at           TEXT NOT NULL
    );
  `);
  // Backward-compat: a pre-existing audio.sqlite may have been created before the
  // recording_started_at column existed. ADD COLUMN throws on an already-present
  // column (node:sqlite exec surfaces the SQLite error); swallow only that case.
  try {
    database.exec("ALTER TABLE interview_audio ADD COLUMN recording_started_at TEXT");
  } catch {
    /* column already exists — ignore */
  }

  const upsert = database.prepare(
    `INSERT INTO interview_audio (session_id, audio, mime, byte_size, duration_ms, recording_started_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(session_id) DO UPDATE SET
       audio = excluded.audio,
       mime = excluded.mime,
       byte_size = excluded.byte_size,
       duration_ms = excluded.duration_ms,
       recording_started_at = excluded.recording_started_at,
       created_at = excluded.created_at`
  );
  const selectOne = database.prepare("SELECT * FROM interview_audio WHERE session_id = ?");
  const existsOne = database.prepare("SELECT 1 FROM interview_audio WHERE session_id = ?");
  const deleteOne = database.prepare("DELETE FROM interview_audio WHERE session_id = ?");
  const deleteAllStmt = database.prepare("DELETE FROM interview_audio");
  const selectIds = database.prepare(
    "SELECT session_id FROM interview_audio ORDER BY created_at ASC"
  );
  const selectAll = database.prepare(
    "SELECT * FROM interview_audio ORDER BY created_at ASC"
  );

  // Shared row→object mapping for get/listAll. BLOB columns come back as Uint8Array;
  // normalize defensively (a Buffer is a Uint8Array subclass, so wrapping keeps bytes exact).
  const mapRow = (row: AudioRow): InterviewAudio => {
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
    if (row.recording_started_at !== null && row.recording_started_at !== undefined) {
      result.recordingStartedAt = row.recording_started_at;
    }
    return result;
  };

  return {
    get(sessionId) {
      const row = selectOne.get(sessionId) as AudioRow | undefined;
      if (!row) {
        return undefined;
      }
      return mapRow(row);
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
        a.recordingStartedAt ?? null,
        a.createdAt
      );
    },
    delete(sessionId) {
      deleteOne.run(sessionId);
    },
    deleteAll() {
      deleteAllStmt.run();
    },
    listSessionIds() {
      const rows = selectIds.all() as Array<Pick<AudioRow, "session_id">>;
      return rows.map((row) => row.session_id);
    },
    listAll() {
      const rows = selectAll.all() as unknown as AudioRow[];
      return rows.map(mapRow);
    }
  };
}
