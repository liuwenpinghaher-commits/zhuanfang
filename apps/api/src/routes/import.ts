import type { FastifyInstance } from "fastify";
import { ingestImportSource, type ImportDocumentInput } from "../../../../src/domain/import";
import { extractCandidateMemories } from "../intelligence/memory-extraction-llm";
import { createLlmBudget, type LlmBudget } from "../llm-budget";
import type { BailianChatClient, BailianEmbeddingClient } from "../providers/bailian";
import type { ProductStateRepository } from "../product-state-repository";
import type { KnowledgeIndexRepository } from "../knowledge-index-repository";
import { reindexMaterial } from "./knowledge";

interface ImportRouteOptions {
  bailianChatClient?: BailianChatClient;
  embeddingClient?: BailianEmbeddingClient;
  llmBudget?: LlmBudget;
  knowledgeIndexRepository?: KnowledgeIndexRepository;
}

// P1-05: cap import document content. 256KB is roomy for a pasted article/transcript while
// keeping a single field from becoming a multi-MB prompt/embedding cost amplifier. (The
// server-wide body limit is 28MB to allow base64 audio elsewhere, so this field needs its own.)
const IMPORT_CONTENT_MAX_CHARS = 256 * 1024;

export async function registerImportRoutes(
  server: FastifyInstance,
  repository: ProductStateRepository,
  options: ImportRouteOptions = {}
) {
  const budget = options.llmBudget ?? createLlmBudget();

  server.post("/api/import/documents", async (request, reply) => {
    const input = normalizeImportInput(request.body);
    if (!input.content.trim()) {
      return reply.code(422).send({ error: "Document content is required." });
    }
    if (input.content.length > IMPORT_CONTENT_MAX_CHARS) {
      return reply.code(422).send({ error: `Document content exceeds the ${IMPORT_CONTENT_MAX_CHARS}-character limit.` });
    }

    const state = repository.getState();

    // Extract candidate memories via LLM; on failure, still ingest the source
    // (chunked for RAG) with zero candidates so nothing is lost.
    const allowLlm = !!options.bailianChatClient && budget.tryConsume("system");
    if (!!options.bailianChatClient && !allowLlm) {
      console.warn(JSON.stringify({ event: "llm_budget_exceeded", capability: "import_documents" }));
    }
    let candidates: Awaited<ReturnType<typeof extractCandidateMemories>> = [];
    if (allowLlm) {
      try {
        candidates = await extractCandidateMemories(input.title, input.content, options.bailianChatClient!);
      } catch (error) {
        console.warn("[import] memory extraction failed, ingesting source only:", error instanceof Error ? error.message : error);
      }
    }

    const { sourceId, candidateCount, nextState } = await ingestImportSource(
      state,
      input,
      candidates,
      options.embeddingClient
    );
    // state 必须是 replaceState 返回的权威态(revision 已 bump),否则客户端下一次乐观 PUT 必 409。
    const persisted = repository.replaceState(nextState);
    // 知识索引补点：新 importSource 的 material 块（不在持久化边界 diff 内）。
    // fire-and-forget——不 await、不阻塞响应、不抛回写路径。
    if (options.knowledgeIndexRepository) {
      void reindexMaterial(persisted, sourceId, options.knowledgeIndexRepository, options.embeddingClient, budget);
    }
    return { sourceId, candidateCount, state: persisted };
  });
}

function normalizeImportInput(value: unknown): ImportDocumentInput {
  const payload = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const sourceType = payload.sourceType === "webpage" ? "webpage" : "text";
  return {
    title: typeof payload.title === "string" && payload.title.trim() ? payload.title.trim() : "未命名导入资料",
    content: typeof payload.content === "string" ? payload.content : "",
    sourceType,
    sourceUrl: typeof payload.sourceUrl === "string" && payload.sourceUrl.trim() ? payload.sourceUrl.trim() : undefined
  };
}
