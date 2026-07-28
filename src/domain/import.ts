// Material import → long-term-memory flywheel entry. Turns an imported document
// into a chunked ImportSource (for RAG/context) plus reviewable MemoryCandidates
// (the user must approve each before it enters long-term memory). Pure +
// deterministic so it can be unit-tested; the LLM extraction lives server-side.
import type { ImportSource, MemorySensitivity, ProductState, RagChunk } from "./types";
import { cloneState, makeId, nowIso, withAuditEvent } from "./utils";
import { withMemoryCandidateReview } from "./memoryReview";
import { planMemoryUpdate } from "./memory";
import { tagSourceThemes } from "./theme-tagging";

export interface ImportedMemoryCandidate {
  text: string;
  evidenceQuote: string;
  sensitivity: MemorySensitivity;
}

export interface ImportDocumentInput {
  title: string;
  content: string;
  sourceType: ImportSource["sourceType"];
  sourceUrl?: string;
}

/** Minimal interface for an embedding client — matches BailianEmbeddingClient exactly. */
export interface EmbeddingClient {
  embed(texts: string[]): Promise<number[][]>;
}

/**
 * DashScope text-embedding-v3 单批上限。
 * 超过此数会整批 400 失败；分批调用后合并结果。
 */
export const EMBED_BATCH_SIZE = 10;

/**
 * 单次导入最多为前 N 个 chunk 计算/存储 embedding。
 * 超出部分不存 embedding，走关键词召回。
 * // ponytail: 固定上限防 state 膨胀;规模上来再换外部向量库
 */
export const MAX_EMBEDDED_CHUNKS = 200;

/**
 * 将 texts 按 batchSize 分批调用 embeddingClient.embed，合并结果。
 * 单批失败不中断：该批返回对应数量的 undefined，chunk 走关键词召回。
 */
async function batchEmbed(
  client: EmbeddingClient,
  texts: string[],
  batchSize = EMBED_BATCH_SIZE
): Promise<(number[] | undefined)[]> {
  const results: (number[] | undefined)[] = [];
  for (let i = 0; i < texts.length; i += batchSize) {
    const batch = texts.slice(i, i + batchSize);
    try {
      const vecs = await client.embed(batch);
      for (let j = 0; j < batch.length; j++) {
        const vec = vecs[j];
        // 仅接受非空数组（空数组 = API 缺失该条）
        results.push(Array.isArray(vec) && vec.length > 0 ? vec : undefined);
      }
    } catch (err) {
      console.warn(
        `[import] embedding batch ${Math.floor(i / batchSize) + 1} failed, chunks will use keyword fallback:`,
        err instanceof Error ? err.message : err
      );
      // 该批所有 chunk 无 embedding
      for (let j = 0; j < batch.length; j++) {
        results.push(undefined);
      }
    }
  }
  return results;
}

/** Split text into ~maxChars chunks on paragraph/sentence boundaries. */
export function chunkDocument(content: string, maxChars = 600): string[] {
  const paragraphs = content
    .split(/\n{2,}|\r\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);
  const chunks: string[] = [];
  let current = "";
  for (const paragraph of paragraphs.length ? paragraphs : [content.trim()]) {
    if (!current) {
      current = paragraph;
    } else if (current.length + paragraph.length + 1 <= maxChars) {
      current = `${current}\n${paragraph}`;
    } else {
      chunks.push(current);
      current = paragraph;
    }
    while (current.length > maxChars) {
      chunks.push(current.slice(0, maxChars));
      current = current.slice(maxChars);
    }
  }
  if (current.trim()) {
    chunks.push(current.trim());
  }
  return chunks.filter((chunk) => chunk.trim().length > 0);
}

export async function ingestImportSource(
  state: ProductState,
  input: ImportDocumentInput,
  candidates: ImportedMemoryCandidate[],
  embeddingClient?: EmbeddingClient
): Promise<{ sourceId: string; candidateCount: number; nextState: ProductState }> {
  const createdAt = nowIso();
  const sourceId = makeId("import-source");

  const chunkTexts = chunkDocument(input.content);

  // 只对前 MAX_EMBEDDED_CHUNKS 个 chunk 计算 embedding，防止 state 无限膨胀。
  // 超出部分 chunk 不存 embedding，走关键词召回。
  let embeddings: (number[] | undefined)[] = [];
  if (embeddingClient && chunkTexts.length > 0) {
    const textsToEmbed = chunkTexts.slice(0, MAX_EMBEDDED_CHUNKS);
    const skippedCount = chunkTexts.length - textsToEmbed.length;
    if (skippedCount > 0) {
      console.warn(
        `[import] ${skippedCount} chunk(s) exceed MAX_EMBEDDED_CHUNKS(${MAX_EMBEDDED_CHUNKS}), skipping embedding (keyword fallback)`
      );
    }
    // 分批调用，≤ EMBED_BATCH_SIZE 每批，单批失败不阻塞导入
    embeddings = await batchEmbed(embeddingClient, textsToEmbed);
  }

  const ragChunks: RagChunk[] = chunkTexts.map((text, index) => {
    const vec = embeddings[index]; // undefined for chunks beyond cap or failed batches
    return {
      id: makeId("rag-chunk"),
      sourceId,
      title: `${input.title} #${index + 1}`,
      text,
      keywords: [],
      tokenEstimate: Math.ceil(text.length / 2),
      sourceUrl: input.sourceUrl,
      usage: "interview-context" as const,
      createdAt,
      // 仅非空数组才附 embedding（空数组不进 chunk，否则会污染向量检索）
      ...(vec !== undefined && vec.length > 0 ? { embedding: vec } : {})
    };
  });

  const importSource: ImportSource = {
    id: sourceId,
    title: input.title,
    sourceType: input.sourceType,
    sourceUrl: input.sourceUrl,
    content: input.content,
    status: "chunked",
    // IM-P1-01: do not mark the entire import source sensitive because one
    // candidate is sensitive — that hid all chunks from RAG/chat. Candidates keep
    // their own sensitivity; source stays normal for retrieval of the document body.
    sensitivity: "normal",
    searchBriefId: undefined,
    chunkIds: ragChunks.map((chunk) => chunk.id),
    relatedThemeIds: tagSourceThemes(`${input.title} ${input.content}`, state.themes),
    createdAt,
    updatedAt: createdAt
  };

  const memoryCandidates = candidates.map((candidate) => {
    // M2 (Task 6): surface an extract-then-update dedup hint to the HITL reviewer.
    // Candidates have no embedding here, so planMemoryUpdate uses token overlap.
    const plan = planMemoryUpdate({ text: candidate.text }, state.memoryRecords);
    return withMemoryCandidateReview({
      id: makeId("memory-candidate"),
      text: candidate.text,
      status: "pending" as const,
      sourceType: "import_source" as const,
      sourceId,
      evidenceQuote: candidate.evidenceQuote,
      reason: `从导入资料《${input.title}》中抽取，需你确认后才进入长期记忆。`,
      sensitivity: candidate.sensitivity,
      createdAt,
      suggestedUpdate: plan.op,
      ...(plan.op === "update" && plan.similarToRecordId ? { similarToRecordId: plan.similarToRecordId } : {})
    });
  });

  const next = cloneState(state);
  next.importSources = [importSource, ...next.importSources];
  next.ragChunks = [...ragChunks, ...next.ragChunks];
  next.memoryCandidates = [...memoryCandidates, ...next.memoryCandidates];

  const nextState = withAuditEvent(next, {
    type: "reference_material_imported",
    label: "导入资料已入库",
    detail: `《${input.title}》切分为 ${ragChunks.length} 个片段，抽取 ${memoryCandidates.length} 条待审记忆。`,
    severity: "info",
    entityType: "import_source",
    entityId: sourceId,
    createdAt
  });

  return { sourceId, candidateCount: memoryCandidates.length, nextState };
}
