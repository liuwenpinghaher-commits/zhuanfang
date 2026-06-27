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

/** 边身份(无稳定 id):from 表:id | 边类型 | to 表:id。
 *  注:key 不含 provenance。本投影下同 (from,edge,to) 的 provenance 恒等
 *  (derived_from 的 turnId 全局唯一→sessionId 唯一→origin 固定 'llm_extracted'),
 *  故按 key 去重无损。若将来给某种边加“同端点但可变”的字段,需把它并入 key,否则会被静默吞。 */
export function edgeKey(e: EdgeSpec): string {
  return `${e.fromTable}:${e.fromId}|${e.edge}|${e.toTable}:${e.toId}`;
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
