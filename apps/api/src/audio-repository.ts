import type { InterviewAudio } from "../../../src/domain/types";

export interface AudioRepository {
  get(sessionId: string): InterviewAudio | undefined;
  has(sessionId: string): boolean;
  put(audio: InterviewAudio): void;
  delete(sessionId: string): void;
  deleteAll(): void;
  listSessionIds(): string[];
  listAll(): InterviewAudio[];
}

export function createInMemoryAudioRepository(): AudioRepository {
  const store = new Map<string, InterviewAudio>();
  return {
    get: (id) => store.get(id),
    has: (id) => store.has(id),
    put: (a) => { store.set(a.sessionId, a); },
    delete: (id) => { store.delete(id); },
    deleteAll: () => { store.clear(); },
    listSessionIds: () => [...store.keys()],
    listAll: () => [...store.values()]
  };
}
