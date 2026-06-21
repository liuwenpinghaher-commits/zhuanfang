import type { InterviewRawMaterial } from "../../../src/domain/types";

export interface RawMaterialRepository {
  get(sessionId: string): InterviewRawMaterial | undefined;
  list(): InterviewRawMaterial[];
  put(material: InterviewRawMaterial): void;
  delete(sessionId: string): void;
  deleteAll(): void;
}

export function createInMemoryRawMaterialRepository(): RawMaterialRepository {
  const store = new Map<string, InterviewRawMaterial>();
  return {
    get: (id) => store.get(id),
    list: () => [...store.values()],
    put: (m) => { store.set(m.sessionId, m); },
    delete: (id) => { store.delete(id); },
    deleteAll: () => { store.clear(); }
  };
}
