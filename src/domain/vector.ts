/**
 * Vector similarity utilities for semantic (embedding-based) retrieval.
 * Zero external dependencies — all pure arithmetic.
 */

/**
 * Computes the cosine similarity between two numeric vectors.
 *
 * Edge cases:
 * - Zero vector (magnitude 0): returns 0 instead of NaN.
 * - Dimension mismatch: treated as incomparable, returns 0.
 *
 * @returns A value in [-1, 1], or 0 for incomparable inputs.
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;

  let dot = 0;
  let magA = 0;
  let magB = 0;

  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }

  const denom = Math.sqrt(magA) * Math.sqrt(magB);
  if (denom === 0) return 0;

  return dot / denom;
}

/**
 * Filters items that have an `embedding` field, scores each against `query`
 * via cosine similarity, and returns the top-k sorted by similarity descending.
 *
 * Items without an `embedding` field are silently excluded.
 *
 * @param query  - The query embedding vector.
 * @param items  - Candidate items; only those with `.embedding` are ranked.
 * @param k      - Maximum number of results to return.
 */
export function topKByCosine<T extends { embedding?: number[] }>(
  query: number[],
  items: T[],
  k: number
): T[] {
  return items
    .filter((item): item is T & { embedding: number[] } =>
      Array.isArray(item.embedding) && item.embedding.length > 0
    )
    .map((item) => ({
      item,
      score: cosineSimilarity(query, item.embedding),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, k)
    .map(({ item }) => item);
}
