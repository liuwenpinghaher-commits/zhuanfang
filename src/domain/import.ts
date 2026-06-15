// Material import → long-term-memory flywheel entry. Turns an imported document
// into a chunked ImportSource (for RAG/context) plus reviewable MemoryCandidates
// (the user must approve each before it enters long-term memory). Pure +
// deterministic so it can be unit-tested; the LLM extraction lives server-side.
import type { ImportSource, MemorySensitivity, ProductState, RagChunk } from "./types";
import { cloneState, makeId, nowIso, withAuditEvent } from "./utils";
import { withMemoryCandidateReview } from "./memoryReview";

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

export function ingestImportSource(
  state: ProductState,
  input: ImportDocumentInput,
  candidates: ImportedMemoryCandidate[]
): { sourceId: string; candidateCount: number; nextState: ProductState } {
  const createdAt = nowIso();
  const sourceId = makeId("import-source");

  const chunks = chunkDocument(input.content);
  const ragChunks: RagChunk[] = chunks.map((text, index) => ({
    id: makeId("rag-chunk"),
    sourceId,
    title: `${input.title} #${index + 1}`,
    text,
    keywords: [],
    tokenEstimate: Math.ceil(text.length / 2),
    sourceUrl: input.sourceUrl,
    usage: "interview-context" as const,
    createdAt
  }));

  const importSource: ImportSource = {
    id: sourceId,
    title: input.title,
    sourceType: input.sourceType,
    sourceUrl: input.sourceUrl,
    content: input.content,
    status: "chunked",
    sensitivity: candidates.some((candidate) => candidate.sensitivity === "sensitive") ? "sensitive" : "normal",
    searchBriefId: "",
    chunkIds: ragChunks.map((chunk) => chunk.id),
    createdAt,
    updatedAt: createdAt
  };

  const memoryCandidates = candidates.map((candidate) =>
    withMemoryCandidateReview({
      id: makeId("memory-candidate"),
      text: candidate.text,
      status: "pending" as const,
      sourceType: "import_source" as const,
      sourceId,
      evidenceQuote: candidate.evidenceQuote,
      reason: `从导入资料《${input.title}》中抽取，需你确认后才进入长期记忆。`,
      sensitivity: candidate.sensitivity,
      createdAt
    })
  );

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
