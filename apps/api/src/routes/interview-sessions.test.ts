import { describe, it, expect, vi } from "vitest";
import { buildApiServer } from "../server";
import { registerInterviewSessionRoutes } from "./interview-sessions";
import { createInMemoryProductStateRepository } from "../product-state-repository";
import { createLlmBudget } from "../llm-budget";
import Fastify from "fastify";

describe("interview-sessions routes", () => {
  it("record-turn appends a turn to the server session without generating an assistant reply", async () => {
    const server = buildApiServer({ env: {} }); // no key -> no real LLM
    const created = (await server.inject({ method: "POST", url: "/api/interview-sessions", payload: { mode: "decision" } })).json();
    const id = created.session.id;
    const before = created.session.turns.filter((t: any) => t.role === "assistant").length;
    const res = await server.inject({ method: "POST", url: `/api/interview-sessions/${id}/record-turn`, payload: { role: "user", content: "语音转写的一句话" } });
    expect(res.statusCode).toBe(200);
    const session = res.json().session;
    expect(session.turns.at(-1).role).toBe("user");
    expect(session.turns.at(-1).content).toBe("语音转写的一句话");
    // must NOT auto-generate an assistant turn
    expect(session.turns.filter((t: any) => t.role === "assistant").length).toBe(before);
    await server.close();
  });

  it("/turns: 2nd turn blocked by budget falls back to deterministic (200, LLM not called again)", async () => {
    const llmCallCount = { value: 0 };
    const mockInterviewClient = {
      createAssistantTurn: vi.fn(async (input: any) => {
        llmCallCount.value++;
        return {
          providerId: "bailian-character" as const,
          model: "test-model",
          content: `追问 ${llmCallCount.value}`,
          intent: "百炼角色扮演追问" as const
        };
      })
    };

    const budget = createLlmBudget({ maxCallsPerSession: 1 });
    const repo = createInMemoryProductStateRepository();
    const server = Fastify({ logger: false });
    await registerInterviewSessionRoutes(server, repo, {
      bailianInterviewClient: mockInterviewClient,
      llmBudget: budget
    });

    // Create a session
    const created = (await server.inject({ method: "POST", url: "/api/interview-sessions", payload: { mode: "daily" } })).json();
    const id = created.session.id;

    // First turn — within budget, LLM is called
    const res1 = await server.inject({ method: "POST", url: `/api/interview-sessions/${id}/turns`, payload: { content: "第一轮输入" } });
    expect(res1.statusCode).toBe(200);
    expect(llmCallCount.value).toBe(1);

    // Second turn — budget exhausted, LLM must NOT be called
    const res2 = await server.inject({ method: "POST", url: `/api/interview-sessions/${id}/turns`, payload: { content: "第二轮输入" } });
    expect(res2.statusCode).toBe(200);
    expect(llmCallCount.value).toBe(1); // still 1 — LLM was skipped
    // Deterministic fallback still returns a valid session with the user turn recorded
    const body2 = res2.json();
    expect(body2.session).toBeDefined();
    const userTurns = body2.session.turns.filter((t: any) => t.role === "user");
    expect(userTurns.length).toBeGreaterThanOrEqual(2);

    await server.close();
  });
});
