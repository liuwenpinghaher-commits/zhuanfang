import type { ProductState } from "../../../../src/domain/types";

/** state 数组键 ↔ 节点表 + 核心字段(落 typed 列,与 001/004 DEFINE FIELD 对齐;日期不入核心)。
 *  非核心字段(含日期/可选/嵌套/session.turns)整体进 rest,无损。 */
export interface NodeMapping {
  stateKey: Extract<keyof ProductState,
    "points"|"decisions"|"debts"|"questions"|"themes"|"notes"
    |"memoryRecords"|"memoryCandidates"|"importSources"|"ragChunks"|"searchBriefs"|"sessions">;
  table: string;
  core: string[];
}

export const NODE_MAPPINGS: NodeMapping[] = [
  { stateKey: "points",           table: "point",            core: ["title","content","status","confidence","important"] },
  { stateKey: "decisions",        table: "decision",         core: ["title","decisionKind","confirmationStatus","choice","status"] },
  { stateKey: "debts",            table: "debt",             core: ["concept","context","status"] },
  { stateKey: "questions",        table: "question",         core: ["question","whyImportant","status","appearances"] },
  { stateKey: "themes",           table: "theme",            core: ["name","summary","maturity","representativeQuote","appearances"] },
  { stateKey: "notes",            table: "note",             core: ["sessionId","title","summary","keyQuote","saidTrack","learnedTrack"] },
  { stateKey: "memoryRecords",    table: "memory",           core: ["text","status","sourceType","sourceId","evidenceQuote","sensitivity","importance","embedding"] },
  { stateKey: "memoryCandidates", table: "memory_candidate", core: ["text","status","sourceType","sourceId","sensitivity","reviewScore"] },
  { stateKey: "importSources",    table: "material",         core: ["title","sourceType","sourceUrl","content","status","sensitivity"] },
  { stateKey: "ragChunks",        table: "rag_chunk",        core: ["sourceId","title","text","keywords","usage","embedding"] },
  { stateKey: "searchBriefs",     table: "search_brief",     core: ["topic","provider","status","summary"] },
  { stateKey: "sessions",         table: "session",          core: ["title","mode","strength","status"] },
];

const BY_KEY = new Map(NODE_MAPPINGS.map((m) => [m.stateKey, m] as const));
export function mappingFor(stateKey: string): NodeMapping | undefined { return BY_KEY.get(stateKey as NodeMapping["stateKey"]); }

/** 实体 → 记录:核心字段(存在的才落)作 typed 列,其余进 rest;id 不作字段(→ 记录 id)。 */
export function toRecord(entity: Record<string, unknown>, m: NodeMapping): Record<string, unknown> {
  const rec: Record<string, unknown> = {};
  const rest: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(entity)) {
    if (k === "id") continue;
    if (m.core.includes(k)) {
      if (v !== undefined) rec[k] = v;
    } else {
      rest[k] = v;
    }
  }
  rec.rest = rest;
  return rec;
}

/** SurrealDB datetime 列读回是 SDK 的 DateTime 包装类(非原生 Date、更非 string;实测 ctor=DateTime$1)。
 *  域类型把所有时间戳声明为 ISO string,故读回时统一 coerce 回字符串——否则 surreal 权威进程重启后
 *  loadState 出来的 updatedAt/createdAt 等是对象,`.slice()`/字符串比较的消费点会炸(JSON.stringify
 *  恰好把它转回 ISO 而掩盖了这个 bug)。只对 datetime-like 生效:string/number/array(embedding) 原样返回。 */
function coerceSurrealDate(v: unknown): unknown {
  if (v == null || typeof v === "string") return v;
  if (v instanceof Date) return v.toISOString();
  const o = v as { toISOString?: () => unknown; toJSON?: () => unknown };
  if (typeof o.toISOString === "function") {
    const s = o.toISOString();
    if (typeof s === "string") return s;
  }
  if (typeof o.toJSON === "function") {
    const j = o.toJSON();
    if (typeof j === "string") return j;
  }
  return v;
}

/** 记录 → 实体:id(记录 id) + 核心列(datetime 列 coerce 回 ISO string) + 展开 rest。
 *  rest 不含核心键(toRecord 已分流),故合并无冲突;核心列即真值,覆盖 rest 中的同名(若有)。 */
export function fromRecord(id: string, rec: Record<string, unknown>): Record<string, unknown> {
  const { rest, ...core } = rec;
  const restObj = (rest && typeof rest === "object") ? rest as Record<string, unknown> : {};
  const coercedCore: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(core)) coercedCore[k] = coerceSurrealDate(v);
  return { id, ...restObj, ...coercedCore };
}
