/**
 * research-scheduler.ts — 后台调研调度器
 *
 * 生命周期：
 * - 仅在 startServer()（常驻进程）中启动，buildApiServer()/测试不触发。
 * - 调度间隔由 systemConfig.research.scheduleIntervalMin 控制（默认 1440min/24h）。
 * - 默认关闭（autoScheduleEnabled: false）；常驻部署时在 .env.local 或 systemConfig 中开启。
 * - 非常驻（无状态 FaaS / 短生命周期）：依赖 POST /api/research/auto-run 手动触发，
 *   或在 systemConfig.research.autoScheduleEnabled 开启后"打开即更新"（startServer 调用时立即注册）。
 *
 * 设计原则（R3 教训复用）：
 * - 直接调用 generateBriefForTopic/refreshExistingBrief 核心函数，不经 HTTP 往返。
 * - setInterval 不阻塞主线程；每次调度开始时重新读 systemConfig，允许运行时修改间隔/开关。
 */

import type { ProductStateRepository } from "./product-state-repository";
import type { SearchRouteOptions } from "./routes/search";
import { generateBriefForTopic, refreshExistingBrief } from "./routes/search";
import { dedupeBriefSources, planResearchAgendaRun } from "../../../src/domain/research-automation";
import type { ProductState } from "../../../src/domain/types";

export interface ResearchSchedulerOptions {
  repository: ProductStateRepository;
  clients: SearchRouteOptions;
  /** 默认调度间隔（ms）；运行时可从 systemConfig 动态覆盖 */
  intervalMs: number;
  /** 为 false 时 startResearchScheduler 直接返回 noop stop() */
  enabled: boolean;
}

export interface ResearchSchedulerHandle {
  stop: () => void;
}

/**
 * 启动后台调研调度器。
 * - enabled=false 时立即返回 noop，不注册 setInterval。
 * - 每次 tick 内重新从 repository 读取 systemConfig 以支持运行时配置变更。
 */
export function startResearchScheduler(options: ResearchSchedulerOptions): ResearchSchedulerHandle {
  if (!options.enabled) {
    return { stop: () => {} };
  }

  async function runOneTick() {
    const now = new Date().toISOString();
    const state = options.repository.getState();
    const { agendaItems, staleTrackedBriefIds } = planResearchAgendaRun(state, now);

    // LLM budget 不在调度器中跟踪——核心函数内已有降级逻辑
    const allowLlm = false; // 调度器默认不耗费 LLM budget，降级走 local-demo 仍有内容
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
    options.repository.replaceState({ ...runningState, searchBriefs: dedupedBriefs });

    console.info(JSON.stringify({
      event: "research_scheduler_tick",
      generated: agendaItems.length,
      refreshed: staleTrackedBriefIds.length,
      at: now
    }));
  }

  // 动态读取 intervalMs：每次 tick 后重新读 systemConfig
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;

  function scheduleNext() {
    if (stopped) return;
    const state = options.repository.getState();
    const configMin = state.systemConfig.research?.scheduleIntervalMin;
    const resolvedMs =
      typeof configMin === "number" && configMin > 0 ? configMin * 60 * 1000 : options.intervalMs;

    timer = setTimeout(() => {
      if (stopped) return;
      runOneTick()
        .catch((err) => console.warn(JSON.stringify({ event: "research_scheduler_tick_error", error: String(err) })))
        .finally(() => scheduleNext());
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
