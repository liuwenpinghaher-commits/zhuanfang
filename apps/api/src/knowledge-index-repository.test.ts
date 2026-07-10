import { describe, it, expect } from "vitest";
import { createInMemoryKnowledgeIndexRepository } from "./knowledge-index-repository";
import type { KnowledgeChunk } from "../../../src/domain/types";
const mk = (id: string, sourceType: KnowledgeChunk["sourceType"], sourceId: string): KnowledgeChunk => ({
  id, sourceType, sourceId, title: "t", text: "x", keywords: [], createdAt: "2026-06-22T00:00:00.000Z"
});
// R2a:仓库接口已异步化,全部调用 await。
describe("in-memory KnowledgeIndexRepository", () => {
  it("put/listAll, deleteBySource 删该来源全部块, deleteAll", async () => {
    const r = createInMemoryKnowledgeIndexRepository();
    await r.put(mk("c1", "note", "s1")); await r.put(mk("c2", "note", "s1")); await r.put(mk("c3", "memory", "m1"));
    expect(await r.listAll()).toHaveLength(3);
    await r.deleteBySource("note", "s1");
    expect((await r.listAll()).map((c) => c.id)).toEqual(["c3"]);
    await r.deleteAll();
    expect(await r.listAll()).toHaveLength(0);
  });
  it("replaceSource 原子替换某来源的块", async () => {
    const r = createInMemoryKnowledgeIndexRepository();
    await r.put(mk("c1", "note", "s1"));
    await r.replaceSource("note", "s1", [mk("c2", "note", "s1"), mk("c3", "note", "s1")]);
    expect((await r.listAll()).map((c) => c.id).sort()).toEqual(["c2", "c3"]);
  });

  it("R8-1:deleteAll 单调递增 epoch——reset/purge 后陈旧后台嵌入据此丢弃,不复活已清私密块", async () => {
    const r = createInMemoryKnowledgeIndexRepository();
    const e0 = await r.epoch();
    await r.deleteAll();
    expect(await r.epoch()).toBe(e0 + 1);
    await r.deleteAll();
    expect(await r.epoch()).toBe(e0 + 2);
  });

  it("R8-1 消费方模式:rebuild 捕获 startEpoch,put 前 epoch 已变(reset 清空)则判定陈旧丢弃", async () => {
    const r = createInMemoryKnowledgeIndexRepository();
    await r.put(mk("c1", "note", "s1"));
    const startEpoch = await r.epoch();       // 后台嵌入开始时捕获
    await r.deleteAll();                       // 期间 reset/purge 清空私密数据
    expect(await r.epoch()).not.toBe(startEpoch);   // 守卫判定陈旧 → knowledge.ts 丢弃这批 put,不写回已清索引
  });
});
