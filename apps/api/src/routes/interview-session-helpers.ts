/** Helpers split from interview-sessions.ts */
import { discardEmptyActiveInterviewSession } from "../../../../src/domain/lifecycle";
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
  InteractionPreSignals,
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
import type { ProductStateRepository } from "../product-state-repository"
import { replaceStateDurable } from "../product-state-repository";
import type { RawMaterialRepository } from "../raw-material-repository";
import type { KnowledgeIndexRepository } from "../knowledge-index-repository";
import type { BailianChatClient, BailianCharacterInterviewClient, BailianEmbeddingClient } from "../providers/bailian";
import { createLlmBudget, type LlmBudget } from "../llm-budget";
import { offloadCompletedSession } from "./raw-material";
import { reindexTranscript } from "./knowledge";
import {
  applyMidSessionCardRefresh,
  buildInterviewContextPack,
  resolveInterviewTopicHint,
  resolveMidSessionRecallTopic
} from "../../../../src/domain/context-pack";
import { mergeInterviewSessionRefresh } from "../../../../src/domain/session-merge";
import { buildBootContextPack } from "../../../../src/domain/retrieval";
import { asNativeRecall } from "../recall/native-recall-capability";
import { prefetchRecall } from "../recall/prefetch-recall";

export interface CreateSessionPayload {
  mode?: unknown;
  strength?: unknown;
  searchBriefId?: unknown;
  topicHint?: unknown;
  relatedThemeIds?: unknown;
  clientRequestId?: unknown;
}

export interface TurnPayload {
  content?: unknown;
}

export interface ControlPayload {
  action?: unknown;
}

export interface InterviewSessionRouteOptions {
  bailianInterviewClient?: BailianCharacterInterviewClient;
  bailianChatClient?: BailianChatClient;
  embeddingClient?: BailianEmbeddingClient;
  rawMaterialRepository?: RawMaterialRepository;
  knowledgeIndexRepository?: KnowledgeIndexRepository;
  llmBudget?: LlmBudget;
  /**
   * IV-P0-01: voice-instructions is write-gate exempt for slow embed/prefetch, but
   * final session merge MUST re-enter write serialization so record-turn cannot land
   * between re-read and replaceStateDurable.
   */
  /** Max wall time for a single interview turn LLM call (ms). */
  interviewTurnTimeoutMs?: number;
  writeGate?: { runExclusive<T>(label: string, fn: () => Promise<T> | T): Promise<T> };
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


export class InterviewTurnTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Interview turn timed out after ${timeoutMs}ms`);
    this.name = "InterviewTurnTimeoutError";
  }
}

export async function withInterviewTurnDeadline<T>(task: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      task,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new InterviewTurnTimeoutError(timeoutMs)), timeoutMs);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function normalizeTimeoutMs(value: number | undefined, fallback = 45_000): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return fallback;
  return Math.min(Math.max(Math.floor(value), 1_000), 180_000);
}



// M3c: embed a query string (create-time topic or a turn's user text) for semantic
// memory recall. 语义边界:无 embeddingClient（未配置=关键词召回的产品配置态）/ 空文本 →
// undefined。运行时失败（embed 报错/超时）→ 抛错,由路由如实 5xx——不再静默退化成
// 关键词召回让召回质量无声下降。Embeddings are computed here (route layer); the domain stays pure.
// I:嵌入查询超时上限。本地 embedding(transformers.js)首次需加载/下载模型,无内部超时。
// server 启动在 EMBEDDING_PROVIDER=local 时会 await 预热;本地给更宽窗口避免冷启动误杀。
const EMBED_QUERY_TIMEOUT_MS =
  (process.env.EMBEDDING_PROVIDER ?? "").trim().toLowerCase() === "local" ? 120_000 : 20_000;

export async function embedQueryText(
  text: string | undefined,
  embeddingClient: BailianEmbeddingClient | undefined
): Promise<number[] | undefined> {
  const trimmed = text?.trim();
  if (!embeddingClient || !trimmed) {
    return undefined;
  }
  let lastError: unknown;
  for (let attempt = 1; attempt <= 2; attempt++) {
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
      lastError = error;
      const message = error instanceof Error ? error.message : String(error);
      console.warn(JSON.stringify({ event: "interview_query_embed_failed", attempt, error: message }));
      // Retry once on timeout/transient network; fail closed otherwise.
      if (!/timeout|aborted|ECONNRESET|ETIMEDOUT|fetch failed/i.test(message) || attempt === 2) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 500 * attempt));
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  const message = lastError instanceof Error ? lastError.message : String(lastError);
  throw new Error(`召回嵌入失败：${message}`);
}

export function normalizeObject<T>(value: unknown): Partial<T> {
  return value && typeof value === "object" ? (value as Partial<T>) : {};
}

export function normalizeMode(value: unknown): InterviewMode {
  return interviewModes.includes(value as InterviewMode) ? (value as InterviewMode) : "daily";
}

export function normalizeStrength(value: unknown, state: ProductState): InterviewStrength {
  return interviewStrengths.includes(value as InterviewStrength) ? (value as InterviewStrength) : state.profile.preferredStrength;
}

export function normalizeControlAction(value: unknown): InterviewControlAction | undefined {
  return controlActions.includes(value as InterviewControlAction) ? (value as InterviewControlAction) : undefined;
}

export function normalizeOptionalString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function normalizeRelatedThemeIds(value: unknown, state: ProductState): string[] {
  if (!Array.isArray(value)) return [];
  const valid = new Set(state.themes.map((theme) => theme.id));
  return Array.from(
    new Set(
      value
        .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
        .map((item) => item.trim())
        .filter((id) => valid.has(id))
    )
  );
}

export function getSessionId(params: unknown) {
  return normalizeObject<{ id: string }>(params).id;
}

export function findSession(state: ProductState, sessionId: unknown) {
  return typeof sessionId === "string" ? state.sessions.find((session) => session.id === sessionId) : undefined;
}

export function upsertSession(state: ProductState, session: InterviewSession): ProductState {
  return {
    ...state,
    sessions: [session, ...state.sessions.filter((item) => item.id !== session.id)]
  };
}

// Strip （…）manner asides from the most recently generated assistant turn and keep the manner
// as prosody. Touches only the last assistant turn (the one just produced); earlier turns and
// all user turns are returned unchanged. A turn whose content has no asides is left as-is.
export function stripAsidesFromLatestAssistantTurn(session: InterviewSession): InterviewSession {
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
export async function extractSessionMemoryCandidates(
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
  return toSessionMemoryCandidates(extracted, session.id, session.title, nowIso(), session.turns);
}

// 轻量推理(欠账②)编排:规则粗筛同主题观点对 → LLM 精判对立/取代 → 应用关系到 state。
// 失败抛错，由 /end 的统一 catch 原子中止（尚未持久化）——不再静默返回"无关系"掩盖失败。
export async function applySessionCognitiveRelations(
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
export function buildSessionTranscript(session: InterviewSession): string {
  return session.turns
    .slice(-60)
    .map((turn) => `${turn.role === "user" ? "用户" : "主持人"}：${turn.content}`)
    .join("\n");
}

// 追问生成（LLM 必选）。失败向上抛——由 /turns 路由如实 502，本轮不落任何轮次。
// （旧的"LLM 失败回退确定性策略引擎"已剔除：不能用就暴露，不用引擎模板追问冒充。）
export async function receiveTurn(
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
  // C-P1-03: surface the strategy's real referencedMemory on the turn (not card.historyReferences[0]).
  const nextSession = receiveUserTurnWithAssistant(session, content, {
    content: assistant.content,
    intent: assistant.intent,
    strategyDecision,
    ...(strategyDecision.referencedMemory
      ? { referencedMemory: strategyDecision.referencedMemory }
      : {})
  });
  return { nextSession: { ...nextSession, interactionPreSignals: assistant.preSignals }, preSignals: assistant.preSignals };
}
