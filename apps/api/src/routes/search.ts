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
import { sanitizeSearchBriefInputFields } from "../../../../src/domain/search-brief";
import type { ProductState, SearchBrief, SearchBriefInput, SearchProviderId } from "../../../../src/domain/types";
import { nowIso } from "../../../../src/domain/utils";
import {
  dedupeBriefSources,
  planResearchAgendaRun
} from "../../../../src/domain/research-automation";
import { enrichBriefInput } from "../intelligence/search-synthesis-llm";
import { createLlmBudget, type LlmBudget } from "../llm-budget";
import { formatProviderErrorMessage } from "../provider-error";
import type { BailianChatClient } from "../providers/bailian";
import type { ProductStateRepository } from "../product-state-repository"
import { replaceStateDurable } from "../product-state-repository";

const searchProviderIds: SearchProviderId[] = ["local-demo", "bailian", "anysearch"];

interface SearchBriefRequestPayload {
  topic?: unknown;
  providerId?: unknown;
  maxSources?: unknown;
  recencyDays?: unknown;
}

export interface SearchRouteOptions {
  /** 审计修复(D3/P2-17):全局写门——auto-run/调度器的最终读-合并-写经它与串行写互斥。 */
  writeGate?: { runExclusive<T>(label: string, fn: () => Promise<T> | T): Promise<T> };
  bailianSearchClient?: BailianSearchClient;
  anySearchClient?: AnySearchClient;
  bailianChatClient?: BailianChatClient;
  llmBudget?: LlmBudget;
}

// 审计修复(P2-17):auto-run 并发旗标(HTTP 端点与后台调度器共享,防两路并发联网互相覆盖)。
export const researchRunGate = { inFlight: false };

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
    // 联网 provider 选定但未配置 key → 如实 503（不再用壳 provider 生成占位简报冒充联网结果）。
    if (providerId === "bailian" && !options.bailianSearchClient) {
      return reply.code(503).send({ error: "百炼联网搜索未配置（缺少 DASHSCOPE_API_KEY），无法生成联网简报。" });
    }
    if (providerId === "anysearch" && !options.anySearchClient) {
      return reply.code(503).send({ error: "AnySearch 未配置（缺少 ANYSEARCH_API_KEY），无法生成联网简报。" });
    }
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
        : await executeSearchProvider(searchInput); // 仅 local-demo（用户显式选择的演示 provider）

    if (run.task.status === "failed" || run.result === undefined) {
      // 联网搜索失败 → 如实 502（不再用 local-demo 占位简报冒充调研结果落库）。
      return reply.code(502).send({ error: run.task.error ?? "联网搜索失败。", task: run.task });
    }

    // Replace templated insights with LLM synthesis over the real sources
    // (no-op for bailian, which already synthesizes via its Responses API).
    // 无 chatClient = 配置态（简报按 provider 原样产出）;有 client 但预算耗尽 → 429;富化失败 → 502。
    const needsEnrichment =
      !!options.bailianChatClient && run.result.provider !== "bailian" && run.result.status === "ready" && run.result.sources.length > 0;
    if (needsEnrichment && !budget.tryConsume("system")) {
      console.warn(JSON.stringify({ event: "llm_budget_exceeded", capability: "search_briefs" }));
      return reply.code(429).send({ error: "本时段 LLM 预算已用尽，简报生成暂不可用，请稍后重试。" });
    }
    let enriched: SearchBriefInput;
    try {
      enriched = await enrichBriefInput(run.result, needsEnrichment ? options.bailianChatClient : undefined);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(JSON.stringify({ event: "llm_failed", capability: "search_briefs", error: message }));
      return reply.code(502).send({ error: `简报洞察生成失败：${message}。请重试。` });
    }
    // SR-P1-03: provider/enrich ran outside write slot (route is write-gate exempt);
    // commit re-reads latest so concurrent writes during long IO are not clobbered.
    const commitCreate = async () => {
      const latest = repository.getState();
      const { brief, nextState } = createSearchBriefFromInput(latest, enriched);
      const persisted = /*durable*/await replaceStateDurable(repository, nextState);
      return { brief, state: persisted, task: run.task };
    };
    return options.writeGate
      ? await options.writeGate.runExclusive("search-brief-create", commitCreate)
      : await commitCreate();
  });

  // ---------------------------------------------------------------------------
  // POST /api/search/briefs/:id/refresh
  // Re-runs the research for an existing brief, preserving id/tracked/appliedToSessionIds.
  // provider 未配置/失败 → 如实 503/502，原简报原样保留（不落任何变更）。
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
    if (providerId === "local-demo") {
      return reply.code(422).send({ error: "演示简报（local-demo）不支持联网刷新。" });
    }
    if (providerId === "bailian" && !options.bailianSearchClient) {
      return reply.code(503).send({ error: "百炼联网搜索未配置（缺少 DASHSCOPE_API_KEY），无法刷新简报。" });
    }
    if (providerId === "anysearch" && !options.anySearchClient) {
      return reply.code(503).send({ error: "AnySearch 未配置（缺少 ANYSEARCH_API_KEY），无法刷新简报。" });
    }
    const searchInput = {
      topic,
      providerId,
      maxSources: state.systemConfig.search.maxSources,
      recencyDays: state.systemConfig.search.recencyDays
    };

    // Run provider — reuse same flow as creation. 失败如实 502，原简报不动。
    let freshInput: SearchBriefInput;
    try {
      freshInput =
        providerId === "bailian"
          ? await options.bailianSearchClient!.createSearchBrief({ ...searchInput, providerId: "bailian" })
          : await options.anySearchClient!.createSearchBrief({ ...searchInput, providerId: "anysearch" });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(JSON.stringify({ event: "refresh_provider_error", briefId: id, error: message }));
      return reply.code(502).send({ error: `简报刷新失败（联网搜索出错）：${message}。原简报未变。` });
    }

    // LLM enrichment（无 chatClient=配置态;预算耗尽 → 429;失败 → 502,原简报不动）。
    const needsEnrichment =
      !!options.bailianChatClient && freshInput.provider !== "bailian" && freshInput.status === "ready" && freshInput.sources.length > 0;
    if (needsEnrichment && !budget.tryConsume("system")) {
      console.warn(JSON.stringify({ event: "llm_budget_exceeded", capability: "search_refresh" }));
      return reply.code(429).send({ error: "本时段 LLM 预算已用尽，简报刷新暂不可用，请稍后重试。" });
    }
    let enriched: SearchBriefInput;
    try {
      enriched = await enrichBriefInput(freshInput, needsEnrichment ? options.bailianChatClient : undefined);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(JSON.stringify({ event: "llm_failed", capability: "search_refresh", error: message }));
      return reply.code(502).send({ error: `简报洞察生成失败：${message}。原简报未变。` });
    }
    // 审计修复(F1):refresh 路径的 provider 文本与 create 同口径清洗(此前直接 spread 落库)。
    const refreshedBriefInput: SearchBriefInput = sanitizeSearchBriefInputFields(enriched);

    // SR-P1-01/03: stamp lastRefreshedAt; re-read latest under write gate after long IO.
    const commitRefresh = async () => {
      const latest = repository.getState();
      const current = latest.searchBriefs.find((b) => b.id === id);
      if (!current) {
        // Deleted during long refresh window — do not resurrect.
        return null;
      }
      const updatedBrief = {
        ...current,
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
        sourceTrace: refreshedBriefInput.sourceTrace ?? current.sourceTrace,
        agendaTrace: refreshedBriefInput.agendaTrace,
        id: current.id,
        tracked: current.tracked,
        appliedToSessionIds: current.appliedToSessionIds,
        createdAt: current.createdAt,
        lastRefreshedAt: nowIso()
      };
      const nextState = {
        ...latest,
        searchBriefs: latest.searchBriefs.map((b) => (b.id === id ? updatedBrief : b))
      };
      const persisted = /*durable*/await replaceStateDurable(repository, nextState);
      return { brief: updatedBrief, state: persisted };
    };
    const committed = options.writeGate
      ? await options.writeGate.runExclusive("search-brief-refresh", commitRefresh)
      : await commitRefresh();
    if (!committed) {
      return reply.code(404).send({ error: "Brief not found" });
    }
    return committed;
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
    const persisted = /*durable*/await replaceStateDurable(repository, nextState);

    return { brief: updatedBrief, state: persisted };
  });

  // ---------------------------------------------------------------------------
  // P0 稳定性:auto-run 并发保护标志(防多触发堆积拖垮后端)。
  // 审计修复(P2-17):提为模块级 researchRunGate——后台调度器与 HTTP auto-run 此前互不知晓可并发同跑。
  // POST /api/research/auto-run
  // 自动调研：生成新简报 + 刷新过期 tracked 简报 + 跨简报去重来源
  // 受 llmBudget "research_auto_run" key 守卫；耗尽时走降级仍返回 200
  // ---------------------------------------------------------------------------
  server.post("/api/research/auto-run", async (_request, reply) => {
    // P0 稳定性:并发保护 + 限量。auto-run 串行跑多条联网搜索(每条可达 30s),被前端"打开即更新"/
    // 定时/测试重 mount 多次触发时并发堆积会把后端拖垮(reset/turn 卡满 30s)。已有一轮在跑直接降级,
    // 且每轮最多取 3 条 agenda + 3 条刷新,防 state 累积导致 agenda 失控。
    if (researchRunGate.inFlight) {
      return reply.send({ state: repository.getState(), summary: { generated: 0, refreshed: 0, dedupedSources: 0, note: "已有自动调研在进行中,跳过本次" } });
    }
    researchRunGate.inFlight = true;
    try {
    const now = new Date().toISOString();
    const state = repository.getState();
    // N-05:捕获治理代际。auto-run 已豁免全局写串行化(联网可达 90s,期间不持写锁),这段时间里用户可能
    // reset/purge/import。若发生过治理,本轮基于**治理前**主题生成的简报绝不能写回已清空的库(否则 reset
    // 后干净库冒出含旧主题名的简报)。终写前比对代际,已变即丢弃全部产出。
    const startGeneration = repository.getGovernanceGeneration?.();
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
    // 逐条隔离:单条失败不拖垮整轮,但失败【必须】进 summary.failures 如实汇报——
    // 不再用 local-demo 占位简报冒充生成成功、也不再把失败静默计入 generated。
    const currentState = repository.getState();
    const generated: SearchBrief[] = [];
    const failures: Array<{ topic: string; error: string }> = [];
    let runningState: ProductState = currentState;
    for (const item of agendaItems) {
      try {
        const { brief, nextState } = await generateBriefForTopic(
          runningState,
          item.query,
          options,
          allowLlm
        );
        generated.push(brief);
        runningState = nextState;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(JSON.stringify({ event: "auto_run_generate_failed", topic: item.query, error: message }));
        failures.push({ topic: item.query, error: message });
      }
    }

    // --- 刷新过期 tracked 简报 ---
    const refreshed: SearchBrief[] = [];
    for (const briefId of staleTrackedBriefIds) {
      const existing = runningState.searchBriefs.find((b) => b.id === briefId);
      if (!existing) continue;
      try {
        const { updatedBrief, nextState } = await refreshExistingBrief(
          runningState,
          existing,
          options,
          allowLlm,
          now
        );
        refreshed.push(updatedBrief);
        runningState = nextState;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(JSON.stringify({ event: "auto_run_refresh_failed", briefId, error: message }));
        failures.push({ topic: existing.topic, error: message });
      }
    }

    // --- 跨简报来源去重 + 基于 latest 原子合并 ---
    // auto-run 已豁免全局写串行化(联网期间不占写锁),所以这段联网时间里用户/其它写可能已改动 state。
    // 这里重读 latest,把本轮 generated/refreshed 按 id 合并上去(而非用 90s 前的 runningState 作 base
    // 覆盖);"重读→合并→replaceState"是连续同步块(无 await),JS 单线程下原子执行、不被其它写打断,
    // 因此既不阻塞其它写、又不会 clobber 期间的用户写(lost-update)。
    // 审计修复(D3):终写经全局写门排队——豁免只豁免"联网期间不持锁",最终读-合并-写必须与
    // 串行写互斥,否则会落在某个长持锁写(如 /end)的读写窗口内被整态回滚(反向 clobber)。
    const commitFinal = async () => {
      // N-05:终写前(已在 writeGate 独占块内,与治理成功递增代际的时刻可比对)复查代际。已变=联网期间
      // 发生过 reset/purge/import,整库已换,本轮 generated/refreshed 全部基于陈旧状态 → 整体丢弃、记事件,
      // 不回写。(若治理恰在此刻在途,下方 replaceState 还会被 M1 守卫拒 → 409,由端点冒泡,亦不复活。)
      const currentGeneration = repository.getGovernanceGeneration?.();
      if (startGeneration !== undefined && currentGeneration !== startGeneration) {
        console.warn(JSON.stringify({ event: "research_output_discarded_stale_generation", source: "auto-run", startGeneration, currentGeneration }));
        return { persisted: repository.getState(), duplicateCount: 0 };
      }
      const latest = repository.getState();
      const briefById = new Map(latest.searchBriefs.map((b) => [b.id, b]));
      // 回归审查 R3-A:与调度器 commit 对齐——refreshed(刷新既有简报)只在该 id 仍存在于 latest 时回写,
      // 否则复活用户在 90s 联网窗口内删除的 tracked 简报(lost-delete,与 auto-run 自述"不 clobber 用户写"
      // 矛盾)。generated(本轮新建)无条件写(用户不可能删掉还没持久化的东西)。
      const startIds = new Set(currentState.searchBriefs.map((b) => b.id));
      for (const b of refreshed) {
        const isNew = !startIds.has(b.id);   // 本轮才出现的(理论上 refreshed 不含新建,防御)
        if (isNew || briefById.has(b.id)) briefById.set(b.id, b);   // 仍在 latest 才回写,已删不复活
      }
      for (const b of generated) briefById.set(b.id, b);
      const { briefs: dedupedBriefs, duplicateCount } = dedupeBriefSources([...briefById.values()]);
      const finalState: ProductState = { ...latest, searchBriefs: dedupedBriefs };
      return { persisted: await replaceStateDurable(repository, finalState), duplicateCount };
    };
    const { persisted, duplicateCount } = options.writeGate
      ? await options.writeGate.runExclusive("auto-run-final-write", commitFinal)
      : await commitFinal();

    return {
      state: persisted,
      summary: {
        generated: generated.length,
        refreshed: refreshed.length,
        dedupedSources: duplicateCount,
        // 失败逐条如实汇报（主题+原因），不再静默吞掉或用占位简报顶替。
        failed: failures.length,
        ...(failures.length > 0 ? { failures } : {})
      }
    };
    } finally {
      researchRunGate.inFlight = false;
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

    // Guard auto-brief LLM enrichment with budget.
    const allowLlm = !!options.bailianChatClient && budget.tryConsume("system");
    if (!!options.bailianChatClient && !allowLlm) {
      console.warn(JSON.stringify({ event: "llm_budget_exceeded", capability: "search_auto_briefs" }));
      return reply.code(429).send({ error: "本时段 LLM 预算已用尽，自动简报暂不可用，请稍后重试。" });
    }

    // 与 generateBriefForTopic 同一策略:provider 未配置 → 503;联网/富化失败 → 502;
    // 仅显式 local-demo 配置走确定性演示简报。不再静默降级。
    try {
      const { brief, nextState } = await generateBriefForTopic(state, topic, options, allowLlm);
      const persisted = /*durable*/await replaceStateDurable(repository, nextState);
      return { brief, state: persisted };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(JSON.stringify({ event: "auto_brief_failed", topic, error: message }));
      const code = message.includes("未配置") ? 503 : 502;
      return reply.code(code).send({ error: `自动简报生成失败：${message}` });
    }
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
 * 真实性原则:provider 未配置/联网失败/富化失败 → 抛错,由调用方如实暴露
 * （HTTP 路由 5xx;auto-run/调度器逐条记失败并汇报）。
 * 仅当 activeProvider 显式配置为 local-demo 时走确定性演示简报（用户主动选择,非降级）。
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
  if (provider === "local-demo") {
    return buildSearchBrief(state, topic, provider);
  }
  let result: SearchBriefInput;
  if (provider === "bailian") {
    if (!options.bailianSearchClient) {
      throw new Error("百炼联网搜索未配置（缺少 DASHSCOPE_API_KEY）");
    }
    result = await options.bailianSearchClient.createSearchBrief({ ...searchInput, providerId: "bailian" });
  } else {
    if (!options.anySearchClient) {
      throw new Error("AnySearch 未配置（缺少 ANYSEARCH_API_KEY）");
    }
    result = await options.anySearchClient.createSearchBrief({ ...searchInput, providerId: "anysearch" });
  }
  const enriched = await enrichBriefInput(result, allowLlm ? options.bailianChatClient : undefined);
  return createSearchBriefFromInput(state, enriched);
}

/**
 * 刷新一条已有简报，更新 lastRefreshedAt，返回 updatedBrief 和新 state。
 * 真实性原则:provider 未配置/联网失败/富化失败 → 抛错,原简报不动,由调用方如实暴露。
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

  if (providerId === "local-demo") {
    throw new Error("演示简报（local-demo）不支持联网刷新");
  }
  let freshInput: SearchBriefInput;
  if (providerId === "bailian") {
    if (!options.bailianSearchClient) {
      throw new Error("百炼联网搜索未配置（缺少 DASHSCOPE_API_KEY）");
    }
    freshInput = await options.bailianSearchClient.createSearchBrief({ ...searchInput, providerId: "bailian" });
  } else {
    if (!options.anySearchClient) {
      throw new Error("AnySearch 未配置（缺少 ANYSEARCH_API_KEY）");
    }
    freshInput = await options.anySearchClient.createSearchBrief({ ...searchInput, providerId: "anysearch" });
  }

  const enriched = await enrichBriefInput(freshInput, allowLlm ? options.bailianChatClient : undefined);
  // 审计修复(F1):与 create 同口径清洗。
  const refreshedBriefInput: SearchBriefInput = sanitizeSearchBriefInputFields(enriched);

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
