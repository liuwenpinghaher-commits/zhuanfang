import type { InterviewRawMaterial } from "../../../src/domain/types";

/** R2a 接口异步化:全部方法返回 Promise(语义/形状不变)。
 *  动机:冷层新增 SurrealDB 实现(嵌入式连接天然异步),且 R2b 治理事务要在 async 上下文里
 *  跨冷热单事务;同步实现(sqlite/in-memory)机械包装为 async,消费点统一 await。 */
export interface RawMaterialRepository {
  get(sessionId: string): Promise<InterviewRawMaterial | undefined>;
  list(): Promise<InterviewRawMaterial[]>;
  put(material: InterviewRawMaterial): Promise<void>;
  delete(sessionId: string): Promise<void>;
  deleteAll(): Promise<void>;
}

export function createInMemoryRawMaterialRepository(): RawMaterialRepository {
  const store = new Map<string, InterviewRawMaterial>();
  return {
    get: async (id) => store.get(id),
    list: async () => [...store.values()],
    put: async (m) => { store.set(m.sessionId, m); },
    delete: async (id) => { store.delete(id); },
    deleteAll: async () => { store.clear(); }
  };
}
