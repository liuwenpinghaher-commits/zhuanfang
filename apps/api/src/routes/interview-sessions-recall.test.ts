import { describe, it, expect } from "vitest";
import Fastify from "fastify";
import { registerInterviewSessionRoutes } from "./interview-sessions";
import { createInMemoryProductStateRepository } from "../product-state-repository";

describe("interview-sessions:P2b surreal 权威原生召回接线", () => {
  it("surreal 权威 repo → 创建 session 走原生图遍历召回(挂主题决策经 recallThemeAssets 召回)", async () => {
    const repo = createInMemoryProductStateRepository();
    const base = repo.getState();
    repo.replaceState({
      ...base,
      themes: [{ id: "th_1", name: "放权", summary: "", maturity: "聚焦", representativeQuote: "", appearances: 9, nextQuestion: "", updatedAt: "2026-06-27T00:00:00.000Z" }],
      decisions: [{ id: "de_1", title: "挂主题决策", decisionKind: "用户决策", confirmationStatus: "用户确认", choice: "放手让团队自己拍板", tradeOff: "", riskHypothesis: "", reviewAt: "", status: "待复盘", updatedAt: "2026-06-27T00:00:00.000Z", relatedThemeIds: ["th_1"] }]
    });
    // in-memory repo 挂 recall* → 结构等价 surreal 权威;recallThemeAssets 返回挂主题决策 id。
    const fakeSurreal = Object.assign(repo, {
      recallThemeAssets: async () => ({ points: [], decisions: ["de_1"], questions: [], memories: [] }),
      recallMemoriesByVector: async () => [] as Array<{ id: string; text: string }>,
      recallProvenanceTurns: async () => [] as Array<{ id: string; content: string; sessionId: string; role: string }>
    });
    const server = Fastify({ logger: false });
    await registerInterviewSessionRoutes(server, fakeSurreal);
    const created = (await server.inject({ method: "POST", url: "/api/interview-sessions", payload: { mode: "daily", topicHint: "放权" } })).json();
    expect(created.session.guide.relevantMemories.join(" | ")).toContain("挂主题决策");
    await server.close();
  });

  it("非原生 repo(in-memory)→ 回落域层召回,session 正常创建(零回归)", async () => {
    const repo = createInMemoryProductStateRepository();
    const server = Fastify({ logger: false });
    await registerInterviewSessionRoutes(server, repo);
    const res = await server.inject({ method: "POST", url: "/api/interview-sessions", payload: { mode: "daily" } });
    expect(res.statusCode).toBe(200);
    await server.close();
  });
});
