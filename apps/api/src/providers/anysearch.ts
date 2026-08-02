import type { SearchBriefInput, SearchProviderId, SourceHighlight } from "../../../../src/domain/types";
import { fetchWithTimeout, resolveRequestTimeoutMs } from "../request-timeout";
import { normalizeConfiguredSecret } from "../runtime-secrets";

export const ANYSEARCH_DEFAULT_BASE_URL = "https://api.anysearch.com";

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface AnySearchClient {
  createSearchBrief(input: AnySearchBriefRequest): Promise<SearchBriefInput>;
  getAvailability?(): AnySearchAvailability;
}

export type AnySearchAvailabilityStatus = "unknown" | "available" | "unavailable";

export interface AnySearchAvailability {
  status: AnySearchAvailabilityStatus;
  lastCheckedAt?: string;
  lastErrorCode?: string;
}

export interface AnySearchBriefRequest {
  topic: string;
  providerId: Extract<SearchProviderId, "anysearch">;
  maxSources: number;
  recencyDays: number;
}

interface AnySearchClientOptions {
  apiKey?: string;
  baseUrl?: string;
  language?: string;
  zone?: "cn" | "intl";
  fetchImpl?: FetchLike;
  requestTimeoutMs?: number;
}

interface AnySearchResponse {
  code?: unknown;
  message?: unknown;
  data?: {
    results?: unknown;
    metadata?: {
      request_id?: unknown;
      total_results?: unknown;
      search_time_ms?: unknown;
    };
  };
}

interface NormalizedAnySearchResult {
  title: string;
  url: string;
  snippet: string;
  content: string;
}

export function createAnySearchClient(options: AnySearchClientOptions = {}): AnySearchClient {
  const baseUrl = (options.baseUrl ?? ANYSEARCH_DEFAULT_BASE_URL).replace(/\/$/, "");
  const language = options.language ?? "zh-CN";
  const fetchImpl = options.fetchImpl ?? fetch;
  const requestTimeoutMs = options.requestTimeoutMs;
  let availability: AnySearchAvailability = { status: "unknown" };

  return {
    getAvailability() {
      return { ...availability };
    },
    async createSearchBrief(input) {
      try {
        const headers: Record<string, string> = {
          "content-type": "application/json"
        };
        if (options.apiKey?.trim()) {
          headers.authorization = `Bearer ${options.apiKey.trim()}`;
        }

        const response = await fetchWithTimeout(fetchImpl, `${baseUrl}/v1/search`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            query: input.topic,
            max_results: input.maxSources,
            content_types: ["web", "news"],
            language,
            ...(options.zone ? { zone: options.zone } : {}),
            params: {
              recency_days: input.recencyDays
            }
          })
        }, requestTimeoutMs);

        if (!response.ok) {
          throw new Error(`AnySearch API request failed: ${response.status}`);
        }

        const payload = (await response.json()) as AnySearchResponse;
        if (payload.code !== undefined && Number(payload.code) !== 0) {
          throw new Error(`AnySearch API returned non-zero code: ${String(payload.message ?? payload.code)}`);
        }

        const results = normalizeResults(payload.data?.results, input.maxSources);
        if (results.length === 0) {
          throw new Error("AnySearch response did not include search results.");
        }

        const sources = results.map((result, index) => mapSource(result, index));
        const requestId = typeof payload.data?.metadata?.request_id === "string" ? payload.data.metadata.request_id : undefined;
        availability = { status: "available", lastCheckedAt: new Date().toISOString() };

        return {
          topic: input.topic,
          provider: "anysearch",
          status: "ready",
          summary: buildSummary(input.topic, results, requestId),
          facts: results.slice(0, 3).map((result) => `${result.title}：${pickEvidence(result)}`),
          controversies: buildControversies(input.topic, results),
          opposingViews: buildOpposingViews(input.topic, results),
          interviewAngles: buildInterviewAngles(input.topic, results),
          discussionTopics: buildDiscussionTopics(input.topic, results),
          sourceAngles: buildSourceAngles(results),
          sources
        };
      } catch (error) {
        availability = {
          status: "unavailable",
          lastCheckedAt: new Date().toISOString(),
          lastErrorCode: classifyAvailabilityError(error),
        };
        throw error;
      }
    }
  };
}

function classifyAvailabilityError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const httpStatus = message.match(/request failed:\s*(\d{3})/i)?.[1];
  if (httpStatus) return `http_${httpStatus}`;
  if (/abort|timeout|timed out/i.test(message) || (error instanceof Error && error.name === "AbortError")) return "timeout";
  if (/non-zero code/i.test(message)) return "provider_code";
  if (/did not include search results/i.test(message)) return "empty_results";
  return "request_error";
}

export function createAnySearchClientFromEnv(env: Record<string, string | undefined> = process.env): AnySearchClient | undefined {
  const apiKey = normalizeConfiguredSecret(env.ANYSEARCH_API_KEY);
  const allowAnonymous = env.ANYSEARCH_ALLOW_ANONYMOUS === "true";
  if (!apiKey && !allowAnonymous) {
    return undefined;
  }

  return createAnySearchClient({
    apiKey,
    baseUrl: env.ANYSEARCH_BASE_URL,
    language: env.ANYSEARCH_LANGUAGE,
    zone: normalizeZone(env.ANYSEARCH_ZONE),
    requestTimeoutMs: resolveRequestTimeoutMs(env, "SEARCH_REQUEST_TIMEOUT_MS")
  });
}

function normalizeResults(value: unknown, maxSources: number): NormalizedAnySearchResult[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .slice(0, maxSources)
    .map((item) => {
      const result = item && typeof item === "object" ? (item as Record<string, unknown>) : {};
      const title = normalizeText(result.title, "");
      const url = normalizeText(result.url, "");
      if (!title || !url) {
        return undefined;
      }
      return {
        title,
        url,
        snippet: normalizeText(result.snippet, "AnySearch 返回的候选来源摘要。"),
        content: normalizeText(result.content, "")
      };
    })
    .filter((item): item is NormalizedAnySearchResult => Boolean(item));
}

function mapSource(result: NormalizedAnySearchResult, index: number): SourceHighlight {
  return {
    id: `source-anysearch-${Date.now()}-${index + 1}`,
    title: result.title,
    url: result.url,
    publisher: getHostname(result.url),
    publishedAt: new Date().toISOString(),
    snippet: result.snippet,
    relevanceScore: Math.max(0.5, 0.95 - index * 0.07),
    usage: index === 0 ? "topic-suggestion" : index === 1 ? "interview-context" : "post-note-reference"
  };
}

function buildSummary(topic: string, results: NormalizedAnySearchResult[], requestId: string | undefined) {
  const suffix = requestId ? ` 请求 ${requestId}。` : "";
  return `AnySearch 围绕「${topic}」返回 ${results.length} 个来源，首要线索是「${results[0].title}」。${suffix}`.trim();
}

function buildControversies(topic: string, results: NormalizedAnySearchResult[]) {
  return [
    `争议：${topic} 的外部讨论可能代表真实变化，也可能只是短期叙事，需要用户用具体经历校验。`,
    `争议：${pickEvidence(results[1] ?? results[0])}`
  ];
}

function buildOpposingViews(topic: string, results: NormalizedAnySearchResult[]) {
  return [
    `反方观点：即使「${topic}」热度上升，也不代表用户所在团队已经准备好改变工作流。`,
    `反方观点：${pickEvidence(results[results.length - 1])}`
  ];
}

function buildInterviewAngles(topic: string, results: NormalizedAnySearchResult[]) {
  return [
    `专访角度：把「${topic}」落到用户最近一个真实项目或一次冲突上。`,
    `专访角度：围绕「${results[0].title}」追问它到底解释了用户哪一个判断难题。`
  ];
}

function buildDiscussionTopics(topic: string, results: NormalizedAnySearchResult[]) {
  return [
    `专访切入：${topic} 对你当前判断的真实影响是什么？`,
    `哪些来源能解释你的具体困境，哪些只是热闹？首个来源：${results[0].title}`,
    "如果把外部趋势落到一个项目决策上，最小验证动作是什么？"
  ];
}

function buildSourceAngles(results: NormalizedAnySearchResult[]) {
  return results.slice(0, 3).map((result) => `引用「${result.title}」时只把它作为问题线索：${pickEvidence(result)}`);
}

function pickEvidence(result: NormalizedAnySearchResult) {
  return truncateText(result.content || result.snippet, 140);
}

function normalizeText(value: unknown, fallback: string) {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function truncateText(value: string, maxLength: number) {
  return value.length > maxLength ? `${value.slice(0, maxLength - 1)}...` : value;
}

function getHostname(url: string) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "AnySearch";
  }
}

function normalizeZone(value: string | undefined) {
  return value === "cn" || value === "intl" ? value : undefined;
}
