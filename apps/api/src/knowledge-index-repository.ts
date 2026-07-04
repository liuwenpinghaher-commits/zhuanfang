import type { KnowledgeChunk, KnowledgeSourceType } from "../../../src/domain/types";

export interface KnowledgeIndexRepository {
  put(chunk: KnowledgeChunk): void;
  replaceSource(sourceType: KnowledgeSourceType, sourceId: string, chunks: KnowledgeChunk[]): void;
  deleteBySource(sourceType: KnowledgeSourceType, sourceId: string): void;
  deleteAll(): void;
  listAll(): KnowledgeChunk[];
  /** 回归审查 R8-1:单调代际号,每次 deleteAll 递增。rebuild 的后台异步嵌入捕获开始时的 epoch,
   *  put 前校验 epoch 未变——若中途 reset/purge 清空了索引(epoch 已增),陈旧嵌入被丢弃,不复活
   *  已清除的私密块(此前竞态会把 reset 前构建的块 put 回索引 → chat 再召回已清空私人内容)。 */
  epoch(): number;
}

export function createInMemoryKnowledgeIndexRepository(): KnowledgeIndexRepository {
  const store = new Map<string, KnowledgeChunk>();
  let epoch = 0;
  return {
    put: (c) => { store.set(c.id, c); },
    replaceSource(t, id, chunks) {
      for (const [cid, c] of store) if (c.sourceType === t && c.sourceId === id) store.delete(cid);
      for (const c of chunks) store.set(c.id, c);
    },
    deleteBySource(t, id) {
      for (const [cid, c] of store) if (c.sourceType === t && c.sourceId === id) store.delete(cid);
    },
    deleteAll: () => { store.clear(); epoch += 1; },   // R8-1:清空递增代际
    listAll: () => [...store.values()],
    epoch: () => epoch
  };
}
