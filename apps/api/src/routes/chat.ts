import type { FastifyInstance } from "fastify";
import type { ChatCitation, ChatSession, KnowledgeChunk, KnowledgeSourceType } from "../../../../src/domain/types";
import {
  appendChatMessage,
  buildChatPrompt,
  createChatSession,
  getKnowledgeSourceLabel,
  knowledgeChunkForFocus,
  pinKnowledgeFocus,
  rankKnowledgeChunks,
  renameChatSession,
  retrieveAndRankKnowledge
} from "../../../../src/domain/knowledge";
import { createLlmBudget, type LlmBudget } from "../llm-budget";
import { recordGroundingEvent, recordRecallEvent } from "../observability/runtime-metrics";
import { decideGroundingMode, resolveMinRecallScore } from "../../../../src/domain/retrieval";
import type { BailianChatClient, BailianEmbeddingClient } from "../providers/bailian";
import type { KnowledgeIndexRepository } from "../knowledge-index-repository";
import type { ProductStateRepository } from "../product-state-repository"
import { replaceStateDurable } from "../product-state-repository";

/** 召回条数上限。 */
const TOP_K = 8;
/** R2c:原生混合召回的候选集放大因子(候选 = TOP_K × 3)。原生路负责"从索引拉回可能相关的候选",
 *  精排与相关性闸门仍归域层 rankKnowledgeChunks——放大保证精排有足够余量,不因索引侧近似截断漏掉
 *  本该进前 TOP_K 的块。 */
const NATIVE_CANDIDATE_FACTOR = 3;
/** citation snippet 截断的字符上限。 */
const SNIPPET_LIMIT = 200;

interface ChatRouteOptions {
  embeddingClient?: BailianEmbeddingClient;
  bailianChatClient?: BailianChatClient;
  llmBudget?: LlmBudget;
  /** IM-P1-03: final message append serializes through the global write gate. */
  writeGate?: { runExclusive<T>(label: string, fn: () => Promise<T> | T): Promise<T> };
}

interface ChatResponse {
  state: ReturnType<ProductStateRepository["getState"]>;
  sessionId: string;
  answer: string;
  citations: ChatCitation[];
  groundingMode: "grounded" | "partial" | "refused";
}

/**
 * POST /api/chat：检索用户私人资料 + 通用接地 prompt 生成回答 + 引用。
 * LLM/嵌入/召回不可用或失败时如实 503/429/502（原子失败，本轮消息不入库），
 * 绝不把降级文案存成 assistant 消息冒充回答。
 */
export async function registerChatRoutes(
  server: FastifyInstance,
  productRepo: ProductStateRepository,
  knowledgeRepo: KnowledgeIndexRepository,
  options: ChatRouteOptions = {}
): Promise<void> {
  const budget = options.llmBudget ?? createLlmBudget();

  server.post("/api/chat", async (request, reply) => {
    const payload =
      request.body && typeof request.body === "object"
        ? (request.body as Record<string, unknown>)
        : {};

    const message = typeof payload.message === "string" ? payload.message.trim() : "";
    if (!message) {
      return reply.code(422).send({ error: "message 字段不能为空。" });
    }

    const requestedSessionId =
      typeof payload.sessionId === "string" && payload.sessionId.trim()
        ? payload.sessionId.trim()
        : undefined;

    // ── 确定会话 id（消息在 LLM 成功后于写门内一并 append，失败不落库）──
    let state = productRepo.getState();
    let sessionId: string;
    if (requestedSessionId && state.chatSessions.some((s) => s.id === requestedSessionId)) {
      sessionId = requestedSessionId;
    } else {
      // Provisional id for prompt history only; durable create happens under writeGate.
      const created = createChatSession(state);
      state = created.state;
      sessionId = created.sessionId;
    }

    // Working copy for prompt history (includes provisional user turn). Not persisted yet.
    const promptState = appendChatMessage(state, sessionId, "user", message);

    // ── 前置能力闸门:LLM 是对话的必需能力,不可用就如实暴露,不做召回白工 ──
    if (!options.bailianChatClient) {
      return reply.code(503).send({ error: "对话 LLM 未配置（缺少 DASHSCOPE_API_KEY），对话不可用。" });
    }
    if (!budget.tryConsume("chat")) {
      console.warn(JSON.stringify({ event: "llm_budget_exceeded", capability: "chat" }));
      return reply.code(429).send({ error: "本时段 LLM 预算已用尽，对话暂不可用，请稍后重试。" });
    }

    // ── 召回 ──
    let queryEmbedding: number[] | undefined;
    if (options.embeddingClient) {
      try {
        const vecs = await options.embeddingClient.embed([message]);
        queryEmbedding = vecs[0];
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(JSON.stringify({ event: "chat_embed_failed", error: msg }));
        // 嵌入运行时失败 → 如实 502,不再静默退化成关键词召回让回答质量无声下降。
        return reply.code(502).send({ error: `对话召回嵌入失败：${msg}。请重试。` });
      }
    }

    // R2c · P6 双份真相收敛:能力探测。
    // - surreal 档(repo 有 searchHybrid):knowledge_chunk 的 HNSW+BM25+rrf 原生混合检索拉回候选集
    //   (TOP_K×3),再交给域层 rankKnowledgeChunks 精排——同一打分函数、同一 score>0 相关性闸门。
    //   精排后为空 = 没有相关资料(诚实的空,回答将不带引用),不再回落全表 listAll 掩盖差异。
    // - sqlite / in-memory 档(无 searchHybrid):listAll+cosine 是该配置档的正式实现(配置态,非降级)。
    // - 原生路径抛错 → 如实 502,不再静默换路。
    let retrieved: KnowledgeChunk[];
    let recallRejected = false;
    let rejectReason: "empty" | "below_threshold" | undefined;
    let topScore = 0;
    const recallThreshold = resolveMinRecallScore(state.systemConfig.memory);
    if (typeof knowledgeRepo.searchHybrid === "function") {
      try {
        const candidates = await knowledgeRepo.searchHybrid({
          text: message,
          ...(queryEmbedding && queryEmbedding.length > 0 ? { embedding: queryEmbedding } : {}),
          limit: TOP_K * NATIVE_CANDIDATE_FACTOR
        });
        const ranked = retrieveAndRankKnowledge(candidates, message, queryEmbedding, TOP_K, {
          memoryConfig: state.systemConfig.memory
        });
        retrieved = ranked.chunks;
        recallRejected = ranked.rejected;
        rejectReason = ranked.reason;
        topScore = ranked.topScore;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(JSON.stringify({ event: "chat_native_recall_failed", error: msg }));
        recordRecallEvent({ capability: "chat", outcome: "error" });
        return reply.code(502).send({ error: `对话资料召回失败：${msg}。请重试。` });
      }
    } else {
      const ranked = retrieveAndRankKnowledge(await knowledgeRepo.listAll(), message, queryEmbedding, TOP_K, {
        memoryConfig: state.systemConfig.memory
      });
      retrieved = ranked.chunks;
      recallRejected = ranked.rejected;
      rejectReason = ranked.reason;
      topScore = ranked.topScore;
    }
    const focus = parseFocusSource(payload.focusSource);
    if (focus) {
      const pinned = knowledgeChunkForFocus(state, focus.sourceType, focus.sourceId);
      retrieved = pinKnowledgeFocus(retrieved, pinned, TOP_K);
      if (pinned) {
        recallRejected = false;
        rejectReason = undefined;
      }
    }
    recordRecallEvent({
      capability: "chat",
      outcome: recallRejected ? (rejectReason === "below_threshold" ? "low_score" : "empty") : "hit",
      topScore,
      hitCount: retrieved.length,
      threshold: recallThreshold
    });
    console.warn(JSON.stringify({
      event: recallRejected ? (rejectReason === "below_threshold" ? "recall_low_score" : "recall_empty") : "recall_hit",
      capability: "chat",
      topScore,
      hitCount: retrieved.length
    }));

    // ── 答案生成（慢 IO 在写锁外）──
    let answer: string;
    let citations: ChatCitation[];
    {
      const session = promptState.chatSessions.find((s) => s.id === sessionId) as ChatSession;
      // history 不含刚 append 的当前 user 消息(session.messages 末尾即它)，
      // 否则它会同时出现在 buildChatPrompt 的"对话历史"与"当前问题"里，造成最新问题重复。
      const { system, user } = buildChatPrompt(retrieved, session.messages.slice(0, -1), message, {
        recallRejected,
        ...(rejectReason ? { rejectReason } : {})
      });
      try {
        answer = await options.bailianChatClient.complete({
          messages: [
            { role: "system", content: system },
            { role: "user", content: user }
          ]
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(JSON.stringify({ event: "chat_llm_failed", error: msg }));
        // 原子失败:本轮 user/assistant 消息都不入库,如实报错让用户重试。
        return reply.code(502).send({ error: `对话生成失败：${msg}。本轮未记录，请重试。` });
      }
      try {
        citations = validateAndBuildChatCitations(answer, retrieved);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(JSON.stringify({ event: "chat_citation_invalid", error: msg }));
        return reply.code(502).send({ error: `对话引用校验失败：${msg}。本轮未记录，请重试。` });
      }
    }

    const groundingMode = decideGroundingMode({
      rejected: recallRejected,
      retrievedCount: retrieved.length,
      citationCount: citations.length
    });
    recordGroundingEvent({
      capability: "chat",
      mode: groundingMode,
      citationCount: citations.length
    });

    // ── 追加 user+assistant 并持久化（重读 latest，经写门）──
    const commitChat = async () => {
      let latest = productRepo.getState();
      let durableSessionId = sessionId;
      let createdFresh = false;
      if (!latest.chatSessions.some((s) => s.id === durableSessionId)) {
        if (requestedSessionId && latest.chatSessions.some((s) => s.id === requestedSessionId)) {
          durableSessionId = requestedSessionId;
        } else {
          const created = createChatSession(latest);
          latest = created.state;
          durableSessionId = created.sessionId;
          createdFresh = true;
        }
      }
      const existing = latest.chatSessions.find((s) => s.id === durableSessionId);
      const isFirstUserTurn = createdFresh || (existing?.messages.length ?? 0) === 0;
      latest = appendChatMessage(latest, durableSessionId, "user", message);
      latest = appendChatMessage(latest, durableSessionId, "assistant", answer, citations, {
        groundingMode
      });
      // 首条用户消息：默认「新对话」→ 用首问截断作标题，便于会话列表经营。
      const after = latest.chatSessions.find((s) => s.id === durableSessionId);
      if (isFirstUserTurn && after && (!after.title.trim() || after.title === "新对话")) {
        const title = message.length > 36 ? `${message.slice(0, 36)}…` : message;
        latest = renameChatSession(latest, durableSessionId, title);
      }
      const nextState = /*durable*/await replaceStateDurable(productRepo, latest);
      return { state: nextState, sessionId: durableSessionId };
    };
    const committed = options.writeGate
      ? await options.writeGate.runExclusive("chat-append", commitChat)
      : await commitChat();

    return reply.send({
      state: committed.state,
      sessionId: committed.sessionId,
      answer,
      citations,
      groundingMode
    } satisfies ChatResponse);
  });
}

const FOCUS_SOURCE_TYPES: KnowledgeSourceType[] = [
  "note",
  "memory",
  "theme",
  "point",
  "decision",
  "debt",
  "transcript",
  "material"
];

function parseFocusSource(raw: unknown): { sourceType: KnowledgeSourceType; sourceId: string } | null {
  if (!raw || typeof raw !== "object") return null;
  const body = raw as { sourceType?: unknown; sourceId?: unknown };
  const sourceType = typeof body.sourceType === "string" ? body.sourceType : "";
  const sourceId = typeof body.sourceId === "string" ? body.sourceId.trim() : "";
  if (!sourceId || !FOCUS_SOURCE_TYPES.includes(sourceType as KnowledgeSourceType)) return null;
  return { sourceType: sourceType as KnowledgeSourceType, sourceId };
}

function validateAndBuildChatCitations(answer: string, retrieved: KnowledgeChunk[]): ChatCitation[] {
  const citationNumbers = Array.from(answer.matchAll(/\[(\d+)\]/g), (match) => Number(match[1]));
  for (const number of citationNumbers) {
    if (!Number.isInteger(number) || number < 1 || number > retrieved.length) {
      throw new Error(`引用编号 [${number}] 超出本轮允许范围 1-${retrieved.length}。`);
    }
  }

  const sourceAssertions: Array<{ pattern: RegExp; allowed: KnowledgeChunk["sourceType"][]; label: string }> = [
    { pattern: /(?:用户原话|原始记录|逐字稿)\s*\[(\d+)\]/g, allowed: ["transcript"], label: "用户原话/原始记录" },
    { pattern: /(?:已确认长期记忆|长期记忆|记忆)\s*\[(\d+)\]/g, allowed: ["memory"], label: "长期记忆" },
    { pattern: /(?:双轨笔记|笔记)\s*\[(\d+)\]/g, allowed: ["note"], label: "笔记" },
    { pattern: /(?:长期主题|主题)\s*\[(\d+)\]/g, allowed: ["theme"], label: "主题" },
    { pattern: /(?:观点资产|观点)\s*\[(\d+)\]/g, allowed: ["point"], label: "观点" },
    { pattern: /(?:决策资产|决策)\s*\[(\d+)\]/g, allowed: ["decision"], label: "决策" },
    { pattern: /知识债\s*\[(\d+)\]/g, allowed: ["debt"], label: "知识债" },
    { pattern: /(?:导入资料|素材)\s*\[(\d+)\]/g, allowed: ["material"], label: "导入资料" }
  ];
  for (const assertion of sourceAssertions) {
    for (const match of answer.matchAll(assertion.pattern)) {
      const number = Number(match[1]);
      const chunk = retrieved[number - 1];
      if (!chunk || !assertion.allowed.includes(chunk.sourceType)) {
        throw new Error(`来源类型不一致：回答称 [${number}] 为${assertion.label}，实际是${chunk ? getKnowledgeSourceLabel(chunk.sourceType) : "未知来源"}。`);
      }
    }
  }

  if (citationNumbers.length === 0 && /你的资料显示|根据你的资料|用户原话|原始记录|逐字稿|已确认长期记忆/.test(answer)) {
    throw new Error("回答声明使用了用户资料，但没有提供可核验的 citation 编号。");
  }

  const uniqueNumbers = Array.from(new Set(citationNumbers));
  return uniqueNumbers.map((number) => {
    const chunk = retrieved[number - 1];
    return {
      number,
      sourceType: chunk.sourceType,
      sourceId: chunk.sourceId,
      sourceLabel: getKnowledgeSourceLabel(chunk.sourceType),
      title: chunk.title,
      snippet: chunk.text.length > SNIPPET_LIMIT ? `${chunk.text.slice(0, SNIPPET_LIMIT)}…` : chunk.text
    };
  });
}
