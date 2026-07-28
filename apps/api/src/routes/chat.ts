import type { FastifyInstance } from "fastify";
import type { ChatCitation, ChatSession, KnowledgeChunk } from "../../../../src/domain/types";
import {
  appendChatMessage,
  buildChatPrompt,
  createChatSession,
  rankKnowledgeChunks
} from "../../../../src/domain/knowledge";
import { createLlmBudget, type LlmBudget } from "../llm-budget";
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
    if (typeof knowledgeRepo.searchHybrid === "function") {
      try {
        const candidates = await knowledgeRepo.searchHybrid({
          text: message,
          ...(queryEmbedding && queryEmbedding.length > 0 ? { embedding: queryEmbedding } : {}),
          limit: TOP_K * NATIVE_CANDIDATE_FACTOR
        });
        retrieved = candidates.length > 0
          ? rankKnowledgeChunks(candidates, message, queryEmbedding, TOP_K)
          : [];
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(JSON.stringify({ event: "chat_native_recall_failed", error: msg }));
        return reply.code(502).send({ error: `对话资料召回失败：${msg}。请重试。` });
      }
    } else {
      retrieved = rankKnowledgeChunks(await knowledgeRepo.listAll(), message, queryEmbedding, TOP_K);
    }

    // ── 答案生成（慢 IO 在写锁外）──
    let answer: string;
    let citations: ChatCitation[];
    {
      const session = promptState.chatSessions.find((s) => s.id === sessionId) as ChatSession;
      // history 不含刚 append 的当前 user 消息(session.messages 末尾即它)，
      // 否则它会同时出现在 buildChatPrompt 的"对话历史"与"当前问题"里，造成最新问题重复。
      const { system, user } = buildChatPrompt(retrieved, session.messages.slice(0, -1), message);
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
      // 只把模型实际引用的 [n] 对应块作为 citation,并保留原始编号 citationIndex,
      // 避免 UI 按数组序重编号后与正文 [n] 对不上。无有效编号时返回空引用(不回退全量)。
      const citedByIndex = new Map<number, (typeof retrieved)[number]>();
      for (const m of answer.matchAll(/\[(\d+)\]/g)) {
        const n = Number(m[1]);
        const i = n - 1;
        if (i >= 0 && i < retrieved.length && !citedByIndex.has(n)) {
          citedByIndex.set(n, retrieved[i]!);
        }
      }
      citations = [...citedByIndex.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([n, c]) => ({
          sourceType: c.sourceType,
          sourceId: c.sourceId,
          title: c.title,
          snippet: c.text.length > SNIPPET_LIMIT ? `${c.text.slice(0, SNIPPET_LIMIT)}…` : c.text,
          citationIndex: n,
        }));
    }

    // ── 追加 user+assistant 并持久化（重读 latest，经写门）──
    const commitChat = async () => {
      let latest = productRepo.getState();
      let durableSessionId = sessionId;
      if (!latest.chatSessions.some((s) => s.id === durableSessionId)) {
        if (requestedSessionId && latest.chatSessions.some((s) => s.id === requestedSessionId)) {
          durableSessionId = requestedSessionId;
        } else {
          const created = createChatSession(latest);
          latest = created.state;
          durableSessionId = created.sessionId;
        }
      }
      latest = appendChatMessage(latest, durableSessionId, "user", message);
      latest = appendChatMessage(latest, durableSessionId, "assistant", answer, citations);
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
      citations
    } satisfies ChatResponse);
  });
}
