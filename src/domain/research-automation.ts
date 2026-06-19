/**
 * 外部调研自动化的 domain 纯函数
 *
 * 这些函数均为纯函数——不产生副作用、不调用任何 provider。
 * provider 层使用这些函数驱动实际的网络请求和状态写入。
 */

import type { ProductState, SearchAgendaItem, SearchBrief } from "./types";
import { buildProactiveSearchAgenda } from "./search-brief";

const DEFAULT_STALE_DAYS = 14;

/**
 * 判断一个搜索简报是否已过期（需要重新调研）。
 *
 * 基准时间 = brief.lastRefreshedAt ?? brief.createdAt
 * 若距今超过 staleDays 天则视为过期。
 *
 * @param brief     - 待检查的搜索简报
 * @param now       - 当前时间的 ISO 8601 字符串
 * @param staleDays - 过期阈值（天），默认 14 天
 */
export function isSearchBriefStale(
  brief: SearchBrief,
  now: string,
  staleDays: number = DEFAULT_STALE_DAYS
): boolean {
  const baselineMs = Date.parse(brief.lastRefreshedAt ?? brief.createdAt);
  const nowMs = Date.parse(now);
  const elapsedDays = (nowMs - baselineMs) / (1000 * 60 * 60 * 24);
  return elapsedDays > staleDays;
}

/**
 * 跨多个搜索简报对来源（SourceHighlight）进行去重。
 *
 * 去重 key = source.url（非空）|| source.title
 * 同一 key 的来源只在首次出现的简报中保留，后续简报中的重复来源被剔除。
 * 本函数不修改原始 brief 对象（immutable）。
 *
 * @param briefs - 待去重的简报数组
 * @returns 去重后的 briefs 副本 + 被剔除的来源总数
 */
export function dedupeBriefSources(briefs: SearchBrief[]): {
  briefs: SearchBrief[];
  duplicateCount: number;
} {
  const seen = new Set<string>();
  let duplicateCount = 0;

  const deduped = briefs.map((brief) => {
    const filteredSources = brief.sources.filter((source) => {
      const key = source.url?.trim() || source.title?.trim();
      if (!key) {
        // 无 key 则不去重，直接保留
        return true;
      }
      if (seen.has(key)) {
        duplicateCount += 1;
        return false;
      }
      seen.add(key);
      return true;
    });

    // 只有在 sources 有变化时才创建新对象，保持引用稳定
    if (filteredSources.length === brief.sources.length) {
      return brief;
    }
    return { ...brief, sources: filteredSources };
  });

  return { briefs: deduped, duplicateCount };
}

/**
 * 生成本次调研任务的运行计划。
 *
 * 纯函数，不产生副作用：
 * - agendaItems：由 buildProactiveSearchAgenda(state) 生成
 * - staleTrackedBriefIds：从 state.searchBriefs 中筛选出 tracked=true 且已过期的简报 id
 *
 * @param state - 当前产品状态
 * @param now   - 当前时间的 ISO 8601 字符串
 */
export function planResearchAgendaRun(
  state: ProductState,
  now: string
): {
  agendaItems: SearchAgendaItem[];
  staleTrackedBriefIds: string[];
} {
  const agendaItems = buildProactiveSearchAgenda(state);
  const staleTrackedBriefIds = state.searchBriefs
    .filter((b) => b.tracked && isSearchBriefStale(b, now))
    .map((b) => b.id);

  return { agendaItems, staleTrackedBriefIds };
}
