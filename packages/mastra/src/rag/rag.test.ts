import { describe, it, expect } from "vitest";

describe("rag config", () => {
  it("chunkingConfig has strategies", async () => {
    const { chunkingConfig } = await import("./chunking");
    expect(chunkingConfig.strategies.sentence).toBeDefined();
    expect(chunkingConfig.defaultStrategy).toBe("recursive");
  });

  it("embeddingConfig has model", async () => {
    const { embeddingConfig } = await import("./embedding");
    expect(embeddingConfig.model).toBeTruthy();
  });

  it("retrievalConfig has topK", async () => {
    const { retrievalConfig } = await import("./retrieval");
    expect(retrievalConfig.topK).toBe(10);
  });
});
