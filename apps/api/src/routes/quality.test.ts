import Fastify from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createInitialProductState } from "../../../../src/domain/engine";
import { createInMemoryProductStateRepository } from "../product-state-repository";
import { registerQualityRoutes } from "./quality";

describe("quality routes", () => {
  const app = Fastify({ logger: false });
  const repo = createInMemoryProductStateRepository(createInitialProductState());

  beforeAll(async () => {
    await app.register(async (instance) => {
      registerQualityRoutes(instance, repo);
    });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it("lists all 8 scorers", async () => {
    const res = await app.inject({ method: "GET", url: "/api/quality/scorers" });
    expect(res.statusCode).toBe(200);
    expect(res.json().scorers).toEqual(
      expect.arrayContaining([
        "interviewNaturalness",
        "followupRelevance",
        "memoryCitation",
        "memoryCandidatePrecision",
        "sensitiveLeakage",
        "contextPackRelevance",
        "sourceFaithfulness",
        "interviewFeedback"
      ])
    );
    expect(res.json().scorers).toHaveLength(8);
  });

  it("scores interviewNaturalness using question count", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/quality/score",
      payload: { scorerName: "interviewNaturalness", input: "How are you today?\nReally?\nWhy is that?" }
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.scorerName).toBe("interviewNaturalness");
    expect(body.score).toBeGreaterThan(0);
  });

  it("scores followupRelevance with previousTopics", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/quality/score",
      payload: {
        scorerName: "followupRelevance",
        input: "我们再聊聊增长和团队信任",
        previousTopics: ["增长", "团队信任"]
      }
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().score).toBe(1);
  });

  it("scores memoryCitation when response cites a memory", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/quality/score",
      payload: {
        scorerName: "memoryCitation",
        input: "你提到过偏向独立判断这点很重要",
        memories: ["你提到过偏向独立判断"]
      }
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().score).toBeGreaterThan(0.5);
  });

  it("scores memoryCandidatePrecision via candidate object", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/quality/score",
      payload: {
        scorerName: "memoryCandidatePrecision",
        candidate: { text: "团队信任 是 关键", evidenceQuote: "团队信任 是 真正 关键 的事" }
      }
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().score).toBeGreaterThan(0);
  });

  it("flags sensitiveLeakage when phone numbers appear", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/quality/score",
      payload: { scorerName: "sensitiveLeakage", input: "我的手机号是 13800138000" }
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().score).toBe(0);
  });

  it("scores contextPackRelevance against session topic", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/quality/score",
      payload: {
        scorerName: "contextPackRelevance",
        pack: { theme: "增长困境", recentNotes: ["关于增长的复盘"] },
        sessionTopic: "增长"
      }
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().score).toBeGreaterThan(0.5);
  });

  it("scores sourceFaithfulness against external source", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/quality/score",
      payload: {
        scorerName: "sourceFaithfulness",
        claim: "company increased revenue substantially this quarter",
        source: "the company increased revenue substantially this quarter according to filing"
      }
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().score).toBeGreaterThan(0.5);
  });

  it("scores interviewFeedback from rating list", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/quality/score",
      payload: {
        scorerName: "interviewFeedback",
        feedbacks: [{ rating: 4 }, { rating: 5 }, { rating: 5 }]
      }
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.score).toBeGreaterThan(0.8);
    expect(body.feedback).toContain("Average rating");
  });

  it("rejects unknown scorer with 400", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/quality/score",
      payload: { scorerName: "nonExistent", input: "x" }
    });
    expect(res.statusCode).toBe(400);
  });

  it("returns quality report aggregates", async () => {
    const res = await app.inject({ method: "GET", url: "/api/quality/report" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      summary: {
        totalSessions: expect.any(Number),
        totalMemories: expect.any(Number),
        totalAuditEvents: expect.any(Number),
        totalAiRuns: expect.any(Number)
      }
    });
  });
});
