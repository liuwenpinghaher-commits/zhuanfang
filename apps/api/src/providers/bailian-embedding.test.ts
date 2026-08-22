import { describe, expect, it, vi } from "vitest";
import {
  BAILIAN_DEFAULT_EMBEDDING_BASE_URL,
  createBailianEmbeddingClient,
  createBailianEmbeddingClientFromEnv,
  resolveBailianEmbeddingBaseUrl
} from "./bailian";

// 生产客户端做维度校验:非 1024 维(=HNSW DIMENSION)的坏向量绝不入库,直接抛错。
// 测试 mock 因此必须返回真实维度的向量。
const vec1024 = (head: number[]): number[] => {
  const v = new Array(1024).fill(0);
  head.forEach((x, i) => { v[i] = x; });
  return v;
};

describe("createBailianEmbeddingClient", () => {
  it("embeds texts via DashScope compatible-mode embeddings endpoint", async () => {
    const a = vec1024([1, 0]);
    const b = vec1024([0, 1]);
    const fetchImpl = vi.fn(async () =>
      new Response(
        JSON.stringify({
          data: [
            { embedding: a },
            { embedding: b }
          ]
        }),
        { status: 200 }
      )
    );

    const client = createBailianEmbeddingClient({
      apiKey: "k",
      baseUrl: "https://x",
      fetchImpl
    });

    expect(client).not.toBeNull();
    const result = await client!.embed(["a", "b"]);

    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://x/embeddings");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["authorization"]).toBe("Bearer k");
    expect((init.headers as Record<string, string>)["content-type"]).toBe("application/json");
    const body = JSON.parse(init.body as string);
    // compatible-mode /embeddings 要 OpenAI 格式: input 直接是 string[] 而非 { texts }
    expect(body).toMatchObject({
      model: "text-embedding-v3",
      input: ["a", "b"]
    });
    expect(body.input).not.toHaveProperty("texts");
    expect(result).toEqual([a, b]);
  });

  it("throws when the provider returns a non-1024-dim vector (坏向量绝不入库)", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ data: [{ embedding: [1, 0] }] }), { status: 200 })
    );
    const client = createBailianEmbeddingClient({ apiKey: "k", baseUrl: "https://x", fetchImpl });
    await expect(client!.embed(["a"])).rejects.toThrow("2-dim vector (expected 1024)");
  });

  it("returns null when apiKey is empty string", () => {
    const client = createBailianEmbeddingClient({ apiKey: "" });
    expect(client).toBeNull();
  });

  it("returns null when apiKey is omitted", () => {
    const client = createBailianEmbeddingClient({} as { apiKey: string });
    expect(client).toBeNull();
  });

  it("does not POST embeddings to the chat token-plan URL", async () => {
    expect(
      resolveBailianEmbeddingBaseUrl({
        BAILIAN_BASE_URL: "https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1"
      })
    ).toBe(BAILIAN_DEFAULT_EMBEDDING_BASE_URL);
    expect(
      resolveBailianEmbeddingBaseUrl({
        BAILIAN_BASE_URL: "https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1",
        BAILIAN_EMBEDDING_BASE_URL: "https://example.test/emb/v1"
      })
    ).toBe("https://example.test/emb/v1");

    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ data: [{ embedding: vec1024([1]) }] }), { status: 200 })
    );
    const client = createBailianEmbeddingClient({ apiKey: "k", fetchImpl });
    await client!.embed(["授权"]);
    const url = String((fetchImpl.mock.calls[0] as unknown as [string])[0]);
    expect(url).toBe("https://dashscope.aliyuncs.com/compatible-mode/v1/embeddings");
    expect(url).not.toMatch(/token-plan/);
  });
});

describe("createBailianEmbeddingClientFromEnv", () => {
  it("does not use the chat/token-plan key for embeddings", () => {
    expect(createBailianEmbeddingClientFromEnv({
      DASHSCOPE_API_KEY: "chat-key"
    })).toBeNull();
  });

  it("creates a client when the dedicated embeddings key is set", () => {
    expect(createBailianEmbeddingClientFromEnv({
      BAILIAN_EMBEDDING_API_KEY: "emb-key"
    })).not.toBeNull();
  });
});
