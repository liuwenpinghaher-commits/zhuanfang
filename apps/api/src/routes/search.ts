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
import type { ProductState, SearchBrief, SearchBriefInput, SearchProviderId } from "../../../../src/domain/types";
import {
  dedupeBriefSources,
  planResearchAgendaRun
} from "../../../../src/domain/research-automation";
import { enrichBriefInput } from "../intelligence/search-synthesis-llm";
import { createLlmBudget, type LlmBudget } from "../llm-budget";
import { formatProviderErrorMessage } from "../provider-error";
import type { BailianChatClient } from "../providers/bailian";
import type { ProductStateRepository } from "../product-state-repository";

const searchProviderIds: SearchProviderId[] = ["local-demo", "bailian", "anysearch"];

interface SearchBriefRequestPayload {
  topic?: unknown;
  providerId?: unknown;
  maxSources?: unknown;
  recencyDays?: unknown;
}

export interface SearchRouteOptions {
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
      // P0-E: a provider failure no longer hard-502s. Degrade to a deterministic local-demo
      // brief (returned 200, flagged degraded) so this main route behaves like auto-briefs /
      // refresh / generateBriefForTopic, which all fall back instead of erroring.
      const { brief, nextState } = buildSearchBrief(state, searchInput.topic, "local-demo");
      repository.replaceState(nextState);
      return { brief, state: nextState, task: run.task, degraded: true };
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

  // ---------------------------------------------------------------------------
  let autoRunInFlight = false; // P0 稳定性:auto-run 并发保护标志(防多触发堆积拖垮后端)
  // POST /api/research/auto-run
  // 自动调研：生成新简报 + 刷新过期 tracked 简报 + 跨简报去重来源
  // 受 llmBudget "research_auto_run" key 守卫；耗尽时走降级仍返回 200
  // ---------------------------------------------------------------------------
  server.post("/api/research/auto-run", async (_request, reply) => {
    // P0 稳定性:并发保护 + 限量。auto-run 串行跑多条联网搜索(每条可达 30s),被前端"打开即更新"/
    // 定时/测试重 mount 多次触发时并发堆积会把后端拖垮(reset/turn 卡满 30s)。已有一轮在跑直接降级,
    // 且每轮最多取 3 条 agenda + 3 条刷新,防 state 累积导致 agenda 失控。
    if (autoRunInFlight) {
      return reply.send({ state: repository.getState(), summary: { generated: 0, refreshed: 0, dedupedSources: 0, note: "已有自动调研在进行中,跳过本次" } });
    }
    autoRunInFlight = true;
    try {
    const now = new Date().toISOString();
    const state = repository.getState();
    const planned = planResearchAgendaRun(state, now);
    const agendaItems = planned.agendaItems.slice(0, 3);
    const staleTrackedBriefIds = planned.staleTrackedBriefIds.slice(0, 3);
    // 无议程也无过期 tracked 简报时直接短路:不进 replaceState/reindex/dedupe。否则前端"打开即更新"
    // 在空/少资产状态下每次进外部调研视图都做一轮无意义的全量写 + 知识重建,徒增负载。
    if (agendaItems.length === 0 && staleTrackedBriefIds.length === 0) {
      return reply.send({ state, summary: { generated: 0, refreshed: 0, dedupedSources: 0, note: "无可调研议程，跳过本轮" } });
    }

    const allowLlm = !!options.bailianChatClient && budget.tryConsume("research_auto_run");
    if (!!options.bailianChatClient && !allowLlm) {
      console.warn(JSON.stringify({ event: "llm_budget_exceeded", capability: "research_auto_run" }));
    }

    // --- 生成新简报（每个 agendaItem 一条） ---
    const currentState = repository.getState();
    const generated: SearchBrief[] = [];
    let runningState: ProductState = currentState;
    for (const item of agendaItems) {
      const { brief, nextState } = await generateBriefForTopic(
        runningState,
        item.query,
        options,
        allowLlm
      );
      generated.push(brief);
      runningState = nextState;
    }

    // --- 刷新过期 tracked 简报 ---
    const refreshed: SearchBrief[] = [];
    for (const briefId of staleTrackedBriefIds) {
      const existing = runningState.searchBriefs.find((b) => b.id === briefId);
      if (!existing) continue;
      const { updatedBrief, nextState } = await refreshExistingBrief(
        runningState,
        existing,
        options,
        allowLlm,
        now
      );
      refreshed.push(updatedBrief);
      runningState = nextState;
    }

    // --- 跨简报来源去重 + 基于 latest 原子合并 ---
    // auto-run 已豁免全局写串行化(联网期间不占写锁),所以这段联网时间里用户/其它写可能已改动 state。
    // 这里重读 latest,把本轮 generated/refreshed 按 id 合并上去(而非用 90s 前的 runningState 作 base
    // 覆盖);"重读→合并→replaceState"是连续同步块(无 await),JS 单线程下原子执行、不被其它写打断,
    // 因此既不阻塞其它写、又不会 clobber 期间的用户写(lost-update)。
    const latest = repository.getState();
    const briefById = new Map(latest.searchBriefs.map((b) => [b.id, b]));
    for (const b of refreshed) briefById.set(b.id, b);
    for (const b of generated) briefById.set(b.id, b);
    const { briefs: dedupedBriefs, duplicateCount } = dedupeBriefSources([...briefById.values()]);
    const finalState: ProductState = { ...latest, searchBriefs: dedupedBriefs };
    repository.replaceState(finalState);

    return {
      state: finalState,
      summary: {
        generated: generated.length,
        refreshed: refreshed.length,
        dedupedSources: duplicateCount
      }
    };
    } finally {
      autoRunInFlight = false;
    }
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
    const message = formatProviderErrorMessage(error, "百炼联网搜索调用失败。");
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
    const message = formatProviderErrorMessage(error, "AnySearch 调用失败。");
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

// ---------------------------------------------------------------------------
// 可复用核心函数（供 auto-run 端点 + 后台调度器共用，不经 HTTP）
// ---------------------------------------------------------------------------

/**
 * 按 topic 生成一条搜索简报，并将结果合入传入的 state 返回新 state。
 * 无 provider 时降级走 local-demo（不报错，仍返回简报）。
 */
export async function generateBriefForTopic(
  state: ProductState,
  topic: string,
  options: SearchRouteOptions,
  allowLlm: boolean
): Promise<{ brief: SearchBrief; nextState: ProductState }> {
  const provider = state.systemConfig.search.activeProvider;
  const searchInput = {
    topic,
    maxSources: state.systemConfig.search.maxSources,
    recencyDays: state.systemConfig.search.recencyDays
  };
  try {
    let result: SearchBriefInput | undefined;
    if (provider === "bailian" && options.bailianSearchClient) {
      result = await options.bailianSearchClient.createSearchBrief({ ...searchInput, providerId: "bailian" });
    } else if (provider === "anysearch" && options.anySearchClient) {
      result = await options.anySearchClient.createSearchBrief({ ...searchInput, providerId: "anysearch" });
    }
    if (result) {
      const enriched = await enrichBriefInput(result, allowLlm ? options.bailianChatClient : undefined);
      return createSearchBriefFromInput(state, enriched);
    }
  } catch (error) {
    console.warn(JSON.stringify({ event: "generate_brief_provider_error", topic, error: error instanceof Error ? error.message : String(error) }));
  }
  // 降级：local-demo 确定性简报
  return buildSearchBrief(state, topic, provider);
}

/**
 * 刷新一条已有简报，更新 lastRefreshedAt，返回 updatedBrief 和新 state。
 * 无 provider 时降级走 local-demo，仍更新 lastRefreshedAt。
 */
export async function refreshExistingBrief(
  state: ProductState,
  existing: SearchBrief,
  options: SearchRouteOptions,
  allowLlm: boolean,
  now: string
): Promise<{ updatedBrief: SearchBrief; nextState: ProductState }> {
  const topic = existing.topic;
  const providerId = isSearchProviderId(existing.provider) ? existing.provider : state.systemConfig.search.activeProvider;
  const searchInput = {
    topic,
    maxSources: state.systemConfig.search.maxSources,
    recencyDays: state.systemConfig.search.recencyDays
  };

  let freshInput: SearchBriefInput | undefined;
  try {
    if (providerId === "bailian" && options.bailianSearchClient) {
      freshInput = await options.bailianSearchClient.createSearchBrief({ ...searchInput, providerId: "bailian" });
    } else if (providerId === "anysearch" && options.anySearchClient) {
      freshInput = await options.anySearchClient.createSearchBrief({ ...searchInput, providerId: "anysearch" });
    }
  } catch (error) {
    console.warn(JSON.stringify({ event: "refresh_brief_provider_error", briefId: existing.id, error: error instanceof Error ? error.message : String(error) }));
  }

  const enriched = freshInput
    ? await enrichBriefInput(freshInput, allowLlm ? options.bailianChatClient : undefined)
    : undefined;

  let refreshedBriefInput: SearchBriefInput;
  if (enriched) {
    refreshedBriefInput = enriched;
  } else {
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

  const updatedBrief: SearchBrief = {
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
    // 保留身份字段
    id: existing.id,
    tracked: existing.tracked,
    appliedToSessionIds: existing.appliedToSessionIds,
    createdAt: existing.createdAt,
    lastRefreshedAt: now
  };

  const nextState: ProductState = {
    ...state,
    searchBriefs: state.searchBriefs.map((b) => (b.id === existing.id ? updatedBrief : b))
  };

  return { updatedBrief, nextState };
}
