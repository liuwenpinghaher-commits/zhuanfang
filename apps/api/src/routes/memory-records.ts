import type { FastifyInstance } from "fastify";
import { deleteMemoryRecord, deprecateMemoryRecord, updateMemoryRecordText } from "../../../../src/domain/engine";
import type { MemoryRecord, ProductState } from "../../../../src/domain/types";
import type { ProductStateRepository } from "../product-state-repository";
import type { BailianEmbeddingClient } from "../providers/bailian";
import { MAX_EMBED_CHARS } from "./knowledge";
import { runStateCommand } from "../state-command";
import type { WriteGate } from "../server";

interface MemoryRecordRouteOptions {
  /** 审计修复(P2-12):编辑记忆文本后须重算向量——此前旧 embedding 原样保留,语义召回按旧事实
   *  匹配(比无向量更糟)。注入与 approve 同源的 client;缺省/失败则【删除】陈旧向量诚实退化为
   *  关键词召回。 */
  embeddingClient?: BailianEmbeddingClient;
  /** 回归审查 R6-6 → R3:三条路由均豁免全局写锁,同步 read-modify-write 走 runStateCommand
   *  CAS 重试(embed 仍在锁外/重试外先算),CAS commit 经此写门与在途长持锁写互斥(D3 不变量)。 */
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
    // 写序列化;此处 embed 在锁外(也在 CAS 重试外)先算——重试只重跑便宜的纯函数部分,绝不重跑 embed;
    // 算好的向量以闭包常量带进 mutate 写回。
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
    // R3:R6-6 的"写门内重读 latest 原子合并"换轨为 runStateCommand CAS 重试——同步 RMW 语义不变
    // (mutate 每次基于最新态重找记录,并发删除/废弃 → null → 404),多出 expectedRevision 纵深防御
    // 与治理在途 409。commit 仍经写门(D3 不变量,见 state-command.ts)。
    const persisted = await runStateCommand(
      repository,
      (latest) => {
        const cur = findRecord(latest, record.id);
        if (!cur || cur.status !== "confirmed") return null;   // 并发删除/废弃 → 放弃
        const withText = updateMemoryRecordText(latest, cur.id, text);
        return {
          ...withText,
          memoryRecords: withText.memoryRecords.map((item) => {
            if (item.id !== cur.id) return item;
            if (reembedded) return { ...item, ...reembedded };
            const { embedding: _stale, embeddingProvider: _staleProvider, ...rest } = item;
            return rest as MemoryRecord;
          })
        };
      },
      { writeGate: options.writeGate, label: `memory-record-patch:${record.id}` }
    );
    if (!persisted) {
      return reply.code(404).send({ error: "Memory record not found." });
    }
    // 返回 replaceState 的权威态(revision 已 bump),否则客户端下一次乐观 PUT 必 409。
    const updatedRecord = findRecord(persisted, record.id);
    return { record: updatedRecord, state: persisted };
  });

  // R3 试点:纯同步小 RMW,换轨 CAS(查找在 mutate 内基于最新态重算;返回的 record 是删除前快照)。
  server.delete("/api/memory-records/:id", async (request, reply) => {
    const recordId = getRecordId(request.params);
    let deleted: MemoryRecord | undefined;
    const persisted = await runStateCommand(
      repository,
      (state) => {
        deleted = undefined;
        const record = findRecord(state, recordId);
        if (!record) return null;
        deleted = record;
        return deleteMemoryRecord(state, record.id);
      },
      { writeGate: options.writeGate, label: `command:memory-record-delete:${recordId ?? "unknown"}` }
    );
    if (!persisted || !deleted) {
      return reply.code(404).send({ error: "Memory record not found." });
    }
    return { record: deleted, state: persisted };
  });

  // R3 试点:纯同步小 RMW,换轨 CAS。并发双 deprecate 同一记录 = 确定性一胜一 409。
  server.post("/api/memory-records/:id/deprecate", async (request, reply) => {
    const recordId = getRecordId(request.params);
    const reason = normalizeOptionalString(normalizeObject<DeprecateMemoryRecordPayload>(request.body).reason);
    let failure: { code: number; error: string } | null = null;
    let deprecatedRecord: MemoryRecord | undefined;
    const persisted = await runStateCommand(
      repository,
      (state) => {
        failure = null;
        deprecatedRecord = undefined;
        const record = findRecord(state, recordId);
        if (!record) {
          failure = { code: 404, error: "Memory record not found." };
          return null;
        }
        if (record.status !== "confirmed") {
          failure = { code: 409, error: "Memory record is not confirmed." };
          return null;
        }
        const nextState = deprecateMemoryRecord(state, record.id, reason);
        deprecatedRecord = findRecord(nextState, record.id);
        return nextState;
      },
      { writeGate: options.writeGate, label: `command:memory-record-deprecate:${recordId ?? "unknown"}` }
    );
    if (!persisted) {
      const f = failure ?? { code: 404, error: "Memory record not found." };
      return reply.code(f.code).send({ error: f.error });
    }
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
