import { describe, it, expect } from "vitest";
import { diffById, diffEdges, edgeKey } from "./diff";
import type { EdgeSpec } from "./edge-mapper";

describe("diffById", () => {
  it("新增/内容变 → upsert;移除 → removeIds;不变 → 不动", () => {
    const prev = [{ id: "a", v: 1 }, { id: "b", v: 2 }, { id: "c", v: 3 }];
    const next = [{ id: "a", v: 1 }, { id: "b", v: 99 }, { id: "d", v: 4 }];
    const d = diffById(prev, next);
    expect(d.upsert.map((x) => x.id).sort()).toEqual(["b", "d"]); // b 变、d 新
    expect(d.removeIds.sort()).toEqual(["c"]);                    // c 移除
    expect(d.upsert.find((x) => x.id === "a")).toBeUndefined();   // a 不变,不 upsert
  });
  it("空 prev → 全 upsert;空 next → 全 remove", () => {
    expect(diffById([], [{ id: "a", v: 1 }]).upsert).toHaveLength(1);
    expect(diffById([{ id: "a", v: 1 }], []).removeIds).toEqual(["a"]);
  });
});

describe("diffEdges", () => {
  const e = (fromId: string, edge: EdgeSpec["edge"], toId: string): EdgeSpec =>
    ({ edge, fromTable: "point", fromId, toTable: "theme", toId });
  it("按 from|edge|to 身份集差", () => {
    const prev = [e("p1", "belongs_to_theme", "t1"), e("p2", "belongs_to_theme", "t1")];
    const next = [e("p1", "belongs_to_theme", "t1"), e("p3", "belongs_to_theme", "t1")];
    const d = diffEdges(prev, next);
    expect(d.added.map((x) => x.fromId)).toEqual(["p3"]);
    expect(d.removed.map((x) => x.fromId)).toEqual(["p2"]);
  });
  it("重复 key 去重(同 from|edge|to 视为一条)", () => {
    const prev: EdgeSpec[] = [];
    const next = [e("p1", "belongs_to_theme", "t1"), e("p1", "belongs_to_theme", "t1")];
    expect(diffEdges(prev, next).added).toHaveLength(1);
  });
  it("edgeKey 含 from/edge/to", () => {
    expect(edgeKey(e("p1", "derived_from", "x"))).toBe("point:p1|derived_from|theme:x");
  });
});
