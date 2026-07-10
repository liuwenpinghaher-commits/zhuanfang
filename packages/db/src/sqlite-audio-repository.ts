import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { InterviewAudio, InterviewAudioRole } from "../../../src/domain/types";
import type { AudioRepository } from "../../../apps/api/src/audio-repository";

export interface SqliteAudioRepositoryOptions {
  dbPath: string;
}

const DEFAULT_ROLE: InterviewAudioRole = "interviewee";

interface AudioRow {
  session_id: string;
  role: string;
  audio: Uint8Array;
  mime: string;
  byte_size: number;
  duration_ms: number | null;
  recording_started_at: string | null;
  created_at: string;
}

const CREATE_SCHEMA = `
  CREATE TABLE IF NOT EXISTS interview_audio (
    session_id           TEXT NOT NULL,
    role                 TEXT NOT NULL DEFAULT 'interviewee',
    audio                BLOB NOT NULL,
    mime                 TEXT NOT NULL,
    byte_size            INTEGER NOT NULL,
    duration_ms          INTEGER,
    recording_started_at TEXT,
    created_at           TEXT NOT NULL,
    PRIMARY KEY (session_id, role)
  );
`;

export function createSqliteAudioRepository(
  options: SqliteAudioRepositoryOptions
): AudioRepository {
  // ":memory:" has no directory to create; only mkdir for real file paths.
  if (options.dbPath !== ":memory:") {
    mkdirSync(dirname(options.dbPath), { recursive: true });
  }
  const database = new DatabaseSync(options.dbPath);

  // Migration: a pre-existing audio.sqlite may carry the old single-column-PK schema
  // (session_id PK, no role column). The audio table is a write-through hot cache that
  // can be safely rebuilt (re-export/sync restores it), so when the role column is
  // missing we DROP and re-CREATE under the new (session_id, role) PK. New databases
  // hit only CREATE IF NOT EXISTS. Wrapped in try/catch — safety first; on any migration
  // error we fall back to ensuring the new schema exists.
  try {
    const columns = database.prepare("PRAGMA table_info(interview_audio)").all() as Array<{ name: string }>;
    const tableExists = columns.length > 0;
    const hasRole = columns.some((c) => c.name === "role");
    if (tableExists && !hasRole) {
      database.exec("DROP TABLE interview_audio");
    }
  } catch {
    /* PRAGMA/DROP failed — fall through to CREATE IF NOT EXISTS below */
  }
  database.exec(CREATE_SCHEMA);

  const upsert = database.prepare(
    `INSERT INTO interview_audio (session_id, role, audio, mime, byte_size, duration_ms, recording_started_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(session_id, role) DO UPDATE SET
       audio = excluded.audio,
       mime = excluded.mime,
       byte_size = excluded.byte_size,
       duration_ms = excluded.duration_ms,
       recording_started_at = excluded.recording_started_at,
       created_at = excluded.created_at`
  );
  const selectOne = database.prepare(
    "SELECT * FROM interview_audio WHERE session_id = ? AND role = ?"
  );
  const existsOne = database.prepare(
    "SELECT 1 FROM interview_audio WHERE session_id = ? AND role = ?"
  );
  const deleteOneRole = database.prepare(
    "DELETE FROM interview_audio WHERE session_id = ? AND role = ?"
  );
  const deleteSession = database.prepare("DELETE FROM interview_audio WHERE session_id = ?");
  const deleteAllStmt = database.prepare("DELETE FROM interview_audio");
  const selectIds = database.prepare(
    "SELECT DISTINCT session_id FROM interview_audio ORDER BY session_id ASC"
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
      role: (row.role as InterviewAudioRole) ?? DEFAULT_ROLE,
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

  // R2a 接口异步化:同步 sqlite 实现机械包装为 async(语义不变),对齐异步化后的接口。
  return {
    async get(sessionId, role = DEFAULT_ROLE) {
      const row = selectOne.get(sessionId, role) as AudioRow | undefined;
      if (!row) {
        return undefined;
      }
      return mapRow(row);
    },
    async has(sessionId, role = DEFAULT_ROLE) {
      return existsOne.get(sessionId, role) !== undefined;
    },
    async put(a) {
      upsert.run(
        a.sessionId,
        a.role ?? DEFAULT_ROLE,
        a.audio,
        a.mime,
        a.byteSize ?? a.audio.byteLength,
        a.durationMs ?? null,
        a.recordingStartedAt ?? null,
        a.createdAt
      );
    },
    async delete(sessionId, role) {
      if (role) {
        deleteOneRole.run(sessionId, role);
        return;
      }
      // 无 role：删该 session 的全部 role。
      deleteSession.run(sessionId);
    },
    async deleteAll() {
      deleteAllStmt.run();
    },
    async listSessionIds() {
      const rows = selectIds.all() as Array<Pick<AudioRow, "session_id">>;
      return rows.map((row) => row.session_id);
    },
    async listAll() {
      const rows = selectAll.all() as unknown as AudioRow[];
      return rows.map(mapRow);
    }
  };
}
