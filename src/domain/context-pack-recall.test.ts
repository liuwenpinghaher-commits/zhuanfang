import { describe, it, expect } from "vitest";
import { createInitialProductState } from "./engine";
import { resolveInterviewTopicHint } from "./context-pack";
import type { ProductState } from "./types";

function theme(id: string, name: string, appearances: number) {
  return { id, name, summary: "", maturity: "聚焦" as const, representativeQuote: "", appearances, nextQuestion: "", updatedAt: "2026-06-27T00:00:00.000Z" };
}
function stateWith(over: Partial<ProductState> = {}): ProductState {
  return { ...createInitialProductState(), ...over };
}

describe("resolveInterviewTopicHint", () => {
  it("显式 topicHint 优先(且 trim)", () => {
    const s = stateWith({ themes: [theme("th_1", "放权", 5)] });
    expect(resolveInterviewTopicHint(s, { topicHint: "  授权边界 " })).toBe("授权边界");
  });
  it("无显式时回退到出现次数最高的主题名", () => {
    const s = stateWith({ themes: [theme("th_1", "放权", 2), theme("th_2", "复盘", 9)] });
    expect(resolveInterviewTopicHint(s, {})).toBe("复盘");
  });
  it("无主题/简报/聚焦问题时回退到 profile.currentFocus", () => {
    const base = createInitialProductState();
    const s: ProductState = { ...base, themes: [], searchBriefs: [], profile: { ...base.profile, currentFocus: "我的焦点XYZ" } };
    expect(resolveInterviewTopicHint(s, {})).toBe("我的焦点XYZ");
  });
});
