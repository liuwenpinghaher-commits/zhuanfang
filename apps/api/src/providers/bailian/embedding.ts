/** Domain facade: embedding */
export {
  createBailianEmbeddingClient,
  createBailianEmbeddingClientFromEnv,
  resolveBailianEmbeddingBaseUrl,
  BAILIAN_EMBEDDING_MODEL,
  BAILIAN_DEFAULT_EMBEDDING_BASE_URL
} from "./_impl";
export type {
  BailianEmbeddingClient
} from "./_impl";
