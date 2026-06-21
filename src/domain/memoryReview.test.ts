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

  const base = (text: string) => ({
    id: "mc", text, status: "pending" as const,
    sourceType: "interview_session" as const, sourceId: "s1",
    evidenceQuote: "原文片段足够长可作证据", reason: "需确认", sensitivity: "normal" as const,
    reviewScore: 0, reviewSignals: [] as string[], createdAt: new Date().toISOString()
  });

  it("rewards a candidate with a triggerable mechanism / falsifiable structure", () => {
    const mech = scoreMemoryCandidate(base("不是数据量不足，而是评估信号惩罚了宽泛思考，导致模型过度适配。"));
    const flat = scoreMemoryCandidate(base("团队应该多沟通形成共识。"));
    expect(mech.reviewScore).toBeGreaterThan(flat.reviewScore);
    expect(mech.reviewSignals.join()).toMatch(/机制|可操作|可证伪/);
  });

  it("rewards a candidate that carries a quantified anchor", () => {
    const quant = scoreMemoryCandidate(base("把每张卡的有效利用率提高了30%。"));
    const vague = scoreMemoryCandidate(base("利用率有了明显提升。"));
    expect(quant.reviewScore).toBeGreaterThan(vague.reviewScore);
  });

  it("penalizes a flat assertion / pure rhetoric with no mechanism and no quantity", () => {
    const rhetoric = scoreMemoryCandidate(base("人在深渊边缘，唯一属于自己的是那一笔一划的微小主权。"));
    const grounded = scoreMemoryCandidate(base("当用户连续三次在同一时间点卡住时，立刻停掉AB测试去现场看。"));
    expect(rhetoric.reviewScore).toBeLessThan(grounded.reviewScore);
    expect(rhetoric.reviewSignals.join()).toMatch(/缺.*锚点|泛泛|修辞/);
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
