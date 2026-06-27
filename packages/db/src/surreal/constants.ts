/** DashScope text-embedding-v3 默认输出维度。S0/S5 用真实向量确认;
 *  003_index.surql 的 HNSW DIMENSION 必须与此一致(apply-schema.test.ts 守卫,防漂移)。 */
export const EMBEDDING_DIMENSION = 1024;

/** SurrealDB 命名空间/库(与任何其他用途隔离,spec 01 §1)。 */
export const SURREAL_NS = "interview";
export const SURREAL_DB = "main";
