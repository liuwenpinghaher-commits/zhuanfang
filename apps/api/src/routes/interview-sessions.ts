import type { FastifyInstance } from "fastify";
import {
  createSessionDraft,
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
  MemoryCorrection,
  ProductState
} from "../../../../src/domain/types";
import { makeId, nowIso, withAuditEvent } from "../../../../src/domain/utils";
import { finalizeSessionWithLlm } from "../intelligence/finalize-llm";
import { generatePreSignals } from "../intelligence/pre-signals-llm";
import { classifyTurnComplete } from "../intelligence/turn-endpoint-llm";
import type { ProductStateRepository } from "../product-state-repository";
import type { BailianChatClient, BailianCharacterInterviewClient } from "../providers/bailian";
import { createLlmBudget, type LlmBudget } from "../llm-budget";

interface CreateSessionPayload {
  mode?: unknown;
  strength?: unknown;
  searchBriefId?: unknown;
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
    const session = createSessionDraft(state, normalizeMode(payload.mode), normalizeStrength(payload.strength, state), {
      searchBriefId: normalizeOptionalString(payload.searchBriefId)
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

    const allowLlm = !!options.bailianInterviewClient && budget.tryConsume(session.id);
    if (!!options.bailianInterviewClient && !allowLlm) {
      console.warn(JSON.stringify({ event: "llm_budget_exceeded", capability: "interview_turn", sessionId: session.id }));
    }
    const updatedSession = await receiveTurn(
      session,
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
    const result = await finalizeInterview(baseState, session, options.bailianChatClient);
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
  chatClient: BailianChatClient | undefined
): Promise<FinalizeResult> {
  if (chatClient) {
    try {
      return await finalizeSessionWithLlm(state, session, chatClient);
    } catch (error) {
      console.warn(JSON.stringify({ event: "llm_fallback", capability: "finalize", error: error instanceof Error ? error.message : String(error) }));
    }
  }
  return finalizeSession(state, session);
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

  try {
    const assistant = await bailianInterviewClient.createAssistantTurn({ session, userText: content, corrections });
    const nextSession = receiveUserTurnWithAssistant(session, content, {
      content: assistant.content,
      intent: assistant.intent
    });
    return { nextSession: { ...nextSession, interactionPreSignals: assistant.preSignals }, preSignals: assistant.preSignals };
  } catch {
    return { nextSession: receiveUserTurn(session, content) };
  }
}
