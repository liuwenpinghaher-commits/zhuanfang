import type { SearchBriefInput, SearchProviderId, SourceHighlight } from "../../../../src/domain/types";
import { fetchWithTimeout, resolveRequestTimeoutMs } from "../request-timeout";

export const TAVILY_DEFAULT_BASE_URL = "https://api.tavily.com";
export const EXA_DEFAULT_BASE_URL = "https://api.exa.ai";
export const BRAVE_SEARCH_DEFAULT_BASE_URL = "https://api.search.brave.com";

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export type ExternalSearchProviderId = Extract<SearchProviderId, "tavily" | "exa" | "brave">;

export interface ExternalSearchBriefRequest {
  topic: string;
  providerId: ExternalSearchProviderId;
  maxSources: number;
  recencyDays: number;
}

export interface ExternalSearchClient {
  createSearchBrief(input: ExternalSearchBriefRequest): Promise<SearchBriefInput>;
}

export type ExternalSearchClients = Partial<Record<ExternalSearchProviderId, ExternalSearchClient>>;

interface ExternalSearchClientOptions {
  apiKey?: string;
  baseUrl?: string;
  language?: string;
  fetchImpl?: FetchLike;
  now?: () => Date;
  requestTimeoutMs?: number;
}

interface NormalizedExternalSearchResult {
  title: string;
  url: string;
  snippet: string;
  content: string;
  publishedAt?: string;
  relevanceScore?: number;
}

interface TavilySearchResponse {
  answer?: unknown;
  request_id?: unknown;
  results?: unknown;
}

interface ExaSearchResponse {
  requestId?: unknown;
  results?: unknown;
}

interface BraveSearchResponse {
  web?: {
    results?: unknown;
  };
}

const providerLabels: Record<ExternalSearchProviderId, string> = {
  tavily: "Tavily",
  exa: "Exa",
  brave: "Brave Search"
};

export function createTavilySearchClient(options: ExternalSearchClientOptions = {}): ExternalSearchClient {
  const baseUrl = normalizeBaseUrl(options.baseUrl, TAVILY_DEFAULT_BASE_URL);
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? (() => new Date());
  const requestTimeoutMs = options.requestTimeoutMs;

  return {
    async createSearchBrief(input) {
      const response = await fetchWithTimeout(fetchImpl, `${baseUrl}/search`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${requireApiKey(options.apiKey, "Tavily")}`,
          "content-type": "application/json"
        },
        body: JSON.stringify({
          query: input.topic,
          max_results: clampMaxSources(input.maxSources, 20),
          search_depth: "basic",
          include_answer: true,
          include_raw_content: false,
          topic: "general",
          time_range: resolveTavilyTimeRange(input.recencyDays)
        })
      }, requestTimeoutMs);

      if (!response.ok) {
        throw new Error(`Tavily API request failed: ${response.status}`);
      }

      const payload = (await response.json()) as TavilySearchResponse;
      const results = normalizeTavilyResults(payload.results, input.maxSources);
      if (results.length === 0) {
        throw new Error("Tavily response did not include search results.");
      }

      return buildSearchBrief({
        input,
        providerLabel: providerLabels.tavily,
        results,
        requestId: normalizeOptionalText(payload.request_id),
        answer: normalizeOptionalText(payload.answer),
        now
      });
    }
  };
}

export function createExaSearchClient(options: ExternalSearchClientOptions = {}): ExternalSearchClient {
  const baseUrl = normalizeBaseUrl(options.baseUrl, EXA_DEFAULT_BASE_URL);
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? (() => new Date());
  const requestTimeoutMs = options.requestTimeoutMs;

  return {
    async createSearchBrief(input) {
      const response = await fetchWithTimeout(fetchImpl, `${baseUrl}/search`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": requireApiKey(options.apiKey, "Exa")
        },
        body: JSON.stringify({
          query: input.topic,
          numResults: clampMaxSources(input.maxSources, 20),
          type: "auto",
          startPublishedDate: resolveStartPublishedDate(input.recencyDays, now),
          contents: {
            highlights: true,
            summary: true,
            text: {
              maxCharacters: 600
            }
          }
        })
      }, requestTimeoutMs);

      if (!response.ok) {
        throw new Error(`Exa API request failed: ${response.status}`);
      }

      const payload = (await response.json()) as ExaSearchResponse;
      const results = normalizeExaResults(payload.results, input.maxSources);
      if (results.length === 0) {
        throw new Error("Exa response did not include search results.");
      }

      return buildSearchBrief({
        input,
        providerLabel: providerLabels.exa,
        results,
        requestId: normalizeOptionalText(payload.requestId),
        now
      });
    }
  };
}

export function createBraveSearchClient(options: ExternalSearchClientOptions = {}): ExternalSearchClient {
  const baseUrl = normalizeBaseUrl(options.baseUrl, BRAVE_SEARCH_DEFAULT_BASE_URL);
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? (() => new Date());
  const requestTimeoutMs = options.requestTimeoutMs;

  return {
    async createSearchBrief(input) {
      const searchParams = new URLSearchParams({
        q: input.topic,
        count: String(clampMaxSources(input.maxSources, 20)),
        country: "US",
        search_lang: options.language ?? "zh-hans",
        ui_lang: "zh-CN",
        extra_snippets: "true"
      });
      const response = await fetchWithTimeout(fetchImpl, `${baseUrl}/res/v1/web/search?${searchParams.toString()}`, {
        method: "GET",
        headers: {
          accept: "application/json",
          "x-subscription-token": requireApiKey(options.apiKey, "Brave Search")
        }
      }, requestTimeoutMs);

      if (!response.ok) {
        throw new Error(`Brave Search API request failed: ${response.status}`);
      }

      const payload = (await response.json()) as BraveSearchResponse;
      const results = normalizeBraveResults(payload.web?.results, input.maxSources);
      if (results.length === 0) {
        throw new Error("Brave Search response did not include web results.");
      }

      return buildSearchBrief({
        input,
        providerLabel: providerLabels.brave,
        results,
        now
      });
    }
  };
}

export function createExternalSearchClientsFromEnv(
  env: Record<string, string | undefined> = process.env
): ExternalSearchClients {
  const tavilyApiKey = normalizeOptionalText(env.TAVILY_API_KEY);
  const exaApiKey = normalizeOptionalText(env.EXA_API_KEY);
  const braveApiKey = normalizeOptionalText(env.BRAVE_SEARCH_API_KEY);
  const requestTimeoutMs = resolveRequestTimeoutMs(env, "SEARCH_REQUEST_TIMEOUT_MS");

  return {
    ...(tavilyApiKey
      ? {
          tavily: createTavilySearchClient({
            apiKey: tavilyApiKey,
            baseUrl: normalizeOptionalText(env.TAVILY_BASE_URL),
            requestTimeoutMs
          })
        }
      : {}),
    ...(exaApiKey
      ? {
          exa: createExaSearchClient({
            apiKey: exaApiKey,
            baseUrl: normalizeOptionalText(env.EXA_BASE_URL),
            requestTimeoutMs
          })
        }
      : {}),
    ...(braveApiKey
      ? {
          brave: createBraveSearchClient({
            apiKey: braveApiKey,
            baseUrl: normalizeOptionalText(env.BRAVE_SEARCH_BASE_URL),
            requestTimeoutMs
          })
        }
      : {})
  };
}

function normalizeTavilyResults(value: unknown, maxSources: number): NormalizedExternalSearchResult[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.slice(0, maxSources).flatMap((item) => {
    const result = asRecord(item);
    const title = normalizeText(result.title);
    const url = normalizeText(result.url);
    if (!title || !url) {
      return [];
    }

    const content = normalizeText(result.content) || normalizeText(result.raw_content);
    return [
      {
        title,
        url,
        snippet: content || "Tavily 返回的候选来源摘要。",
        content: content || "",
        publishedAt: normalizeOptionalText(result.published_date),
        relevanceScore: normalizeScore(result.score)
      }
    ];
  });
}

function normalizeExaResults(value: unknown, maxSources: number): NormalizedExternalSearchResult[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.slice(0, maxSources).flatMap((item) => {
    const result = asRecord(item);
    const title = normalizeText(result.title);
    const url = normalizeText(result.url);
    if (!title || !url) {
      return [];
    }

    const highlights = normalizeTextArray(result.highlights);
    const text = normalizeText(result.text);
    const summary = normalizeText(result.summary);
    const evidence = highlights[0] || summary || text || "Exa 返回的候选来源摘要。";
    return [
      {
        title,
        url,
        snippet: evidence,
        content: summary || highlights.join(" ") || text,
        publishedAt: normalizeOptionalText(result.publishedDate)
      }
    ];
  });
}

function normalizeBraveResults(value: unknown, maxSources: number): NormalizedExternalSearchResult[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.slice(0, maxSources).flatMap((item) => {
    const result = asRecord(item);
    const title = stripMarkup(normalizeText(result.title));
    const url = normalizeText(result.url);
    if (!title || !url) {
      return [];
    }

    const description = stripMarkup(normalizeText(result.description));
    const extraSnippets = normalizeTextArray(result.extra_snippets).map(stripMarkup);
    const evidence = [description, ...extraSnippets].filter(Boolean).join(" ");
    return [
      {
        title,
        url,
        snippet: evidence || "Brave Search 返回的候选来源摘要。",
        content: evidence
      }
    ];
  });
}

function buildSearchBrief(input: {
  input: ExternalSearchBriefRequest;
  providerLabel: string;
  results: NormalizedExternalSearchResult[];
  requestId?: string;
  answer?: string;
  now: () => Date;
}): SearchBriefInput {
  const { providerId, topic } = input.input;
  const sources = input.results.map((result, index) => mapSource(providerId, result, index, input.now));
  const requestSuffix = input.requestId ? ` 请求 ${input.requestId}。` : "";
  const answerSuffix = input.answer ? ` 直接答案：${truncateText(input.answer, 120)}` : "";

  return {
    topic,
    provider: providerId,
    status: "ready",
    summary: `${input.providerLabel} 围绕「${topic}」返回 ${input.results.length} 个来源，首要线索是「${input.results[0].title}」。${answerSuffix}${requestSuffix}`.trim(),
    facts: input.results.slice(0, 3).map((result) => `${result.title}：${pickEvidence(result)}`),
    controversies: [
      `争议：${topic} 的外部讨论可能代表真实变化，也可能只是短期叙事，需要用户用具体经历校验。`,
      `争议：${pickEvidence(input.results[1] ?? input.results[0])}`
    ],
    opposingViews: [
      `反方观点：即使「${topic}」热度上升，也不代表用户所在团队已经准备好改变工作流。`,
      `反方观点：${pickEvidence(input.results[input.results.length - 1])}`
    ],
    interviewAngles: [
      `专访角度：把「${topic}」落到用户最近一个真实项目或一次冲突上。`,
      `专访角度：围绕「${input.results[0].title}」追问它到底解释了用户哪一个判断难题。`
    ],
    discussionTopics: [
      `专访切入：${topic} 对你当前判断的真实影响是什么？`,
      `哪些来源能解释你的具体困境，哪些只是热闹？首个来源：${input.results[0].title}`,
      "如果把外部趋势落到一个项目决策上，最小验证动作是什么？"
    ],
    sourceAngles: input.results
      .slice(0, 3)
      .map((result) => `引用「${result.title}」时只把它作为问题线索：${pickEvidence(result)}`),
    sources
  };
}

function mapSource(
  providerId: ExternalSearchProviderId,
  result: NormalizedExternalSearchResult,
  index: number,
  now: () => Date
): SourceHighlight {
  return {
    id: `source-${providerId}-${Date.now()}-${index + 1}`,
    title: result.title,
    url: result.url,
    publisher: getHostname(result.url),
    publishedAt: normalizePublishedAt(result.publishedAt, now),
    snippet: result.snippet,
    relevanceScore: result.relevanceScore ?? Math.max(0.5, 0.95 - index * 0.07),
    usage: index === 0 ? "topic-suggestion" : index === 1 ? "interview-context" : "post-note-reference"
  };
}

function normalizeBaseUrl(value: string | undefined, fallback: string) {
  return (value?.trim() || fallback).replace(/\/$/, "");
}

function requireApiKey(value: string | undefined, providerLabel: string) {
  const apiKey = value?.trim();
  if (!apiKey) {
    throw new Error(`${providerLabel} API key 未配置。`);
  }
  return apiKey;
}

function clampMaxSources(value: number, providerLimit: number) {
  return Math.max(1, Math.min(Math.trunc(value), providerLimit));
}

function resolveTavilyTimeRange(recencyDays: number) {
  if (recencyDays <= 1) {
    return "day";
  }
  if (recencyDays <= 7) {
    return "week";
  }
  if (recencyDays <= 31) {
    return "month";
  }
  return "year";
}

function resolveStartPublishedDate(recencyDays: number, now: () => Date) {
  const date = new Date(now().getTime() - Math.max(1, recencyDays) * 24 * 60 * 60 * 1000);
  return date.toISOString();
}

function normalizeText(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function normalizeOptionalText(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function normalizeTextArray(value: unknown) {
  return Array.isArray(value) ? value.map((item) => normalizeText(item)).filter(Boolean) : [];
}

function normalizeScore(value: unknown) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }
  return Math.max(0, Math.min(value, 1));
}

function normalizePublishedAt(value: string | undefined, now: () => Date) {
  if (!value) {
    return now().toISOString();
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? now().toISOString() : parsed.toISOString();
}

function pickEvidence(result: NormalizedExternalSearchResult) {
  return truncateText(result.content || result.snippet, 140);
}

function truncateText(value: string, maxLength: number) {
  return value.length > maxLength ? `${value.slice(0, maxLength - 1)}...` : value;
}

function getHostname(url: string) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "external-search";
  }
}

function stripMarkup(value: string) {
  return value
    .replace(/<[^>]*>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}
