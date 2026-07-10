import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { KnowledgeChunk } from "../../../src/domain/types";
import type { KnowledgeIndexRepository } from "../../../apps/api/src/knowledge-index-repository";

export interface SqliteKnowledgeIndexRepositoryOptions {
  dbPath: string;
}

interface KnowledgeChunkRow {
  id: string;
  source_type: string;
  source_id: string;
  title: string | null;
  text: string;
  keywords_json: string | null;
  embedding_json: string | null;
  created_at: string;
}

function mapRow(row: KnowledgeChunkRow): KnowledgeChunk {
  const chunk: KnowledgeChunk = {
    id: row.id,
    sourceType: row.source_type as KnowledgeChunk["sourceType"],
    sourceId: row.source_id,
    title: row.title ?? "",
    text: row.text,
    keywords: JSON.parse(row.keywords_json ?? "[]"),
    createdAt: row.created_at
  };
  // 仅在持久化了 embedding 时挂字段，保持类型上的可选语义。
  if (row.embedding_json !== null) {
    chunk.embedding = JSON.parse(row.embedding_json);
  }
  return chunk;
}

/** R2c · P6「双份真相」两档差异说明:本 sqlite 实现的 embedding 是 JSON 文本列(embedding_json)、
 *  无向量索引,召回依赖消费点(chat)的 listAll + 应用层 cosine(rankKnowledgeChunks)——**刻意不实现**
 *  可选的 searchHybrid,消费点探测不到即走旧路径,行为保持旧样。Surreal 档的 knowledge_chunk 表
 *  (009_r2a_cold.surql)embedding 为 array<float> + HNSW/BM25 索引且无 JSON 副本,原生混合召回见
 *  createSurrealKnowledgeIndexRepository.searchHybrid;本文件随 sqlite 档位在 R7 一并退役删除。 */
export function createSqliteKnowledgeIndexRepository(
  options: SqliteKnowledgeIndexRepositoryOptions
): KnowledgeIndexRepository {
  // ":memory:" has no directory to create; only mkdir for real file paths.
  if (options.dbPath !== ":memory:") {
    mkdirSync(dirname(options.dbPath), { recursive: true });
  }
  const database = new DatabaseSync(options.dbPath);
  database.exec(`
    CREATE TABLE IF NOT EXISTS knowledge_chunks (
      id            TEXT PRIMARY KEY,
      source_type   TEXT NOT NULL,
      source_id     TEXT NOT NULL,
      title         TEXT,
      text          TEXT NOT NULL,
      keywords_json TEXT,
      embedding_json TEXT,
      created_at    TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_kc_source ON knowledge_chunks(source_type, source_id);
  `);

  const upsert = database.prepare(
    `INSERT INTO knowledge_chunks
       (id, source_type, source_id, title, text, keywords_json, embedding_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       source_type = excluded.source_type,
       source_id = excluded.source_id,
       title = excluded.title,
       text = excluded.text,
       keywords_json = excluded.keywords_json,
       embedding_json = excluded.embedding_json,
       created_at = excluded.created_at`
  );
  const deleteBySourceStmt = database.prepare(
    "DELETE FROM knowledge_chunks WHERE source_type = ? AND source_id = ?"
  );
  const deleteAllStmt = database.prepare("DELETE FROM knowledge_chunks");
  const selectAll = database.prepare("SELECT * FROM knowledge_chunks ORDER BY created_at ASC");

  const put = (c: KnowledgeChunk): void => {
    upsert.run(
      c.id,
      c.sourceType,
      c.sourceId,
      c.title,
      c.text,
      JSON.stringify(c.keywords),
      c.embedding ? JSON.stringify(c.embedding) : null,
      c.createdAt
    );
  };

  // 回归审查 R8-1:进程内单调代际号(索引是派生可重建的进程态,epoch 无需持久化)。
  let epoch = 0;
  // R2a 接口异步化:同步 sqlite 实现机械包装为 async(语义不变),对齐异步化后的接口。
  return {
    put: async (c) => { put(c); },
    async replaceSource(sourceType, sourceId, chunks) {
      // 单线程同步执行：DELETE 后逐条 put，事务保证原子替换。
      database.exec("BEGIN");
      try {
        deleteBySourceStmt.run(sourceType, sourceId);
        for (const c of chunks) {
          put(c);
        }
        database.exec("COMMIT");
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    },
    async deleteBySource(sourceType, sourceId) {
      deleteBySourceStmt.run(sourceType, sourceId);
    },
    async deleteAll() {
      deleteAllStmt.run();
      epoch += 1;   // R8-1:清空递增代际,丢弃陈旧后台嵌入
    },
    async listAll() {
      const rows = selectAll.all() as unknown as KnowledgeChunkRow[];
      return rows.map(mapRow);
    },
    epoch: async () => epoch
  };
}
