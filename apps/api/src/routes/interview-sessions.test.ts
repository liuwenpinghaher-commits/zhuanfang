import { describe, it, expect, vi } from "vitest";
import { buildApiServer } from "../server";
import { registerInterviewSessionRoutes } from "./interview-sessions";
import { createInMemoryProductStateRepository } from "../product-state-repository";
import { createLlmBudget } from "../llm-budget";
import { createInitialProductState } from "../../../../src/domain/engine";
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

  // S3 follow-up: /turns must pull state.memoryCorrections out of the repository
  // and hand them to the interview client, so the cascade/text path's LLM prompt
  // carries them (the LiveKit path already had them; this path didn't).
  it("/turns passes the repository's memoryCorrections to createAssistantTurn", async () => {
    const capturedCorrections: unknown[] = [];
    const mockInterviewClient = {
      createAssistantTurn: vi.fn(async (input: any) => {
        capturedCorrections.push(input.corrections);
        return {
          providerId: "bailian-character" as const,
          model: "test-model",
          content: "好的，我们继续。",
          intent: "百炼角色扮演追问" as const
        };
      })
    };

    const seededState = {
      ...createInitialProductState(),
      memoryCorrections: [
        { id: "corr-1", text: "我现在带的是 12 个人。", createdAt: "2026-06-01T00:00:00.000Z" }
      ]
    };
    const repo = createInMemoryProductStateRepository(seededState);
    const server = Fastify({ logger: false });
    await registerInterviewSessionRoutes(server, repo, {
      bailianInterviewClient: mockInterviewClient,
      llmBudget: createLlmBudget({ maxCallsPerSession: 5 })
    });

    const created = (await server.inject({ method: "POST", url: "/api/interview-sessions", payload: { mode: "daily" } })).json();
    const id = created.session.id;

    const res = await server.inject({ method: "POST", url: `/api/interview-sessions/${id}/turns`, payload: { content: "团队还是不够主动。" } });
    expect(res.statusCode).toBe(200);

    expect(mockInterviewClient.createAssistantTurn).toHaveBeenCalledTimes(1);
    expect(capturedCorrections[0]).toEqual([
      { id: "corr-1", text: "我现在带的是 12 个人。", createdAt: "2026-06-01T00:00:00.000Z" }
    ]);

    await server.close();
  });

  // --- turn-complete (Layer 2) + decisions (audit log) ---

  it("/turn-complete: with chatClient mock returns done:true when LLM says so", async () => {
    const mockChatClient = {
      complete: vi.fn(async (_opts: any) => '{"done":true,"reason":"完整"}')
    };
    const repo = createInMemoryProductStateRepository();
    const server = Fastify({ logger: false });
    await registerInterviewSessionRoutes(server, repo, {
      bailianChatClient: mockChatClient as any
    });

    // Create a session first
    const created = (await server.inject({ method: "POST", url: "/api/interview-sessions", payload: { mode: "daily" } })).json();
    const id = created.session.id;

    const res = await server.inject({
      method: "POST",
      url: `/api/interview-sessions/${id}/turn-complete`,
      payload: { transcript: "我已经说完了这段话" }
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.done).toBe(true);
    expect(typeof body.reason).toBe("string");
    expect(mockChatClient.complete).toHaveBeenCalledTimes(1);

    await server.close();
  });

  it("/turn-complete: without chatClient returns done:true as safe default", async () => {
    const repo = createInMemoryProductStateRepository();
    const server = Fastify({ logger: false });
    await registerInterviewSessionRoutes(server, repo, {}); // no chatClient

    const created = (await server.inject({ method: "POST", url: "/api/interview-sessions", payload: { mode: "daily" } })).json();
    const id = created.session.id;

    const res = await server.inject({
      method: "POST",
      url: `/api/interview-sessions/${id}/turn-complete`,
      payload: { transcript: "说一半" }
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().done).toBe(true);

    await server.close();
  });

  it("/turn-complete: missing transcript returns 422", async () => {
    const repo = createInMemoryProductStateRepository();
    const server = Fastify({ logger: false });
    await registerInterviewSessionRoutes(server, repo, {});

    const created = (await server.inject({ method: "POST", url: "/api/interview-sessions", payload: { mode: "daily" } })).json();
    const id = created.session.id;

    const res = await server.inject({
      method: "POST",
      url: `/api/interview-sessions/${id}/turn-complete`,
      payload: {}
    });
    expect(res.statusCode).toBe(422);

    await server.close();
  });

  it("/decisions: logs a decision trace and returns ok:true", async () => {
    const repo = createInMemoryProductStateRepository();
    const server = Fastify({ logger: false });
    await registerInterviewSessionRoutes(server, repo, {});

    const created = (await server.inject({ method: "POST", url: "/api/interview-sessions", payload: { mode: "daily" } })).json();
    const id = created.session.id;

    const res = await server.inject({
      method: "POST",
      url: `/api/interview-sessions/${id}/decisions`,
      payload: {
        layer: 1,
        action: "respond",
        reason: "silence threshold exceeded",
        silenceMs: 800
      }
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(true);

    await server.close();
  });

  it("/decisions: persists decision to auditEvents in state (P2-22)", async () => {
    const repo = createInMemoryProductStateRepository();
    const server = Fastify({ logger: false });
    await registerInterviewSessionRoutes(server, repo, {});

    const created = (await server.inject({ method: "POST", url: "/api/interview-sessions", payload: { mode: "daily" } })).json();
    const id = created.session.id;

    await server.inject({
      method: "POST",
      url: `/api/interview-sessions/${id}/decisions`,
      payload: {
        layer: 2,
        action: "hold",
        reason: "guest still speaking",
        silenceMs: 200,
        expressionState: "listening",
        transcript: "正在讲话中"
      }
    });

    const state = repo.getState();
    const event = state.auditEvents.find((e) => e.type === "cascade_decision_logged");
    expect(event).toBeDefined();
    expect(event?.entityType).toBe("interview_session");
    expect(event?.entityId).toBe(id);
    expect(event?.severity).toBe("info");
    expect(event?.detail).toContain("hold");
    expect(event?.detail).toContain("guest still speaking");

    await server.close();
  });

  // C1: mid-session corpus-learning staleness. enginePolicy is stamped once at
  // create time. When the operator approves a PlaybookPatch WHILE an interview is
  // running, that session must pick up the new rule on its NEXT turn — not only on
  // the next session. /turns must re-stamp session.enginePolicy from fresh state.
  function applyMidSessionPatch(repo: ReturnType<typeof createInMemoryProductStateRepository>) {
    const state = repo.getState();
    repo.replaceState({
      ...state,
      playbookPatches: [
        {
          id: "patch-midsession",
          title: "先索要具体时刻",
          description: "抽象评价先落到具体事件",
          sourceInsightId: "insight-1",
          status: "applied" as const,
          rules: ["当用户使用抽象评价时，先追问一个具体时刻。"],
          ruleTypes: ["concrete-moment"],
          impact: "medium" as const,
          createdAt: "2026-06-01T00:00:00.000Z",
          appliedAt: "2026-06-19T00:00:00.000Z"
        },
        ...state.playbookPatches
      ]
    });
  }

  it("/turns (no LLM): re-stamps enginePolicy so a mid-session applied patch takes effect THIS turn", async () => {
    const repo = createInMemoryProductStateRepository();
    const server = Fastify({ logger: false });
    await registerInterviewSessionRoutes(server, repo, {}); // deterministic path

    const created = (await server.inject({ method: "POST", url: "/api/interview-sessions", payload: { mode: "decision" } })).json();
    const id = created.session.id;
    // Sanity: the session was created BEFORE any patch existed.
    expect(created.session.enginePolicy.appliedPlaybookRules).toEqual([]);

    // Operator approves a PlaybookPatch mid-session.
    applyMidSessionPatch(repo);

    // First user turn AFTER the patch — an abstract claim that should trigger the
    // concrete-moment strategy IF the freshly-applied rule is now in scope.
    const res = await server.inject({ method: "POST", url: `/api/interview-sessions/${id}/turns`, payload: { content: "团队总是不主动承担。" } });
    expect(res.statusCode).toBe(200);
    const session = res.json().session;

    // The new rule must now be on this session's policy (re-stamped this turn).
    expect(session.enginePolicy.appliedPlaybookRules).toContain("当用户使用抽象评价时，先追问一个具体时刻。");
    // And the ruleType must actually route the deterministic strategy engine.
    const lastAssistant = [...session.turns].reverse().find((t: any) => t.role === "assistant");
    expect(lastAssistant.strategy).toBe("concrete_example_probe");

    await server.close();
  });

  it("/turns (LLM): the assistant client sees the re-stamped enginePolicy with the mid-session rule", async () => {
    const capturedRules: string[][] = [];
    const mockInterviewClient = {
      createAssistantTurn: vi.fn(async (input: any) => {
        capturedRules.push(input.session.enginePolicy?.appliedPlaybookRules ?? []);
        return {
          providerId: "bailian-character" as const,
          model: "test-model",
          content: "你能讲一个最近的具体时刻吗？",
          intent: "百炼角色扮演追问" as const
        };
      })
    };
    const repo = createInMemoryProductStateRepository();
    const server = Fastify({ logger: false });
    await registerInterviewSessionRoutes(server, repo, {
      bailianInterviewClient: mockInterviewClient,
      llmBudget: createLlmBudget({ maxCallsPerSession: 5 })
    });

    const created = (await server.inject({ method: "POST", url: "/api/interview-sessions", payload: { mode: "daily" } })).json();
    const id = created.session.id;

    applyMidSessionPatch(repo);

    const res = await server.inject({ method: "POST", url: `/api/interview-sessions/${id}/turns`, payload: { content: "团队总是不主动承担。" } });
    expect(res.statusCode).toBe(200);

    expect(mockInterviewClient.createAssistantTurn).toHaveBeenCalledTimes(1);
    // The session handed to the LLM client must already carry the mid-session rule,
    // so buildCharacterSystemPrompt injects it into the prompt.
    expect(capturedRules[0]).toContain("当用户使用抽象评价时，先追问一个具体时刻。");

    await server.close();
  });
});
