/**
 * Deterministic API-level end-to-end business-journey tests.
 *
 * These tests drive the real Fastify server (buildApiServer) via server.inject
 * through COMPLETE multi-route user journeys against ONE server's persisted
 * in-memory state, asserting cross-route consistency.
 *
 * Constraints:
 *  - No live LLM calls: LLM 能力经 test-helpers/fake-llm-clients 在 provider 边界注入确定性
 *    假 client，走真实 LLM 代码路径（真实性重构后生产已无离线兜底：无 client 即 503/429/502）。
 *  - No real network: external providers are never contacted.
 *  - No real server process: everything goes through server.inject.
 *  - Tests must not touch ports 8787/5173.
 */

import { describe, it, expect, vi } from "vitest";
import { buildApiServer } from "../server";
import { registerInterviewSessionRoutes } from "../routes/interview-sessions";
import { registerStateRoutes } from "../routes/state";
import { createInMemoryProductStateRepository } from "../product-state-repository";
import { createLlmBudget } from "../llm-budget";
import {
  createFakeChatClient,
  createFakeEmbeddingClient,
  createFakeInterviewClient
} from "../test-helpers/fake-llm-clients";
import Fastify from "fastify";

// 全套假 LLM client：让旅程走真实 LLM 代码路径（prompt 组装/解析/校验/落库全真）。
function fakeLlmClients() {
  return {
    bailianChatClient: createFakeChatClient(),
    bailianInterviewClient: createFakeInterviewClient(),
    embeddingClient: createFakeEmbeddingClient()
  };
}

// ---------------------------------------------------------------------------
// Journey 1 — full interview → diary → reviews lifecycle
// ---------------------------------------------------------------------------
describe("Journey 1: full interview → diary → reviews lifecycle", () => {
  it("completes an interview lifecycle and verifies cross-route consistency", async () => {
    const server = buildApiServer({ env: {}, ...fakeLlmClients() });

    // Step 1: Reset to empty state
    const resetRes = await server.inject({ method: "POST", url: "/api/state/reset", payload: { confirm: "RESET_ALL_DATA" } });
    expect(resetRes.statusCode).toBe(200);
    const resetState = resetRes.json();
    expect(resetState.notes).toHaveLength(0);
    expect(resetState.themes).toHaveLength(0);
    expect(resetState.revision).toBeGreaterThanOrEqual(0);
    const revisionAfterReset = resetState.revision;

    // Step 2: Create interview session
    const createRes = await server.inject({
      method: "POST",
      url: "/api/interview-sessions",
      payload: { mode: "decision", strength: "standard" }
    });
    expect(createRes.statusCode).toBe(200);
    const { session: createdSession, state: stateAfterCreate } = createRes.json();
    expect(createdSession.mode).toBe("decision");
    expect(createdSession.strength).toBe("standard");
    expect(createdSession.status).toBe("active");
    expect(createdSession.card).toBeDefined();
    expect(typeof createdSession.card.title).toBe("string");
    expect(createdSession.card.title.length).toBeGreaterThan(0);
    expect(createdSession.guide).toBeDefined();
    const sessionId = createdSession.id;
    const revisionAfterCreate = stateAfterCreate.revision;

    // Step 3: Send 4 turns (topics: 离职/独立开发, NOT 救火/授权)
    const turnTopics = [
      "我最近一直在纠结，要不要从大厂离职去做独立开发者。",
      "真正让我踌躇的是失去团队归属感，而不是薪资的问题。",
      "如果真的离职，我觉得最大的风险是一年内做不出任何用户愿意付费的产品。",
      "另外我也在想，也许做独立开发是一种个人身份重塑的机会，而不只是职业选择。"
    ];
    let lastTurnState: any;
    for (const content of turnTopics) {
      const turnRes = await server.inject({
        method: "POST",
        url: `/api/interview-sessions/${sessionId}/turns`,
        payload: { content }
      });
      expect(turnRes.statusCode).toBe(200);
      const body = turnRes.json();
      expect(body.session).toBeDefined();
      expect(body.session.id).toBe(sessionId);
      // After each turn: user turn recorded; assistant turn added by the injected fake LLM client
      const userTurns = body.session.turns.filter((t: any) => t.role === "user");
      expect(userTurns.length).toBeGreaterThanOrEqual(1);
      lastTurnState = body.state;
    }

    // Step 4: End the session
    const endRes = await server.inject({
      method: "POST",
      url: `/api/interview-sessions/${sessionId}/end`
    });
    expect(endRes.statusCode).toBe(200);
    const endBody = endRes.json();

    // Assert: note returned with required diary fields
    expect(endBody.note).toBeDefined();
    expect(endBody.note.sessionId).toBe(sessionId);
    expect(typeof endBody.note.title).toBe("string");
    expect(endBody.note.title.length).toBeGreaterThan(0);
    expect(endBody.note.summary).toBeDefined();
    expect(Array.isArray(endBody.note.saidTrack)).toBe(true);
    expect(Array.isArray(endBody.note.learnedTrack)).toBe(true);
    expect(Array.isArray(endBody.note.nextQuestions)).toBe(true);

    // Assert: session is marked completed in the returned state
    const completedSessionInState = endBody.state.sessions.find((s: any) => s.id === sessionId);
    expect(completedSessionInState).toBeDefined();
    expect(completedSessionInState!.status).toBe("completed");

    // Assert: revision strictly increased from post-create revision
    expect(endBody.state.revision).toBeGreaterThan(revisionAfterCreate);

    // Assert: note persisted — GET /api/state reflects it
    const stateAfterEnd = await server.inject({ method: "GET", url: "/api/state" });
    expect(stateAfterEnd.statusCode).toBe(200);
    const persistedState = stateAfterEnd.json();
    const persistedNote = persistedState.notes.find((n: any) => n.sessionId === sessionId);
    expect(persistedNote).toBeDefined();
    expect(persistedNote!.title).toBe(endBody.note.title);

    // Assert: session recorded in GET /api/state
    const persistedSession = persistedState.sessions.find((s: any) => s.id === sessionId);
    expect(persistedSession).toBeDefined();
    expect(persistedSession!.status).toBe("completed");

    // Step 5: GET /api/reviews → LLM 叙事（fake chat client）+ 确定性 metrics/radar
    const reviewsRes = await server.inject({ method: "GET", url: "/api/reviews" });
    expect(reviewsRes.statusCode).toBe(200);
    const reviews = reviewsRes.json();
    expect(reviews.monthly).toBeDefined();
    expect(reviews.monthly.metrics).toBeDefined();
    expect(typeof reviews.monthly.metrics.notes).toBe("number");
    expect(reviews.yearly).toBeDefined();
    expect(Array.isArray(reviews.yearly.coreQuestions)).toBe(true);
    expect(reviews.radar).toBeDefined();

    await server.close();
  });
});

// ---------------------------------------------------------------------------
// Journey 2 — search → podcast → TTS resilience
// ---------------------------------------------------------------------------
describe("Journey 2: search → podcast → TTS resilience", () => {
  it("creates a search brief with local-demo provider (deterministic)", async () => {
    const server = buildApiServer({ env: {} });

    const briefRes = await server.inject({
      method: "POST",
      url: "/api/search/briefs",
      payload: { topic: "AI 编程助手 2026", providerId: "local-demo" }
    });
    expect(briefRes.statusCode).toBe(200);
    const { brief } = briefRes.json();
    expect(brief.topic).toBe("AI 编程助手 2026");
    expect(brief.provider).toBe("local-demo");
    expect(Array.isArray(brief.sources)).toBe(true);
    expect(brief.sources.length).toBeGreaterThan(0);

    await server.close();
  });

  it("generates podcast episode without TTS client — script persists, no audio URL", async () => {
    // note 路径播客脚本是 LLM 必选能力（无 chat client → 503），注入假 chat client 走真实脚本生成。
    const server = buildApiServer({ env: {}, bailianChatClient: createFakeChatClient() });

    // Use the demo state's first note (server starts with demo state by default)
    const stateRes = await server.inject({ method: "GET", url: "/api/state" });
    const firstNote = stateRes.json().notes[0];
    expect(firstNote).toBeDefined();
    const noteId = firstNote.id;

    const episodeRes = await server.inject({
      method: "POST",
      url: "/api/podcast/episodes",
      payload: { noteId, format: "solo" }
    });
    expect(episodeRes.statusCode).toBe(200);
    const { episode } = episodeRes.json();
    expect(episode.noteId).toBe(noteId);
    expect(typeof episode.script).toBe("string");
    expect(episode.script.length).toBeGreaterThan(0);
    // No TTS client → episode returned as-is from domain layer.
    // The domain always sets audioRenderStatus: "pending" (script generated, audio not yet rendered).
    // The podcast route returns immediately without calling TTS, so the status stays "pending".
    expect(episode.audioRenderStatus).toBe("pending");

    await server.close();
  });

  it("TTS client failure → 200, script intact, audioRenderStatus=failed, episode persisted", async () => {
    const __prevAutoRender = process.env.PODCAST_AUTO_RENDER_ON_CREATE;
    process.env.PODCAST_AUTO_RENDER_ON_CREATE = "true";
    try {
    // 真实性重构:TTS 失败入库为 "failed"（真错误），不再伪装成可自动恢复的 "fallback" 中间态。
    // 创建端点先持久化脚本再尝试 TTS，因此 TTS 失败仍 200、脚本不丢。
    const failingTtsClient = {
      synthesize: vi.fn(async () => {
        throw new Error("TTS 400");
      })
    };

    const server = buildApiServer({
      env: {},
      bailianChatClient: createFakeChatClient(),
      bailianPodcastAudioClient: failingTtsClient
    });

    // Need a note — use demo state
    const stateRes = await server.inject({ method: "GET", url: "/api/state" });
    const firstNote = stateRes.json().notes[0];
    expect(firstNote).toBeDefined();
    const noteId = firstNote.id;

    const episodeRes = await server.inject({
      method: "POST",
      url: "/api/podcast/episodes",
      payload: { noteId, format: "solo" }
    });
    // Must return 200 even though TTS failed
    expect(episodeRes.statusCode).toBe(200);
    const { episode } = episodeRes.json();
    expect(episode.noteId).toBe(noteId);
    expect(typeof episode.script).toBe("string");
    expect(episode.script.length).toBeGreaterThan(0);
    expect(episode.audioRenderStatus).toBe("failed");
    expect(episode.audioRenderMessage).toContain("音频渲染失败");

    // Episode must be persisted in state
    const stateAfterEpisode = await server.inject({ method: "GET", url: "/api/state" });
    const persistedEpisode = stateAfterEpisode.json().podcastEpisodes.find((e: any) => e.id === episode.id);
    expect(persistedEpisode).toBeDefined();
    expect(persistedEpisode!.audioRenderStatus).toBe("failed");
    expect(typeof persistedEpisode!.script).toBe("string");
    expect(persistedEpisode!.script.length).toBeGreaterThan(0);


      await server.close();
    } finally {
      if (__prevAutoRender === undefined) delete process.env.PODCAST_AUTO_RENDER_ON_CREATE;
      else process.env.PODCAST_AUTO_RENDER_ON_CREATE = __prevAutoRender;
    }
  });
});

// ---------------------------------------------------------------------------
// Journey 3 — memory governance HITL
// ---------------------------------------------------------------------------
describe("Journey 3: memory governance HITL", () => {
  // 真实性重构:导入抽取是 LLM 必选能力——无 chat client 不再"0 候选照常导入"，而是如实 503。
  it("imports a document on no-key server → 503 (LLM 未配置就暴露，不再静默 0 候选导入)", async () => {
    const server = buildApiServer({ env: {} });

    const importRes = await server.inject({
      method: "POST",
      url: "/api/import/documents",
      payload: {
        title: "AI 产品方法论摘录",
        content:
          "张伟在 2024 年主导了公司 AI 转型，带领团队从传统软件开发转型为 AI 优先的开发流程。" +
          "核心洞察是：AI 工具的价值不在于替代人力，而在于放大人的判断力。" +
          "他们的成功率从 60% 提升到 85%，主要归因于决策透明化和快速迭代机制。",
        sourceType: "text"
      }
    });
    expect(importRes.statusCode).toBe(503);
    expect(importRes.json().error).toContain("未配置");
    // 原子失败：什么都不落库
    const state = (await server.inject({ method: "GET", url: "/api/state" })).json();
    expect(state.importSources.some((s: any) => s.title === "AI 产品方法论摘录")).toBe(false);

    await server.close();
  });

  it("when import produces candidates via fake LLM, approving one moves it to memoryRecords", async () => {
    // 注入假 chat client（canned 记忆抽取固定产出 1 条候选），走真实抽取→审批路径。
    const server = buildApiServer({ env: {}, bailianChatClient: createFakeChatClient() });

    const importRes = await server.inject({
      method: "POST",
      url: "/api/import/documents",
      payload: {
        title: "AI 产品方法论摘录",
        content:
          "张伟在 2024 年主导了公司 AI 转型，带领团队从传统软件开发转型为 AI 优先的开发流程。",
        sourceType: "text"
      }
    });
    expect(importRes.statusCode).toBe(200);
    const importBody = importRes.json();
    // fake 记忆抽取确定性产出 1 条候选（不再有"抽不出→静默 0 候选"的分叉）。
    expect(importBody.candidateCount).toBe(1);

    // Find the first pending candidate
    const stateAfterImport = importBody.state;
    const pendingCandidate = stateAfterImport.memoryCandidates.find(
      (c: any) => c.status === "pending"
    );
    expect(pendingCandidate).toBeDefined();

    // Approve via POST /api/memory-candidates/:id/approve
    const approveRes = await server.inject({
      method: "POST",
      url: `/api/memory-candidates/${pendingCandidate!.id}/approve`
    });
    expect(approveRes.statusCode).toBe(200);
    const approveBody = approveRes.json();

    // Approved candidate should move to memoryRecords in state
    expect(approveBody.state.memoryRecords).toBeDefined();
    const record = approveBody.state.memoryRecords.find(
      (r: any) => r.sourceCandidateId === pendingCandidate!.id
    );
    expect(record).toBeDefined();

    // Cross-verify via GET /api/state
    const stateRes = await server.inject({ method: "GET", url: "/api/state" });
    const finalState = stateRes.json();
    const persistedRecord = finalState.memoryRecords.find(
      (r: any) => r.sourceCandidateId === pendingCandidate!.id
    );
    expect(persistedRecord).toBeDefined();

    await server.close();
  });
});

// ---------------------------------------------------------------------------
// Journey 5 — state integrity / optimistic concurrency
// ---------------------------------------------------------------------------
describe("Journey 5: state integrity / optimistic concurrency", () => {
  it("enforces optimistic concurrency and handles forged high revision", async () => {
    const server = buildApiServer({ env: {} });

    // Reset to known state
    await server.inject({ method: "POST", url: "/api/state/reset", payload: { confirm: "RESET_ALL_DATA" } });

    // Step 1: GET current state, capture revision R
    const getRes = await server.inject({ method: "GET", url: "/api/state" });
    expect(getRes.statusCode).toBe(200);
    const currentState = getRes.json();
    const revisionR = currentState.revision;

    // Step 2: PUT with stale revision (R-1) → 409
    const staleRes = await server.inject({
      method: "PUT",
      url: "/api/state",
      payload: { ...currentState, revision: revisionR - 1 }
    });
    expect(staleRes.statusCode).toBe(409);
    const staleBody = staleRes.json();
    expect(staleBody.error).toContain("stale");
    expect(staleBody.current).toBeDefined();
    expect(staleBody.current.revision).toBe(revisionR);

    // Step 3: PUT with fresh revision R (small content change) → 200, server bumps revision
    const updatedProfile = {
      ...currentState.profile,
      currentFocus: "optimistic concurrency test"
    };
    const freshRes = await server.inject({
      method: "PUT",
      url: "/api/state",
      payload: { ...currentState, revision: revisionR, profile: updatedProfile }
    });
    expect(freshRes.statusCode).toBe(200);
    const freshBody = freshRes.json();
    // Server revision should be >= R+1 after a successful PUT
    // (normalizeProductState may bump it; at minimum it's >= R)
    expect(freshBody.revision).toBeGreaterThanOrEqual(revisionR);

    // Verify the content change was accepted
    const afterFreshGet = await server.inject({ method: "GET", url: "/api/state" });
    expect(afterFreshGet.json().profile.currentFocus).toBe("optimistic concurrency test");

    // Step 4: PUT with FORGED high revision (9999) but "old" content
    // Fixed (P1-18): route now requires incomingRevision === stored.revision exactly.
    // A forged number HIGHER than stored revision is now rejected with 409.
    const stateBeforeForge = afterFreshGet.json() as Record<string, unknown>;
    const forgedRes = await server.inject({
      method: "PUT",
      url: "/api/state",
      payload: { ...stateBeforeForge, revision: 9999 }
    });
    // Must-equal check: 9999 !== storedRevisionNow → 409 conflict
    expect(forgedRes.statusCode).toBe(409);

    // Step 5: POST /api/state/reset → empty state
    const resetRes = await server.inject({ method: "POST", url: "/api/state/reset", payload: { confirm: "RESET_ALL_DATA" } });
    expect(resetRes.statusCode).toBe(200);
    const resetState = resetRes.json();
    expect(resetState.notes).toHaveLength(0);
    expect(resetState.themes).toHaveLength(0);

    // GET reflects the reset
    const afterResetGet = await server.inject({ method: "GET", url: "/api/state" });
    expect(afterResetGet.statusCode).toBe(200);
    const afterResetState = afterResetGet.json();
    expect(afterResetState.notes).toHaveLength(0);

    await server.close();
  });
});

// ---------------------------------------------------------------------------
// Journey 6 — cost guard (per-session LLM budget)
// ---------------------------------------------------------------------------
describe("Journey 6: cost guard (per-session LLM budget)", () => {
  // 真实性重构:预算耗尽不再"静默跳过 LLM 仍 200"——第二轮如实 429，且本轮原子失败不落任何轮次。
  it("LLM called exactly once when maxCallsPerSession=1; second turn returns 429 and records nothing", async () => {
    let llmCallCount = 0;
    const mockInterviewClient = {
      createAssistantTurn: vi.fn(async (input: any) => {
        llmCallCount++;
        return {
          providerId: "bailian-character" as const,
          model: "test-model",
          content: `追问 ${llmCallCount}：${input.userText} 背后的具体时刻是什么？`,
          intent: "百炼角色扮演追问" as const
        };
      })
    };

    const budget = createLlmBudget({ maxCallsPerSession: 1 });
    const repo = createInMemoryProductStateRepository();
    const miniServer = Fastify({ logger: false });

    // Register only the routes we need for this journey
    await registerInterviewSessionRoutes(miniServer, repo, {
      bailianInterviewClient: mockInterviewClient as any,
      llmBudget: budget
    });
    // Also register state routes so GET /api/state works
    await miniServer.register(registerStateRoutes, repo);

    // Create session
    const createRes = await miniServer.inject({
      method: "POST",
      url: "/api/interview-sessions",
      payload: { mode: "daily" }
    });
    expect(createRes.statusCode).toBe(200);
    const sessionId = createRes.json().session.id;

    // First turn — within budget (count=0 → allow), LLM called
    const res1 = await miniServer.inject({
      method: "POST",
      url: `/api/interview-sessions/${sessionId}/turns`,
      payload: { content: "我最近在考虑离职去做独立开发。" }
    });
    expect(res1.statusCode).toBe(200);
    expect(llmCallCount).toBe(1);
    const body1 = res1.json();
    const userTurns1 = body1.session.turns.filter((t: any) => t.role === "user");
    expect(userTurns1.length).toBeGreaterThanOrEqual(1);

    // Second turn — budget exhausted → 如实 429，LLM 不再被调用，本轮原子失败（不落用户轮）
    const res2 = await miniServer.inject({
      method: "POST",
      url: `/api/interview-sessions/${sessionId}/turns`,
      payload: { content: "最大的担忧是做不出用户愿意付费的产品。" }
    });
    expect(res2.statusCode).toBe(429);
    expect(res2.json().error).toContain("预算");
    // LLM still at 1 — not called again
    expect(llmCallCount).toBe(1);
    // Atomic failure: the session still has exactly the first exchange (user + assistant)
    const stateAfter = (await miniServer.inject({ method: "GET", url: "/api/state" })).json();
    const sessionAfter = stateAfter.sessions.find((s: any) => s.id === sessionId);
    expect(sessionAfter.turns.filter((t: any) => t.role === "user")).toHaveLength(1);
    expect(sessionAfter.turns).toHaveLength(2);

    await miniServer.close();
  });
});

// ---------------------------------------------------------------------------
// Journey 7 — full happy path across routes with injected fake LLM clients
// （真实性重构后已无"无 key 优雅降级"路径：无 client 即 5xx。本旅程改为注入全套假
//   client 验证主要路由端到端 happy path 全程非 5xx。）
// ---------------------------------------------------------------------------
describe("Journey 7: full happy path on fake-LLM server", () => {
  it("every route on happy path returns a non-5xx status with fake LLM clients", async () => {
    const server = buildApiServer({ env: {}, ...fakeLlmClients() });

    // Health
    const health = await server.inject({ method: "GET", url: "/api/health" });
    expect(health.statusCode).toBeLessThan(500);

    // GET state
    const stateRes = await server.inject({ method: "GET", url: "/api/state" });
    expect(stateRes.statusCode).toBeLessThan(500);

    // Reset state
    const resetRes = await server.inject({ method: "POST", url: "/api/state/reset", payload: { confirm: "RESET_ALL_DATA" } });
    expect(resetRes.statusCode).toBeLessThan(500);

    // Create search brief (local-demo)
    const briefRes = await server.inject({
      method: "POST",
      url: "/api/search/briefs",
      payload: { topic: "AI 产品设计 2026", providerId: "local-demo" }
    });
    expect(briefRes.statusCode).toBeLessThan(500);

    // Create interview session
    const createSessionRes = await server.inject({
      method: "POST",
      url: "/api/interview-sessions",
      payload: { mode: "decision", strength: "standard" }
    });
    expect(createSessionRes.statusCode).toBeLessThan(500);
    const sessionId = createSessionRes.json().session.id;

    // Send a turn
    const turnRes = await server.inject({
      method: "POST",
      url: `/api/interview-sessions/${sessionId}/turns`,
      payload: { content: "我在考虑离职做独立产品开发。" }
    });
    expect(turnRes.statusCode).toBeLessThan(500);

    // End the session
    const endRes = await server.inject({
      method: "POST",
      url: `/api/interview-sessions/${sessionId}/end`
    });
    expect(endRes.statusCode).toBeLessThan(500);

    // GET reviews
    const reviewsRes = await server.inject({ method: "GET", url: "/api/reviews" });
    expect(reviewsRes.statusCode).toBeLessThan(500);

    // Import a document
    const importRes = await server.inject({
      method: "POST",
      url: "/api/import/documents",
      payload: {
        title: "测试文档",
        content: "这是一段关于 AI 产品设计的测试内容，包含几个具体的洞察。",
        sourceType: "text"
      }
    });
    expect(importRes.statusCode).toBeLessThan(500);

    // GET state — final consistency check
    const finalState = await server.inject({ method: "GET", url: "/api/state" });
    expect(finalState.statusCode).toBeLessThan(500);
    const finalBody = finalState.json();
    expect(finalBody.revision).toBeGreaterThanOrEqual(0);
    expect(Array.isArray(finalBody.notes)).toBe(true);
    expect(Array.isArray(finalBody.sessions)).toBe(true);

    await server.close();
  });
});
