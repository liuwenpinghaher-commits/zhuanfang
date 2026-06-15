import { describe, expect, it, vi, type Mock } from "vitest";
import { createAnySearchClient } from "./anysearch";

type FetchMock = Mock<(input: string, init?: RequestInit) => Promise<Response>>;
function getFetchCallInit(mock: FetchMock): RequestInit | undefined {
  const calls = mock.mock.calls as [string, RequestInit | undefined][];
  return calls[0]?.[1];
}

describe("anysearch provider client", () => {
  it("posts search requests to AnySearch and maps structured results into interview material", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(
        JSON.stringify({
          code: 0,
          message: "success",
          data: {
            results: [
              {
                title: "Agentic search is reshaping product research",
                url: "https://example.com/agentic-search",
                snippet: "Teams are adding search infrastructure to agent workflows.",
                content:
                  "Agentic search systems retrieve fresh sources, extract content, and give product teams a more grounded way to discuss market changes."
              },
              {
                title: "AI workflow adoption creates new operating tensions",
                url: "https://example.com/ai-workflow",
                snippet: "AI products change team responsibilities and decision loops.",
                content:
                  "The practical controversy is whether AI reduces coordination cost or simply moves more judgment work to product leaders."
              }
            ],
            metadata: {
              request_id: "req-anysearch-test",
              total_results: 2,
              search_time_ms: 341
            }
          }
        }),
        { status: 200 }
      )
    );
    const client = createAnySearchClient({
      apiKey: "test-anysearch-key",
      fetchImpl
    });

    const result = await client.createSearchBrief({
      topic: "AI 产品商业化热点",
      providerId: "anysearch",
      maxSources: 2,
      recencyDays: 14
    });

    expect(fetchImpl).toHaveBeenCalledWith(
      "https://api.anysearch.com/v1/search",
      expect.objectContaining({
        method: "POST",
        headers: {
          authorization: "Bearer test-anysearch-key",
          "content-type": "application/json"
        }
      })
    );
    const requestBody = JSON.parse(getFetchCallInit(fetchImpl as FetchMock)?.body as string);
    expect(requestBody).toMatchObject({
      query: "AI 产品商业化热点",
      max_results: 2,
      content_types: ["web", "news"],
      language: "zh-CN"
    });
    expect(result).toMatchObject({
      topic: "AI 产品商业化热点",
      provider: "anysearch",
      status: "ready",
      facts: expect.arrayContaining([expect.stringContaining("Agentic search")]),
      controversies: expect.arrayContaining([expect.stringContaining("争议")]),
      opposingViews: expect.arrayContaining([expect.stringContaining("反方")]),
      interviewAngles: expect.arrayContaining([expect.stringContaining("专访")])
    });
    expect(result.sources).toHaveLength(2);
    expect(result.sources[0]).toMatchObject({
      title: "Agentic search is reshaping product research",
      url: "https://example.com/agentic-search",
      publisher: "example.com",
      usage: "topic-suggestion"
    });
  });

  it("can run AnySearch anonymous mode when explicitly configured without an API key", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(
        JSON.stringify({
          code: 0,
          message: "success",
          data: {
            results: [
              {
                title: "Anonymous tier result",
                url: "https://example.com/free",
                snippet: "Anonymous AnySearch access returned a result."
              }
            ]
          }
        }),
        { status: 200 }
      )
    );
    const client = createAnySearchClient({ fetchImpl });

    const result = await client.createSearchBrief({
      topic: "匿名搜索",
      providerId: "anysearch",
      maxSources: 1,
      recencyDays: 3
    });

    const headers = getFetchCallInit(fetchImpl as FetchMock)?.headers as Record<string, string>;
    expect(headers.authorization).toBeUndefined();
    expect(result.sources[0].publisher).toBe("example.com");
  });
});
