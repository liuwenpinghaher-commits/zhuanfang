import { describe, expect, it } from "vitest";
import { createInitialProductState } from "./engine";
import { resolveMidSessionRecallTopic } from "./context-pack";

describe("resolveMidSessionRecallTopic (R-P1-01)", () => {
  it("without latest text falls back to opening topic for both theme and query", () => {
    const state = createInitialProductState();
    const r = resolveMidSessionRecallTopic(state, "放权", undefined);
    expect(r.themeTopic).toBe("放权");
    expect(r.queryText).toBe("放权");
  });

  it("uses latest utterance as queryText even when theme name is opening-time only", () => {
    const base = createInitialProductState();
    const state = {
      ...base,
      themes: [
        {
          id: "th_1",
          name: "放权",
          summary: "",
          maturity: "聚焦" as const,
          representativeQuote: "",
          appearances: 9,
          nextQuestion: "",
          updatedAt: "2026-06-27T00:00:00.000Z"
        }
      ]
    };
    const r = resolveMidSessionRecallTopic(state, "放权", "今天我想谈第二增长曲线的焦虑");
    // Drift: latest does not contain theme name → no silent open-time graph theme
    expect(r.themeTopic).toBe("");
    expect(r.queryText).toBe("今天我想谈第二增长曲线的焦虑");
  });

  it("picks theme name that appears in latest utterance for graph matching", () => {
    const base = createInitialProductState();
    const state = {
      ...base,
      themes: [
        {
          id: "th_1",
          name: "放权",
          summary: "",
          maturity: "聚焦" as const,
          representativeQuote: "",
          appearances: 3,
          nextQuestion: "",
          updatedAt: "2026-06-27T00:00:00.000Z"
        },
        {
          id: "th_2",
          name: "增长焦虑",
          summary: "",
          maturity: "萌芽" as const,
          representativeQuote: "",
          appearances: 5,
          nextQuestion: "",
          updatedAt: "2026-06-27T00:00:00.000Z"
        }
      ]
    };
    const r = resolveMidSessionRecallTopic(state, "放权", "其实增长焦虑比放权更让我睡不着");
    // Longest matching theme name wins among those present in latest text
    expect(r.themeTopic).toBe("增长焦虑");
    expect(r.queryText).toContain("增长焦虑");
  });
});
