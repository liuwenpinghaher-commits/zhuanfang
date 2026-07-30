import type { FastifyInstance } from "fastify";
import { ingestImportSource, type ImportDocumentInput } from "../../../../src/domain/import";
import { extractCandidateMemories } from "../intelligence/memory-extraction-llm";
import { createLlmBudget, type LlmBudget } from "../llm-budget";
import type { BailianChatClient, BailianEmbeddingClient } from "../providers/bailian";
import type { ProductStateRepository } from "../product-state-repository";
import { replaceStateDurable } from "../product-state-repository";
import type { KnowledgeIndexRepository } from "../knowledge-index-repository";
import { reindexMaterial } from "./knowledge";

interface ImportRouteOptions {
  bailianChatClient?: BailianChatClient;
  embeddingClient?: BailianEmbeddingClient;
  llmBudget?: LlmBudget;
  knowledgeIndexRepository?: KnowledgeIndexRepository;
  /** IM-P1-03: final ingest write serializes through the global write gate. */
  writeGate?: { runExclusive<T>(label: string, fn: () => Promise<T> | T): Promise<T> };
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

    // 记忆候选抽取是 LLM 能力：不可用/失败就如实暴露（503/429/502），不再"静默 0 候选照常导入"
    // ——那会让"抽取失败"与"资料确实没有值得记的内容"对用户不可区分。导入是原子操作：失败重试即可。
    // LLM 在写锁外；终写经 writeGate 重读 latest（IM-P1-03）。
    if (!options.bailianChatClient) {
      return reply.code(503).send({ error: "导入分析 LLM 未配置（缺少 DASHSCOPE_API_KEY），无法抽取记忆候选。" });
    }
    if (!budget.tryConsume("system")) {
      console.warn(JSON.stringify({ event: "llm_budget_exceeded", capability: "import_documents" }));
      return reply.code(429).send({ error: "本时段 LLM 预算已用尽，导入分析暂不可用，请稍后重试。" });
    }
    let candidates: Awaited<ReturnType<typeof extractCandidateMemories>>;
    try {
      // IM-P1-03: LLM extraction runs outside the global write slot (route exempt);
      // final ingest re-reads latest under writeGate.
      candidates = await extractCandidateMemories(input.title, input.content, options.bailianChatClient);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(JSON.stringify({ event: "llm_failed", capability: "import_documents", error: message }));
      return reply.code(502).send({ error: `导入资料的记忆抽取失败：${message}。本次未导入，请重试。` });
    }

    const commitImport = async () => {
      const latest = repository.getState();
      const { sourceId, candidateCount, nextState } = await ingestImportSource(
        latest,
        input,
        candidates,
        options.embeddingClient
      );
      // state 必须是 replaceState 返回的权威态(revision 已 bump),否则客户端下一次乐观 PUT 必 409。
      const persisted = await replaceStateDurable(repository, nextState);
      return { sourceId, candidateCount, persisted };
    };
    const { sourceId, candidateCount, persisted } = options.writeGate
      ? await options.writeGate.runExclusive("import-documents", commitImport)
      : await commitImport();
    // 知识索引补点：await 嵌入结果，把覆盖率诚实回传（R-P2-03）。
    let reindex = { chunkCount: 0, embeddedCount: 0, failed: false, staleDiscarded: false };
    if (options.knowledgeIndexRepository) {
      reindex = await reindexMaterial(
        persisted,
        sourceId,
        options.knowledgeIndexRepository,
        options.embeddingClient,
        budget
      );
    }
    const sourceChunks = persisted.ragChunks.filter((chunk) => chunk.sourceId === sourceId);
    const chunkCount = reindex.chunkCount > 0 ? reindex.chunkCount : sourceChunks.length;
    const embeddedChunkCount = reindex.embeddedCount;
    const embeddingReady = embeddedChunkCount > 0;
    const warning = !options.embeddingClient
      ? "资料已导入，但当前未配置嵌入模型：跨会话向量召回不可用，仅关键词/BM25 路径可命中。"
      : reindex.failed
        ? "资料已导入，但嵌入/索引失败：跨会话向量召回可能不可用。"
      : reindex.staleDiscarded
        ? "资料已导入，但索引在写入前被并发清空（stale epoch），请重试导入以重建向量。"
      : !embeddingReady
        ? "资料已导入，但本批片段未写入可用语义向量：跨会话向量召回可能不可用，仅关键词/BM25 路径可命中。"
        : undefined;
    return {
      sourceId,
      candidateCount,
      state: persisted,
      chunkCount,
      embeddedChunkCount,
      embeddingFailedCount: Math.max(0, chunkCount - embeddedChunkCount),
      embeddingReady,
      vectorRecallAvailable: embeddingReady,
      reindexFailed: reindex.failed,
      reindexStaleDiscarded: reindex.staleDiscarded,
      ...(warning ? { warning } : {})
    };
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
