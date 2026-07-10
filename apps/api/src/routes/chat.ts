import type { FastifyInstance } from "fastify";
import type { ChatCitation, ChatSession } from "../../../../src/domain/types";
import {
  appendChatMessage,
  buildChatPrompt,
  createChatSession,
  rankKnowledgeChunks
} from "../../../../src/domain/knowledge";
import { createLlmBudget, type LlmBudget } from "../llm-budget";
import type { BailianChatClient, BailianEmbeddingClient } from "../providers/bailian";
import type { KnowledgeIndexRepository } from "../knowledge-index-repository";
import type { ProductStateRepository } from "../product-state-repository";

/** 召回条数上限。 */
const TOP_K = 8;
/** citation snippet 截断的字符上限。 */
const SNIPPET_LIMIT = 200;
/** 无模型/超预算时的降级答案。 */
const OFFLINE_ANSWER = "对话暂不可用(未配置模型或额度已用尽)。";

interface ChatRouteOptions {
  embeddingClient?: BailianEmbeddingClient;
  bailianChatClient?: BailianChatClient;
  llmBudget?: LlmBudget;
}

interface ChatResponse {
  state: ReturnType<ProductStateRepository["getState"]>;
  sessionId: string;
  answer: string;
  citations: ChatCitation[];
}

/**
 * POST /api/chat：检索用户私人资料 + 通用接地 prompt 生成回答 + 引用。
 * 离线/超预算降级为固定文案、空引用，永不 500。
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

    // ── 确定会话 ──
    let state = productRepo.getState();
    let sessionId: string;
    if (requestedSessionId && state.chatSessions.some((s) => s.id === requestedSessionId)) {
      sessionId = requestedSessionId;
    } else {
      const created = createChatSession(state);
      state = created.state;
      sessionId = created.sessionId;
    }

    // ── 追加 user 消息 ──
    state = appendChatMessage(state, sessionId, "user", message);

    // ── 召回 ──
    let queryEmbedding: number[] | undefined;
    if (options.embeddingClient) {
      try {
        const vecs = await options.embeddingClient.embed([message]);
        queryEmbedding = vecs[0];
      } catch (err) {
        console.warn(
          JSON.stringify({
            event: "chat_embed_failed",
            error: err instanceof Error ? err.message : String(err)
          })
        );
      }
    }

    const retrieved = rankKnowledgeChunks(await knowledgeRepo.listAll(), message, queryEmbedding, TOP_K);   // R2a:仓库接口已异步化

    // ── 答案生成 ──
    const allowLlm = !!options.bailianChatClient && budget.tryConsume("chat");
    if (!!options.bailianChatClient && !allowLlm) {
      console.warn(JSON.stringify({ event: "llm_budget_exceeded", capability: "chat" }));
    }

    let answer: string;
    let citations: ChatCitation[];

    if (allowLlm) {
      const session = state.chatSessions.find((s) => s.id === sessionId) as ChatSession;
      // history 不含刚 append 的当前 user 消息(session.messages 末尾即它)，
      // 否则它会同时出现在 buildChatPrompt 的"对话历史"与"当前问题"里，造成最新问题重复。
      const { system, user } = buildChatPrompt(retrieved, session.messages.slice(0, -1), message);
      try {
        answer = await options.bailianChatClient!.complete({
          messages: [
            { role: "system", content: system },
            { role: "user", content: user }
          ]
        });
        // 只把模型实际引用的 [n] 对应块作为 citation,避免展示模型根本没用到的资料。
        // 解析不到任何有效编号时,回退为全部检索块(保留可溯源性)。
        const citedIdx = new Set<number>();
        for (const m of answer.matchAll(/\[(\d+)\]/g)) {
          const i = Number(m[1]) - 1;
          if (i >= 0 && i < retrieved.length) citedIdx.add(i);
        }
        const citedChunks = citedIdx.size > 0 ? retrieved.filter((_, i) => citedIdx.has(i)) : retrieved;
        citations = citedChunks.map((c) => ({
          sourceType: c.sourceType,
          sourceId: c.sourceId,
          title: c.title,
          snippet: c.text.length > SNIPPET_LIMIT ? `${c.text.slice(0, SNIPPET_LIMIT)}…` : c.text
        }));
      } catch (err) {
        console.warn(
          JSON.stringify({
            event: "chat_llm_failed",
            error: err instanceof Error ? err.message : String(err)
          })
        );
        answer = OFFLINE_ANSWER;
        citations = [];
      }
    } else {
      answer = OFFLINE_ANSWER;
      citations = [];
    }

    // ── 追加 assistant 消息 + 持久化 ──
    state = appendChatMessage(state, sessionId, "assistant", answer, citations);
    const nextState = productRepo.replaceState(state);

    return reply.send({ state: nextState, sessionId, answer, citations } satisfies ChatResponse);
  });
}
