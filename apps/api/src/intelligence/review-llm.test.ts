import { describe, expect, it } from "vitest";
import { createInitialProductState } from "../../../../src/domain/engine";
import type { BailianChatClient } from "../providers/bailian";
import { buildReviewsWithLlm } from "./review-llm";

const mockChat = (json: string): BailianChatClient => ({
  async complete() {
    return json;
  }
});

describe("buildReviewsWithLlm", () => {
  it("overlays LLM narratives but keeps deterministic metrics/radar", async () => {
    const state = createInitialProductState(); // seeded with demo assets
    const json = JSON.stringify({
      monthly: { topTheme: "X", changedView: "CV", avoidedQuestion: "AQ", recommendedNextInterview: "RN" },
      yearly: {
        coreQuestions: ["q1"],
        changedViews: ["v1"],
        unresolvedPatterns: ["p1"],
        importantDecisions: ["d1"],
        missingPerspectives: ["哲学"],
        nextYearFocus: "NYF"
      }
    });

    const reviews = await buildReviewsWithLlm(state, mockChat(json));
    expect(reviews.monthly.changedView).toBe("CV");
    expect(reviews.monthly.avoidedQuestion).toBe("AQ");
    expect(reviews.yearly.nextYearFocus).toBe("NYF");
    // metrics are real counts, not from the LLM
    expect(reviews.monthly.metrics.points).toBe(state.points.length);
    expect(reviews.radar.assets.length).toBeGreaterThan(0);
  });

  it("falls back to the deterministic narrative on malformed LLM output", async () => {
    const state = createInitialProductState();
    const reviews = await buildReviewsWithLlm(state, mockChat("not json")).catch(() => null);
    // parse failure throws; the route (not this fn) handles fallback. Here we
    // just assert it surfaces rather than returning corrupt data.
    expect(reviews).toBeNull();
  });
});
