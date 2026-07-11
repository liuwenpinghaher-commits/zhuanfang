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
import { generateBriefForTopic, refreshExistingBrief, researchRunGate } from "./routes/search";
import type { SearchBrief } from "../../../src/domain/types";
import type { WriteGate } from "./server";
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
  /** 审计修复(D4):终写经全局写门与 HTTP 串行写互斥。 */
  writeGate?: WriteGate;
}

export interface ResearchSchedulerHandle {
  stop: () => void;
}

export function startResearchScheduler(options: ResearchSchedulerOptions): ResearchSchedulerHandle {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;

  // 审计修复(D4):对齐端点侧的限量(P0 稳定性修复此前只落在 HTTP auto-run,调度器无 3+3 上限)。
  const MAX_AGENDA_PER_TICK = 3;
  const MAX_REFRESH_PER_TICK = 3;

  async function runOneTick() {
    // 审计修复(P2-17):与 HTTP auto-run 共享并发旗标——两路此前互不知晓,可并发同跑重复联网并互相覆盖。
    if (researchRunGate.inFlight) {
      console.info(JSON.stringify({ event: "research_scheduler_tick_skipped", reason: "auto-run in flight" }));
      return;
    }
    researchRunGate.inFlight = true;
    try {
      const now = new Date().toISOString();
      const state = options.repository.getState();
      // N-05:捕获治理代际(同 HTTP auto-run)。tick 联网期间若发生 reset/purge/import,本轮基于治理前
      // 状态生成的简报绝不能写回已清空的库;终写前比对代际,已变即整体丢弃。
      const startGeneration = options.repository.getGovernanceGeneration?.();
      const plan = planResearchAgendaRun(state, now);
      const agendaItems = plan.agendaItems.slice(0, MAX_AGENDA_PER_TICK);
      const staleTrackedBriefIds = plan.staleTrackedBriefIds.slice(0, MAX_REFRESH_PER_TICK);
      if (plan.agendaItems.length > agendaItems.length || plan.staleTrackedBriefIds.length > staleTrackedBriefIds.length) {
        console.info(JSON.stringify({
          event: "research_scheduler_tick_capped",
          agendaTotal: plan.agendaItems.length,
          refreshTotal: plan.staleTrackedBriefIds.length
        }));
      }

      // LLM enrichment 经共享预算守卫：有 chatClient 且预算未耗尽才开启，否则降级（仍联网搜索）。
      const allowLlm = !!options.clients.bailianChatClient && (options.budget?.tryConsume("research_auto_run") ?? false);
      let runningState: ProductState = state;
      // 审计修复(D4):跟踪本 tick 的【产出简报】,终写只把产出按 id 合并到 latest 上——
      // 此前用 tick 起点快照的整表覆盖 searchBriefs,tick 期间用户新建的被删、删除的被复活。
      const produced: SearchBrief[] = [];

      for (const item of agendaItems) {
        try {
          const { brief, nextState } = await generateBriefForTopic(runningState, item.query, options.clients, allowLlm);
          if (brief) produced.push(brief);
          runningState = nextState;
        } catch (err) {
          console.warn(JSON.stringify({ event: "scheduler_generate_error", query: item.query, error: String(err) }));
        }
      }

      for (const briefId of staleTrackedBriefIds) {
        const existing = runningState.searchBriefs.find((b) => b.id === briefId);
        if (!existing) continue;
        try {
          const { updatedBrief, nextState } = await refreshExistingBrief(runningState, existing, options.clients, allowLlm, now);
          produced.push(updatedBrief);
          runningState = nextState;
        } catch (err) {
          console.warn(JSON.stringify({ event: "scheduler_refresh_error", briefId, error: String(err) }));
        }
      }

      // 终写:重读 latest,仅把本 tick 产出按 id 叠加(用户期间的新建/删除/编辑全保留),
      // 并经全局写门与在途 HTTP 写互斥(审计修复 D4:此前完全绕开串行化)。
      const commit = () => {
        // N-05:终写前复查代际(同 HTTP auto-run)。已变=tick 期间发生过治理,整库已换,本轮产出全部
        // 基于陈旧状态 → 整体丢弃、记事件,不回写(否则 reset 后干净库冒出含旧主题名的简报)。
        const currentGeneration = options.repository.getGovernanceGeneration?.();
        if (startGeneration !== undefined && currentGeneration !== startGeneration) {
          console.warn(JSON.stringify({ event: "research_output_discarded_stale_generation", source: "scheduler", startGeneration, currentGeneration }));
          return;
        }
        const latest = options.repository.getState();
        const byId = new Map(latest.searchBriefs.map((b) => [b.id, b]));
        for (const b of produced) {
          // 用户在 tick 期间删除的简报不复活:refresh 产出仅当该 id 仍在 latest 时回写。
          const isNew = !state.searchBriefs.some((x) => x.id === b.id);
          if (isNew || byId.has(b.id)) byId.set(b.id, b);
        }
        const { briefs } = dedupeBriefSources([...byId.values()]);
        options.repository.replaceState({ ...latest, searchBriefs: briefs });
      };
      if (options.writeGate) {
        await options.writeGate.runExclusive("research-scheduler-tick", commit);
      } else {
        commit();
      }

      console.info(JSON.stringify({
        event: "research_scheduler_tick",
        generated: agendaItems.length,
        refreshed: staleTrackedBriefIds.length,
        at: now
      }));
    } finally {
      researchRunGate.inFlight = false;
    }
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
