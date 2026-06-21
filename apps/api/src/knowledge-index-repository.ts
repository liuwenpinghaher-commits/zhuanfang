import type { KnowledgeChunk, KnowledgeSourceType } from "../../../src/domain/types";

export interface KnowledgeIndexRepository {
  put(chunk: KnowledgeChunk): void;
  replaceSource(sourceType: KnowledgeSourceType, sourceId: string, chunks: KnowledgeChunk[]): void;
  deleteBySource(sourceType: KnowledgeSourceType, sourceId: string): void;
  deleteAll(): void;
  listAll(): KnowledgeChunk[];
}

export function createInMemoryKnowledgeIndexRepository(): KnowledgeIndexRepository {
  const store = new Map<string, KnowledgeChunk>();
  return {
    put: (c) => { store.set(c.id, c); },
    replaceSource(t, id, chunks) {
      for (const [cid, c] of store) if (c.sourceType === t && c.sourceId === id) store.delete(cid);
      for (const c of chunks) store.set(c.id, c);
    },
    deleteBySource(t, id) {
      for (const [cid, c] of store) if (c.sourceType === t && c.sourceId === id) store.delete(cid);
    },
    deleteAll: () => store.clear(),
    listAll: () => [...store.values()]
  };
}
