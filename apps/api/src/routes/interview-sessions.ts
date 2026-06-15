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
  ProductState
} from "../../../../src/domain/types";
import { finalizeSessionWithLlm } from "../intelligence/finalize-llm";
import type { ProductStateRepository } from "../product-state-repository";
import type { BailianChatClient, BailianCharacterInterviewClient } from "../providers/bailian";

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
  server.post("/api/interview-sessions", async (request) => {
    const state = repository.getState();
    const payload = normalizeObject<CreateSessionPayload>(request.body);
    const session = createSessionDraft(state, normalizeMode(payload.mode), normalizeStrength(payload.strength, state), {
      searchBriefId: normalizeOptionalString(payload.searchBriefId)
    });
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

    const updatedSession = await receiveTurn(session, content, options.bailianInterviewClient);
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
    return { session: completedSession, note: result.note, state: result.nextState };
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
      console.warn("[finalize] LLM synthesis failed, falling back to deterministic:", error instanceof Error ? error.message : error);
    }
  }
  return finalizeSession(state, session);
}

async function receiveTurn(
  session: InterviewSession,
  content: string,
  bailianInterviewClient: BailianCharacterInterviewClient | undefined
): Promise<{ nextSession: InterviewSession; preSignals?: import("../../../../src/domain/types").InteractionPreSignals }> {
  if (!bailianInterviewClient) {
    return { nextSession: receiveUserTurn(session, content) };
  }

  try {
    const assistant = await bailianInterviewClient.createAssistantTurn({ session, userText: content });
    const nextSession = receiveUserTurnWithAssistant(session, content, {
      content: assistant.content,
      intent: assistant.intent
    });
    return { nextSession: { ...nextSession, interactionPreSignals: assistant.preSignals }, preSignals: assistant.preSignals };
  } catch {
    return { nextSession: receiveUserTurn(session, content) };
  }
}
