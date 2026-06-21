import { describe, it, expect } from "vitest";
import { resolveEvidenceAnchors } from "./raw-material";
import type { InterviewTurn } from "./types";

const turn = (id: string, role: "user" | "assistant", content: string): InterviewTurn => ({
  id, role, content, intent: "", timestamp: "2026-06-21T00:00:00.000Z"
});

describe("resolveEvidenceAnchors", () => {
  const turns = [
    turn("t1", "assistant", "你怕的是结果失控，还是判断力被质疑？"),
    turn("t2", "user", "其实是怕我自己不再被需要。"),
    turn("t3", "user", "我一直不敢把审批权交给团队，怕出错。")
  ];

  it("精确匹配逐字引用到来源 turn", () => {
    const a = resolveEvidenceAnchors("其实是怕我自己不再被需要。", "s1", turns);
    expect(a).toEqual([{ sessionId: "s1", turnId: "t2" }]);
  });

  it("引用是某 turn 的子串也能命中", () => {
    const a = resolveEvidenceAnchors("不敢把审批权交给团队", "s1", turns);
    expect(a).toEqual([{ sessionId: "s1", turnId: "t3" }]);
  });

  it("空引用 / 匹配不到 → 空数组(不伪造)", () => {
    expect(resolveEvidenceAnchors("", "s1", turns)).toEqual([]);
    expect(resolveEvidenceAnchors("一句对话里根本没有的话", "s1", turns)).toEqual([]);
  });

  it("只在 user 轮里找(默认不锚到主持人的话)", () => {
    const a = resolveEvidenceAnchors("你怕的是结果失控", "s1", turns);
    expect(a).toEqual([]);
  });
});
