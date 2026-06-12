import { Memory } from "@mastra/memory";

export const semanticMemory = new Memory({
  options: {
    lastMessages: 50,
    semanticRecall: {
      topK: 5,
      messageRange: { before: 5, after: 3 },
    },
  },
  vector: "libsql" as const,
  embedder: "openai/text-embedding-3-small",
});
