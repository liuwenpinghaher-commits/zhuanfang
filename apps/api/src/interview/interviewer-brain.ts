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
  appendUserTurnOnly,
  applyTurnPatch,
  buildInterviewEnginePolicy,
  buildInterviewGuide,
  decideInterviewStrategy
} from "../../../../src/domain/engine";
import {
  applyCraftOutputGuard,
  buildCraftMetaFromGuardResult,
  type CraftOutputGuardResult
} from "../../../../src/domain/craft-output-guard";
import type {
  InteractionPreSignals,
  InterviewSession,
  InterviewStrategyDecision,
  ProductState
} from "../../../../src/domain/types";
import { nowIso } from "../../../../src/domain/utils";
import {
  applyMidSessionCardRefresh,
  buildInterviewContextPack,
  resolveInterviewTopicHint,
  resolveMidSessionRecallTopic
} from "../../../../src/domain/context-pack";
import type { ProductStateRepository } from "../product-state-repository";
import { runStateCommand } from "../state-command";
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
  /** Required once /turns is write-gate exempt: CAS commit re-enters the slot. */
  writeGate?: { runExclusive<T>(label: string, fn: () => Promise<T> | T): Promise<T> };
}

type InFlightStreamTurn = {
  abort: AbortController;
  cancelled: boolean;
  accumulated: string;
};

const inFlightBySession = new Map<string, InFlightStreamTurn>();

type AssistantPersistInput = {
  content: string;
  intent: string;
  referencedMemory?: string;
  strategyDecision?: InterviewStrategyDecision;
  preSignals?: InteractionPreSignals;
  enginePolicy?: InterviewSession["enginePolicy"];
  guide?: InterviewSession["guide"];
  card?: InterviewSession["card"];
  recalledTexts?: Set<string>;
};

function stampRecency(state: ProductState, recalledTexts: Set<string>): ProductState {
  if (recalledTexts.size === 0) return state;
  return {
    ...state,
    memoryRecords: state.memoryRecords.map((record) =>
      record.status === "confirmed" && recalledTexts.has(record.text)
        ? { ...record, lastAccessedAt: nowIso() }
        : record
    )
  };
}

async function persistUserTurn(
  deps: InterviewerBrainDeps,
  sessionId: string,
  content: string
): Promise<{ userTurnId: string; session: InterviewSession } | null> {
  let captured: { userTurnId: string; session: InterviewSession } | null = null;
  await runStateCommand(
    deps.repository,
    (latest) => {
      captured = null;
      const current = findSession(latest, sessionId);
      if (!current || current.status !== "active") return null;
      const nextSession = appendUserTurnOnly(current, content);
      const last = nextSession.turns.at(-1);
      if (!last || last.role !== "user") return null;
      captured = { userTurnId: last.id, session: nextSession };
      if (nextSession === current) return null;
      return upsertSession(latest, nextSession);
    },
    { writeGate: deps.writeGate, label: `command:turns-user:${sessionId}` }
  );
  return captured;
}

async function persistAssistantTurn(
  deps: InterviewerBrainDeps,
  sessionId: string,
  input: AssistantPersistInput
): Promise<{ session: InterviewSession; state: ProductState } | null> {
  let captured: InterviewSession | null = null;
  const state = await runStateCommand(
    deps.repository,
    (latest) => {
      captured = null;
      const current = findSession(latest, sessionId);
      if (!current || current.status !== "active") return null;
      let nextSession = applyTurnPatch(current, {
        assistant: {
          content: input.content,
          intent: input.intent,
          ...(input.referencedMemory ? { referencedMemory: input.referencedMemory } : {}),
          ...(input.strategyDecision ? { strategyDecision: input.strategyDecision } : {})
        }
      });
      nextSession = stripAsidesFromLatestAssistantTurn(nextSession);
      nextSession = {
        ...nextSession,
        ...(input.enginePolicy ? { enginePolicy: input.enginePolicy } : {}),
        ...(input.guide ? { guide: input.guide } : {}),
        ...(input.card ? { card: input.card } : {}),
        ...(input.preSignals ? { interactionPreSignals: input.preSignals } : {})
      };
      captured = nextSession;
      const base = upsertSession(latest, nextSession);
      return input.recalledTexts && input.recalledTexts.size > 0
        ? stampRecency(base, input.recalledTexts)
        : base;
    },
    { writeGate: deps.writeGate, label: `command:turns-assistant:${sessionId}` }
  );
  if (!captured || !state) return null;
  return { session: captured, state };
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
    console.warn(JSON.stringify({ event: "session_turn_embed_failed", error: message, degraded: "frozen_guide" }));
    turnEmbedding = undefined;
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
      console.warn(JSON.stringify({ event: "session_turn_recall_failed", error: message, degraded: "frozen_guide" }));
      turnRecall = undefined;
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
  // 503/429 在落用户句之前返回。过了这道门后用户句先入书；主持句失败或取消时用户句保留。
  if (!deps.bailianInterviewClient) {
    return reply.code(503).send({ error: "专访追问 LLM 未配置（缺少 DASHSCOPE_API_KEY），无法生成追问。" });
  }
  if (!budget.tryConsume(freshSession.id)) {
    console.warn(JSON.stringify({ event: "llm_budget_exceeded", capability: "interview_turn", sessionId: freshSession.id }));
    return reply.code(429).send({ error: "本会话 LLM 预算已用尽，追问暂不可用，请稍后重试。" });
  }

  const userPersist = await persistUserTurn(deps, freshSession.id, content);
  if (!userPersist) {
    return reply.code(409).send({ error: "会话已结束，无法追加轮次。" });
  }

  // Barge used to abort the fetch and drop the guest sentence. User is already in the
  // book; abort still skips the host follow-up (no ghost full turn).
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
    return reply.code(502).send({ error: `追问生成失败：${message}。用户句已记录，主持句未写入，请重试。` });
  }
  request.raw.off("aborted", onClientAbort);
  if (clientAborted) {
    console.info(JSON.stringify({
      event: "interview_turn_aborted_user_kept",
      sessionId: freshSession.id,
      userTurnId: userPersist.userTurnId,
      reason: "client_disconnect_or_abort"
    }));
    return reply.code(499).send({ error: "客户端已取消本轮，主持句未写入。" });
  }
  const { nextSession: rawNextSession, preSignals } = updatedResult;
  const guardedSession = applyGuardToLatestAssistantTurn(rawNextSession, freshSession.id, "json");
  const lastAssistant = [...guardedSession.turns].reverse().find((turn) => turn.role === "assistant");
  if (!lastAssistant) {
    return reply.code(502).send({ error: "追问生成失败：主持句为空。本轮用户句已记录，请重试。" });
  }
  const recalledTexts = new Set(refreshedGuide.relevantMemories ?? []);
  const persisted = await persistAssistantTurn(deps, freshSession.id, {
    content: lastAssistant.content,
    intent: lastAssistant.intent,
    referencedMemory: lastAssistant.referencedMemory,
    strategyDecision: guardedSession.strategyTrace?.at(-1),
    preSignals,
    enginePolicy,
    guide: refreshedGuide,
    card: refreshedCard,
    recalledTexts
  });
  if (!persisted) {
    return reply.code(409).send({ error: "会话已结束，无法追加主持句。" });
  }
  return { session: persisted.session, state: persisted.state, ...(preSignals ? { preSignals } : {}) };
}

/**
 * Streaming turn for cascade voice TTFA (POST /turns/stream).
 * SSE events: user_persisted → delta* → final | aborted | error.
 * Guest sentence is CAS-persisted before the host LLM. Cancel does not tear the SSE.
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

  const userPersist = await persistUserTurn(deps, session.id, content);
  if (!userPersist) {
    return reply.code(409).send({ error: "会话已结束，无法追加轮次。" });
  }

  const flight: InFlightStreamTurn = {
    abort: new AbortController(),
    cancelled: false,
    accumulated: ""
  };
  inFlightBySession.set(session.id, flight);

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
  writeEvent("user_persisted", { userTurnId: userPersist.userTurnId });

  let clientAborted = false;
  const onAbort = () => {
    clientAborted = true;
    flight.abort.abort();
  };
  request.raw.once("aborted", onAbort);

  const finishAborted = async (assistantTurnId?: string) => {
    writeEvent("aborted", assistantTurnId ? { assistantTurnId } : {});
    reply.raw.end();
  };

  try {
    const strategyDecision = decideInterviewStrategy(session, content);
    const streamFn = deps.bailianInterviewClient.createAssistantTurnStream;
    let assistantResult: Awaited<ReturnType<NonNullable<typeof deps.bailianInterviewClient>["createAssistantTurn"]>> | undefined;
    let preSignals: InteractionPreSignals | undefined;

    if (streamFn) {
      try {
        for await (const ev of streamFn.call(deps.bailianInterviewClient, {
          session,
          userText: content,
          corrections: state.memoryCorrections,
          boundaries: state.profile.explicitBoundaries,
          strategyDecision,
          signal: flight.abort.signal
        })) {
          if (flight.cancelled || clientAborted) break;
          if (ev.type === "delta") {
            flight.accumulated += ev.text;
            writeEvent("delta", { text: ev.text });
          } else {
            assistantResult = ev.result;
            preSignals = ev.result.preSignals;
          }
        }
      } catch (error) {
        if (!flight.cancelled && !clientAborted && !flight.abort.signal.aborted) {
          throw error;
        }
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
      if (assistantResult.content) {
        flight.accumulated = assistantResult.content;
        writeEvent("delta", { text: assistantResult.content });
      }
    }

    if (flight.cancelled || clientAborted) {
      const spoken = flight.accumulated.trim();
      if (!spoken) {
        await finishAborted();
        return;
      }
      const { text: guardedContent } = guardAssistantText(spoken, session.id, "stream");
      const persisted = await persistAssistantTurn(deps, session.id, {
        content: guardedContent,
        intent: assistantResult?.intent ?? "百炼角色扮演追问",
        referencedMemory: strategyDecision.referencedMemory,
        strategyDecision,
        preSignals: assistantResult?.preSignals ?? preSignals
      });
      const assistantTurnId = persisted
        ? [...persisted.session.turns].reverse().find((turn) => turn.role === "assistant")?.id
        : undefined;
      await finishAborted(assistantTurnId);
      return;
    }

    if (assistantResult === undefined) {
      writeEvent("error", { error: "追问生成失败：主持句为空。用户句已记录。" });
      reply.raw.end();
      return;
    }

    const { text: guardedContent } = guardAssistantText(
      assistantResult.content,
      session.id,
      "stream"
    );
    const persisted = await persistAssistantTurn(deps, session.id, {
      content: guardedContent,
      intent: assistantResult.intent,
      referencedMemory: strategyDecision.referencedMemory,
      strategyDecision,
      preSignals: assistantResult.preSignals
    });
    if (!persisted) {
      writeEvent("error", { error: "会话已结束，无法追加主持句。" });
      reply.raw.end();
      return;
    }
    const lastAssistant = [...persisted.session.turns].reverse().find((x) => x.role === "assistant");
    writeEvent("final", {
      session: persisted.session,
      state: persisted.state,
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
    inFlightBySession.delete(session.id);
  }
}

export async function handleTurnsCancelRequest(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<unknown> {
  const sessionId = getSessionId(request.params);
  if (!sessionId) {
    return reply.code(400).send({ error: "sessionId is required." });
  }
  const flight = inFlightBySession.get(sessionId);
  if (!flight) {
    return reply.code(409).send({ error: "没有进行中的追问可取消。" });
  }
  flight.cancelled = true;
  flight.abort.abort();
  return { ok: true };
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
