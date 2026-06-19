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

  // ---------------------------------------------------------------------------
  // POST /api/search/briefs/:id/refresh
  // Re-runs the research for an existing brief, preserving id/tracked/appliedToSessionIds.
  // Falls back to local-demo when no live provider is configured.
  // ---------------------------------------------------------------------------
  server.post("/api/search/briefs/:id/refresh", async (request, reply) => {
    const { id } = request.params as { id: string };
    const state = repository.getState();
    const existing = state.searchBriefs.find((b) => b.id === id);
    if (!existing) {
      return reply.code(404).send({ error: "Brief not found" });
    }

    const topic = existing.topic;
    const providerId = isSearchProviderId(existing.provider) ? existing.provider : state.systemConfig.search.activeProvider;
    const searchInput = {
      topic,
      providerId,
      maxSources: state.systemConfig.search.maxSources,
      recencyDays: state.systemConfig.search.recencyDays
    };

    // Run provider — reuse same flow as creation
    let freshInput: SearchBriefInput | undefined;
    try {
      if (providerId === "bailian" && options.bailianSearchClient) {
        freshInput = await options.bailianSearchClient.createSearchBrief({ ...searchInput, providerId: "bailian" });
      } else if (providerId === "anysearch" && options.anySearchClient) {
        freshInput = await options.anySearchClient.createSearchBrief({ ...searchInput, providerId: "anysearch" });
      }
    } catch (error) {
      console.warn(JSON.stringify({ event: "refresh_provider_error", briefId: id, error: error instanceof Error ? error.message : String(error) }));
    }

    // LLM enrichment (budget-guarded)
    const allowLlm = !!options.bailianChatClient && budget.tryConsume("system");
    const enriched = freshInput
      ? await enrichBriefInput(freshInput, allowLlm ? options.bailianChatClient : undefined)
      : undefined;

    // Build refreshed brief from enriched input or fall back to local-demo
    let refreshedBriefInput: SearchBriefInput;
    if (enriched) {
      refreshedBriefInput = enriched;
    } else {
      // Local fallback — re-create a deterministic brief for the topic
      const { brief: fallback } = buildSearchBrief(state, topic, "local-demo");
      refreshedBriefInput = {
        topic: fallback.topic,
        provider: fallback.provider,
        status: fallback.status,
        summary: fallback.summary,
        facts: fallback.facts,
        controversies: fallback.controversies,
        opposingViews: fallback.opposingViews,
        interviewAngles: fallback.interviewAngles,
        discussionTopics: fallback.discussionTopics,
        sourceAngles: fallback.sourceAngles,
        sources: fallback.sources,
        sourceTrace: fallback.sourceTrace,
        agendaTrace: fallback.agendaTrace
      };
    }

    // Merge: preserve id, tracked, appliedToSessionIds, createdAt
    const updatedBrief = {
      ...existing,
      topic: refreshedBriefInput.topic,
      provider: refreshedBriefInput.provider,
      status: refreshedBriefInput.status,
      summary: refreshedBriefInput.summary,
      facts: refreshedBriefInput.facts,
      controversies: refreshedBriefInput.controversies,
      opposingViews: refreshedBriefInput.opposingViews,
      interviewAngles: refreshedBriefInput.interviewAngles,
      discussionTopics: refreshedBriefInput.discussionTopics,
      sourceAngles: refreshedBriefInput.sourceAngles,
      sources: refreshedBriefInput.sources,
      sourceTrace: refreshedBriefInput.sourceTrace ?? existing.sourceTrace,
      agendaTrace: refreshedBriefInput.agendaTrace,
      // preserve these identity fields:
      id: existing.id,
      tracked: existing.tracked,
      appliedToSessionIds: existing.appliedToSessionIds,
      createdAt: existing.createdAt
    };

    const nextState = {
      ...state,
      searchBriefs: state.searchBriefs.map((b) => (b.id === id ? updatedBrief : b))
    };
    repository.replaceState(nextState);

    return { brief: updatedBrief, state: nextState };
  });

  // ---------------------------------------------------------------------------
  // POST /api/search/briefs/:id/track
  // Toggles the tracked field on an existing brief.
  // Body: { tracked: boolean }
  // ---------------------------------------------------------------------------
  server.post("/api/search/briefs/:id/track", async (request, reply) => {
    const { id } = request.params as { id: string };
    const state = repository.getState();
    const existing = state.searchBriefs.find((b) => b.id === id);
    if (!existing) {
      return reply.code(404).send({ error: "Brief not found" });
    }

    const body = (request.body ?? {}) as { tracked?: unknown };
    const tracked = typeof body.tracked === "boolean" ? body.tracked : !existing.tracked;
    const updatedBrief = { ...existing, tracked };
    const nextState = {
      ...state,
      searchBriefs: state.searchBriefs.map((b) => (b.id === id ? updatedBrief : b))
    };
    repository.replaceState(nextState);

    return { brief: updatedBrief, state: nextState };
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
