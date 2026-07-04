import type { FastifyInstance } from "fastify";
import { deleteMemoryRecord, deprecateMemoryRecord, updateMemoryRecordText } from "../../../../src/domain/engine";
import type { MemoryRecord, ProductState } from "../../../../src/domain/types";
import type { ProductStateRepository } from "../product-state-repository";
import type { BailianEmbeddingClient } from "../providers/bailian";
import { MAX_EMBED_CHARS } from "./knowledge";
import type { WriteGate } from "../server";

interface MemoryRecordRouteOptions {
  /** 审计修复(P2-12):编辑记忆文本后须重算向量——此前旧 embedding 原样保留,语义召回按旧事实
   *  匹配(比无向量更糟)。注入与 approve 同源的 client;缺省/失败则【删除】陈旧向量诚实退化为
   *  关键词召回。 */
  embeddingClient?: BailianEmbeddingClient;
  /** 回归审查 R6-6:PATCH 豁免全局写锁后,用它把同步 read-modify-write 串行化(embed 在锁外先算)。 */
  writeGate?: WriteGate;
}

interface DeprecateMemoryRecordPayload {
  reason?: unknown;
}

interface UpdateMemoryRecordPayload {
  text?: unknown;
}

// P1-05: cap a single memory text field. Long-term memory is short, factual statements;
// 16KB is generous for that while keeping one field from ballooning prompt/embedding cost.
const MEMORY_TEXT_MAX_CHARS = 16 * 1024;

export async function registerMemoryRecordRoutes(
  server: FastifyInstance,
  repository: ProductStateRepository,
  options: MemoryRecordRouteOptions = {}
) {
  server.patch("/api/memory-records/:id", async (request, reply) => {
    const state = repository.getState();
    const record = findRecord(state, getRecordId(request.params));
    if (!record) {
      return reply.code(404).send({ error: "Memory record not found." });
    }
    if (record.status !== "confirmed") {
      return reply.code(409).send({ error: "Memory record is not confirmed." });
    }

    const text = normalizeOptionalString(normalizeObject<UpdateMemoryRecordPayload>(request.body).text);
    if (!text) {
      return reply.code(422).send({ error: "Memory record text is required." });
    }
    if (text.length > MEMORY_TEXT_MAX_CHARS) {
      return reply.code(422).send({ error: `Memory record text exceeds the ${MEMORY_TEXT_MAX_CHARS}-character limit.` });
    }

    // 回归审查 R6-6:embed 是慢网络 IO(可达数百 ms),移出写锁。本路由已在 server preHandler 豁免全局
    // 写序列化;此处 embed 在锁外先算,只把同步的 read-modify-write 包进 writeGate.runExclusive。
    // 审计修复(P2-12):文本变 → 向量必须跟着变。成功则更新(带 provider 戳);失败/无 client 则
    // 删除陈旧向量(诚实退化为关键词召回,绝不让旧语义继续参与排序)。
    let reembedded: { embedding: number[]; embeddingProvider?: string } | undefined;
    if (options.embeddingClient) {
      try {
        const [vec] = await options.embeddingClient.embed([text.slice(0, MAX_EMBED_CHARS)]);
        if (Array.isArray(vec) && vec.length > 0) {
          reembedded = { embedding: vec, ...(options.embeddingClient.providerId ? { embeddingProvider: options.embeddingClient.providerId } : {}) };
        }
      } catch (err) {
        console.warn(JSON.stringify({ event: "memory_record_reembed_failed", id: record.id, error: err instanceof Error ? err.message : String(err) }));
      }
    }
    // 写门内重读 latest(并发可能已删/废弃该记录),应用文本与向量后落库。
    const commit = (): ProductState | null => {
      const latest = repository.getState();
      const cur = findRecord(latest, record.id);
      if (!cur || cur.status !== "confirmed") return null;   // 并发删除/废弃 → 放弃
      const withText = updateMemoryRecordText(latest, cur.id, text);
      const nextState: ProductState = {
        ...withText,
        memoryRecords: withText.memoryRecords.map((item) => {
          if (item.id !== cur.id) return item;
          if (reembedded) return { ...item, ...reembedded };
          const { embedding: _stale, embeddingProvider: _staleProvider, ...rest } = item;
          return rest as MemoryRecord;
        })
      };
      // 返回 replaceState 的权威态(revision 已 bump),否则客户端下一次乐观 PUT 必 409。
      return repository.replaceState(nextState);
    };
    const persisted = options.writeGate
      ? await options.writeGate.runExclusive(`memory-record-patch:${record.id}`, commit)
      : commit();
    if (!persisted) {
      return reply.code(404).send({ error: "Memory record not found." });
    }
    const updatedRecord = findRecord(persisted, record.id);
    return { record: updatedRecord, state: persisted };
  });

  server.delete("/api/memory-records/:id", async (request, reply) => {
    const state = repository.getState();
    const record = findRecord(state, getRecordId(request.params));
    if (!record) {
      return reply.code(404).send({ error: "Memory record not found." });
    }

    const nextState = deleteMemoryRecord(state, record.id);
    const persisted = repository.replaceState(nextState);

    return { record, state: persisted };
  });

  server.post("/api/memory-records/:id/deprecate", async (request, reply) => {
    const state = repository.getState();
    const record = findRecord(state, getRecordId(request.params));
    if (!record) {
      return reply.code(404).send({ error: "Memory record not found." });
    }
    if (record.status !== "confirmed") {
      return reply.code(409).send({ error: "Memory record is not confirmed." });
    }

    const reason = normalizeOptionalString(normalizeObject<DeprecateMemoryRecordPayload>(request.body).reason);
    const nextState = deprecateMemoryRecord(state, record.id, reason);
    const deprecatedRecord = findRecord(nextState, record.id);
    const persisted = repository.replaceState(nextState);

    return { record: deprecatedRecord, state: persisted };
  });
}

function normalizeObject<T>(value: unknown): Partial<T> {
  return value && typeof value === "object" ? (value as Partial<T>) : {};
}

function normalizeOptionalString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function getRecordId(params: unknown) {
  return normalizeObject<{ id: string }>(params).id;
}

function findRecord(state: ProductState, recordId: unknown): MemoryRecord | undefined {
  return typeof recordId === "string" ? state.memoryRecords.find((record) => record.id === recordId) : undefined;
}
