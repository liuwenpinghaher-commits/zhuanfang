import type { ProductState } from "../../../../src/domain/types";

/** state 数组键 ↔ 节点表 + 核心字段(落 typed 列,与 001/004 DEFINE FIELD 对齐;日期不入核心)。
 *  非核心字段(含日期/可选/嵌套/session.turns)整体进 rest,无损。
 *
 *  ⚠️ 新增一类数组实体的完整清单(5 步,漏一步都是静默数据缺陷,守卫测试会拦但别赌):
 *  ① migrations/ 新增迁移:SCHEMAFULL 表 + 核心列(枚举 ASSERT)+ rest FLEXIBLE DEFAULT {};
 *  ② 本文件:NODE_MAPPINGS 加映射 + stateKey 联合类型加键(core 列表与 ① DEFINE FIELD 对齐);
 *  ③ surreal-product-state-repository.ts:该表所有 `DEFAULT time::now()` 列登记进
 *     DATETIME_DEFAULT_COLS(UPSERT CONTENT 不重跑 DEFAULT);若曾在 META_KEYS,从中摘除;
 *  ④ src/domain/storage.ts clampPersistableEnums:必填 string 列 str() / array<string> 列
 *     strArr() / 枚举列 clampEnum(白名单与 ① ASSERT 逐一对齐,fail-closed);
 *  ⑤ 若域层写入是 prepend(newest-first),登记 R1A_PREPEND_TABLES(loadState 重排,防重启反序)。 */
export interface NodeMapping {
  stateKey: Extract<keyof ProductState,
    "points"|"decisions"|"debts"|"questions"|"themes"|"notes"
    |"memoryRecords"|"memoryCandidates"|"importSources"|"ragChunks"|"searchBriefs"|"sessions"
    // R1a:9 类原 state_meta.rest blob 数组实体真表化(单例 profile/systemConfig 走 repository 专门路径,
    // 流水 4 类 auditEvents/aiRunEvents/workflowRuns/operationalChecks 留待 R1b)
    |"profileSuggestions"|"interviewAnnotations"|"chatSessions"|"memoryCorrections"
    |"podcastEpisodes"|"corpusImports"|"corpusInsights"|"playbookPatches"|"configVersions">;
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
  // R1a:blob 实体真表化(核心列与 007_r1a_entities.surql DEFINE FIELD 对齐;日期仍不入核心,
  // datetime typed 列由 fillUpsertDefaults 从 rest 补值,登记见 DATETIME_DEFAULT_COLS)。
  { stateKey: "profileSuggestions",   table: "profile_suggestion",   core: ["field","currentValue","suggestedValue","sourceSessionId","status"] },
  { stateKey: "interviewAnnotations", table: "interview_annotation", core: ["sessionId","turnId","text"] },
  { stateKey: "chatSessions",         table: "chat_session",         core: ["title"] },
  { stateKey: "memoryCorrections",    table: "memory_correction",    core: ["text"] },
  { stateKey: "podcastEpisodes",      table: "podcast_episode",      core: ["noteId","title","format","voice","status","scriptReviewStatus","sourceType","sourceId"] },
  { stateKey: "corpusImports",        table: "corpus_import",        core: ["title","mediaType","content","sourceUrl","status"] },
  { stateKey: "corpusInsights",       table: "corpus_insight",       core: ["importId","title"] },
  { stateKey: "playbookPatches",      table: "playbook_patch",       core: ["title","sourceInsightId","sourceImportId","status","impact"] },
  { stateKey: "configVersions",       table: "config_version",       core: ["version","changedBy","reason","active"] },
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
