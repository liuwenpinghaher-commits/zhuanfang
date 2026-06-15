import { describe, expect, it } from "vitest";
import { buildInterviewCard, buildInterviewGuide } from "./context-pack";
import { createInitialProductState } from "./engine";

describe("context-pack (de-hardcoded)", () => {
  it("does not parrot the 救火/控制感 demo when the user's themes are unrelated", () => {
    const state = createInitialProductState();
    state.themes = [{
      id: "t1", name: "搬家焦虑", summary: "关于搬到新城市的不安",
      maturity: "聚焦", representativeQuote: "我怕在新城市没有朋友",
      appearances: 3, nextQuestion: "你最担心失去什么？", updatedAt: new Date().toISOString()
    }];
    state.points = []; state.questions = []; state.debts = []; state.notes = [];
    const card = buildInterviewCard(state);
    expect(card.title).not.toContain("救火");
    expect(card.potentialTension).not.toContain("授权");
    expect(`${card.title} ${card.whyNow} ${card.suggestedOpening} ${card.potentialTension}`).toMatch(/搬家|新城市|朋友|焦虑/);
  });

  it("produces neutral card fields when the user has no themes (clean-start)", () => {
    const state = createInitialProductState();
    state.themes = []; state.points = []; state.questions = []; state.debts = []; state.notes = [];
    const card = buildInterviewCard(state);
    expect(card.title).toBe("今天想聊点什么？");
    expect(card.whyNow.length).toBeGreaterThan(0);
    expect(card.suggestedOpening.length).toBeGreaterThan(0);
    expect(card.potentialTension.length).toBeGreaterThan(0);
    expect(`${card.title}${card.whyNow}${card.potentialTension}`).not.toMatch(/救火|授权/);
  });

  it("blindspot candidates never leak the 救火/授权 demo persona", () => {
    for (const themes of [[], [{ id: "t1", name: "搬家焦虑", summary: "搬到新城市的不安", maturity: "聚焦" as const, representativeQuote: "怕没朋友", appearances: 2, nextQuestion: "最担心失去什么？", updatedAt: new Date().toISOString() }]]) {
      const state = createInitialProductState();
      state.themes = themes; state.points = []; state.questions = []; state.debts = []; state.notes = []; state.memoryRecords = []; state.memoryCandidates = [];
      const guide = buildInterviewGuide(state);
      for (const b of guide.blindspotCandidates) {
        expect(`${b.concept} ${b.reason}`).not.toMatch(/救火|授权/);
      }
    }
  });
});
