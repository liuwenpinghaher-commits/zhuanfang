// @vitest-environment node
// ↑ onnxruntime-node 的 float32 tensor 要求原生 Float32Array;vitest 默认 jsdom 环境的
//   Float32Array 与之不兼容(报 "A float32 tensor's data must be type of Float32Array"),
//   故本地 embedding 相关测试必须在 node 环境跑。生产 server 本就是 node,不受影响。
/**
 * 真实 bge-large-zh-v1.5 embedding 测试(**不 mock** transformers.js,加载真实 ONNX 模型)。
 * 补 local-embedding.test 的 mock 盲区:验证本地 embedding 真实产出 1024 维、单位向量、语义可分。
 *
 * gate:模型已缓存(B2 spike 下载到 node_modules/@huggingface/transformers/.cache)时才跑;
 *      CI/未缓存环境联网下载数百 MB(且本机 TLS 拦截),故 skipIf 缺缓存时跳过(诚实标注、非静默)。
 */
import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { createLocalEmbeddingClient } from "./local-embedding";

const MODEL_CACHE = join(process.cwd(), "node_modules/@huggingface/transformers/.cache/Xenova/bge-large-zh-v1.5");
const hasModel = existsSync(MODEL_CACHE);

function cosine(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

describe.skipIf(!hasModel)("real local embedding · bge-large-zh-v1.5(真实模型,非 mock)", () => {
  it("真实 embed 产出 1024 维有限单位向量(匹配 HNSW DIMENSION + COSINE)", async () => {
    const vecs = await createLocalEmbeddingClient().embed(["放权与拍板的边界在哪里"]);
    expect(vecs).toHaveLength(1);
    expect(vecs[0]).toHaveLength(1024);
    expect(vecs[0].every(Number.isFinite)).toBe(true);
    // normalize:true → 单位向量(模长≈1),与 HNSW DIST COSINE 一致
    const norm = Math.sqrt(vecs[0].reduce((s, x) => s + x * x, 0));
    expect(Math.abs(norm - 1)).toBeLessThan(0.02);
  }, 60000);

  it("真实 embed 语义可分:近义句余弦 > 不相关句(证明是真模型、不是噪声/常量)", async () => {
    const [authorize, delegate, lunch] = await createLocalEmbeddingClient().embed([
      "如何把决策权放权给团队负责人",
      "怎样授权下属独立做判断",
      "今天中午食堂吃什么"
    ]);
    expect(cosine(authorize, delegate)).toBeGreaterThan(cosine(authorize, lunch));
  }, 60000);

  it("空输入直接返回 [](不触发模型加载)", async () => {
    expect(await createLocalEmbeddingClient().embed([])).toEqual([]);
  });
});
