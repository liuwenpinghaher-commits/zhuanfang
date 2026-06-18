import { describe, expect, it } from "vitest";
import { createInitialProductState } from "./engine";
import { chunkDocument, ingestImportSource } from "./import";
import type { BailianEmbeddingClient } from "../../apps/api/src/providers/bailian";

describe("chunkDocument", () => {
  it("splits on paragraphs and caps chunk size", () => {
    const text = `${"a".repeat(700)}\n\n${"b".repeat(100)}`;
    const chunks = chunkDocument(text, 600);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.length <= 600)).toBe(true);
  });

  it("returns a single chunk for short text", () => {
    expect(chunkDocument("hello world", 600)).toEqual(["hello world"]);
  });
});

describe("ingestImportSource", () => {
  it("creates an import source, rag chunks, and pending candidates", async () => {
    const state = createInitialProductState();
    const { sourceId, candidateCount, nextState } = await ingestImportSource(
      state,
      { title: "T", content: "para one\n\npara two", sourceType: "text" },
      [
        { text: "fact A", evidenceQuote: "para one", sensitivity: "normal" },
        { text: "secret B", evidenceQuote: "para two", sensitivity: "sensitive" }
      ]
    );

    expect(candidateCount).toBe(2);
    expect(nextState.importSources[0].id).toBe(sourceId);
    // sensitivity rolls up to sensitive when any candidate is sensitive
    expect(nextState.importSources[0].sensitivity).toBe("sensitive");
    expect(nextState.ragChunks.length).toBeGreaterThan(0);

    const newCandidates = nextState.memoryCandidates.filter((candidate) => candidate.sourceId === sourceId);
    expect(newCandidates).toHaveLength(2);
    expect(newCandidates.every((candidate) => candidate.status === "pending")).toBe(true);
    expect(newCandidates.every((candidate) => typeof candidate.reviewScore === "number")).toBe(true);
    expect(newCandidates.every((candidate) => candidate.sourceType === "import_source")).toBe(true);
  });

  it("does not mutate the input state", async () => {
    const state = createInitialProductState();
    const before = state.importSources.length;
    await ingestImportSource(state, { title: "T", content: "x", sourceType: "text" }, []);
    expect(state.importSources.length).toBe(before);
  });

  it("attaches embeddings to chunks when embeddingClient is provided", async () => {
    const fakeEmbedding = [0.1, 0.2, 0.3];
    const fakeClient: BailianEmbeddingClient = {
      embed: async (texts: string[]) => texts.map(() => fakeEmbedding)
    };

    const state = createInitialProductState();
    const { sourceId, nextState } = await ingestImportSource(
      state,
      { title: "Embed Test", content: "paragraph alpha\n\nparagraph beta", sourceType: "text" },
      [],
      fakeClient
    );

    const newChunks = nextState.ragChunks.filter((chunk) => chunk.sourceId === sourceId);
    expect(newChunks.length).toBeGreaterThan(0);
    // Every chunk should have an embedding attached
    expect(newChunks.every((chunk) => Array.isArray(chunk.embedding))).toBe(true);
    expect(newChunks[0].embedding).toEqual(fakeEmbedding);
  });

  it("produces chunks without embedding when no embeddingClient is provided", async () => {
    const state = createInitialProductState();
    const { sourceId, nextState } = await ingestImportSource(
      state,
      { title: "No Embed", content: "some content here", sourceType: "text" },
      []
      // no embeddingClient
    );

    const newChunks = nextState.ragChunks.filter((chunk) => chunk.sourceId === sourceId);
    expect(newChunks.length).toBeGreaterThan(0);
    expect(newChunks.every((chunk) => chunk.embedding === undefined)).toBe(true);
  });

  it("does not throw when embeddingClient.embed fails — chunks still ingested", async () => {
    const failingClient: BailianEmbeddingClient = {
      embed: async () => { throw new Error("network error"); }
    };

    const state = createInitialProductState();
    const { sourceId, nextState } = await ingestImportSource(
      state,
      { title: "Fail Embed", content: "content that fails to embed", sourceType: "text" },
      [],
      failingClient
    );

    const newChunks = nextState.ragChunks.filter((chunk) => chunk.sourceId === sourceId);
    // Chunks still written, just without embeddings
    expect(newChunks.length).toBeGreaterThan(0);
    expect(newChunks.every((chunk) => chunk.embedding === undefined)).toBe(true);
  });
});
