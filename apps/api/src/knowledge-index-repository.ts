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
  /** R2c · 可选原生混合召回能力(P6「双份真相」收敛)。
   *
   *  两档差异与 P6 结论:
   *  - **Surreal 实现**:knowledge_chunk 表的 embedding 是 `array<float>` 唯一存储,自带
   *    HNSW(1024 COSINE)+ BM25(zh)索引(009_r2a_cold.surql);本方法走 HNSW+BM25+search::rrf
   *    原生混合检索——存储与检索共用同一份索引数据,embedding 不再有任何 JSON 文本副本,P6 就此终结。
   *  - **sqlite / in-memory 实现**:不实现本方法(可选成员保持 undefined)。sqlite 的 embedding
   *    仍是 JSON 文本列、无向量索引(旧样保持,R7 随档位退役一并删除),召回由消费点回落
   *    listAll + 应用层 cosine(rankKnowledgeChunks)。
   *
   *  消费契约(chat 等消费点据此探测):
   *  - 返回**候选集**(完整 KnowledgeChunk,含 embedding,调用方可用域层 rankKnowledgeChunks 精排,
   *    保持与旧路径同一打分函数与 score>0 相关性闸门)。排序:混合路按 rrf 名次降序;BM25-only 路
   *    是**无序候选截断**——LIMIT 无 ORDER BY,截的是候选集本身、不承诺 BM25 分数序。最终排序一律
   *    归调用方精排,不要依赖本方法的返回序作最终序。
   *  - `embedding` 缺省时走 BM25-only(纯关键词);无 embedding 的关键词降级块经 BM25 路可达。
   *  - 实现内部自带降级(混合失败 → 纯 HNSW → 空);消费点对"方法缺失 / 抛错 / 空候选 / 精排后为空"
   *    一律回落旧 listAll 路径,行为语义只增不减。
   *
   *  ⚠️ 装配透传 pin:未来任何给 knowledgeIndexRepository 引入装饰器/包装器的 PR,必须 spread 透传
   *  整个被包对象(含本可选能力成员),并附带"能力在包装后仍可探测"的装配测试——前车之鉴 P4:
   *  withKnowledgeReindex 只回固定方法清单,吞掉了原生召回能力,生产从未生效而测试直连 repo 全绿掩盖。 */
  searchHybrid?(query: { text: string; embedding?: number[]; limit: number }): Promise<KnowledgeChunk[]>;
}

// R2c:刻意不实现 searchHybrid(与 sqlite 档同口径)——消费点探测不到该能力时走
// listAll + rankKnowledgeChunks 旧路径,这正是 in-memory 档的既定召回语义。
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
