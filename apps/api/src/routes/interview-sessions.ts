import type { FastifyInstance } from "fastify";
import {
  buildInterviewEnginePolicy,
  buildInterviewGuide,
  createSessionDraft,
  decideInterviewStrategy,
  finalizeSession,
  receiveUserTurn,
  receiveUserTurnWithAssistant,
  updateInterviewControl
} from "../../../../src/domain/engine";
import type {
  FinalizeResult,
  InterviewControlAction,
  InterviewMode,
  InterviewSession,
  InterviewStrength,
  InterviewTurn,
  MemoryCandidate,
  MemoryCorrection,
  ProductState
} from "../../../../src/domain/types";
import { makeId, nowIso, withAuditEvent } from "../../../../src/domain/utils";
import { buildRealtimeVoiceInstructions } from "../../../../src/domain/voice-instructions";
import { finalizeSessionWithLlm } from "../intelligence/finalize-llm";
import { extractCandidateMemories, toSessionMemoryCandidates } from "../intelligence/memory-extraction-llm";
import { generatePreSignals } from "../intelligence/pre-signals-llm";
import { classifyTurnComplete } from "../intelligence/turn-endpoint-llm";
import type { ProductStateRepository } from "../product-state-repository";
import type { BailianChatClient, BailianCharacterInterviewClient, BailianEmbeddingClient } from "../providers/bailian";
import { createLlmBudget, type LlmBudget } from "../llm-budget";

interface CreateSessionPayload {
  mode?: unknown;
  strength?: unknown;
  searchBriefId?: unknown;
  topicHint?: unknown;
}

interface TurnPayload {
  content?: unknown;
}

interface ControlPayload {
  action?: unknown;
}

interface InterviewSessionRouteOptions {
  bailianInterviewClient?: BailianCharacterInterviewClient;
  bailianChatClient?: BailianChatClient;
  embeddingClient?: BailianEmbeddingClient;
  llmBudget?: LlmBudget;
}

const interviewModes: InterviewMode[] = ["daily", "decision", "point", "learning", "organization", "long-term"];
const interviewStrengths: InterviewStrength[] = ["gentle", "standard", "sharp"];
const controlActions: InterviewControlAction[] = [
  "skip",
  "softer",
  "sharper",
  "different-angle",
  "summary",
  "do-not-save"
];

export async function registerInterviewSessionRoutes(
  server: FastifyInstance,
  repository: ProductStateRepository,
  options: InterviewSessionRouteOptions = {}
) {
  const budget = options.llmBudget ?? createLlmBudget();

  server.post("/api/interview-sessions", async (request) => {
    const state = repository.getState();
    const payload = normalizeObject<CreateSessionPayload>(request.body);
    const topicHint = normalizeOptionalString(payload.topicHint);
    // M3c: embed the topic that drives memory recall so the new session's guide
    // (buildInterviewGuide → collectRelevantMemories) ranks confirmed memories by
    // cosine instead of substring. Mirrors buildInterviewContextPack's topicHint
    // default so the query vector and the recall corpus stay aligned. Fail-safe:
    // no client / embed error → undefined → keyword recall (unchanged behaviour).
    const recallTopic = topicHint || state.themes[0]?.name || state.profile.currentFocus;
    const queryEmbedding = await embedQueryText(recallTopic, options.embeddingClient);
    const session = createSessionDraft(state, normalizeMode(payload.mode), normalizeStrength(payload.strength, state), {
      ...(payload.searchBriefId != null ? { searchBriefId: normalizeOptionalString(payload.searchBriefId) } : {}),
      ...(topicHint ? { topicHint } : {}),
      ...(queryEmbedding ? { queryEmbedding } : {})
    });
    // The deterministic card (createSessionDraft → buildInterviewCard) is already
    // de-hardcoded/personalized, so "开始专访" returns instantly. The LLM card
    // enrichment used to block here ~5s on a live call; moved off the create
    // critical path for responsiveness. The diary still uses real LLM at /end.
    const nextState = upsertSession(state, session);

    repository.replaceState(nextState);
    return { session, state: nextState };
  });

  server.get("/api/interview-sessions/:id", async (request, reply) => {
    const session = findSession(repository.getState(), getSessionId(request.params));
    if (!session) {
      return reply.code(404).send({ error: "Interview session not found." });
    }
    return { session };
  });

  server.post("/api/interview-sessions/:id/turns", async (request, reply) => {
    const state = repository.getState();
    const session = findSession(state, getSessionId(request.params));
    if (!session) {
      return reply.code(404).send({ error: "Interview session not found." });
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
    const turnEmbedding = await embedQueryText(content, options.embeddingClient);
    const refreshedGuide = turnEmbedding
      ? buildInterviewGuide(state, {
          topicHint: session.guide.topicHint || undefined,
          ...(session.card.searchBriefId ? { searchBriefId: session.card.searchBriefId } : {}),
          queryEmbedding: turnEmbedding
        })
      : session.guide;
    const freshSession: InterviewSession = { ...session, enginePolicy, guide: refreshedGuide };

    const allowLlm = !!options.bailianInterviewClient && budget.tryConsume(freshSession.id);
    if (!!options.bailianInterviewClient && !allowLlm) {
      console.warn(JSON.stringify({ event: "llm_budget_exceeded", capability: "interview_turn", sessionId: freshSession.id }));
    }
    const updatedSession = await receiveTurn(
      freshSession,
      content,
      allowLlm ? options.bailianInterviewClient : undefined,
      state.memoryCorrections
    );
    const { nextSession, preSignals } = updatedSession;
    const nextState = upsertSession(state, nextSession);

    repository.replaceState(nextState);
    return { session: nextSession, state: nextState, ...(preSignals ? { preSignals } : {}) };
  });

  server.post("/api/interview-sessions/:id/control", async (request, reply) => {
    const state = repository.getState();
    const session = findSession(state, getSessionId(request.params));
    if (!session) {
      return reply.code(404).send({ error: "Interview session not found." });
    }

    const action = normalizeControlAction(normalizeObject<ControlPayload>(request.body).action);
    if (!action) {
      return reply.code(422).send({ error: "Valid control action is required." });
    }

    const updatedSession = updateInterviewControl(session, action);
    const nextState = upsertSession(state, updatedSession);

    repository.replaceState(nextState);
    return { session: updatedSession, state: nextState };
  });

  server.post("/api/interview-sessions/:id/end", async (request, reply) => {
    const state = repository.getState();
    const session = findSession(state, getSessionId(request.params));
    if (!session) {
      return reply.code(404).send({ error: "Interview session not found." });
    }
    if (session.turns.filter((turn) => turn.role === "user").length === 0) {
      return reply.code(422).send({ error: "Interview session cannot be ended before the first user turn." });
    }

    const baseState = {
      ...state,
      sessions: state.sessions.filter((item) => item.id !== session.id)
    };
    // M1b: when an LLM is available, extract real long-term memory candidates from
    // the conversation and hand them to finalize (replacing the heuristic template
    // candidate). On budget exhaustion / extraction failure we pass nothing and
    // mergeFinalizedState falls back to the Task-1 session heuristic.
    const providedCandidates = await extractSessionMemoryCandidates(session, options.bailianChatClient, budget);
    const result = await finalizeInterview(baseState, session, options.bailianChatClient, providedCandidates);
    const completedSession = result.nextState.sessions.find((item) => item.id === session.id) ?? session;

    repository.replaceState(result.nextState);
    budget.reset(session.id);
    return { session: completedSession, note: result.note, state: result.nextState };
  });

  // Voice path: generate interaction pre_signals for the next turn on demand
  // (the realtime voice model, unlike the character model, doesn't emit them).
  server.post("/api/interview-sessions/:id/pre-signals", async (request, reply) => {
    const state = repository.getState();
    const session = findSession(state, getSessionId(request.params));
    if (!session) {
      return reply.code(404).send({ error: "Interview session not found." });
    }
    if (!options.bailianChatClient) {
      return reply.code(503).send({ error: "Chat client is not configured." });
    }
    if (!budget.tryConsume(session.id)) {
      console.warn(JSON.stringify({ event: "llm_budget_exceeded", capability: "pre_signals", sessionId: session.id }));
      return { preSignals: null, session };
    }
    try {
      const preSignals = await generatePreSignals(session, options.bailianChatClient);
      const updatedSession: InterviewSession = { ...session, interactionPreSignals: preSignals };
      repository.replaceState(upsertSession(state, updatedSession));
      return { preSignals, session: updatedSession };
    } catch (error) {
      return reply.code(502).send({ error: error instanceof Error ? error.message : "pre_signals generation failed." });
    }
  });

  // Layer 2 endpoint: is the user done speaking? (cascade calls this only on
  // an "ambiguous" heuristic verdict.) Fails safe to done=true (respond).
  server.post("/api/interview-sessions/:id/turn-complete", async (request, reply) => {
    const state = repository.getState();
    const session = findSession(state, getSessionId(request.params));
    if (!session) {
      return reply.code(404).send({ error: "Interview session not found." });
    }
    const transcript = normalizeOptionalString(
      normalizeObject<{ transcript?: unknown }>(request.body).transcript
    );
    if (!transcript) {
      return reply.code(422).send({ error: "transcript is required." });
    }
    if (!options.bailianChatClient) {
      return { done: true, reason: "no chat client → default respond" };
    }
    const result = await classifyTurnComplete(session, transcript, options.bailianChatClient);
    console.info(JSON.stringify({
      event: "cascade_turn_complete", sessionId: session.id,
      done: result.done, reason: result.reason, transcript: transcript.slice(0, 80)
    }));
    return result;
  });

  // Decision audit (G3): the cascade fire-and-forgets its turn decisions here so
  // they show up in the server log the operator greps. Best-effort, never errors.
  server.post("/api/interview-sessions/:id/decisions", async (request) => {
    const sessionId = getSessionId(request.params);
    const body = normalizeObject<{
      layer?: unknown;
      action?: unknown;
      reason?: unknown;
      silenceMs?: unknown;
      expressionState?: unknown;
      transcript?: unknown;
    }>(request.body);
    const action = typeof body.action === "string" ? body.action : String(body.action ?? "");
    const reason = typeof body.reason === "string" ? body.reason : String(body.reason ?? "");
    const layer = body.layer != null ? String(body.layer) : undefined;
    const silenceMs = body.silenceMs != null ? String(body.silenceMs) : undefined;
    const expressionState = typeof body.expressionState === "string" ? body.expressionState : undefined;
    const transcript = typeof body.transcript === "string" ? body.transcript.slice(0, 80) : undefined;

    const detail = [
      action,
      reason,
      layer != null ? `layer=${layer}` : undefined,
      silenceMs != null ? `silenceMs=${silenceMs}` : undefined,
      expressionState != null ? `expr=${expressionState}` : undefined,
      transcript != null ? `transcript=${transcript}` : undefined
    ].filter(Boolean).join(" | ");

    const createdAt = nowIso();
    const state = repository.getState();
    const nextState = withAuditEvent(state, {
      type: "cascade_decision_logged",
      label: "级联决策已记录",
      detail,
      severity: "info",
      entityType: "interview_session",
      entityId: sessionId ?? "",
      createdAt
    });
    repository.replaceState(nextState);

    return { ok: true };
  });

  // Voice path: persist a turn (user or assistant) from the client to the server
  // session WITHOUT triggering LLM assistant generation. Used so the server
  // session stays authoritative even when the voice path handles the dialogue.
  server.post("/api/interview-sessions/:id/record-turn", async (request, reply) => {
    const state = repository.getState();
    const session = findSession(state, getSessionId(request.params));
    if (!session) {
      return reply.code(404).send({ error: "Interview session not found." });
    }
    const body = normalizeObject<{ role?: unknown; content?: unknown }>(request.body);
    const content = normalizeOptionalString(body.content);
    if (!content) {
      return reply.code(422).send({ error: "content is required." });
    }
    const role: "user" | "assistant" = body.role === "assistant" ? "assistant" : "user";
    const turn: InterviewTurn = {
      id: makeId("turn"),
      role,
      content,
      intent: role === "user" ? "语音用户输入" : "语音助手回应",
      timestamp: nowIso()
    };
    const nextSession = { ...session, turns: [...session.turns, turn] };
    const nextState = upsertSession(state, nextSession);
    repository.replaceState(nextState);
    return { session: nextSession, state: nextState };
  });

  // 🔴-1: omni (bailian WS/WebRTC) voice path — refresh the realtime model's
  // instructions per user turn. The realtime session sets `instructions` ONCE at
  // session open (an opening-time recall snapshot) and the omni model can't recompute
  // recall itself, so as the topic drifts its memory recall goes stale. The client
  // calls this after each final user transcript with the freshest utterance; we
  // re-embed it, rebuild the guide's memory recall (same path as /turns — cosine over
  // confirmed memories), and re-render the voice instruction string. The client then
  // pushes it via connection.updateInstructions → session.update.
  //
  // Read-only: this never mutates the session/state — it only computes and returns a
  // string. Fail-safe: no embeddingClient / empty text / embed error → fall back to
  // the existing session.guide (instructions unchanged, never crashes).
  server.post("/api/interview-sessions/:id/voice-instructions", async (request, reply) => {
    const state = repository.getState();
    const session = findSession(state, getSessionId(request.params));
    if (!session) {
      return reply.code(404).send({ error: "Interview session not found." });
    }
    const latestUserText = normalizeOptionalString(
      normalizeObject<{ latestUserText?: unknown }>(request.body).latestUserText
    );

    const queryEmbedding = await embedQueryText(latestUserText, options.embeddingClient);
    const refreshedGuide = queryEmbedding
      ? buildInterviewGuide(state, {
          topicHint: session.guide.topicHint || undefined,
          ...(session.card.searchBriefId ? { searchBriefId: session.card.searchBriefId } : {}),
          queryEmbedding
        })
      : session.guide;
    const refreshedSession: InterviewSession = { ...session, guide: refreshedGuide };

    const instructions = buildRealtimeVoiceInstructions(
      refreshedSession,
      session.card,
      state.memoryCorrections
    );
    return { instructions };
  });
}

// M3c: embed a query string (create-time topic or a turn's user text) for semantic
// memory recall. Fail-safe — returns undefined on no client / empty text / embed
// error, so the interview line silently degrades to keyword recall (unchanged
// behaviour). Embeddings are computed here (route layer); the domain stays pure.
async function embedQueryText(
  text: string | undefined,
  embeddingClient: BailianEmbeddingClient | undefined
): Promise<number[] | undefined> {
  const trimmed = text?.trim();
  if (!embeddingClient || !trimmed) {
    return undefined;
  }
  try {
    const vectors = await embeddingClient.embed([trimmed]);
    const vector = vectors[0];
    return Array.isArray(vector) && vector.length > 0 ? vector : undefined;
  } catch (error) {
    console.warn(
      JSON.stringify({ event: "interview_query_embed_failed", error: error instanceof Error ? error.message : String(error) })
    );
    return undefined;
  }
}

function normalizeObject<T>(value: unknown): Partial<T> {
  return value && typeof value === "object" ? (value as Partial<T>) : {};
}

function normalizeMode(value: unknown): InterviewMode {
  return interviewModes.includes(value as InterviewMode) ? (value as InterviewMode) : "daily";
}

function normalizeStrength(value: unknown, state: ProductState): InterviewStrength {
  return interviewStrengths.includes(value as InterviewStrength) ? (value as InterviewStrength) : state.profile.preferredStrength;
}

function normalizeControlAction(value: unknown): InterviewControlAction | undefined {
  return controlActions.includes(value as InterviewControlAction) ? (value as InterviewControlAction) : undefined;
}

function normalizeOptionalString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function getSessionId(params: unknown) {
  return normalizeObject<{ id: string }>(params).id;
}

function findSession(state: ProductState, sessionId: unknown) {
  return typeof sessionId === "string" ? state.sessions.find((session) => session.id === sessionId) : undefined;
}

function upsertSession(state: ProductState, session: InterviewSession): ProductState {
  return {
    ...state,
    sessions: [session, ...state.sessions.filter((item) => item.id !== session.id)]
  };
}

async function finalizeInterview(
  state: ProductState,
  session: InterviewSession,
  chatClient: BailianChatClient | undefined,
  providedCandidates?: MemoryCandidate[]
): Promise<FinalizeResult> {
  if (chatClient) {
    try {
      return await finalizeSessionWithLlm(state, session, chatClient, providedCandidates);
    } catch (error) {
      console.warn(JSON.stringify({ event: "llm_fallback", capability: "finalize", error: error instanceof Error ? error.message : String(error) }));
    }
  }
  return finalizeSession(state, session, providedCandidates);
}

// M1b: LLM extraction of long-term memory candidates from the actual conversation,
// converted into session-sourced reviewable candidates. Budget-gated and fully
// fail-safe: any miss (no client / budget exhausted / extraction error / empty
// result) returns undefined so finalize falls back to the deterministic heuristic.
async function extractSessionMemoryCandidates(
  session: InterviewSession,
  chatClient: BailianChatClient | undefined,
  budget: LlmBudget
): Promise<MemoryCandidate[] | undefined> {
  if (!chatClient) {
    return undefined;
  }
  if (!budget.tryConsume(session.id)) {
    console.warn(JSON.stringify({ event: "llm_budget_exceeded", capability: "memory_extraction", sessionId: session.id }));
    return undefined;
  }
  const transcript = buildSessionTranscript(session);
  if (!transcript.trim()) {
    return undefined;
  }
  try {
    const extracted = await extractCandidateMemories(session.title, transcript, chatClient);
    if (extracted.length === 0) {
      return undefined;
    }
    return toSessionMemoryCandidates(extracted, session.id, session.title, nowIso());
  } catch (error) {
    console.warn(JSON.stringify({
      event: "memory_extraction_fallback",
      sessionId: session.id,
      error: error instanceof Error ? error.message : String(error)
    }));
    return undefined;
  }
}

// Join the conversation into a 用户/主持人 transcript (same shape finalize-llm uses),
// capped to the last 60 turns so the extraction prompt stays bounded.
function buildSessionTranscript(session: InterviewSession): string {
  return session.turns
    .slice(-60)
    .map((turn) => `${turn.role === "user" ? "用户" : "主持人"}：${turn.content}`)
    .join("\n");
}

async function receiveTurn(
  session: InterviewSession,
  content: string,
  bailianInterviewClient: BailianCharacterInterviewClient | undefined,
  corrections: MemoryCorrection[] = []
): Promise<{ nextSession: InterviewSession; preSignals?: import("../../../../src/domain/types").InteractionPreSignals }> {
  if (!bailianInterviewClient) {
    return { nextSession: receiveUserTurn(session, content) };
  }

  // Strategy engine decides this turn's action; injected into the LLM prompt AND
  // backfilled onto the assistant turn so strategyTrace / turn.strategy / the technique
  // badge / quality-report all have real data on the live path (not just offline).
  const strategyDecision = decideInterviewStrategy(session, content);
  try {
    const assistant = await bailianInterviewClient.createAssistantTurn({ session, userText: content, corrections, strategyDecision });
    const nextSession = receiveUserTurnWithAssistant(session, content, {
      content: assistant.content,
      intent: assistant.intent,
      strategyDecision
    });
    return { nextSession: { ...nextSession, interactionPreSignals: assistant.preSignals }, preSignals: assistant.preSignals };
  } catch (error) {
    // Honest degrade signal — LLM turn failed, falling back to the deterministic engine.
    console.warn(JSON.stringify({ event: "llm_fallback", capability: "interview_turn", error: error instanceof Error ? error.message : String(error) }));
    return { nextSession: receiveUserTurn(session, content) };
  }
}
