import { stableStringify } from "../../../../src/domain/stateDigest";
import type { EdgeSpec } from "./edge-mapper";

export interface IdDiff<T> { upsert: T[]; removeIds: string[]; }

/** 按 id 配对 diff:next 有 prev 无、或同 id 内容变(stableStringify 比对) → upsert;
 *  prev 有 next 无 → removeIds。纯函数。 */
export function diffById<T extends { id: string }>(prev: readonly T[], next: readonly T[]): IdDiff<T> {
  const prevById = new Map(prev.map((x) => [x.id, x] as const));
  const nextIds = new Set(next.map((x) => x.id));
  const upsert: T[] = [];
  for (const item of next) {
    const before = prevById.get(item.id);
    if (!before || stableStringify(before) !== stableStringify(item)) upsert.push(item);
  }
  const removeIds: string[] = [];
  for (const item of prev) if (!nextIds.has(item.id)) removeIds.push(item.id);
  return { upsert, removeIds };
}

/** 边身份(无稳定 id):from 表:id | 边类型 | to 表:id [| origin]。
 *  ⑤:derived_from 的 provenance.origin 现按资产确认状态【可变】(用户确认→user_confirmed,
 *  其余→llm_extracted),不再恒定 'llm_extracted'。故把 origin 并入 key——同端点 origin 变时
 *  旧 key 进 removed(persist 先 DELETE in/out)、新 key 进 added(后 RELATE),顺序保证 origin
 *  更新正确落库,不滞后。无 origin 的边(belongs_to_theme/about_theme/part_of/contradicts)
 *  key 无后缀、行为不变。 */
export function edgeKey(e: EdgeSpec): string {
  const origin = e.data?.provenance?.origin;
  return `${e.fromTable}:${e.fromId}|${e.edge}|${e.toTable}:${e.toId}${origin ? `|${origin}` : ""}`;
}

export interface EdgeDiff { added: EdgeSpec[]; removed: EdgeSpec[]; }

/** 边集 diff:next 多的 added(RELATE),prev 多的 removed(DELETE WHERE in/out)。同 key 去重。 */
export function diffEdges(prev: readonly EdgeSpec[], next: readonly EdgeSpec[]): EdgeDiff {
  const prevByKey = new Map(prev.map((e) => [edgeKey(e), e] as const));
  const nextByKey = new Map(next.map((e) => [edgeKey(e), e] as const));
  const added: EdgeSpec[] = [];
  for (const [k, e] of nextByKey) if (!prevByKey.has(k)) added.push(e);
  const removed: EdgeSpec[] = [];
  for (const [k, e] of prevByKey) if (!nextByKey.has(k)) removed.push(e);
  return { added, removed };
}
