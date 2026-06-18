import { describe, expect, it, vi } from "vitest";
import { createBailianEmbeddingClient } from "./bailian";

describe("createBailianEmbeddingClient", () => {
  it("embeds texts via DashScope compatible-mode embeddings endpoint", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(
        JSON.stringify({
          data: [
            { embedding: [1, 0] },
            { embedding: [0, 1] }
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
    expect(body).toMatchObject({
      model: "text-embedding-v3",
      input: { texts: ["a", "b"] }
    });
    expect(result).toEqual([[1, 0], [0, 1]]);
  });

  it("returns null when apiKey is empty string", () => {
    const client = createBailianEmbeddingClient({ apiKey: "" });
    expect(client).toBeNull();
  });

  it("returns null when apiKey is omitted", () => {
    const client = createBailianEmbeddingClient({} as { apiKey: string });
    expect(client).toBeNull();
  });
});
