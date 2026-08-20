/**
 * Recall/embed is an enhancement: runtime 401/400 must not block session create or turns.
 * Drives shipped registerInterviewSessionRoutes (not a copy of the catch).
 */
import { describe, expect, it, vi } from "vitest";
import Fastify from "fastify";
import { registerInterviewSessionRoutes } from "./interview-sessions";
import { createInMemoryProductStateRepository } from "../product-state-repository";

describe("interview session embed fail-soft", () => {
  it("create session still 200 when embeddingClient throws 401", async () => {
    const embed = vi.fn(async () => {
      throw new Error("Bailian embeddings request failed: 401");
    });
    const repo = createInMemoryProductStateRepository();
    const server = Fastify({ logger: false });
    await registerInterviewSessionRoutes(server, repo, { embeddingClient: { embed } as never });
    const res = await server.inject({
      method: "POST",
      url: "/api/interview-sessions",
      payload: { mode: "daily", topicHint: "ADV-short-abstract" }
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().session?.id).toBeTruthy();
    expect(embed).toHaveBeenCalled();
    await server.close();
  });

  it("/turns still records LLM follow-up when embed throws", async () => {
    const mockInterviewClient = {
      createAssistantTurn: vi.fn(async () => ({
        providerId: "bailian-character" as const,
        model: "test-model",
        content: "哪一次授权让你最难受？",
        intent: "百炼角色扮演追问" as const
      }))
    };
    const embed = vi.fn(async () => {
      throw new Error("Bailian embeddings request failed: 401");
    });
    const repo = createInMemoryProductStateRepository();
    const server = Fastify({ logger: false });
    await registerInterviewSessionRoutes(server, repo, {
      bailianInterviewClient: mockInterviewClient,
      embeddingClient: { embed } as never
    });
    const created = (
      await server.inject({ method: "POST", url: "/api/interview-sessions", payload: { mode: "daily" } })
    ).json();
    const id = created.session.id;
    const res = await server.inject({
      method: "POST",
      url: `/api/interview-sessions/${id}/turns`,
      payload: { content: "最近工作压力大，不想展开。" }
    });
    expect(res.statusCode).toBe(200);
    const last = [...res.json().session.turns].reverse().find((t: { role: string }) => t.role === "assistant");
    expect(last?.content).toContain("哪一次授权");
    expect(mockInterviewClient.createAssistantTurn).toHaveBeenCalled();
    await server.close();
  });
});
