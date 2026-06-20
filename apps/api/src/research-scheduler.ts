/**
 * research-scheduler.ts — 后台调研调度器
 *
 * 生命周期：
 * - 仅在常驻进程中启动（buildApiServer({ enableResearchScheduler: true })，由 startServer 传入）；
 *   buildApiServer 默认不启、测试不触发。
 * - 调度间隔由 systemConfig.research.scheduleIntervalMin 控制（默认 1440min/24h）。
 * - **运行时可开关**：每个 tick 重新读取 systemConfig.research.autoScheduleEnabled，
 *   关闭时跳过本轮但保留计时器，用户在配置里打开后无需重启即可在下一个 tick 生效。
 * - 非常驻（无状态 FaaS）：依赖 POST /api/research/auto-run 或前端「打开即更新」即时触发。
 *
 * 设计原则（R3 教训复用）：
 * - 直接调用 generateBriefForTopic/refreshExistingBrief 核心函数，不经 HTTP 往返。
 * - 使用真实 provider clients（与 search 路由同源）+ 共享 llmBudget，定时调研能真正联网，
 *   且 LLM enrichment 受同一预算上限约束，避免定时器吃光预算。
 */

import type { ProductStateRepository } from "./product-state-repository";
import type { SearchRouteOptions } from "./routes/search";
import { generateBriefForTopic, refreshExistingBrief } from "./routes/search";
import type { LlmBudget } from "./llm-budget";
import { dedupeBriefSources, planResearchAgendaRun } from "../../../src/domain/research-automation";
import type { ProductState } from "../../../src/domain/types";

export interface ResearchSchedulerOptions {
  repository: ProductStateRepository;
  /** 实时 provider clients（每个 tick 读取最新值，支持运行时刷新 key） */
  clients: SearchRouteOptions;
  /** 共享 LLM 预算；enrichment 经它守卫，耗尽时降级仍出简报 */
  budget?: LlmBudget;
  /** 默认调度间隔（ms）；运行时可被 systemConfig.research.scheduleIntervalMin 覆盖 */
  intervalMs: number;
}

export interface ResearchSchedulerHandle {
  stop: () => void;
}

export function startResearchScheduler(options: ResearchSchedulerOptions): ResearchSchedulerHandle {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;

  async function runOneTick() {
    const now = new Date().toISOString();
    const state = options.repository.getState();
    const { agendaItems, staleTrackedBriefIds } = planResearchAgendaRun(state, now);

    // LLM enrichment 经共享预算守卫：有 chatClient 且预算未耗尽才开启，否则降级（仍联网搜索）。
    const allowLlm = !!options.clients.bailianChatClient && (options.budget?.tryConsume("research_auto_run") ?? false);
    let runningState: ProductState = state;

    for (const item of agendaItems) {
      try {
        const { nextState } = await generateBriefForTopic(runningState, item.query, options.clients, allowLlm);
        runningState = nextState;
      } catch (err) {
        console.warn(JSON.stringify({ event: "scheduler_generate_error", query: item.query, error: String(err) }));
      }
    }

    for (const briefId of staleTrackedBriefIds) {
      const existing = runningState.searchBriefs.find((b) => b.id === briefId);
      if (!existing) continue;
      try {
        const { nextState } = await refreshExistingBrief(runningState, existing, options.clients, allowLlm, now);
        runningState = nextState;
      } catch (err) {
        console.warn(JSON.stringify({ event: "scheduler_refresh_error", briefId, error: String(err) }));
      }
    }

    const { briefs: dedupedBriefs } = dedupeBriefSources(runningState.searchBriefs);
    // Field-level merge: a tick can take tens of seconds across LLM calls, during which a
    // user may have committed interview turns / asset edits. Re-read the LATEST state and
    // write back ONLY searchBriefs, instead of overwriting the whole snapshot captured at
    // tick start (which silently dropped concurrent edits — last-write-wins).
    options.repository.replaceState({ ...options.repository.getState(), searchBriefs: dedupedBriefs });

    console.info(JSON.stringify({
      event: "research_scheduler_tick",
      generated: agendaItems.length,
      refreshed: staleTrackedBriefIds.length,
      at: now
    }));
  }

  function scheduleNext() {
    if (stopped) return;
    const research = options.repository.getState().systemConfig.research;
    const configMin = research?.scheduleIntervalMin;
    const resolvedMs =
      typeof configMin === "number" && configMin > 0 ? configMin * 60 * 1000 : options.intervalMs;

    timer = setTimeout(() => {
      if (stopped) return;
      // 运行时开关：每个 tick 重读 enabled，关闭时跳过工作但继续排程。
      const enabled = options.repository.getState().systemConfig.research?.autoScheduleEnabled ?? false;
      const work = enabled
        ? runOneTick().catch((err) => console.warn(JSON.stringify({ event: "research_scheduler_tick_error", error: String(err) })))
        : Promise.resolve();
      work.finally(() => scheduleNext());
    }, resolvedMs);
  }

  scheduleNext();

  return {
    stop: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    }
  };
}
