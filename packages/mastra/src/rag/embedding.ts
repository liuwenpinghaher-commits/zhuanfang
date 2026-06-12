export const embeddingConfig = {
  provider: "openai" as const,
  model: process.env.EMBEDDING_MODEL || "text-embedding-v3",
  dimensions: 1024,
  batchSize: 20,
};
