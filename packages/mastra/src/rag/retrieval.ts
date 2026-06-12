export const retrievalConfig = {
  topK: 10,
  minSimilarity: 0.5,
  rerank: {
    enabled: true,
    model: process.env.RERANK_MODEL || "gte-rerank",
    topN: 5,
  },
  hybridSearch: {
    enabled: true,
    semanticWeight: 0.7,
    keywordWeight: 0.3,
  },
};
