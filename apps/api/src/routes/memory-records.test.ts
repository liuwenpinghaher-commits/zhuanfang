import { describe, it, expect, vi } from "vitest";
import Fastify from "fastify";
import { registerMemoryRecordRoutes } from "./memory-records";
import { createInMemoryProductStateRepository } from "../product-state-repository";
import { createEmptyProductState } from "../../../../src/domain/engine";
import type { BailianEmbeddingClient } from "../providers/bailian";
import type { MemoryRecord, MemoryRecordStatus, ProductState } from "../../../../src/domain/types";

function record(partial: Partial<MemoryRecord> & { id: string; text: string }): MemoryRecord {
  return {
    status: "confirmed" as MemoryRecordStatus,
    sourceType: "interview_session",
    sourceId: "s1",
    evidenceQuote: "",
    sensitivity: "normal",
    createdAt: "2026-06-20T00:00:00.000Z",
    updatedAt: "2026-06-20T00:00:00.000Z",
    ...partial
  } as MemoryRecord;
}

function seed(records: MemoryRecord[]): ProductState {
  return { ...createEmptyProductState(), memoryRecords: records };
}

const client = (embed: BailianEmbeddingClient["embed"], providerId?: string): BailianEmbeddingClient =>
  ({ embed, ...(providerId ? { providerId } : {}) }) as unknown as BailianEmbeddingClient;

describe("memory-records PATCH (P2-12 重嵌 + 回归审查 R6-5/R6-6)", () => {
  it("编辑文本 → 重算向量(带 provider 戳),返回权威态(revision 已 bump)", async () => {
    const newVec = [0.1, 0.2, 0.3];
    const embed = vi.fn(async (texts: string[]) => texts.map(() => newVec));
    const repo = createInMemoryProductStateRepository(seed([record({ id: "m1", text: "旧文本", embedding: [9, 9], embeddingProvider: "old" })]));
    const rev0 = repo.getState().revision ?? 0;
    const server = Fastify({ logger: false });
    await registerMemoryRecordRoutes(server, repo, { embeddingClient: client(embed, "test-provider") });
    const res = await server.inject({ method: "PATCH", url: "/api/memory-records/m1", payload: { text: "新的事实陈述" } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.record.text).toBe("新的事实陈述");
    expect(body.record.embedding).toEqual(newVec);          // 文本变 → 向量真的重算了
    expect(body.record.embeddingProvider).toBe("test-provider");
    expect(body.state.revision).toBe(rev0 + 1);             // 返回权威态,客户端下次乐观 PUT 不 409
  });

  it("无 embeddingClient → 删除陈旧向量(诚实退化为关键词召回,绝不留旧语义)", async () => {
    const repo = createInMemoryProductStateRepository(seed([record({ id: "m1", text: "旧", embedding: [9, 9], embeddingProvider: "old" })]));
    const server = Fastify({ logger: false });
    await registerMemoryRecordRoutes(server, repo, {});
    const res = await server.inject({ method: "PATCH", url: "/api/memory-records/m1", payload: { text: "改后" } });
    expect(res.statusCode).toBe(200);
    expect(res.json().record.text).toBe("改后");
    expect(res.json().record.embedding).toBeUndefined();    // 陈旧向量已删,不带旧语义参与排序
  });

  it("R6-5:embed 输入截断到 MAX_EMBED_CHARS(2000)——与 approve 同口径,不喂超长文本致向量漂移", async () => {
    const embed = vi.fn(async (texts: string[]) => texts.map(() => [0.1]));
    const repo = createInMemoryProductStateRepository(seed([record({ id: "m1", text: "旧" })]));
    const server = Fastify({ logger: false });
    await registerMemoryRecordRoutes(server, repo, { embeddingClient: client(embed) });
    await server.inject({ method: "PATCH", url: "/api/memory-records/m1", payload: { text: "文".repeat(5000) } });
    expect(embed).toHaveBeenCalledTimes(1);
    expect(embed.mock.calls[0]![0]![0]!.length).toBe(2000);  // 截断到 MAX_EMBED_CHARS,与 approve 一致
  });

  it("text 超 16KB 上限 → 422(不写入)", async () => {
    const repo = createInMemoryProductStateRepository(seed([record({ id: "m1", text: "旧" })]));
    const server = Fastify({ logger: false });
    await registerMemoryRecordRoutes(server, repo, {});
    const res = await server.inject({ method: "PATCH", url: "/api/memory-records/m1", payload: { text: "x".repeat(16 * 1024 + 1) } });
    expect(res.statusCode).toBe(422);
    expect(repo.getState().memoryRecords[0]!.text).toBe("旧");  // 未写入
  });

  it("不存在的 record → 404", async () => {
    const repo = createInMemoryProductStateRepository(seed([]));
    const server = Fastify({ logger: false });
    await registerMemoryRecordRoutes(server, repo, {});
    const res = await server.inject({ method: "PATCH", url: "/api/memory-records/nope", payload: { text: "x" } });
    expect(res.statusCode).toBe(404);
  });

  it("非 confirmed record(deprecated) → 409", async () => {
    const repo = createInMemoryProductStateRepository(seed([record({ id: "m1", text: "旧", status: "deprecated" })]));
    const server = Fastify({ logger: false });
    await registerMemoryRecordRoutes(server, repo, {});
    const res = await server.inject({ method: "PATCH", url: "/api/memory-records/m1", payload: { text: "x" } });
    expect(res.statusCode).toBe(409);
  });

  it("R6-6:传 writeGate 时同步 RMW 经写门串行化(commit 在写门内执行)", async () => {
    const calls: string[] = [];
    const fakeGate = {
      runExclusive: async <T,>(label: string, fn: () => Promise<T> | T): Promise<T> => {
        calls.push(label);
        return await fn();
      }
    };
    const repo = createInMemoryProductStateRepository(seed([record({ id: "m1", text: "旧" })]));
    const server = Fastify({ logger: false });
    await registerMemoryRecordRoutes(server, repo, { writeGate: fakeGate });
    const res = await server.inject({ method: "PATCH", url: "/api/memory-records/m1", payload: { text: "改后" } });
    expect(res.statusCode).toBe(200);
    expect(calls).toEqual(["memory-record-patch:m1"]);      // read-modify-write 经写门,不绕串行化
    expect(repo.getState().memoryRecords[0]!.text).toBe("改后");
  });
});
