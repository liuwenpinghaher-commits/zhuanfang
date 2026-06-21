import type { FastifyInstance } from "fastify";
import {
  buildFallbackPreSignals,
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
import { makeId, nowIso, withAiRunEvent, withAuditEvent } from "../../../../src/domain/utils";
import { stripSpokenAsides, deriveSpeechProsody } from "../../../../src/domain/speech-text";
import { buildRealtimeVoiceInstructions } from "../../../../src/domain/voice-instructions";
import { finalizeSessionWithLlm } from "../intelligence/finalize-llm";
import { extractCandidateMemories, toSessionMemoryCandidates } from "../intelligence/memory-extraction-llm";
import { generatePreSignals } from "../intelligence/pre-signals-llm";
import { classifyTurnComplete } from "../intelligence/turn-endpoint-llm";
import type { ProductStateRepository } from "../product-state-repository";
import type { RawMaterialRepository } from "../raw-material-repository";
import type { BailianChatClient, BailianCharacterInterviewClient, BailianEmbeddingClient } from "../providers/bailian";
import { createLlmBudget, type LlmBudget } from "../llm-budget";
import { offloadCompletedSession } from "./raw-material";

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
  rawMaterialRepository?: RawMaterialRepository;
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

  // Per-session write serialization. /turns is a read-modify-write on the global state with
  // an await window (embedding + LLM round-trip) in the middle, so two concurrent turns on the
  // SAME session would otherwise both read the same base snapshot and the second replaceState
  // would clobber the first — silently dropping a user turn. Chaining each session's critical
  // sections through a promise keyed by session id forces them to run one-at-a-time. The chain
  // self-evicts when it drains, so the map stays bounded (no per-session leak).
  const turnLocks = new Map<string, Promise<unknown>>();
  function runExclusive<T>(key: string, task: () => Promise<T>): Promise<T> {
    const prev = turnLocks.get(key) ?? Promise.resolve();
    const result = prev.then(task, task); // run after prev settles, success OR failure
    const chain = result.then(
      () => undefined,
      () => undefined
    );
    turnLocks.set(key, chain);
    void chain.then(() => {
      if (turnLocks.get(key) === chain) {
        turnLocks.delete(key);
      }
    });
    return result;
  }

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

  server.post("/api/interview-sessions/:id/turns", (request, reply) =>
    runExclusive(getSessionId(request.params) ?? "", async () => {
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
      state.memoryCorrections,
      state.profile.explicitBoundaries
    );
    const { nextSession: rawNextSession, preSignals, degradedReason } = updatedSession;
    // The character model conveys manner via （…）stage-direction asides (e.g. 「（身体微倾，
    // 表现出好奇）」). Strip them out of the stored question so the transcript / finalize / memory
    // read as clean words like a real interview; distill the manner into `prosody` so the voice
    // path can still deliver it expressively. Only the just-generated assistant turn is touched.
    const nextSession = stripAsidesFromLatestAssistantTurn(rawNextSession);
    // P1-13: when the live turn LLM degraded to the deterministic engine, record an
    // aiRunEvent(degraded) alongside the existing console.warn so transparency/quality
    // reports can see it. Folded into the same state we persist below (no extra write).
    const seedState = degradedReason
      ? withAiRunEvent(state, {
          workflow: "interview_turn_generation",
          providerId: "bailian-character",
          status: "degraded",
          entityType: "interview_session",
          entityId: nextSession.id,
          inputSummary: `文本专访回合降级：${content.slice(0, 60)}`,
          outputSummary: "LLM 追问失败，已回退到确定性策略引擎生成本回合。",
          degradedReason,
          createdAt: nowIso()
        })
      : state;
    const baseNextState = upsertSession(seedState, nextSession);

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

    repository.replaceState(nextState);
    return { session: nextSession, state: nextState, ...(preSignals ? { preSignals } : {}) };
    })
  );

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
    // doNotSave skips extraction entirely — mergeFinalizedState would discard the
    // candidates anyway, so spending LLM budget + a round-trip on them is pure waste.
    const providedCandidates = session.doNotSave
      ? undefined
      : await extractSessionMemoryCandidates(session, options.bailianChatClient, budget);
    const result = await finalizeInterview(baseState, session, options.bailianChatClient, providedCandidates);
    // P1-13: if the LLM diary degraded to the deterministic finalize, record an
    // aiRunEvent(degraded) on the finalized state (single write below).
    const finalizedState = result.degradedReason
      ? withAiRunEvent(result.nextState, {
          workflow: "interview_preparation",
          providerId: "bailian-chat",
          status: "degraded",
          entityType: "interview_session",
          entityId: session.id,
          inputSummary: `专访收尾归档降级：${session.title}`,
          outputSummary: "LLM 日记生成失败，已回退到确定性 finalize 生成双轨笔记与资产。",
          degradedReason: result.degradedReason,
          createdAt: nowIso()
        })
      : result.nextState;
    const completedSession = finalizedState.sessions.find((item) => item.id === session.id) ?? session;

    // Cold-storage offload: move this just-completed session's heavy evidence
    // (turns + strategyTrace) into the raw-material repository and persist only
    // the lightweight hot state. The RESPONSE must return the same light state
    // we persist — the client adopts it (adoptServerState) and its autosave
    // effect would PUT it straight back; returning the heavy finalized state
    // would re-inflate the just-offloaded turns on the next save (the 28MB-wall
    // regression). The raw material is served lazily via
    // GET /api/sessions/:id/raw-material. The end screen shows the dual-track
    // note, not the transcript, so a light state doesn't degrade it.
    let stateToPersist = finalizedState;
    if (options.rawMaterialRepository) {
      const { hotState, material } = offloadCompletedSession(finalizedState, session.id);
      if (material) {
        options.rawMaterialRepository.put(material);
        stateToPersist = hotState;
      }
    }
    // Return the light, persisted session (turns stripped, rawMaterialOffloaded),
    // not the heavy completedSession from finalizedState.
    const persistedSession = stateToPersist.sessions.find((item) => item.id === session.id) ?? completedSession;

    repository.replaceState(stateToPersist);
    budget.reset(session.id);
    return { session: persistedSession, note: result.note, state: stateToPersist };
  });

  // Voice path: generate interaction pre_signals for the next turn on demand
  // (the realtime voice model, unlike the character model, doesn't emit them).
  server.post("/api/interview-sessions/:id/pre-signals", async (request, reply) => {
    const state = repository.getState();
    const session = findSession(state, getSessionId(request.params));
    if (!session) {
      return reply.code(404).send({ error: "Interview session not found." });
    }
    // No LLM / budget exhausted → fall back to the deterministic offline engine instead of
    // erroring (it produces the same InteractionPreSignals shape). Previously this hard-503/502'd
    // and the offline buildFallbackPreSignals was a dead import.
    if (!options.bailianChatClient || !budget.tryConsume(session.id)) {
      if (!options.bailianChatClient) {
        // Steady-state offline (no key) — surfaced via /capabilities, not recorded per-turn here.
        console.warn(JSON.stringify({ event: "llm_unavailable", capability: "pre_signals", sessionId: session.id }));
        return { preSignals: buildFallbackPreSignals(session.guide), session };
      }
      // P1-13: budget exhausted while a client IS configured — a real degrade from a working
      // state, so record an aiRunEvent(degraded) (the offline result is still returned).
      console.warn(JSON.stringify({ event: "llm_budget_exceeded", capability: "pre_signals", sessionId: session.id }));
      repository.replaceState(withAiRunEvent(state, {
        workflow: "interview_turn_generation",
        providerId: "bailian-chat",
        status: "degraded",
        entityType: "interview_session",
        entityId: session.id,
        inputSummary: `语音 pre_signals 降级：${session.title}`,
        outputSummary: "per-session LLM 预算耗尽，已回退到确定性 pre_signals。",
        degradedReason: "per-session LLM budget exhausted",
        createdAt: nowIso()
      }));
      return { preSignals: buildFallbackPreSignals(session.guide), session };
    }
    try {
      const preSignals = await generatePreSignals(session, options.bailianChatClient);
      const updatedSession: InterviewSession = { ...session, interactionPreSignals: preSignals };
      repository.replaceState(upsertSession(state, updatedSession));
      return { preSignals, session: updatedSession };
    } catch (error) {
      // P1-13: LLM pre_signals failed — record an aiRunEvent(degraded) alongside the warn.
      const degradedReason = error instanceof Error ? error.message : String(error);
      console.warn(JSON.stringify({ event: "llm_fallback", capability: "pre_signals", error: degradedReason }));
      repository.replaceState(withAiRunEvent(state, {
        workflow: "interview_turn_generation",
        providerId: "bailian-chat",
        status: "degraded",
        entityType: "interview_session",
        entityId: session.id,
        inputSummary: `语音 pre_signals 降级：${session.title}`,
        outputSummary: "LLM pre_signals 生成失败，已回退到确定性 pre_signals。",
        degradedReason,
        createdAt: nowIso()
      }));
      return { preSignals: buildFallbackPreSignals(session.guide), session };
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
    // M6: mirror /turns — never append to a completed + offloaded session (cold/hot split).
    if (session.status === "completed" || session.rawMaterialOffloaded === true) {
      return reply.code(409).send({ error: "会话已结束并归档，无法追加轮次。" });
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
    // Re-stamp enginePolicy from the latest state (mirrors /turns:136) so a PlaybookPatch
    // approved mid-session actually reaches the omni voice instructions, not just guide.
    const refreshedSession: InterviewSession = {
      ...session,
      enginePolicy: buildInterviewEnginePolicy(state),
      guide: refreshedGuide
    };

    const instructions = buildRealtimeVoiceInstructions(
      refreshedSession,
      session.card,
      state.memoryCorrections,
      state.profile.explicitBoundaries
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
): Promise<FinalizeResult & { degradedReason?: string }> {
  if (chatClient) {
    try {
      return await finalizeSessionWithLlm(state, session, chatClient, providedCandidates);
    } catch (error) {
      // P1-13: capture the reason so the route records an aiRunEvent(degraded) — the LLM diary
      // failed and we're falling back to the deterministic finalize.
      const degradedReason = error instanceof Error ? error.message : String(error);
      console.warn(JSON.stringify({ event: "llm_fallback", capability: "finalize", error: degradedReason }));
      return { ...finalizeSession(state, session, providedCandidates), degradedReason };
    }
  }
  return finalizeSession(state, session, providedCandidates);
}

// M1b: LLM extraction of long-term memory candidates from the actual conversation,
// converted into session-sourced reviewable candidates. Budget-gated and fully
// fail-safe: any miss (no client / budget exhausted / extraction error / empty
// result) returns undefined so finalize falls back to the deterministic heuristic.
// Strip （…）manner asides from the most recently generated assistant turn and keep the manner
// as prosody. Touches only the last assistant turn (the one just produced); earlier turns and
// all user turns are returned unchanged. A turn whose content has no asides is left as-is.
function stripAsidesFromLatestAssistantTurn(session: InterviewSession): InterviewSession {
  const turns = session.turns;
  let lastAssistantIndex = -1;
  for (let i = turns.length - 1; i >= 0; i--) {
    if (turns[i].role === "assistant") {
      lastAssistantIndex = i;
      break;
    }
  }
  if (lastAssistantIndex === -1) {
    return session;
  }
  const turn = turns[lastAssistantIndex];
  const clean = stripSpokenAsides(turn.content);
  if (clean === turn.content) {
    return session; // no asides to strip
  }
  const prosody = deriveSpeechProsody(turn.content);
  const nextTurns = turns.slice();
  // Guard against an aside-only reply collapsing to empty — keep the original in that edge case.
  nextTurns[lastAssistantIndex] = { ...turn, content: clean || turn.content, prosody };
  return { ...session, turns: nextTurns };
}

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
  corrections: MemoryCorrection[] = [],
  boundaries: string[] = []
): Promise<{
  nextSession: InterviewSession;
  preSignals?: import("../../../../src/domain/types").InteractionPreSignals;
  degradedReason?: string;
}> {
  if (!bailianInterviewClient) {
    return { nextSession: receiveUserTurn(session, content) };
  }

  // Strategy engine decides this turn's action; injected into the LLM prompt AND
  // backfilled onto the assistant turn so strategyTrace / turn.strategy / the technique
  // badge / quality-report all have real data on the live path (not just offline).
  const strategyDecision = decideInterviewStrategy(session, content);
  try {
    const assistant = await bailianInterviewClient.createAssistantTurn({ session, userText: content, corrections, boundaries, strategyDecision });
    const nextSession = receiveUserTurnWithAssistant(session, content, {
      content: assistant.content,
      intent: assistant.intent,
      strategyDecision
    });
    return { nextSession: { ...nextSession, interactionPreSignals: assistant.preSignals }, preSignals: assistant.preSignals };
  } catch (error) {
    // Honest degrade signal — LLM turn failed, falling back to the deterministic engine.
    const degradedReason = error instanceof Error ? error.message : String(error);
    console.warn(JSON.stringify({ event: "llm_fallback", capability: "interview_turn", error: degradedReason }));
    // P1-13: surface the degrade so the route records an aiRunEvent(degraded) (caller folds
    // it into the same replaceState), making the fallback visible to transparency/quality.
    return { nextSession: receiveUserTurn(session, content), degradedReason };
  }
}
