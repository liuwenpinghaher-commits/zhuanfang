// 轻量推理(本体论欠账②)· 域层纯函数。
//
// 混合载体:这里是【确定性规则粗筛 + 应用】两端。中间的语义精判由
// apps/api/src/intelligence/cognitive-relations-llm.ts(judgeCognitiveRelations)
// 用 LLM 完成 —— 域层不持有 LLM,只产候选对、消费判定结果。
//
// 范围:Point↔Point 的 contradicts(语义对立)与 supersedes(后者修正/取代前者)。
// theme 级 evolves_into 不做(主题是 upsert 模型,不适配 t→t+1)。
//
// 关系数据走 PointAsset 的内嵌软链(contradictsPointIds / supersededByPointId),
// 与 relatedThemeIds 同模式;edge-mapper 再把它们投影成 contradicts 边。
import type { PointAsset, ProductState } from "./types";
import { nowIso } from "./utils";

/** LLM 精判结果:对立对 + 取代关系。oldId 被 newId 修正/取代。 */
export interface CognitiveRelations {
  /** 语义对立的观点对(无序;应用时双向写)。 */
  contradicts: Array<[string, string]>;
  /** 后者修正/深化前者:oldId 被 newId 取代。 */
  supersedes: Array<{ oldId: string; newId: string }>;
}

/** 候选对上限 —— 防同主题观点全配对的组合爆炸(N 大时 N²/2 会把 LLM 预算瞬间打爆)。
 *  超过则截断(确定性:按 point 在 state.points 的顺序稳定取前 N 对)。 */
const MAX_CANDIDATE_PAIRS = 60;

/** 不参与推理的观点终态:已放弃 = 用户已主动废弃,不该再被卷进矛盾/演化判定。 */
const TERMINAL_POINT_STATUSES = new Set(["已放弃"]);

/**
 * 规则粗筛:产「同主题、不同 id」的候选观点对,交给 LLM 精判。
 * - 分组依据:relatedThemeIds(一条观点可落入多个主题组)。
 * - symmetric 去重:每个无序对最多出现一次(按 id 字典序 a<b 归一)。
 * - 跳过已成关系的对(已互为 contradicts、或其一已被 supersede)——避免重复送判、反复改写。
 * - 跳过终态观点(已放弃)。
 * - 上限封顶,防爆炸。
 * 纯函数。
 */
export function collectCandidatePointPairs(state: ProductState): Array<[PointAsset, PointAsset]> {
  const eligible = state.points.filter(
    (p) => !TERMINAL_POINT_STATUSES.has(p.status) && (p.relatedThemeIds?.length ?? 0) > 0
  );
  const byId = new Map(eligible.map((p) => [p.id, p] as const));

  // 已成关系的无序对键集(归一为 a<b),用于跳过。
  const settled = new Set<string>();
  for (const p of eligible) {
    for (const other of p.contradictsPointIds ?? []) settled.add(pairKey(p.id, other));
    if (p.supersededByPointId) settled.add(pairKey(p.id, p.supersededByPointId));
  }

  // 按主题分组 → 组内两两配对;跨组同一对靠 seen 去重。
  const groups = new Map<string, PointAsset[]>();
  for (const p of eligible) {
    for (const tid of p.relatedThemeIds ?? []) {
      const arr = groups.get(tid);
      if (arr) arr.push(p);
      else groups.set(tid, [p]);
    }
  }

  const seen = new Set<string>();
  const pairs: Array<[PointAsset, PointAsset]> = [];
  for (const members of groups.values()) {
    for (let i = 0; i < members.length; i++) {
      for (let j = i + 1; j < members.length; j++) {
        const a = members[i];
        const b = members[j];
        const key = pairKey(a.id, b.id);
        if (seen.has(key) || settled.has(key)) continue;
        seen.add(key);
        // 稳定方向:按 id 字典序(from<to),与 edge-mapper 的 symmetric 去重一致。
        const [lo, hi] = a.id < b.id ? [a, b] : [b, a];
        const loPoint = byId.get(lo.id);
        const hiPoint = byId.get(hi.id);
        if (loPoint && hiPoint) pairs.push([loPoint, hiPoint]);
        if (pairs.length >= MAX_CANDIDATE_PAIRS) return pairs;
      }
    }
  }
  return pairs;
}

/**
 * 应用 LLM 精判结果到 state(不可变更新,纯函数):
 * - contradicts → 双向写两端 contradictsPointIds(去重);较弱的一方 status 置「被挑战中」。
 *   弱方启发式:置信更低者优先;同置信则更早(updatedAt 小)者。被挑战 = 一方观点动摇,
 *   不把双方都打成被挑战(对立不等于双败)。已是终态/已修正的不覆盖。
 * - supersedes → 旧观点 supersededByPointId=newId + status 置「已修正」。
 * 指向不存在 point 的关系一律忽略(防悬挂软链)。
 */
export function applyCognitiveRelations(state: ProductState, relations: CognitiveRelations): ProductState {
  if (relations.contradicts.length === 0 && relations.supersedes.length === 0) {
    return state;
  }
  const byId = new Map(state.points.map((p) => [p.id, p] as const));

  // 累积每个 point 要追加的 contradicts 软链、要置的 status、要写的 supersededBy。
  const addContradicts = new Map<string, Set<string>>();
  const nextStatus = new Map<string, PointAsset["status"]>();
  const supersededBy = new Map<string, string>();

  const pushContradict = (from: string, to: string) => {
    const set = addContradicts.get(from) ?? new Set<string>();
    set.add(to);
    addContradicts.set(from, set);
  };

  for (const [a, b] of relations.contradicts) {
    const pa = byId.get(a);
    const pb = byId.get(b);
    if (!pa || !pb || pa.id === pb.id) continue;
    pushContradict(pa.id, pb.id);
    pushContradict(pb.id, pa.id);
    const weaker = weakerPoint(pa, pb);
    // 只在弱方仍是非终态(未放弃/未修正)时降级为被挑战,避免覆盖更确定的生命周期态。
    if (!TERMINAL_POINT_STATUSES.has(weaker.status) && weaker.status !== "已修正") {
      nextStatus.set(weaker.id, "被挑战中");
    }
  }

  for (const { oldId, newId } of relations.supersedes) {
    const oldP = byId.get(oldId);
    const newP = byId.get(newId);
    if (!oldP || !newP || oldP.id === newP.id) continue;
    supersededBy.set(oldP.id, newP.id);
    // 已修正优先级高于被挑战:若同一 point 既被判对立又被判取代,落「已修正」。
    nextStatus.set(oldP.id, "已修正");
  }

  if (addContradicts.size === 0 && nextStatus.size === 0 && supersededBy.size === 0) {
    return state;
  }

  const stamp = nowIso();
  const points = state.points.map((p) => {
    const extra = addContradicts.get(p.id);
    const status = nextStatus.get(p.id);
    const superseded = supersededBy.get(p.id);
    if (!extra && !status && !superseded) return p;

    const next: PointAsset = { ...p, updatedAt: stamp };
    if (extra) {
      next.contradictsPointIds = dedupe([...(p.contradictsPointIds ?? []), ...extra]);
    }
    if (status) next.status = status;
    if (superseded) next.supersededByPointId = superseded;
    return next;
  });

  return { ...state, points };
}

// --- helpers ---

/** 无序对归一键:按 id 字典序。 */
function pairKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

/** 较弱的一方:置信更低优先;同置信则更早(updatedAt 字典序更小)。 */
function weakerPoint(a: PointAsset, b: PointAsset): PointAsset {
  const ra = confidenceRank(a.confidence);
  const rb = confidenceRank(b.confidence);
  if (ra !== rb) return ra < rb ? a : b;
  return a.updatedAt <= b.updatedAt ? a : b;
}

function confidenceRank(c: PointAsset["confidence"]): number {
  switch (c) {
    case "用户确认":
      return 3;
    case "AI 推断":
      return 2;
    case "待验证":
      return 1;
    default:
      return 0;
  }
}

function dedupe(ids: string[]): string[] {
  return Array.from(new Set(ids));
}
