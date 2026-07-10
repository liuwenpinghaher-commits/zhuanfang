import type { KnowledgeChunk, KnowledgeSourceType } from "../../../src/domain/types";

/** R2a 接口异步化:全部方法返回 Promise(语义/形状不变),为 Surreal 实现与 R2b 治理事务铺路。 */
export interface KnowledgeIndexRepository {
  put(chunk: KnowledgeChunk): Promise<void>;
  replaceSource(sourceType: KnowledgeSourceType, sourceId: string, chunks: KnowledgeChunk[]): Promise<void>;
  deleteBySource(sourceType: KnowledgeSourceType, sourceId: string): Promise<void>;
  deleteAll(): Promise<void>;
  listAll(): Promise<KnowledgeChunk[]>;
  /** 回归审查 R8-1:单调代际号,每次 deleteAll 递增。rebuild 的后台异步嵌入捕获开始时的 epoch,
   *  put 前校验 epoch 未变——若中途 reset/purge 清空了索引(epoch 已增),陈旧嵌入被丢弃,不复活
   *  已清除的私密块(此前竞态会把 reset 前构建的块 put 回索引 → chat 再召回已清空私人内容)。 */
  epoch(): Promise<number>;
}

export function createInMemoryKnowledgeIndexRepository(): KnowledgeIndexRepository {
  const store = new Map<string, KnowledgeChunk>();
  let epoch = 0;
  return {
    put: async (c) => { store.set(c.id, c); },
    async replaceSource(t, id, chunks) {
      for (const [cid, c] of store) if (c.sourceType === t && c.sourceId === id) store.delete(cid);
      for (const c of chunks) store.set(c.id, c);
    },
    async deleteBySource(t, id) {
      for (const [cid, c] of store) if (c.sourceType === t && c.sourceId === id) store.delete(cid);
    },
    deleteAll: async () => { store.clear(); epoch += 1; },   // R8-1:清空递增代际
    listAll: async () => [...store.values()],
    epoch: async () => epoch
  };
}
