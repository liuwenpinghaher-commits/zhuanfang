import type { FastifyInstance } from "fastify";
import {
  buildInterviewEnginePolicy,
  buildInterviewGuide,
  createSessionDraft,
  decideInterviewStrategy,
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
import { stripSpokenAsides, deriveSpeechProsody } from "../../../../src/domain/speech-text";
import { buildRealtimeVoiceInstructions } from "../../../../src/domain/voice-instructions";
import { finalizeSessionWithLlm } from "../intelligence/finalize-llm";
import { extractCandidateMemories, toSessionMemoryCandidates } from "../intelligence/memory-extraction-llm";
import { judgeCognitiveRelations } from "../intelligence/cognitive-relations-llm";
import { collectCandidatePointPairs, applyCognitiveRelations } from "../../../../src/domain/reasoning";
import { generatePreSignals } from "../intelligence/pre-signals-llm";
import { classifyTurnComplete } from "../intelligence/turn-endpoint-llm";
import type { ProductStateRepository } from "../product-state-repository";
import type { RawMaterialRepository } from "../raw-material-repository";
import type { KnowledgeIndexRepository } from "../knowledge-index-repository";
import type { BailianChatClient, BailianCharacterInterviewClient, BailianEmbeddingClient } from "../providers/bailian";
import { createLlmBudget, type LlmBudget } from "../llm-budget";
import { offloadCompletedSession } from "./raw-material";
import { reindexTranscript } from "./knowledge";
import { resolveInterviewTopicHint } from "../../../../src/domain/context-pack";
import { asNativeRecall } from "../recall/native-recall-capability";
import { prefetchRecall } from "../recall/prefetch-recall";

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
  knowledgeIndexRepository?: KnowledgeIndexRepository;
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

  server.post("/api/interview-sessions", async (request, reply) => {
    const state = repository.getState();
    const payload = normalizeObject<CreateSessionPayload>(request.body);
    const topicHint = normalizeOptionalString(payload.topicHint);
    const searchBriefId = payload.searchBriefId != null ? normalizeOptionalString(payload.searchBriefId) : undefined;
    // M3c: embed the topic that drives memory recall so the new session's guide ranks
    // confirmed memories by cosine instead of substring. P2b: resolveInterviewTopicHint 与域内
    // topicHint 对齐;surreal 权威时预召回原生图遍历/HNSW/溯源,作为纯数据喂给同步 createSessionDraft。
    // 配置边界:无 embedding client → queryEmbedding undefined(关键词召回配置态);无原生 repo →
    // recall undefined(域层召回)。运行时失败(embed 错/召回错)→ 如实 502,不再静默少注入召回。
    const recallTopic = resolveInterviewTopicHint(state, {
      ...(topicHint ? { topicHint } : {}),
      ...(searchBriefId ? { searchBriefId } : {})
    });
    let queryEmbedding: number[] | undefined;
    let recall: Awaited<ReturnType<typeof prefetchRecall>> | undefined;
    try {
      queryEmbedding = await embedQueryText(recallTopic, options.embeddingClient);
      const nativeRecall = asNativeRecall(repository);
      recall = nativeRecall
        ? await prefetchRecall(nativeRecall, state, recallTopic, queryEmbedding, {
            includeSensitive: state.systemConfig.memory.includeSensitiveMemoriesInContext,
            topN: state.systemConfig.search.maxSources
          })
        : undefined;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(JSON.stringify({ event: "session_create_recall_failed", error: message }));
      return reply.code(502).send({ error: `创建会话失败（记忆召回不可用）：${message}` });
    }
    const session = createSessionDraft(state, normalizeMode(payload.mode), normalizeStrength(payload.strength, state), {
      ...(searchBriefId ? { searchBriefId } : {}),
      ...(topicHint ? { topicHint } : {}),
      ...(queryEmbedding ? { queryEmbedding } : {}),
      ...(recall ? { recall } : {})
    });
    // The deterministic card (createSessionDraft → buildInterviewCard) is already
    // de-hardcoded/personalized, so "开始专访" returns instantly. The LLM card
    // enrichment used to block here ~5s on a live call; moved off the create
    // critical path for responsiveness. The diary still uses real LLM at /end.
    const nextState = upsertSession(state, session);

    // state 必须是 replaceState 返回的权威态(revision 已 bump):回传入参会让前端 adoptServerState
    // 记下过期 revision,finalize/创建后的第一次编辑 PUT 必 409、被"改动已被其他更新覆盖"丢弃(真实业务 E2E 实测)。
    const persisted = repository.replaceState(nextState);
    return { session, state: persisted };
  });

  // 端点定位(审计说明):单会话查询 API。前端整取走 GET /api/state,故此端点前端未调用,但保留作
  // RESTful 完整性 + 外部集成/调试入口(按 id 精确取单会话,无维护成本)。非死代码。
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
    let turnEmbedding: number[] | undefined;
    try {
      turnEmbedding = await embedQueryText(content, options.embeddingClient);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return reply.code(502).send({ error: `本轮记忆召回嵌入失败：${message}。本轮未记录，请重试。` });
    }
    const refreshedGuide = turnEmbedding
      ? buildInterviewGuide(state, {
          topicHint: session.guide.topicHint || undefined,
          ...(session.card.searchBriefId ? { searchBriefId: session.card.searchBriefId } : {}),
          queryEmbedding: turnEmbedding
        })
      : session.guide;
    const freshSession: InterviewSession = { ...session, enginePolicy, guide: refreshedGuide };

    // 追问是 LLM 能力：不可用/失败就如实暴露（503/429/502），不再回退确定性策略引擎生成假追问。
    // 失败时不落任何轮次——请求原子失败，用户可原样重试。
    if (!options.bailianInterviewClient) {
      return reply.code(503).send({ error: "专访追问 LLM 未配置（缺少 DASHSCOPE_API_KEY），无法生成追问。" });
    }
    if (!budget.tryConsume(freshSession.id)) {
      console.warn(JSON.stringify({ event: "llm_budget_exceeded", capability: "interview_turn", sessionId: freshSession.id }));
      return reply.code(429).send({ error: "本会话 LLM 预算已用尽，追问暂不可用，请稍后重试。" });
    }
    let updatedSession: Awaited<ReturnType<typeof receiveTurn>>;
    try {
      updatedSession = await receiveTurn(
        freshSession,
        content,
        options.bailianInterviewClient,
        state.memoryCorrections,
        state.profile.explicitBoundaries
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(JSON.stringify({ event: "llm_failed", capability: "interview_turn", sessionId: freshSession.id, error: message }));
      return reply.code(502).send({ error: `追问生成失败：${message}。本轮未记录，请重试。` });
    }
    const { nextSession: rawNextSession, preSignals } = updatedSession;
    // The character model conveys manner via （…）stage-direction asides (e.g. 「（身体微倾，
    // 表现出好奇）」). Strip them out of the stored question so the transcript / finalize / memory
    // read as clean words like a real interview; distill the manner into `prosody` so the voice
    // path can still deliver it expressively. Only the just-generated assistant turn is touched.
    const nextSession = stripAsidesFromLatestAssistantTurn(rawNextSession);
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

    const persisted = repository.replaceState(nextState);
    return { session: nextSession, state: persisted, ...(preSignals ? { preSignals } : {}) };
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
    // 审计修复(P2-19):与 /turns、/record-turn 对齐的归档守卫。写串行化的排队语义使
    // "end 在前、control 在后"成为网络时序常态——向 completed 会话 push 控制轮会让热层 turns
    // 重新非空、与已降冷冷层副本分叉。已结束会话拒绝追加。
    if (session.status === "completed") {
      return reply.code(409).send({ error: "会话已结束并归档，无法追加轮次。" });
    }

    const updatedSession = updateInterviewControl(session, action);
    const nextState = upsertSession(state, updatedSession);

    const persisted = repository.replaceState(nextState);
    return { session: updatedSession, state: persisted };
  });

  server.post("/api/interview-sessions/:id/end", async (request, reply) => {
    const state = repository.getState();
    const session = findSession(state, getSessionId(request.params));
    if (!session) {
      return reply.code(404).send({ error: "Interview session not found." });
    }
    // 幂等守卫:已结束的会话不得二次 finalize。否则在无 rawMaterialRepository 的配置下(turns 不被降冷清空),
    // 双击"结束"或网络重试会重新 finalize,重复插入 note/资产/记忆候选。靠 status 显式拦截,
    // 不依赖"turns 被副作用清空"这一隐式护栏。
    if (session.status === "completed") {
      return reply.code(409).send({ error: "Interview session has already been ended." });
    }
    if (session.turns.filter((turn) => turn.role === "user").length === 0) {
      return reply.code(422).send({ error: "Interview session cannot be ended before the first user turn." });
    }

    // 归档（双轨笔记+资产+记忆抽取+矛盾精判）是 LLM 能力：不可用/失败就如实暴露，
    // 会话保持 active 可重试，绝不用确定性 finalize 生成模板笔记冒充。
    if (!options.bailianChatClient) {
      return reply.code(503).send({ error: "归档 LLM 未配置（缺少 DASHSCOPE_API_KEY），无法结束并归档专访。" });
    }

    const baseState = {
      ...state,
      sessions: state.sessions.filter((item) => item.id !== session.id)
    };
    let result: FinalizeResult;
    let reasonedState: ProductState;
    try {
      // M1b: extract real long-term memory candidates from the conversation and hand
      // them to finalize. doNotSave skips extraction entirely — mergeFinalizedState
      // would discard the candidates anyway, so spending LLM budget on them is pure waste.
      const providedCandidates = session.doNotSave
        ? undefined
        : await extractSessionMemoryCandidates(session, options.bailianChatClient, budget);
      result = await finalizeSessionWithLlm(baseState, session, options.bailianChatClient, providedCandidates, options.embeddingClient);
      // 轻量推理(欠账②):finalize 之后,对全量观点做矛盾/演化检出。规则粗筛 → LLM 精判 →
      // 应用关系(双向 contradicts + supersedes)。失败与 finalize 一体原子中止(此时尚未持久化)。
      reasonedState = await applySessionCognitiveRelations(
        result.nextState,
        session.id,
        options.bailianChatClient,
        budget
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(JSON.stringify({ event: "llm_failed", capability: "finalize", sessionId: session.id, error: message }));
      return reply.code(502).send({ error: `专访归档失败：${message}。会话未结束，可重试。` });
    }
    const completedSession = reasonedState.sessions.find((item) => item.id === session.id) ?? session;

    // Cold-storage offload: move this just-completed session's heavy evidence
    // (turns + strategyTrace) into the raw-material repository and persist only
    // the lightweight hot state. The RESPONSE must return the same light state
    // we persist — the client adopts it (adoptServerState) and its autosave
    // effect would PUT it straight back; returning the heavy finalized state
    // would re-inflate the just-offloaded turns on the next save (the 28MB-wall
    // regression). The raw material is served lazily via
    // GET /api/sessions/:id/raw-material. The end screen shows the dual-track
    // note, not the transcript, so a light state doesn't degrade it.
    let stateToPersist = reasonedState;
    let offloadedTurns: InterviewTurn[] | undefined;
    if (options.rawMaterialRepository) {
      const { hotState, material } = offloadCompletedSession(reasonedState, session.id);
      if (material) {
        await options.rawMaterialRepository.put(material);   // R2a:仓库接口已异步化(降冷落库须先于返回轻态)
        stateToPersist = hotState;
        offloadedTurns = material.turns;
      }
    }
    // Return the light, persisted session (turns stripped, rawMaterialOffloaded),
    // not the heavy completedSession from finalizedState.
    const persistedSession = stateToPersist.sessions.find((item) => item.id === session.id) ?? completedSession;

    // state 必须是 replaceState 返回的权威态(revision 已 bump):此前回传 stateToPersist(过期
    // revision),前端 /end 后 adoptServerState 记下旧 revision → finalize 后第一次编辑(如"标记
    // 重要")的去抖 PUT 必 409 → 本地编辑被"改动已被其他更新覆盖"丢弃(真实业务 E2E 用例2 实测)。
    const persisted = repository.replaceState(stateToPersist);
    // 知识索引补点：该会话降冷后的 transcript 块（逐字稿冷层，不在持久化边界 diff 内）。
    // note 块已由包装后的 replaceState 自动增量（note 在 diffIndexableSources 内）。
    // fire-and-forget——不 await、不阻塞响应、不抛回写路径。
    if (options.knowledgeIndexRepository && offloadedTurns) {
      void reindexTranscript(
        persisted,
        session.id,
        offloadedTurns,
        options.knowledgeIndexRepository,
        options.embeddingClient,
        budget
      );
    }
    budget.reset(session.id);
    return { session: persistedSession, note: result.note, state: persisted };
  });

  // Voice path: generate interaction pre_signals for the next turn on demand
  // (the realtime voice model, unlike the character model, doesn't emit them).
  server.post("/api/interview-sessions/:id/pre-signals", async (request, reply) => {
    const state = repository.getState();
    const session = findSession(state, getSessionId(request.params));
    if (!session) {
      return reply.code(404).send({ error: "Interview session not found." });
    }
    // pre_signals 是 LLM 能力：不可用/失败就如实暴露（503/429/502），
    // 不再回退确定性 buildFallbackPreSignals 冒充。调用方（语音路）自行决定无信号时的交互策略。
    if (!options.bailianChatClient) {
      console.warn(JSON.stringify({ event: "llm_unavailable", capability: "pre_signals", sessionId: session.id }));
      return reply.code(503).send({ error: "pre_signals LLM 未配置（缺少 DASHSCOPE_API_KEY）。" });
    }
    if (!budget.tryConsume(session.id)) {
      console.warn(JSON.stringify({ event: "llm_budget_exceeded", capability: "pre_signals", sessionId: session.id }));
      return reply.code(429).send({ error: "本会话 LLM 预算已用尽，pre_signals 暂不可用。" });
    }
    try {
      const preSignals = await generatePreSignals(session, options.bailianChatClient);
      const updatedSession: InterviewSession = { ...session, interactionPreSignals: preSignals };
      repository.replaceState(upsertSession(state, updatedSession));
      return { preSignals, session: updatedSession };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(JSON.stringify({ event: "llm_failed", capability: "pre_signals", error: message }));
      return reply.code(502).send({ error: `pre_signals 生成失败：${message}` });
    }
  });

  // Layer 2 endpoint: is the user done speaking? (cascade calls this only on
  // an "ambiguous" heuristic verdict.) 分类失败/不可用如实返回 5xx/429——
  // 实时交互的"拿不到判定就默认应答"是调用方（cascade 前端）的显式实时策略，
  // 不再由服务端伪造 done:true 的分类结果。
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
      return reply.code(503).send({ error: "turn-complete 分类 LLM 未配置。" });
    }
    // turn-complete 是语音路最高频的 LLM 调用，此前唯一漏过 per-session 成本闸控 → 可无界烧钱。
    if (!budget.tryConsume(session.id)) {
      console.warn(JSON.stringify({ event: "llm_budget_exceeded", capability: "turn_complete", sessionId: session.id }));
      return reply.code(429).send({ error: "本会话 LLM 预算已用尽（turn-complete 分类）。" });
    }
    let result: Awaited<ReturnType<typeof classifyTurnComplete>>;
    try {
      result = await classifyTurnComplete(session, transcript, options.bailianChatClient);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(JSON.stringify({ event: "llm_failed", capability: "turn_complete", sessionId: session.id, error: message }));
      return reply.code(502).send({ error: `turn-complete 分类失败：${message}` });
    }
    console.info(JSON.stringify({
      // 审计修复(P3-51):私密日记场景,用户原话不入日志——只记长度用于诊断。
      event: "cascade_turn_complete", sessionId: session.id,
      done: result.done, reason: result.reason, transcriptChars: transcript.length
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
    const persisted = repository.replaceState(nextState);
    return { session: nextSession, state: persisted };
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
  // string. 配置边界:无 embeddingClient / 空文本 → 沿用现有 session.guide。
  // 运行时嵌入失败 → 如实 502,由语音客户端决定是否沿用旧指令（显式决策,不再服务端静默）。
  server.post("/api/interview-sessions/:id/voice-instructions", async (request, reply) => {
    const state = repository.getState();
    const session = findSession(state, getSessionId(request.params));
    if (!session) {
      return reply.code(404).send({ error: "Interview session not found." });
    }
    const latestUserText = normalizeOptionalString(
      normalizeObject<{ latestUserText?: unknown }>(request.body).latestUserText
    );

    let queryEmbedding: number[] | undefined;
    try {
      queryEmbedding = await embedQueryText(latestUserText, options.embeddingClient);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return reply.code(502).send({ error: `语音指令刷新失败（召回嵌入不可用）：${message}` });
    }
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
// memory recall. 语义边界:无 embeddingClient（未配置=关键词召回的产品配置态）/ 空文本 →
// undefined。运行时失败（embed 报错/超时）→ 抛错,由路由如实 5xx——不再静默退化成
// 关键词召回让召回质量无声下降。Embeddings are computed here (route layer); the domain stays pure.
// I:嵌入查询超时上限。本地 embedding(transformers.js)首次需加载模型、无内部超时,直接 await
// 会把"开始专访"/turn 卡住;超时即抛错。server 启动会预热本地模型(见 server.ts startServer),
// 稳态下 embed 远快于此;真超时只在冷启动未预热完就建会话的窄窗口。
const EMBED_QUERY_TIMEOUT_MS = 8000;

async function embedQueryText(
  text: string | undefined,
  embeddingClient: BailianEmbeddingClient | undefined
): Promise<number[] | undefined> {
  const trimmed = text?.trim();
  if (!embeddingClient || !trimmed) {
    return undefined;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const vectors = await Promise.race([
      embeddingClient.embed([trimmed]),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("embed timeout")), EMBED_QUERY_TIMEOUT_MS);
      })
    ]);
    const vector = vectors[0];
    return Array.isArray(vector) && vector.length > 0 ? vector : undefined;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(JSON.stringify({ event: "interview_query_embed_failed", error: message }));
    throw new Error(`召回嵌入失败：${message}`);
  } finally {
    if (timer) clearTimeout(timer);
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
  // 总是 stamp prosody:deriveSpeechProsody 即使在无 （…）asides 时也会从文本语义派生(问句升调 /
  // 感叹热情 / 共情放缓 / 情绪枚举等)。原来"无 asides 即早退"会让真实 LLM(其追问不产 manner asides)
  // 的每轮 assistant turn 丢失全部语音情绪(2026-06-29 真实 E2E:每轮缺 prosody 的根因)。
  const prosody = deriveSpeechProsody(turn.content);
  if (clean === turn.content && prosody.emotion === "neutral" && prosody.rate === 1 && prosody.pitch === 1 && prosody.volume === 50) {
    return session; // 既无 asides 又派生为纯中性 → 无需改写
  }
  const nextTurns = turns.slice();
  // Guard against an aside-only reply collapsing to empty — keep the original in that edge case.
  nextTurns[lastAssistantIndex] = { ...turn, content: clean || turn.content, prosody };
  return { ...session, turns: nextTurns };
}

// M1b: LLM extraction of long-term memory candidates from the actual conversation,
// converted into session-sourced reviewable candidates. 失败/预算耗尽直接抛错——
// 由 /end 的统一 catch 原子中止归档并如实 5xx/429，不再静默跳过让 mergeFinalizedState
// 回落启发式模板候选。LLM 明确说"没有值得沉淀的记忆"时返回 []（诚实的空，不触发启发式）。
async function extractSessionMemoryCandidates(
  session: InterviewSession,
  chatClient: BailianChatClient,
  budget: LlmBudget
): Promise<MemoryCandidate[]> {
  if (!budget.tryConsume(session.id)) {
    console.warn(JSON.stringify({ event: "llm_budget_exceeded", capability: "memory_extraction", sessionId: session.id }));
    throw new Error("本会话 LLM 预算已用尽（记忆抽取）");
  }
  const transcript = buildSessionTranscript(session);
  if (!transcript.trim()) {
    return [];
  }
  const extracted = await extractCandidateMemories(session.title, transcript, chatClient);
  return toSessionMemoryCandidates(extracted, session.id, session.title, nowIso());
}

// 轻量推理(欠账②)编排:规则粗筛同主题观点对 → LLM 精判对立/取代 → 应用关系到 state。
// 失败抛错，由 /end 的统一 catch 原子中止（尚未持久化）——不再静默返回"无关系"掩盖失败。
async function applySessionCognitiveRelations(
  state: ProductState,
  sessionId: string,
  chatClient: BailianChatClient,
  budget: LlmBudget
): Promise<ProductState> {
  const pairs = collectCandidatePointPairs(state);
  if (pairs.length === 0) {
    return state;
  }
  const relations = await judgeCognitiveRelations(pairs, chatClient, budget, sessionId);
  if (relations.contradicts.length === 0 && relations.supersedes.length === 0) {
    return state;
  }
  return applyCognitiveRelations(state, relations);
}

// Join the conversation into a 用户/主持人 transcript (same shape finalize-llm uses),
// capped to the last 60 turns so the extraction prompt stays bounded.
function buildSessionTranscript(session: InterviewSession): string {
  return session.turns
    .slice(-60)
    .map((turn) => `${turn.role === "user" ? "用户" : "主持人"}：${turn.content}`)
    .join("\n");
}

// 追问生成（LLM 必选）。失败向上抛——由 /turns 路由如实 502，本轮不落任何轮次。
// （旧的"LLM 失败回退确定性策略引擎"已剔除：不能用就暴露，不用引擎模板追问冒充。）
async function receiveTurn(
  session: InterviewSession,
  content: string,
  bailianInterviewClient: BailianCharacterInterviewClient,
  corrections: MemoryCorrection[] = [],
  boundaries: string[] = []
): Promise<{
  nextSession: InterviewSession;
  preSignals?: import("../../../../src/domain/types").InteractionPreSignals;
}> {
  // Strategy engine decides this turn's action; injected into the LLM prompt AND
  // backfilled onto the assistant turn so strategyTrace / turn.strategy / the technique
  // badge / quality-report all have real data on the live path.
  const strategyDecision = decideInterviewStrategy(session, content);
  const assistant = await bailianInterviewClient.createAssistantTurn({ session, userText: content, corrections, boundaries, strategyDecision });
  const nextSession = receiveUserTurnWithAssistant(session, content, {
    content: assistant.content,
    intent: assistant.intent,
    strategyDecision
  });
  return { nextSession: { ...nextSession, interactionPreSignals: assistant.preSignals }, preSignals: assistant.preSignals };
}
