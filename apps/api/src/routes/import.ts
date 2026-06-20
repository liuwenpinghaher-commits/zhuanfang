import type { FastifyInstance } from "fastify";
import { ingestImportSource, type ImportDocumentInput } from "../../../../src/domain/import";
import { extractCandidateMemories } from "../intelligence/memory-extraction-llm";
import { createLlmBudget, type LlmBudget } from "../llm-budget";
import type { BailianChatClient, BailianEmbeddingClient } from "../providers/bailian";
import type { ProductStateRepository } from "../product-state-repository";

interface ImportRouteOptions {
  bailianChatClient?: BailianChatClient;
  embeddingClient?: BailianEmbeddingClient;
  llmBudget?: LlmBudget;
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
    repository.replaceState(nextState);
    return { sourceId, candidateCount, state: nextState };
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
