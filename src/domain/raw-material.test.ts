import { describe, it, expect } from "vitest";
import { resolveEvidenceAnchors, addAnnotation, removeAnnotation, stampFinalizeAnchors, backfillEvidenceAnchors } from "./raw-material";
import { createInitialProductState } from "./engine";
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

  // I2: a short filler turn ("嗯。") that is a substring of a long quote must NOT
  // be misanchored even though it sorts before the real source turn. Reverse
  // substring matching (quote.includes(turn)) needs a minimum-length guard so
  // trivial fillers never win over the turn the quote actually came from.
  it("极短填充轮不被长引用误锚(反向子串最小长度守卫)", () => {
    const withFiller = [
      turn("t0", "user", "嗯。"),
      turn("t1", "assistant", "你当时是怎么想的？"),
      turn("t2", "user", "嗯。我当时其实特别犹豫要不要继续撑下去。")
    ];
    const a = resolveEvidenceAnchors("嗯。我当时其实特别犹豫要不要继续撑下去。", "s1", withFiller);
    expect(a).toEqual([{ sessionId: "s1", turnId: "t2" }]);
  });
});

describe("interview annotations", () => {
  it("addAnnotation 追加一条带 turn 锚点的旁注,trim,记审计", () => {
    const s = createInitialProductState();
    const next = addAnnotation(s, "sess-1", "turn-9", "  这里他其实在回避  ");
    expect(next.interviewAnnotations).toHaveLength(1);
    expect(next.interviewAnnotations[0].text).toBe("这里他其实在回避");
    expect(next.interviewAnnotations[0].sessionId).toBe("sess-1");
    expect(next.interviewAnnotations[0].turnId).toBe("turn-9");
    expect(next.auditEvents.some((e) => e.type === "annotation_created")).toBe(true);
  });

  it("空白旁注被忽略", () => {
    const s = createInitialProductState();
    expect(addAnnotation(s, "sess-1", "turn-9", "   ").interviewAnnotations).toHaveLength(0);
  });

  it("removeAnnotation 删除指定 id,不存在则原样返回", () => {
    const s = addAnnotation(createInitialProductState(), "sess-1", "turn-9", "x");
    const id = s.interviewAnnotations[0].id;
    expect(removeAnnotation(s, id).interviewAnnotations).toHaveLength(0);
    expect(removeAnnotation(s, "nope")).toBe(s);
  });

  it("不可变:不改输入 state", () => {
    const s = createInitialProductState();
    addAnnotation(s, "sess-1", "turn-9", "x");
    expect(s.interviewAnnotations).toHaveLength(0);
  });
});

describe("stampFinalizeAnchors", () => {
  const turns = [turn("t2", "user", "其实是怕我自己不再被需要。")];
  it("给带 evidenceQuote 的记忆候选盖上锚点", () => {
    const candidates = [{ evidenceQuote: "其实是怕我自己不再被需要。" } as any];
    const out = stampFinalizeAnchors(candidates, "s1", turns);
    expect(out[0].evidenceAnchors).toEqual([{ sessionId: "s1", turnId: "t2" }]);
  });
  it("匹配不到则不加 evidenceAnchors(保持 undefined)", () => {
    const out = stampFinalizeAnchors([{ evidenceQuote: "没有的话" } as any], "s1", turns);
    expect(out[0].evidenceAnchors).toBeUndefined();
  });
});

describe("backfillEvidenceAnchors", () => {
  it("用 sessions 的 turns 给已有 memoryRecords 补锚点,幂等", () => {
    const base = createInitialProductState();
    const state = {
      ...base,
      sessions: [{ id: "s1", turns: [turn("t2", "user", "其实是怕我自己不再被需要。")] } as any],
      memoryRecords: [{ id: "m1", evidenceQuote: "其实是怕我自己不再被需要。", sourceId: "s1" } as any]
    };
    const out = backfillEvidenceAnchors(state);
    expect(out.memoryRecords[0].evidenceAnchors).toEqual([{ sessionId: "s1", turnId: "t2" }]);
    expect(backfillEvidenceAnchors(out).memoryRecords[0].evidenceAnchors).toEqual([{ sessionId: "s1", turnId: "t2" }]);
  });
});
