/**
 * InterviewerBrain — single entry for turn-generation orchestration.
 *
 * Pure extraction of the former /turns and /turns/stream handler bodies.
 * Zero user-visible behavior change when VOICE_CRAFT_OUTPUT_GUARD is off (default).
 * Routes keep write serialization (runExclusive), then delegate here. Brain calls
 * the existing createAssistantTurn / createAssistantTurnStream paths; it does NOT
 * invent a parallel brain, half-cascade, or Audio3 path.
 *
 * No VOICE_BRAIN_UNIFIED flag: pure refactor; revert via git if needed.
 * Optional craft output guard: see src/domain/craft-output-guard.ts.
 */
import type { FastifyReply, FastifyRequest } from "fastify";
import {
  buildInterviewEnginePolicy,
  buildInterviewGuide,
  decideInterviewStrategy,
  receiveUserTurnWithAssistant
} from "../../../../src/domain/engine";
import {
  applyCraftOutputGuard,
  buildCraftMetaFromGuardResult,
  type CraftOutputGuardResult
} from "../../../../src/domain/craft-output-guard";
import type {
  InteractionPreSignals,
  InterviewSession
} from "../../../../src/domain/types";
import { nowIso } from "../../../../src/domain/utils";
import {
  applyMidSessionCardRefresh,
  buildInterviewContextPack,
  resolveInterviewTopicHint,
  resolveMidSessionRecallTopic
} from "../../../../src/domain/context-pack";
import type { ProductStateRepository } from "../product-state-repository";
import { replaceStateDurable } from "../product-state-repository";
import type { BailianCharacterInterviewClient, BailianEmbeddingClient } from "../providers/bailian";
import { createLlmBudget, type LlmBudget } from "../llm-budget";
import { asNativeRecall } from "../recall/native-recall-capability";
import { prefetchRecall } from "../recall/prefetch-recall";
import {
  type TurnPayload,
  embedQueryText,
  findSession,
  getSessionId,
  normalizeObject,
  normalizeOptionalString,
  receiveTurn,
  stripAsidesFromLatestAssistantTurn,
  upsertSession,
  withInterviewTurnDeadline
} from "../routes/interview-session-helpers";

/** Apply optional craft output guard to raw assistant text; log when triggered. */
function guardAssistantText(
  content: string,
  sessionId: string,
  path: "json" | "stream"
): { text: string; guard: CraftOutputGuardResult } {
  const guard = applyCraftOutputGuard(content);
  if (guard.outputGuardTriggered) {
    const meta = buildCraftMetaFromGuardResult(guard);
    console.info(
      JSON.stringify({
        event: "craft_output_guard",
        sessionId,
        path,
        action: meta.action,
        reasons: meta.reasons,
        singleQuestionHeuristicOk: meta.singleQuestionHeuristicOk,
        originalLen: guard.originalText.length,
        resultLen: guard.text.length
      })
    );
  }
  return { text: guard.text, guard };
}

/** Rewrite latest assistant turn content when guard truncated (json path after receiveTurn). */
function applyGuardToLatestAssistantTurn(
  session: InterviewSession,
  sessionId: string,
  path: "json" | "stream"
): InterviewSession {
  const turns = session.turns;
  let lastAssistantIndex = -1;
  for (let i = turns.length - 1; i >= 0; i--) {
    if (turns[i].role === "assistant") {
      lastAssistantIndex = i;
      break;
    }
  }
  if (lastAssistantIndex === -1) return session;
  const turn = turns[lastAssistantIndex];
  const { text, guard } = guardAssistantText(turn.content, sessionId, path);
  if (!guard.outputGuardTriggered || text === turn.content) return session;
  const nextTurns = turns.slice();
  nextTurns[lastAssistantIndex] = { ...turn, content: text };
  return { ...session, turns: nextTurns };
}

/** Path tag for future multi-channel callers; HTTP handlers set this implicitly. */
export type BrainPath = "cascade" | "omni" | "livekit" | "text";

export interface InterviewerBrainDeps {
  repository: ProductStateRepository;
  bailianInterviewClient?: BailianCharacterInterviewClient;
  embeddingClient?: BailianEmbeddingClient;
  /**
   * Shared budget used by non-stream /turns (same instance as route registration).
   * Stream path historically does `options.llmBudget ?? createLlmBudget()` separately
   * when no option is injected — preserve that via llmBudgetOption.
   */
  budget: LlmBudget;
  /** Raw option from route registration; stream uses this for its local budget line. */
  llmBudgetOption?: LlmBudget;
  interviewTurnTimeoutMs: number;
}

/**
 * Non-stream turn orchestration (POST /turns body after runExclusive).
 * Preserves: 404/409/422 → mid-session embed/recall → 503/429 → LLM → 499/502 → persist.
 *
 * Design alias: this is the non-stream half of runInterviewerBrainTurn.
 */
export async function handleTurnsRequest(
  request: FastifyRequest,
  reply: FastifyReply,
  deps: InterviewerBrainDeps
): Promise<unknown> {
  const { repository, budget, interviewTurnTimeoutMs } = deps;
  const state = repository.getState();
  const session = findSession(state, getSessionId(request.params));
  if (!session) {
    return reply.code(404).send({ error: "Interview session not found." });
  }
  // M6: a completed + raw-material-offloaded session has its transcript in cold storage
  // and an empty hot layer. Appending here would re-grow the hot turns and split them from
  // the cold copy, so refuse.
  if (session.status === "completed" || session.rawMaterialOffloaded === true) {
    return reply.code(409).send({ error: "会话已结束并归档，无法追加轮次。" });
  }

  const payload = normalizeObject<TurnPayload>(request.body);
  const content = normalizeOptionalString(payload.content);
  if (!content) {
    return reply.code(422).send({ error: "Turn content is required." });
  }

  // C1: re-stamp enginePolicy from the LATEST state every turn. The policy is
  // captured once at create time, so a PlaybookPatch approved mid-session would
  // otherwise only take effect next session. Re-stamping here means a corpus rule
  // approved while this interview is running shapes the very next question — both
  // the LLM prompt (createAssistantTurn → buildCharacterSystemPrompt reads
  // session.enginePolicy.appliedPlaybookRules) and the deterministic strategy
  // engine (decideInterviewStrategy routes on appliedPlaybookRuleTypes). Pure
  // recompute; it only changes HOW we ask, never the existing turns/state.
  //
  // M3c: in the same spirit, re-derive the guide's memory recall against the
  // FRESHEST user utterance. When an embeddingClient exists we embed the incoming
  // user text and recompute the guide so collectRelevantMemories ranks confirmed
  // memories by cosine to what the guest just said (not just the create-time topic).
  // The deterministic strategy engine reads session.guide (openDebts /
  // recommendedMemories), so this genuinely changes which memory gets referenced.
  // Fail-safe: no client / embed failure → guide unchanged (create-time recall).
  const enginePolicy = buildInterviewEnginePolicy(state);
  let turnEmbedding: number[] | undefined;
  try {
    turnEmbedding = await embedQueryText(content, deps.embeddingClient);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return reply.code(502).send({ error: `本轮记忆召回嵌入失败：${message}。本轮未记录，请重试。` });
  }
  // C-P1-02 + R-P1-01: mid-session native prefetch; BM25/queryText follows latest user
  // text; theme graph only when a theme name appears in the utterance (no open-time freeze).
  const midTopic = resolveMidSessionRecallTopic(
    state,
    session.guide.topicHint || resolveInterviewTopicHint(state, {}),
    content
  );
  let turnRecall: Awaited<ReturnType<typeof prefetchRecall>> | undefined;
  const nativeRecall = asNativeRecall(repository);
  if (nativeRecall) {
    try {
      turnRecall = await prefetchRecall(
        nativeRecall,
        state,
        midTopic.themeTopic,
        turnEmbedding,
        {
          includeSensitive: state.systemConfig.memory.includeSensitiveMemoriesInContext,
          topN: state.systemConfig.search.maxSources,
          queryText: midTopic.queryText
        }
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(JSON.stringify({ event: "session_turn_recall_failed", error: message }));
      return reply.code(502).send({ error: `本轮记忆召回失败：${message}。本轮未记录，请重试。` });
    }
  }
  // Refresh guide from mid-session query semantics. Card materials refresh from the
  // same pack (sourceHighlights) and history refs are live-only (no dual freeze merge).
  const guideTopicHint = midTopic.queryText || session.guide.topicHint || undefined;
  const refreshedGuide =
    turnEmbedding || turnRecall
      ? buildInterviewGuide(
          state,
          {
            ...(guideTopicHint ? { topicHint: guideTopicHint } : {}),
            ...(session.card.searchBriefId ? { searchBriefId: session.card.searchBriefId } : {}),
            ...(turnEmbedding ? { queryEmbedding: turnEmbedding } : {})
          },
          turnRecall
        )
      : session.guide;
  const livePack =
    turnEmbedding || turnRecall
      ? buildInterviewContextPack(
          state,
          {
            ...(guideTopicHint ? { topicHint: guideTopicHint } : {}),
            ...(session.card.searchBriefId ? { searchBriefId: session.card.searchBriefId } : {}),
            ...(turnEmbedding ? { queryEmbedding: turnEmbedding } : {})
          },
          turnRecall
        )
      : undefined;
  const refreshedCard = applyMidSessionCardRefresh(session.card, refreshedGuide, livePack);
  const freshSession: InterviewSession = {
    ...session,
    enginePolicy,
    guide: refreshedGuide,
    card: refreshedCard
  };

  // 追问是 LLM 能力：不可用/失败就如实暴露（503/429/502），不再回退确定性策略引擎生成假追问。
  // 失败时不落任何轮次——请求原子失败，用户可原样重试。
  if (!deps.bailianInterviewClient) {
    return reply.code(503).send({ error: "专访追问 LLM 未配置（缺少 DASHSCOPE_API_KEY），无法生成追问。" });
  }
  if (!budget.tryConsume(freshSession.id)) {
    console.warn(JSON.stringify({ event: "llm_budget_exceeded", capability: "interview_turn", sessionId: freshSession.id }));
    return reply.code(429).send({ error: "本会话 LLM 预算已用尽，追问暂不可用，请稍后重试。" });
  }
  // IV-P1-01: cascade barge-in aborts the client fetch; do not persist a ghost full turn.
  // Listen for the abort *event* during the LLM await — do NOT use request.raw.aborted
  // after await (Node/undici can report aborted/destroyed on a completed request and
  // false-positive 499, dropping successful turns in e2e/browser).
  let clientAborted = false;
  const onClientAbort = () => {
    clientAborted = true;
  };
  // Only the 'aborted' event is reliable mid-flight. Do not use raw.aborted/destroyed
  // after await, and do not treat generic 'close' as cancel (races with successful end).
  request.raw.once("aborted", onClientAbort);
  let updatedResult: Awaited<ReturnType<typeof receiveTurn>>;
  try {
    updatedResult = await withInterviewTurnDeadline(
      receiveTurn(
        freshSession,
        content,
        deps.bailianInterviewClient,
        state.memoryCorrections,
        state.profile.explicitBoundaries
      ),
      interviewTurnTimeoutMs
    );
  } catch (error) {
    request.raw.off("aborted", onClientAbort);
    const message = error instanceof Error ? error.message : String(error);
    console.warn(JSON.stringify({ event: "llm_failed", capability: "interview_turn", sessionId: freshSession.id, error: message }));
    return reply.code(502).send({ error: `追问生成失败：${message}。本轮未记录，请重试。` });
  }
  request.raw.off("aborted", onClientAbort);
  if (clientAborted) {
    console.info(JSON.stringify({
      event: "interview_turn_aborted_no_persist",
      sessionId: freshSession.id,
      reason: "client_disconnect_or_abort"
    }));
    return reply.code(499).send({ error: "客户端已取消本轮，未写入轮次。" });
  }
  const { nextSession: rawNextSession, preSignals } = updatedResult;
  // Optional craft output guard (VOICE_CRAFT_OUTPUT_GUARD, default off): truncate multi-?
  // assistant turns or log retry-worthy violations before asides strip / persist.
  const guardedSession = applyGuardToLatestAssistantTurn(rawNextSession, freshSession.id, "json");
  // The character model conveys manner via （…）stage-direction asides (e.g. 「（身体微倾，
  // 表现出好奇）」). Strip them out of the stored question so the transcript / finalize / memory
  // read as clean words like a real interview; distill the manner into `prosody` so the voice
  // path can still deliver it expressively. Only the just-generated assistant turn is touched.
  const nextSession = stripAsidesFromLatestAssistantTurn(guardedSession);
  const baseNextState = upsertSession(state, nextSession);

  // M3 recency write-back: the records actually recalled into THIS turn's guide get
  // lastAccessedAt = now, so the recency factor reflects "recently used" rather than
  // only "recently confirmed" (which would otherwise decay a frequently-cited memory).
  // Route layer owns this because it has the clock; the domain scorer stays pure.
  const recalledTexts = new Set(refreshedGuide.relevantMemories ?? []);
  const nextState = recalledTexts.size > 0
    ? {
        ...baseNextState,
        memoryRecords: baseNextState.memoryRecords.map((record) =>
          record.status === "confirmed" && recalledTexts.has(record.text)
            ? { ...record, lastAccessedAt: nowIso() }
            : record
        )
      }
    : baseNextState;

  const persisted = /*durable*/await replaceStateDurable(repository, nextState);
  return { session: nextSession, state: persisted, ...(preSignals ? { preSignals } : {}) };
}

/**
 * Streaming turn for cascade voice TTFA (POST /turns/stream body after runExclusive).
 * SSE events: delta → final | error. Falls back to non-stream LLM when
 * createAssistantTurnStream is unavailable (existing behavior).
 *
 * Design alias: this is the stream half of runInterviewerBrainTurn.
 */
export async function handleTurnsStreamRequest(
  request: FastifyRequest,
  reply: FastifyReply,
  deps: InterviewerBrainDeps
): Promise<unknown> {
  const { repository, interviewTurnTimeoutMs } = deps;
  const state = repository.getState();
  const session = findSession(state, getSessionId(request.params));
  if (!session) {
    return reply.code(404).send({ error: "Interview session not found." });
  }
  if (session.status !== "active") {
    return reply.code(409).send({ error: "Interview session is not active." });
  }
  if (!deps.bailianInterviewClient) {
    return reply.code(503).send({ error: "缺少 DASHSCOPE_API_KEY，专访追问 LLM 未配置。" });
  }
  const payload = (request.body && typeof request.body === "object" ? request.body : {}) as { content?: unknown };
  const content = typeof payload.content === "string" ? payload.content.trim() : "";
  if (!content) {
    return reply.code(400).send({ error: "content is required." });
  }

  // Preserve historical stream budget resolution: option or a fresh local budget.
  const budget = deps.llmBudgetOption ?? createLlmBudget();
  if (!budget.tryConsume(session.id)) {
    return reply.code(429).send({ error: "本会话 LLM 预算已耗尽，请稍后再试。" });
  }

  reply.hijack();
  reply.raw.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no"
  });
  const writeEvent = (event: string, data: unknown) => {
    reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  let clientAborted = false;
  const onAbort = () => {
    clientAborted = true;
  };
  request.raw.once("aborted", onAbort);

  try {
    const strategyDecision = decideInterviewStrategy(session, content);
    const streamFn = deps.bailianInterviewClient.createAssistantTurnStream;
    let assistantResult: Awaited<ReturnType<NonNullable<typeof deps.bailianInterviewClient>["createAssistantTurn"]>> | undefined;
    let preSignals: InteractionPreSignals | undefined;

    if (streamFn) {
      const ac = new AbortController();
      const onClientAbort = () => ac.abort();
      request.raw.once("aborted", onClientAbort);
      try {
        for await (const ev of streamFn.call(deps.bailianInterviewClient, {
          session,
          userText: content,
          corrections: state.memoryCorrections,
          boundaries: state.profile.explicitBoundaries,
          strategyDecision,
          signal: ac.signal
        })) {
          if (clientAborted) break;
          if (ev.type === "delta") {
            writeEvent("delta", { text: ev.text });
          } else {
            assistantResult = ev.result;
            preSignals = ev.result.preSignals;
          }
        }
      } finally {
        request.raw.off("aborted", onClientAbort);
      }
    } else {
      assistantResult = await withInterviewTurnDeadline(
        deps.bailianInterviewClient.createAssistantTurn({
          session,
          userText: content,
          corrections: state.memoryCorrections,
          boundaries: state.profile.explicitBoundaries,
          strategyDecision
        }),
        interviewTurnTimeoutMs
      );
      preSignals = assistantResult.preSignals;
      // Emit full content as one delta so clients still get progressive-ish path
      if (assistantResult.content) writeEvent("delta", { text: assistantResult.content });
    }

    if (clientAborted || assistantResult === undefined) {
      writeEvent("error", { error: "客户端已取消本轮，未写入轮次。" });
      reply.raw.end();
      return;
    }

    // Stream path: guard applies to final persisted text (deltas may already have gone out).
    const { text: guardedContent } = guardAssistantText(
      assistantResult.content,
      session.id,
      "stream"
    );

    const built = receiveUserTurnWithAssistant(session, content, {
      content: guardedContent,
      intent: assistantResult.intent,
      strategyDecision,
      ...(strategyDecision.referencedMemory
        ? { referencedMemory: strategyDecision.referencedMemory }
        : {})
    });
    const nextSession = stripAsidesFromLatestAssistantTurn({
      ...built,
      interactionPreSignals: assistantResult.preSignals
    });
    const lastAssistant = [...nextSession.turns].reverse().find((x) => x.role === "assistant");
    const baseNextState = {
      ...state,
      sessions: state.sessions.map((s) => (s.id === session.id ? nextSession : s)),
      revision: state.revision
    };
    const persisted = await replaceStateDurable(repository, baseNextState);
    writeEvent("final", {
      session: nextSession,
      state: persisted,
      assistantText: lastAssistant?.content ?? guardedContent,
      prosody: lastAssistant?.prosody,
      ...(assistantResult.preSignals ? { preSignals: assistantResult.preSignals } : {})
    });
    reply.raw.end();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(JSON.stringify({ event: "llm_failed", capability: "interview_turn_stream", error: message }));
    try {
      writeEvent("error", { error: `追问生成失败：${message}` });
    } catch {
      /* ignore */
    }
    reply.raw.end();
  } finally {
    request.raw.off("aborted", onAbort);
  }
}

/**
 * Unified entry name from CFC design. Routes pick the mode; both paths are brain-owned.
 * - mode "json"  → handleTurnsRequest  (POST /turns)
 * - mode "stream" → handleTurnsStreamRequest (POST /turns/stream)
 */
export async function runInterviewerBrainTurn(
  mode: "json" | "stream",
  request: FastifyRequest,
  reply: FastifyReply,
  deps: InterviewerBrainDeps
): Promise<unknown> {
  if (mode === "stream") {
    return handleTurnsStreamRequest(request, reply, deps);
  }
  return handleTurnsRequest(request, reply, deps);
}
