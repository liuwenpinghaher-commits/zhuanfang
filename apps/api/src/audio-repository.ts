import type { InterviewAudio, InterviewAudioRole } from "../../../src/domain/types";

/** R2a 接口异步化:全部方法返回 Promise(语义/形状不变),为 Surreal 实现与 R2b 治理事务铺路。 */
export interface AudioRepository {
  get(sessionId: string, role?: InterviewAudioRole): Promise<InterviewAudio | undefined>;
  has(sessionId: string, role?: InterviewAudioRole): Promise<boolean>;
  put(audio: InterviewAudio): Promise<void>;
  /** role 省略时删除该 session 的全部 role（供 purge/按会话清用）；带 role 时仅删该路。 */
  delete(sessionId: string, role?: InterviewAudioRole): Promise<void>;
  deleteAll(): Promise<void>;
  /** 去重后的 sessionId 列表（同 session 的多路只算一次）。 */
  listSessionIds(): Promise<string[]>;
  /** 每路一条。 */
  listAll(): Promise<InterviewAudio[]>;
}

const DEFAULT_ROLE: InterviewAudioRole = "interviewee";
const keyOf = (sessionId: string, role: InterviewAudioRole): string => `${sessionId}::${role}`;

export function createInMemoryAudioRepository(): AudioRepository {
  const store = new Map<string, InterviewAudio>();
  return {
    get: async (id, role = DEFAULT_ROLE) => store.get(keyOf(id, role)),
    has: async (id, role = DEFAULT_ROLE) => store.has(keyOf(id, role)),
    put: async (a) => { store.set(keyOf(a.sessionId, a.role ?? DEFAULT_ROLE), a); },
    delete: async (id, role) => {
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
    deleteAll: async () => { store.clear(); },
    listSessionIds: async () => [...new Set([...store.values()].map((a) => a.sessionId))],
    listAll: async () => [...store.values()]
  };
}
