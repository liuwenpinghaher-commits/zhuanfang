import { describe, it, expect } from "vitest";
import { createInMemoryKnowledgeIndexRepository } from "./knowledge-index-repository";
import type { KnowledgeChunk } from "../../../src/domain/types";
const mk = (id: string, sourceType: KnowledgeChunk["sourceType"], sourceId: string): KnowledgeChunk => ({
  id, sourceType, sourceId, title: "t", text: "x", keywords: [], createdAt: "2026-06-22T00:00:00.000Z"
});
describe("in-memory KnowledgeIndexRepository", () => {
  it("put/listAll, deleteBySource 删该来源全部块, deleteAll", () => {
    const r = createInMemoryKnowledgeIndexRepository();
    r.put(mk("c1", "note", "s1")); r.put(mk("c2", "note", "s1")); r.put(mk("c3", "memory", "m1"));
    expect(r.listAll()).toHaveLength(3);
    r.deleteBySource("note", "s1");
    expect(r.listAll().map((c) => c.id)).toEqual(["c3"]);
    r.deleteAll();
    expect(r.listAll()).toHaveLength(0);
  });
  it("replaceSource 原子替换某来源的块", () => {
    const r = createInMemoryKnowledgeIndexRepository();
    r.put(mk("c1", "note", "s1"));
    r.replaceSource("note", "s1", [mk("c2", "note", "s1"), mk("c3", "note", "s1")]);
    expect(r.listAll().map((c) => c.id).sort()).toEqual(["c2", "c3"]);
  });

  it("R8-1:deleteAll 单调递增 epoch——reset/purge 后陈旧后台嵌入据此丢弃,不复活已清私密块", () => {
    const r = createInMemoryKnowledgeIndexRepository();
    const e0 = r.epoch();
    r.deleteAll();
    expect(r.epoch()).toBe(e0 + 1);
    r.deleteAll();
    expect(r.epoch()).toBe(e0 + 2);
  });

  it("R8-1 消费方模式:rebuild 捕获 startEpoch,put 前 epoch 已变(reset 清空)则判定陈旧丢弃", () => {
    const r = createInMemoryKnowledgeIndexRepository();
    r.put(mk("c1", "note", "s1"));
    const startEpoch = r.epoch();       // 后台嵌入开始时捕获
    r.deleteAll();                       // 期间 reset/purge 清空私密数据
    expect(r.epoch()).not.toBe(startEpoch);   // 守卫判定陈旧 → knowledge.ts 丢弃这批 put,不写回已清索引
  });
});
