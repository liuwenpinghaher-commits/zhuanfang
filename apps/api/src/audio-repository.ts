import type { InterviewAudio, InterviewAudioRole } from "../../../src/domain/types";

export interface AudioRepository {
  get(sessionId: string, role?: InterviewAudioRole): InterviewAudio | undefined;
  has(sessionId: string, role?: InterviewAudioRole): boolean;
  put(audio: InterviewAudio): void;
  /** role 省略时删除该 session 的全部 role（供 purge/按会话清用）；带 role 时仅删该路。 */
  delete(sessionId: string, role?: InterviewAudioRole): void;
  deleteAll(): void;
  /** 去重后的 sessionId 列表（同 session 的多路只算一次）。 */
  listSessionIds(): string[];
  /** 每路一条。 */
  listAll(): InterviewAudio[];
}

const DEFAULT_ROLE: InterviewAudioRole = "interviewee";
const keyOf = (sessionId: string, role: InterviewAudioRole): string => `${sessionId}::${role}`;

export function createInMemoryAudioRepository(): AudioRepository {
  const store = new Map<string, InterviewAudio>();
  return {
    get: (id, role = DEFAULT_ROLE) => store.get(keyOf(id, role)),
    has: (id, role = DEFAULT_ROLE) => store.has(keyOf(id, role)),
    put: (a) => { store.set(keyOf(a.sessionId, a.role ?? DEFAULT_ROLE), a); },
    delete: (id, role) => {
      if (role) {
        store.delete(keyOf(id, role));
        return;
      }
      // 无 role：删该 sessionId 的全部 role。
      for (const value of [...store.values()]) {
        if (value.sessionId === id) {
          store.delete(keyOf(value.sessionId, value.role ?? DEFAULT_ROLE));
        }
      }
    },
    deleteAll: () => { store.clear(); },
    listSessionIds: () => [...new Set([...store.values()].map((a) => a.sessionId))],
    listAll: () => [...store.values()]
  };
}
