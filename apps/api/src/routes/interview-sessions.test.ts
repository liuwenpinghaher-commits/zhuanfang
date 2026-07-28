import { describe, it, expect, vi } from "vitest";
import { buildApiServer } from "../server";
import { registerInterviewSessionRoutes } from "./interview-sessions";
import { createInMemoryProductStateRepository } from "../product-state-repository";
import { createLlmBudget } from "../llm-budget";
import { createInitialProductState } from "../../../../src/domain/engine";
import { createFakeChatClient, createFakeInterviewClient } from "../test-helpers/fake-llm-clients";
import Fastify from "fastify";

describe("interview-sessions routes", () => {
  // The character model emits （神态/动作）stage-direction asides to convey manner. Those must
  // NOT appear in the stored question text (the transcript / finalize / memory should read as
  // clean words like a real 张小珺 interview); the manner is preserved as `prosody` on the turn
  // so the voice path can still speak it expressively.
  it("/turns: strips （…）asides from the stored assistant question and keeps the manner as prosody", async () => {
    const mockInterviewClient = {
      createAssistantTurn: vi.fn(async () => ({
        providerId: "bailian-character" as const,
        model: "test-model",
        content: "你怎么看这件事？（身体微倾，表现出好奇）能展开说说吗？",
        intent: "百炼角色扮演追问" as const
      }))
    };
    const repo = createInMemoryProductStateRepository();
    const server = Fastify({ logger: false });
    await registerInterviewSessionRoutes(server, repo, { bailianInterviewClient: mockInterviewClient });
    const created = (await server.inject({ method: "POST", url: "/api/interview-sessions", payload: { mode: "daily" } })).json();
    const id = created.session.id;
    const res = await server.inject({ method: "POST", url: `/api/interview-sessions/${id}/turns`, payload: { content: "我有点纠结。" } });
    const sess = res.json().session;
    const lastAssistant = [...sess.turns].reverse().find((t: { role: string }) => t.role === "assistant") as
      | { role: string; content: string; prosody?: { emotion?: string; rate: number; pitch: number; volume: number } }
      | undefined;
    expect(lastAssistant).toBeDefined();
    // stored question is clean — no parenthetical stage directions
    expect(lastAssistant!.content).not.toContain("（");
    expect(lastAssistant!.content).toContain("你怎么看这件事？");
    expect(lastAssistant!.content).toContain("能展开说说吗？");
    // manner preserved as prosody (好奇 → faster + higher pitch)
    expect(lastAssistant!.prosody).toBeDefined();
    expect(lastAssistant!.prosody!.pitch).toBeGreaterThan(1);
    // 情绪也随 manner 派生成官方枚举(好奇 → surprised),至少必是合法 CosyVoice 情绪值
    expect(["neutral", "happy", "sad", "angry", "surprised", "fearful", "disgusted"]).toContain(
      lastAssistant!.prosody!.emotion
    );
    await server.close();
  });

  // REQ-INTERVIEW-TURN-NEXT-QUESTION (REQ-B): the generated host turn must observably
  // RESPOND to the user's latest utterance — not just return any 200. 真实性重构后追问
  // 只有 LLM 一条路（确定性策略引擎兜底已删除），改用注入的假 interview client（回显
  // 用户原文前 12 字）证明：路由把【本轮】用户原文交给了 LLM，且 LLM 的追问被落为
  // assistant turn——固定的、与输入无关的问题无法通过该断言。
  it("/turns: next question references the user's latest input (fake LLM echoes the utterance)", async () => {
    const server = buildApiServer({ env: {}, bailianInterviewClient: createFakeInterviewClient() });
    const created = (await server.inject({ method: "POST", url: "/api/interview-sessions", payload: { mode: "daily" } })).json();
    const id = created.session.id;
    const content = "公司里那条审批链路每次都卡在中间这件事让我特别烦躁";

    const res = await server.inject({ method: "POST", url: `/api/interview-sessions/${id}/turns`, payload: { content } });
    expect(res.statusCode).toBe(200);
    const session = res.json().session;
    const lastAssistant = [...session.turns].reverse().find((t: { role: string }) => t.role === "assistant") as
      | { role: string; content: string }
      | undefined;
    expect(lastAssistant).toBeDefined();
    expect(lastAssistant!.content.length).toBeGreaterThan(0);
    // the host turn quotes the echo of THIS user's input → demonstrably responsive
    expect(lastAssistant!.content).toContain(content.slice(0, 12));
    await server.close();
  });

  it("/turns: empty content is rejected 422 and appends no turn", async () => {
    const server = buildApiServer({ env: {} });
    const created = (await server.inject({ method: "POST", url: "/api/interview-sessions", payload: { mode: "daily" } })).json();
    const id = created.session.id;
    const before = created.session.turns.length;
    const res = await server.inject({ method: "POST", url: `/api/interview-sessions/${id}/turns`, payload: { content: "   " } });
    expect(res.statusCode).toBe(422);
    const after = (await server.inject({ method: "GET", url: `/api/interview-sessions/${id}` })).json().session;
    expect(after.turns.length).toBe(before);
    await server.close();
  });

  it("/turns: unknown session id returns 404", async () => {
    const server = buildApiServer({ env: {} });
    const res = await server.inject({ method: "POST", url: "/api/interview-sessions/does-not-exist/turns", payload: { content: "hi" } });
    expect(res.statusCode).toBe(404);
    await server.close();
  });

  // M6: once a session is completed + raw-material-offloaded (turns moved to cold storage,
  // hot layer cleared), appending another turn would re-grow the hot layer and split it from
  // the cold copy. /turns and /record-turn must guard against that with 409 — but an
  // in-progress session must still accept turns (no regression).
  it("/turns: appending to a completed + offloaded session is rejected 409 (no cold/hot split)", async () => {
    // 真实性重构后 /turns 与 /end 都必须有 LLM client 才能成功——注入假 client 走通成功路径。
    const server = buildApiServer({
      env: {},
      bailianInterviewClient: createFakeInterviewClient(),
      bailianChatClient: createFakeChatClient()
    });
    const created = (await server.inject({ method: "POST", url: "/api/interview-sessions", payload: { mode: "decision" } })).json();
    const id = created.session.id as string;
    await server.inject({ method: "POST", url: `/api/interview-sessions/${id}/turns`, payload: { content: "我现在带的是 12 个人，最难的是放权。" } });
    // /end completes the session and offloads the transcript to cold storage.
    const end = await server.inject({ method: "POST", url: `/api/interview-sessions/${id}/end` });
    expect(end.statusCode).toBe(200);
    expect(end.json().session.rawMaterialOffloaded).toBe(true);

    const res = await server.inject({ method: "POST", url: `/api/interview-sessions/${id}/turns`, payload: { content: "再补一句。" } });
    expect(res.statusCode).toBe(409);
    await server.close();
  });

  it("/control: 向 completed 会话追加控制轮被拒 409(审计修复 P2-19,与 /turns 对称)", async () => {
    const server = buildApiServer({
      env: {},
      bailianInterviewClient: createFakeInterviewClient(),
      bailianChatClient: createFakeChatClient()
    });
    const created = (await server.inject({ method: "POST", url: "/api/interview-sessions", payload: { mode: "decision" } })).json();
    const id = created.session.id as string;
    await server.inject({ method: "POST", url: `/api/interview-sessions/${id}/turns`, payload: { content: "我现在带的是 12 个人，最难的是放权。" } });
    const end = await server.inject({ method: "POST", url: `/api/interview-sessions/${id}/end` });
    expect(end.statusCode).toBe(200);
    const res = await server.inject({ method: "POST", url: `/api/interview-sessions/${id}/control`, payload: { action: "sharper" } });
    expect(res.statusCode).toBe(409);
    await server.close();
  });

  it("/record-turn: appending to a completed + offloaded session is rejected 409", async () => {
    const server = buildApiServer({
      env: {},
      bailianInterviewClient: createFakeInterviewClient(),
      bailianChatClient: createFakeChatClient()
    });
    const created = (await server.inject({ method: "POST", url: "/api/interview-sessions", payload: { mode: "decision" } })).json();
    const id = created.session.id as string;
    await server.inject({ method: "POST", url: `/api/interview-sessions/${id}/turns`, payload: { content: "我现在带的是 12 个人，最难的是放权。" } });
    const end = await server.inject({ method: "POST", url: `/api/interview-sessions/${id}/end` });
    expect(end.statusCode).toBe(200);

    const res = await server.inject({
      method: "POST",
      url: `/api/interview-sessions/${id}/record-turn`,
      payload: { role: "user", content: "语音再补一句。" }
    });
    expect(res.statusCode).toBe(409);
    await server.close();
  });

  it("/turns: an in-progress (not completed/offloaded) session still accepts turns 200 (no regression)", async () => {
    const server = buildApiServer({ env: {}, bailianInterviewClient: createFakeInterviewClient() });
    const created = (await server.inject({ method: "POST", url: "/api/interview-sessions", payload: { mode: "decision" } })).json();
    const id = created.session.id as string;
    const res = await server.inject({ method: "POST", url: `/api/interview-sessions/${id}/turns`, payload: { content: "继续聊。" } });
    expect(res.statusCode).toBe(200);
    await server.close();
  });

  // /turns is a read-modify-write on the global state with an await window (embedding /
  // LLM). Two concurrent turns on the SAME session must NOT clobber each other: without
  // per-session serialization both read the same base snapshot and the second replaceState
  // overwrites the first → a silently dropped user turn. We force the interleave with an
  // embedding client that awaits, then assert BOTH user turns survived.
  it("/turns: two concurrent same-session turns both persist (no lost-update)", async () => {
    const slowEmbeddingClient = {
      embed: vi.fn(async (_texts: string[]) => {
        await new Promise((r) => setTimeout(r, 25)); // hold the await window open for interleave
        return [[0.1, 0.2, 0.3]];
      })
    };
    const repo = createInMemoryProductStateRepository();
    const server = Fastify({ logger: false });
    await registerInterviewSessionRoutes(server, repo, {
      embeddingClient: slowEmbeddingClient as never,
      bailianInterviewClient: createFakeInterviewClient() // /turns 成功路径现在必须有 LLM client
    });

    const created = (await server.inject({ method: "POST", url: "/api/interview-sessions", payload: { mode: "daily" } })).json();
    const id = created.session.id;
    const userTurnsBefore = created.session.turns.filter((t: { role: string }) => t.role === "user").length;

    // fire both turns WITHOUT awaiting the first → they race through the embed await window
    const [a, b] = await Promise.all([
      server.inject({ method: "POST", url: `/api/interview-sessions/${id}/turns`, payload: { content: "并发回合甲：审批链路卡在中间" } }),
      server.inject({ method: "POST", url: `/api/interview-sessions/${id}/turns`, payload: { content: "并发回合乙：交付节奏总是延期" } })
    ]);
    expect(a.statusCode).toBe(200);
    expect(b.statusCode).toBe(200);

    const after = (await server.inject({ method: "GET", url: `/api/interview-sessions/${id}` })).json().session;
    const userContents = after.turns.filter((t: { role: string }) => t.role === "user").map((t: { content: string }) => t.content);
    // both turns recorded — neither overwrote the other
    expect(userContents.length).toBe(userTurnsBefore + 2);
    expect(userContents).toContain("并发回合甲：审批链路卡在中间");
    expect(userContents).toContain("并发回合乙：交付节奏总是延期");
    await server.close();
  });
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

  it("/turns: 2nd turn blocked by budget → 429 预算已用尽，LLM 不再被调用，本轮不落任何轮次", async () => {
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
    const turnsAfterFirst = (res1.json().session.turns as Array<{ role: string }>).length;

    // Second turn — budget exhausted → 429 如实暴露（确定性追问兜底已删除），LLM must NOT be called
    const res2 = await server.inject({ method: "POST", url: `/api/interview-sessions/${id}/turns`, payload: { content: "第二轮输入" } });
    expect(res2.statusCode).toBe(429);
    expect((res2.json() as { error: string }).error).toContain("预算已用尽");
    expect(llmCallCount.value).toBe(1); // still 1 — LLM was skipped

    // 原子失败：被拒的这一轮不得落任何轮次（用户轮也不落，用户可原样重试）
    const after = (await server.inject({ method: "GET", url: `/api/interview-sessions/${id}` })).json().session;
    expect(after.turns.length).toBe(turnsAfterFirst);
    expect(after.turns.filter((t: any) => t.role === "user").map((t: any) => t.content)).not.toContain("第二轮输入");

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

  it("/turn-complete: without chatClient → 503 如实暴露（不再伪造 done:true 安全默认）", async () => {
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
    expect(res.statusCode).toBe(503);
    expect((res.json() as { error: string }).error).toContain("未配置");

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

  // 真实性重构后 /turns 无纯确定性路径（无 client 即 503），但策略引擎仍在真实 LLM 路径上
  // 决策本轮动作并回填到 assistant turn（receiveTurn → decideInterviewStrategy）。用假 client
  // 走通 LLM 路径，断言 re-stamp 的规则既出现在响应的 enginePolicy 上，也真实路由了策略引擎。
  it("/turns: re-stamps enginePolicy so a mid-session applied patch takes effect THIS turn (strategy backfilled)", async () => {
    const repo = createInMemoryProductStateRepository();
    const server = Fastify({ logger: false });
    await registerInterviewSessionRoutes(server, repo, { bailianInterviewClient: createFakeInterviewClient() });

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
    // And the ruleType must actually route the strategy engine (decision backfilled onto the turn).
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

  // --- /end: LLM memory extraction (M1b) wires real candidates into finalize ---

  // The /end finalize path makes TWO kinds of chat calls: (1) the diary
  // synthesis (finalizeSessionWithLlm) and (2) the long-term memory extraction
  // (extractCandidateMemories). This fake routes each by the system prompt so we
  // can assert the extracted candidates actually land in state.memoryCandidates.
  function makeDualPurposeChatClient(extractedCandidates: Array<{ text: string; evidenceQuote: string; sensitivity?: "normal" | "sensitive" }>) {
    const finalizeJson = JSON.stringify({
      summary: "这次对话推进了团队管理的判断",
      keyQuote: "我现在带的是 12 个人，最难的是放权",
      saidTrack: ["谈了带团队的现状", "点出放权是最大难题"],
      learnedTrack: ["放权不是一次性动作", "需要建立信任机制"],
      nextQuestions: ["下次如何具体推进放权？"],
      points: [],
      questions: [],
      decisions: [],
      debts: [],
      themes: []
    });
    const extractJson = JSON.stringify({
      candidates: extractedCandidates.map((c) => ({
        text: c.text,
        evidenceQuote: c.evidenceQuote,
        sensitivity: c.sensitivity ?? "normal"
      }))
    });
    const complete = vi.fn(async (opts: any) => {
      const system = (opts?.messages ?? [])
        .filter((m: any) => m?.role === "system")
        .map((m: any) => String(m?.content ?? ""))
        .join("\n");
      // extractCandidateMemories' system prompt talks about 候选记忆 from 导入的资料.
      if (system.includes("候选记忆")) {
        return extractJson;
      }
      return finalizeJson;
    });
    return { complete };
  }

  async function seedEndableSession(server: ReturnType<typeof Fastify>) {
    const created = (await server.inject({ method: "POST", url: "/api/interview-sessions", payload: { mode: "decision" } })).json();
    const id = created.session.id as string;
    // Two real user turns so the transcript carries content to extract from.
    await server.inject({ method: "POST", url: `/api/interview-sessions/${id}/record-turn`, payload: { role: "user", content: "我现在带的是 12 个人，最难的是放权。" } });
    await server.inject({ method: "POST", url: `/api/interview-sessions/${id}/record-turn`, payload: { role: "assistant", content: "放权具体卡在哪一步？" } });
    await server.inject({ method: "POST", url: `/api/interview-sessions/${id}/record-turn`, payload: { role: "user", content: "我总想自己复核，结果反而成了瓶颈。" } });
    return id;
  }

  it("/end (with chatClient): LLM-extracted memories become state.memoryCandidates", async () => {
    const chatClient = makeDualPurposeChatClient([
      { text: "用户目前带领一支 12 人的团队。", evidenceQuote: "我现在带的是 12 个人", sensitivity: "normal" },
      { text: "用户认为放权是当前最大的管理难题。", evidenceQuote: "最难的是放权", sensitivity: "normal" }
    ]);
    const repo = createInMemoryProductStateRepository();
    const server = Fastify({ logger: false });
    await registerInterviewSessionRoutes(server, repo, {
      bailianChatClient: chatClient as any,
      llmBudget: createLlmBudget({ maxCallsPerSession: 5 })
    });

    const id = await seedEndableSession(server);
    const res = await server.inject({ method: "POST", url: `/api/interview-sessions/${id}/end` });
    expect(res.statusCode).toBe(200);

    const candidates = repo.getState().memoryCandidates;
    // At least the 2 LLM-extracted ones (vs. the single heuristic template candidate).
    expect(candidates.length).toBeGreaterThanOrEqual(2);
    const texts = candidates.map((c) => c.text);
    expect(texts).toContain("用户目前带领一支 12 人的团队。");
    expect(texts).toContain("用户认为放权是当前最大的管理难题。");
    // The extracted candidates must be wired to the session as their source.
    const wired = candidates.filter((c) => c.sourceType === "interview_session" && c.sourceId === id && c.status === "pending");
    expect(wired.length).toBeGreaterThanOrEqual(2);
    // Review scoring must run (reviewScore set, signals non-empty).
    expect(wired.every((c) => Number.isFinite(c.reviewScore) && c.reviewSignals.length > 0)).toBe(true);

    await server.close();
  });

  // IV-P1-04: doNotSave short-circuits — no finalize LLM, no long-term assets.
  it("/end doNotSave: 不调归档 LLM，不写笔记/记忆，审计诚实", async () => {
    const complete = vi.fn(async () => JSON.stringify({ title: "should-not-run" }));
    const repo = createInMemoryProductStateRepository();
    const server = Fastify({ logger: false });
    await registerInterviewSessionRoutes(server, repo, {
      bailianChatClient: { complete } as any,
      bailianInterviewClient: { complete: async () => "追问？" } as any
    });

    const create = await server.inject({
      method: "POST",
      url: "/api/interview-sessions",
      payload: { mode: "daily" }
    });
    const id = (create.json() as { session: { id: string } }).session.id;
    // mark doNotSave via control or direct state
    const state = repo.getState();
    const session = state.sessions.find((s) => s.id === id)!;
    repo.replaceState({
      ...state,
      sessions: state.sessions.map((s) =>
        s.id === id
          ? {
              ...s,
              doNotSave: true,
              turns: [
                {
                  id: "u1",
                  sessionId: id,
                  role: "user",
                  content: "隐私对话内容不应进长期资产",
                  intent: "user_reply",
                  timestamp: "2026-07-23T00:00:00.000Z"
                },
                {
                  id: "a1",
                  sessionId: id,
                  role: "assistant",
                  content: "好的",
                  intent: "follow_up",
                  timestamp: "2026-07-23T00:00:01.000Z"
                }
              ] as typeof session.turns
            }
          : s
      )
    });

    const notesBefore = repo.getState().notes.length;
    const res = await server.inject({ method: "POST", url: `/api/interview-sessions/${id}/end` });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      longTermAssetsPersisted?: boolean;
      note: { title: string };
      state: { notes: unknown[]; sessions: { id: string }[]; auditEvents?: { label: string }[] };
    };
    expect(body.longTermAssetsPersisted).toBe(false);
    expect(body.note.title).toContain("未保存");
    expect(complete).not.toHaveBeenCalled();
    expect(body.state.notes.length).toBe(notesBefore);
    expect(body.state.sessions.some((s) => s.id === id)).toBe(false);
    const audit =
      (body.state as { auditEvents?: { label?: string; detail?: string }[] }).auditEvents ??
      (body.state as { recentAuditEvents?: { label?: string; detail?: string }[] }).recentAuditEvents ??
      [];
    expect(
      audit.some(
        (e) =>
          (e.label ?? "").includes("未写入长期资产") ||
          (e.detail ?? "").includes("不保存") ||
          (e.detail ?? "").includes("未调用归档")
      )
    ).toBe(true);

    await server.close();
  });

  // 真实性重构：确定性 finalizeSession/启发式模板候选已删除——无 chatClient 时 /end 如实 503，
  // 会话保持 active 可重试，state 不落任何 finalize 产物。
  it("/end (no chatClient): 503 如实暴露，会话保持 active，不产任何笔记/候选", async () => {
    const repo = createInMemoryProductStateRepository();
    const server = Fastify({ logger: false });
    await registerInterviewSessionRoutes(server, repo, {}); // no LLM

    const id = await seedEndableSession(server);
    const notesBefore = repo.getState().notes.length;
    const res = await server.inject({ method: "POST", url: `/api/interview-sessions/${id}/end` });
    expect(res.statusCode).toBe(503);
    expect((res.json() as { error: string }).error).toContain("未配置");

    // 会话保持可重试：未 completed、未归档；不产模板笔记/启发式候选冒充归档产物。
    const state = repo.getState();
    const session = state.sessions.find((s) => s.id === id)!;
    expect(session.status).not.toBe("completed");
    expect(session.rawMaterialOffloaded).not.toBe(true);
    expect(state.notes.length).toBe(notesBefore);
    expect(state.memoryCandidates.some((c) => c.sourceType === "interview_session" && c.sourceId === id)).toBe(false);

    await server.close();
  });

  // --- /end: 轻量推理(欠账②)矛盾检测端到端接线 ---
  it("/end (with chatClient): 同主题对立观点经 LLM 精判 → contradicts 软链双向落库 + 较弱方置「被挑战中」", async () => {
    // 三路 chat 调用按 system prompt 分发:finalize / 候选记忆抽取 / 认知关系精判。
    const complete = vi.fn(async (opts: any) => {
      const system = (opts?.messages ?? []).filter((m: any) => m?.role === "system").map((m: any) => String(m?.content ?? "")).join("\n");
      if (system.includes("认知关系审校员")) {
        // 把预置的两条同主题观点判为对立。
        return JSON.stringify({ relations: [{ a: "pt_x", b: "pt_y", verdict: "contradict" }] });
      }
      if (system.includes("候选记忆")) return JSON.stringify({ candidates: [] });
      // finalize:不产新资产(只产笔记),让候选对仅由预置的两条观点构成。
      return JSON.stringify({
        summary: "推进了团队管理判断", keyQuote: "最难的是放权",
        saidTrack: ["谈了带团队"], learnedTrack: ["放权要建机制"], nextQuestions: [],
        points: [], questions: [], decisions: [], debts: [], themes: []
      });
    });

    const seededState = {
      ...createInitialProductState(),
      themes: [{ id: "th_1", name: "放权与拍板", summary: "", maturity: "聚焦" as const, representativeQuote: "", appearances: 3, nextQuestion: "", updatedAt: "2026-06-01T00:00:00.000Z" }],
      points: [
        { id: "pt_x", title: "应当集中拍板", content: "凡事自己复核", status: "临时想法" as const, confidence: "AI 推断" as const, evidence: ["x"], relatedThemeIds: ["th_1"], important: false, updatedAt: "2026-06-01T00:00:00.000Z", evidenceAnchors: [{ sessionId: "se_old", turnId: "tu_old" }] },
        { id: "pt_y", title: "应当充分放权", content: "把执行交出去", status: "稳定观点" as const, confidence: "用户确认" as const, evidence: ["y"], relatedThemeIds: ["th_1"], important: false, updatedAt: "2026-06-20T00:00:00.000Z", evidenceAnchors: [{ sessionId: "se_old", turnId: "tu_old2" }] }
      ]
    };
    const repo = createInMemoryProductStateRepository(seededState);
    const server = Fastify({ logger: false });
    await registerInterviewSessionRoutes(server, repo, {
      bailianChatClient: { complete } as any,
      llmBudget: createLlmBudget({ maxCallsPerSession: 10 })
    });

    const id = await seedEndableSession(server);
    const res = await server.inject({ method: "POST", url: `/api/interview-sessions/${id}/end` });
    expect(res.statusCode).toBe(200);

    const points = repo.getState().points;
    const px = points.find((p) => p.id === "pt_x")!;
    const py = points.find((p) => p.id === "pt_y")!;
    // 双向软链。
    expect(px.contradictsPointIds).toContain("pt_y");
    expect(py.contradictsPointIds).toContain("pt_x");
    // 较弱方(AI 推断 < 用户确认)被挑战;较强方维持原状态。
    expect(px.status).toBe("被挑战中");
    expect(py.status).toBe("稳定观点");
    // 精判确实被调用过。
    expect(complete.mock.calls.some((c: any) => String(c[0]?.messages?.[0]?.content ?? "").includes("认知关系审校员"))).toBe(true);

    await server.close();
  });

  // C1: the /end RESPONSE must return the SAME light state that was persisted
  // (turns stripped + rawMaterialOffloaded), not the heavy finalized state. The
  // client adopts the response and an autosave effect would PUT it straight back;
  // if it carried full turns the cold-storage offload (28MB wall fix) would be
  // undone on the very next save. The heavy transcript stays only in cold storage,
  // served lazily via GET /api/sessions/:id/raw-material.
  it("/end: response state is the light (offloaded) state, heavy turns live only in cold storage", async () => {
    // in-memory product + raw-material repos；/turns 与 /end 的成功路径注入假 LLM client
    const server = buildApiServer({
      env: {},
      bailianInterviewClient: createFakeInterviewClient(),
      bailianChatClient: createFakeChatClient()
    });
    const created = (await server.inject({ method: "POST", url: "/api/interview-sessions", payload: { mode: "decision" } })).json();
    const id = created.session.id as string;
    await server.inject({ method: "POST", url: `/api/interview-sessions/${id}/turns`, payload: { content: "我现在带的是 12 个人，最难的是放权。" } });
    await server.inject({ method: "POST", url: `/api/interview-sessions/${id}/turns`, payload: { content: "我总想自己复核，结果反而成了瓶颈。" } });

    const res = await server.inject({ method: "POST", url: `/api/interview-sessions/${id}/end` });
    expect(res.statusCode).toBe(200);
    const body = res.json();

    // The completed session in the RESPONSE must be light: turns stripped, flagged offloaded.
    const completed = (body.state.sessions as Array<{ id: string; turns?: unknown[]; rawMaterialOffloaded?: boolean }>).find(
      (s) => s.id === id
    );
    expect(completed).toBeTruthy();
    expect(completed!.turns?.length ?? 0).toBe(0);
    expect(completed!.rawMaterialOffloaded).toBe(true);
    // The top-level `session` field is the same light, offloaded record.
    expect((body.session.turns?.length ?? 0)).toBe(0);
    expect(body.session.rawMaterialOffloaded).toBe(true);

    // The heavy transcript is preserved in cold storage and served lazily.
    const raw = await server.inject({ method: "GET", url: `/api/sessions/${id}/raw-material` });
    expect(raw.statusCode).toBe(200);
    const material = raw.json();
    expect(material.turns.length).toBeGreaterThan(0);
    expect(material.turns.some((t: { role: string }) => t.role === "user")).toBe(true);

    await server.close();
  });

  // --- M3c: semantic recall is REALLY wired into the interview line ---
  //
  // This is the anti-fake-wiring test. Two confirmed memories are crafted so the
  // KEYWORD path cannot separate them: both contain the exact topicHint string the
  // same number of times, identical createdAt (so recency ties) and identical
  // importance. The ONLY signal that differs is the embedding. We inject a fake
  // embeddingClient that returns a query vector pointing AT the "near" memory's
  // embedding and ORTHOGONAL to the "far" one. If cosine truly flows
  // route → createSessionDraft → buildInterviewGuide → collectRelevantMemories →
  // scoreMemoryForRetrieval, the near memory must rank first. Under the old
  // substring-only behaviour the two would be order-indistinguishable.
  function seedTwoCosineSeparableMemories() {
    const NEAR_TEXT = "放权 场景 A：用户在复盘里反复纠结要不要继续替团队兜底。";
    const FAR_TEXT = "放权 场景 B：用户在复盘里反复纠结要不要继续替团队兜底。";
    const base = createInitialProductState();
    const common = {
      status: "confirmed" as const,
      sourceType: "interview_session" as const,
      sourceId: "seed",
      sensitivity: "normal" as const,
      importance: 5,
      createdAt: "2026-06-15T00:00:00.000Z",
      updatedAt: "2026-06-15T00:00:00.000Z"
    };
    return {
      ...base,
      // wipe the demo memories so only our two crafted records are in scope
      memoryRecords: [
        { id: "rec-near", text: NEAR_TEXT, evidenceQuote: NEAR_TEXT, embedding: [1, 0, 0], ...common },
        { id: "rec-far", text: FAR_TEXT, evidenceQuote: FAR_TEXT, embedding: [0, 1, 0], ...common }
      ],
      profile: { ...base.profile },
      NEAR_TEXT,
      FAR_TEXT
    };
  }

  it("create session (with embeddingClient): cosine picks the near memory ahead of the far one", async () => {
    const seeded = seedTwoCosineSeparableMemories();
    // query vector === rec-near's embedding direction; orthogonal to rec-far.
    const queryVector = [1, 0, 0];
    const embed = vi.fn(async (texts: string[]) => texts.map(() => queryVector));
    const repo = createInMemoryProductStateRepository(seeded as any);
    const server = Fastify({ logger: false });
    await registerInterviewSessionRoutes(server, repo, { embeddingClient: { embed } });

    const created = (await server.inject({
      method: "POST",
      url: "/api/interview-sessions",
      payload: { mode: "daily", topicHint: "放权 场景" }
    })).json();

    // The embedding client must have actually been called (query embedded).
    expect(embed).toHaveBeenCalled();

    const relevant: string[] = created.session.guide.relevantMemories;
    const nearIdx = relevant.indexOf(seeded.NEAR_TEXT);
    const farIdx = relevant.indexOf(seeded.FAR_TEXT);
    // Cosine decides: near (parallel to query) must rank. Far is orthogonal (cosine=0)
    // and is dropped by the relevance floor (parity with chat score>0 — no zero padding).
    expect(nearIdx).toBeGreaterThanOrEqual(0);
    expect(farIdx).toBe(-1);

    await server.close();
  });

  it("create session (no embeddingClient): degrades to keyword recall, still returns both memories", async () => {
    const seeded = seedTwoCosineSeparableMemories();
    const repo = createInMemoryProductStateRepository(seeded as any);
    const server = Fastify({ logger: false });
    await registerInterviewSessionRoutes(server, repo, {}); // no embeddingClient

    const created = (await server.inject({
      method: "POST",
      url: "/api/interview-sessions",
      payload: { mode: "daily", topicHint: "放权 场景" }
    })).json();

    const relevant: string[] = created.session.guide.relevantMemories;
    // No crash; both crafted memories are still recalled via the substring path.
    expect(relevant).toContain(seeded.NEAR_TEXT);
    expect(relevant).toContain(seeded.FAR_TEXT);

    await server.close();
  });

  // --- 🔴-1: omni (bailian) voice path can refresh its memory recall per turn ---
  //
  // POST /api/interview-sessions/:id/voice-instructions recomputes the realtime
  // voice instruction string against the FRESHEST user utterance. With a fake
  // embeddingClient whose query vector points AT the "near" memory, the rebuilt
  // recall must surface that memory inside the returned instructions — proving the
  // omni path's recall now tracks the conversation (not just an opening snapshot).
  it("voice-instructions: recall follows the latest user text (embedded → near memory appears in instructions)", async () => {
    const seeded = seedTwoCosineSeparableMemories();
    // First create with a query orthogonal to BOTH memories so the opening guide is
    // recall-neutral; then the per-turn refresh below points the query at the near one.
    const queryVector = [1, 0, 0]; // === rec-near direction
    const embed = vi.fn(async (texts: string[]) => texts.map(() => queryVector));
    const repo = createInMemoryProductStateRepository(seeded as any);
    const server = Fastify({ logger: false });
    await registerInterviewSessionRoutes(server, repo, { embeddingClient: { embed } });

    const created = (await server.inject({
      method: "POST",
      url: "/api/interview-sessions",
      payload: { mode: "daily", topicHint: "放权 场景" }
    })).json();
    const id = created.session.id;

    embed.mockClear();
    const res = await server.inject({
      method: "POST",
      url: `/api/interview-sessions/${id}/voice-instructions`,
      payload: { latestUserText: "我现在最纠结的就是要不要继续替团队兜底" }
    });

    expect(res.statusCode).toBe(200);
    // The latest user text must actually be embedded (recall recomputed for this turn).
    expect(embed).toHaveBeenCalled();
    const { instructions } = res.json() as { instructions: string };
    expect(typeof instructions).toBe("string");
    // Cosine recall surfaced the near memory into the realtime instruction string.
    expect(instructions).toContain(seeded.NEAR_TEXT);

    await server.close();
  });

  it("voice-instructions: no embeddingClient → 200, does not crash, returns instructions from the existing guide", async () => {
    const seeded = seedTwoCosineSeparableMemories();
    const repo = createInMemoryProductStateRepository(seeded as any);
    const server = Fastify({ logger: false });
    await registerInterviewSessionRoutes(server, repo, {}); // no embeddingClient

    const created = (await server.inject({
      method: "POST",
      url: "/api/interview-sessions",
      payload: { mode: "daily", topicHint: "放权 场景" }
    })).json();
    const id = created.session.id;

    const res = await server.inject({
      method: "POST",
      url: `/api/interview-sessions/${id}/voice-instructions`,
      payload: { latestUserText: "随便说点什么" }
    });

    expect(res.statusCode).toBe(200);
    const { instructions } = res.json() as { instructions: string };
    expect(typeof instructions).toBe("string");
    expect(instructions.length).toBeGreaterThan(0);

    await server.close();
  });

  it("voice-instructions: 404 when the interview session does not exist", async () => {
    const repo = createInMemoryProductStateRepository(createInitialProductState());
    const server = Fastify({ logger: false });
    await registerInterviewSessionRoutes(server, repo, {});
    const res = await server.inject({
      method: "POST",
      url: "/api/interview-sessions/does-not-exist/voice-instructions",
      payload: { latestUserText: "x" }
    });
    expect(res.statusCode).toBe(404);
    await server.close();
  });

  // IV-P0-01: shipped mutators — record-turn during voice-instructions embed must not be clobbered.
  it("IV-P0-01: record-turn interleaved with voice-instructions keeps the new turn (writeGate)", async () => {
    let releaseEmbed!: (v: number[][]) => void;
    const hangEmbed = new Promise<number[][]>((resolve) => {
      releaseEmbed = resolve;
    });
    let hangOnNextEmbed = false;
    let hangingEmbedCalls = 0;
    const embeddingClient = {
      embed: async () => {
        if (hangOnNextEmbed) {
          hangingEmbedCalls += 1;
          return hangEmbed;
        }
        return [[0, 0, 1]];
      }
    };
    // Simple mutex matching production writeGate contract
    let chain: Promise<unknown> = Promise.resolve();
    const writeGate = {
      async runExclusive<T>(_label: string, fn: () => Promise<T> | T): Promise<T> {
        const run = chain.then(() => fn());
        chain = run.then(
          () => undefined,
          () => undefined
        );
        return run;
      }
    };

    const repo = createInMemoryProductStateRepository(createInitialProductState());
    const server = Fastify({ logger: false });
    await registerInterviewSessionRoutes(server, repo, {
      embeddingClient: embeddingClient as any,
      writeGate
    });

    const created = (
      await server.inject({ method: "POST", url: "/api/interview-sessions", payload: { mode: "daily" } })
    ).json() as { session: { id: string; turns: unknown[] } };
    const id = created.session.id;

    // Seed one user turn before the race
    await server.inject({
      method: "POST",
      url: `/api/interview-sessions/${id}/record-turn`,
      payload: { role: "user", content: "开场已记录轮" }
    });

    // Only the voice-instructions refresh should hang on embed (create already finished).
    hangOnNextEmbed = true;
    // Start voice-instructions (holds on embed — outside write gate)
    const voiceRefreshPromise = server.inject({
      method: "POST",
      url: `/api/interview-sessions/${id}/voice-instructions`,
      payload: { latestUserText: "中场刷新召回" }
    });
    // Wait until hanging embed was called (refresh mid-flight)
    for (let i = 0; i < 50 && hangingEmbedCalls === 0; i++) {
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(hangingEmbedCalls).toBeGreaterThan(0);

    // Concurrent record-turn while refresh still embedding
    const raceContent = "竞态中新记录的用户轮-不可丢";
    const rt = await server.inject({
      method: "POST",
      url: `/api/interview-sessions/${id}/record-turn`,
      payload: { role: "user", content: raceContent }
    });
    expect(rt.statusCode).toBe(200);

    // Release embed → refresh re-enters writeGate, re-reads, merges guide without clobbering turns
    releaseEmbed([[1, 0, 0]]);
    const voiceRefreshRes = await voiceRefreshPromise;
    expect(voiceRefreshRes.statusCode).toBe(200);

    const final = repo.getState().sessions.find((s) => s.id === id)!;
    expect(final.turns.some((t) => t.content === "开场已记录轮")).toBe(true);
    expect(final.turns.some((t) => t.content === raceContent)).toBe(true);
    // guide/card refresh still applied
    expect(voiceRefreshRes.json().guidePersisted).toBe(true);
    expect(
      voiceRefreshRes.json().session.turns.some((t: { content: string }) => t.content === raceContent)
    ).toBe(true);

    await server.close();
  });

  // IV-P1-01 / criterion 5: client abort → 499, no ghost turn persisted
  it("/turns: client abort after LLM → 499 and no turn persisted", async () => {
    let capturedRaw: { aborted?: boolean; destroyed?: boolean } | null = null;
    const createAssistantTurn = async () => {
      if (capturedRaw) {
        capturedRaw.aborted = true;
        capturedRaw.destroyed = true;
      }
      return {
        providerId: "bailian-character" as const,
        model: "test",
        content: "幽灵追问不应落库",
        intent: "百炼角色扮演追问" as const
      };
    };
    const repo = createInMemoryProductStateRepository(createInitialProductState());
    const server = Fastify({ logger: false });
    // Capture inject request.raw so the LLM mock can mark client abort mid-handler.
    server.addHook("onRequest", async (request) => {
      capturedRaw = request.raw as { aborted?: boolean; destroyed?: boolean };
    });
    await registerInterviewSessionRoutes(server, repo, {
      bailianInterviewClient: { createAssistantTurn } as any
    });

    const created = (
      await server.inject({ method: "POST", url: "/api/interview-sessions", payload: { mode: "daily" } })
    ).json() as { session: { id: string; turns: unknown[] } };
    const id = created.session.id;
    const turnsBefore = repo.getState().sessions.find((s) => s.id === id)!.turns.length;

    const res = await server.inject({
      method: "POST",
      url: `/api/interview-sessions/${id}/turns`,
      payload: { content: "用户本轮输入" }
    });

    expect(res.statusCode).toBe(499);
    expect((res.json() as { error: string }).error).toMatch(/取消|未写入/);
    const turnsAfter = repo.getState().sessions.find((s) => s.id === id)!.turns.length;
    expect(turnsAfter).toBe(turnsBefore);
    expect(
      repo.getState().sessions.find((s) => s.id === id)!.turns.some((t) => t.content.includes("幽灵追问"))
    ).toBe(false);

    await server.close();
  });
});
