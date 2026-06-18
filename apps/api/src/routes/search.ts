import type { FastifyInstance } from "fastify";
import type { AnySearchClient } from "../providers/anysearch";
import type { BailianSearchClient } from "../providers/bailian";
import { executeSearchProvider } from "../../../../src/capabilities/search";
import {
  completeCapabilityTask,
  createIdleCapabilityTask,
  failCapabilityTask,
  startCapabilityTask
} from "../../../../src/capabilities/task";
import { buildSearchBrief, createSearchBriefFromInput } from "../../../../src/domain/engine";
import type { SearchBriefInput, SearchProviderId } from "../../../../src/domain/types";
import { enrichBriefInput } from "../intelligence/search-synthesis-llm";
import { createLlmBudget, type LlmBudget } from "../llm-budget";
import type { BailianChatClient } from "../providers/bailian";
import type { ProductStateRepository } from "../product-state-repository";

const searchProviderIds: SearchProviderId[] = ["local-demo", "bailian", "anysearch", "tavily", "exa", "brave"];

interface SearchBriefRequestPayload {
  topic?: unknown;
  providerId?: unknown;
  maxSources?: unknown;
  recencyDays?: unknown;
}

interface SearchRouteOptions {
  bailianSearchClient?: BailianSearchClient;
  anySearchClient?: AnySearchClient;
  bailianChatClient?: BailianChatClient;
  llmBudget?: LlmBudget;
}

export async function registerSearchRoutes(
  server: FastifyInstance,
  repository: ProductStateRepository,
  options: SearchRouteOptions = {}
) {
  const budget = options.llmBudget ?? createLlmBudget();

  server.post("/api/search/briefs", async (request, reply) => {
    const state = repository.getState();
    const payload = normalizePayload(request.body);
    const providerId = isSearchProviderId(payload.providerId)
      ? payload.providerId
      : state.systemConfig.search.activeProvider;
    const searchInput = {
      topic: normalizeTopic(payload.topic),
      providerId,
      maxSources: normalizePositiveInteger(payload.maxSources, state.systemConfig.search.maxSources),
      recencyDays: normalizePositiveInteger(payload.recencyDays, state.systemConfig.search.recencyDays)
    };
    const run =
      providerId === "bailian" && options.bailianSearchClient
        ? await executeBailianSearchProvider(options.bailianSearchClient, {
            ...searchInput,
            providerId: "bailian"
          })
        : providerId === "anysearch" && options.anySearchClient
          ? await executeAnySearchProvider(options.anySearchClient, {
              ...searchInput,
              providerId: "anysearch"
            })
        : await executeSearchProvider(searchInput);

    if (run.task.status === "failed" || run.result === undefined) {
      return reply.code(502).send({ task: run.task });
    }

    // Replace templated insights with LLM synthesis over the real sources
    // (no-op for bailian, which already synthesizes via its Responses API).
    // Guard with budget to avoid uncapped LLM calls.
    const allowLlm = !!options.bailianChatClient && budget.tryConsume("system");
    if (!!options.bailianChatClient && !allowLlm) {
      console.warn(JSON.stringify({ event: "llm_budget_exceeded", capability: "search_briefs" }));
    }
    const enriched = await enrichBriefInput(run.result, allowLlm ? options.bailianChatClient : undefined);
    const { brief, nextState } = createSearchBriefFromInput(state, enriched);
    repository.replaceState(nextState);
    return { brief, state: nextState, task: run.task };
  });

  server.post("/api/search/auto-briefs", async (request, reply) => {
    const state = repository.getState();
    const { themeId, debtId } = (request.body ?? {}) as { themeId?: string; debtId?: string };

    let topic = "";
    if (themeId) {
      const theme = state.themes.find((t) => t.id === themeId);
      topic = theme ? theme.name : "";
    } else if (debtId) {
      const debt = state.debts.find((d) => d.id === debtId);
      topic = debt ? debt.concept : "";
    }

    if (!topic) {
      return reply.code(400).send({ error: "No topic found" });
    }

    const provider = state.systemConfig.search.activeProvider;
    const searchInput = {
      topic,
      maxSources: state.systemConfig.search.maxSources,
      recencyDays: state.systemConfig.search.recencyDays
    };

    // Guard auto-brief LLM enrichment with budget.
    const allowLlm = !!options.bailianChatClient && budget.tryConsume("system");
    if (!!options.bailianChatClient && !allowLlm) {
      console.warn(JSON.stringify({ event: "llm_budget_exceeded", capability: "search_auto_briefs" }));
    }

    // Actually run the configured provider so auto-briefs hit the live web
    // instead of returning the templated demo brief.
    try {
      let result: SearchBriefInput | undefined;
      if (provider === "bailian" && options.bailianSearchClient) {
        result = await options.bailianSearchClient.createSearchBrief({ ...searchInput, providerId: "bailian" });
      } else if (provider === "anysearch" && options.anySearchClient) {
        result = await options.anySearchClient.createSearchBrief({ ...searchInput, providerId: "anysearch" });
      }
      if (result) {
        const enriched = await enrichBriefInput(result, allowLlm ? options.bailianChatClient : undefined);
        const { brief, nextState } = createSearchBriefFromInput(state, enriched);
        repository.replaceState(nextState);
        return { brief, state: nextState };
      }
    } catch (error) {
      console.warn(JSON.stringify({ event: "llm_fallback", capability: "search", error: error instanceof Error ? error.message : String(error) }));
    }

    // Fallback: deterministic local brief when no live provider is configured.
    const { brief, nextState } = buildSearchBrief(state, topic, provider);
    repository.replaceState(nextState);
    return { brief, state: nextState };
  });
}

async function executeBailianSearchProvider(
  client: BailianSearchClient,
  input: {
    topic: string;
    providerId: Extract<SearchProviderId, "bailian">;
    maxSources: number;
    recencyDays: number;
  }
) {
  const runningTask = startCapabilityTask(createIdleCapabilityTask("联网搜索"), input.providerId);

  try {
    const result = await client.createSearchBrief(input);
    return {
      result,
      task: completeCapabilityTask(runningTask, result)
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "百炼联网搜索调用失败。";
    return {
      result: undefined,
      task: failCapabilityTask(runningTask, message)
    };
  }
}

async function executeAnySearchProvider(
  client: AnySearchClient,
  input: {
    topic: string;
    providerId: Extract<SearchProviderId, "anysearch">;
    maxSources: number;
    recencyDays: number;
  }
) {
  const runningTask = startCapabilityTask(createIdleCapabilityTask("联网搜索"), input.providerId);

  try {
    const result = await client.createSearchBrief(input);
    return {
      result,
      task: completeCapabilityTask(runningTask, result)
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "AnySearch 调用失败。";
    return {
      result: undefined,
      task: failCapabilityTask(runningTask, message)
    };
  }
}

function normalizePayload(value: unknown): SearchBriefRequestPayload {
  if (!value || typeof value !== "object") {
    return {};
  }
  return value as SearchBriefRequestPayload;
}

function normalizeTopic(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : "本周值得讨论的 AI 产品变化";
}

function normalizePositiveInteger(value: unknown, fallback: number) {
  const parsedValue = Number(value);
  if (!Number.isFinite(parsedValue)) {
    return fallback;
  }
  return Math.max(1, Math.trunc(parsedValue));
}

function isSearchProviderId(value: unknown): value is SearchProviderId {
  return typeof value === "string" && searchProviderIds.includes(value as SearchProviderId);
}
