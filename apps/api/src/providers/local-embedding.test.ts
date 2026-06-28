import { describe, it, expect, vi } from "vitest";

// mock transformers.js:验证 client 逻辑(批量/空/tolist 透传),不加载真实模型(~20s+下载)。
// 真实 bge-large-zh embed 由 spike + 端到端冒烟验证(1024维/22ms/离线)。
vi.mock("@huggingface/transformers", () => ({
  pipeline: vi.fn(async () => {
    // 模拟 extractor:返回 [n, 1024] 的 Tensor-like(tolist)。
    return async (texts: string[]) => ({
      tolist: () => texts.map(() => new Array(1024).fill(0.1))
    });
  })
}));

import { createLocalEmbeddingClient } from "./local-embedding";

describe("local-embedding client", () => {
  it("空输入直接返回 [](不触发模型加载)", async () => {
    expect(await createLocalEmbeddingClient().embed([])).toEqual([]);
  });

  it("批量 embed → [n, 1024],与 HNSW 维度一致", async () => {
    const vecs = await createLocalEmbeddingClient().embed(["放权", "控制感", "去中心化"]);
    expect(vecs.length).toBe(3);
    expect(vecs[0].length).toBe(1024);
    expect(vecs.every((v) => v.every(Number.isFinite))).toBe(true);
  });

  it("实现 BailianEmbeddingClient 接口(embed 方法)", () => {
    expect(typeof createLocalEmbeddingClient().embed).toBe("function");
  });
});
