import { describe, it, expect } from "vitest";
import { scoreMemoryCandidate, withMemoryCandidateReview } from "./memoryReview";

describe("memoryReview", () => {
  it("scores candidate with evidence quote", () => {
    const candidate = {
      id: "mc1", text: "test", status: "pending" as const,
      sourceType: "interview_session" as const, sourceId: "s1",
      evidenceQuote: "direct quote from interview",
      reason: "important", sensitivity: "normal" as const,
      reviewScore: 0, reviewSignals: [] as string[],
      createdAt: new Date().toISOString(),
    };
    const score = scoreMemoryCandidate(candidate);
    expect(score.reviewScore).toBeGreaterThan(0);
    expect(score.reviewSignals.length).toBeGreaterThan(0);
  });

  it("withMemoryCandidateReview adds review fields", () => {
    const candidate = {
      id: "mc1", text: "test", status: "pending" as const,
      sourceType: "interview_session" as const, sourceId: "s1",
      evidenceQuote: "direct quote from interview",
      reason: "important", sensitivity: "normal" as const,
      reviewScore: 0, reviewSignals: [] as string[],
      createdAt: new Date().toISOString(),
    };
    const reviewed = withMemoryCandidateReview(candidate, { preserveExisting: false });
    expect(reviewed.reviewScore).toBeGreaterThan(0);
    expect(reviewed.reviewSignals.length).toBeGreaterThan(0);
  });

  it("preserves existing review scores when preserveExisting is true", () => {
    const candidate = {
      id: "mc1", text: "test", status: "pending" as const,
      sourceType: "interview_session" as const, sourceId: "s1",
      evidenceQuote: "direct quote from interview",
      reason: "important", sensitivity: "normal" as const,
      reviewScore: 85, reviewSignals: ["已有评分"] as string[],
      createdAt: new Date().toISOString(),
    };
    const reviewed = withMemoryCandidateReview(candidate);
    expect(reviewed.reviewScore).toBe(85);
    expect(reviewed.reviewSignals).toContain("已有评分");
  });

  it("penalizes sensitive candidates", () => {
    const normal = scoreMemoryCandidate({
      sourceType: "interview_session" as const,
      evidenceQuote: "a clear and specific quote",
      sensitivity: "normal" as const,
    });
    const sensitive = scoreMemoryCandidate({
      sourceType: "interview_session" as const,
      evidenceQuote: "a clear and specific quote",
      sensitivity: "sensitive" as const,
    });
    expect(sensitive.reviewScore).toBeLessThan(normal.reviewScore);
  });
});
