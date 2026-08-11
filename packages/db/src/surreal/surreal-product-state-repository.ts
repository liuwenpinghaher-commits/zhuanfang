import { RecordId } from "surrealdb";
import type { Surreal } from "surrealdb";
import type { ProductStateRepository, ReplaceStateOptions } from "../../../../apps/api/src/product-state-repository";
import { GovernanceInFlightError, StateRevisionConflictError } from "../../../../apps/api/src/product-state-repository";
import { createInitialProductState, createEmptyProductState } from "../../../../src/domain/engine";
import { normalizeProductState } from "../../../../src/domain/storage";
import { stableStringify } from "../../../../src/domain/stateDigest";
import type { InterviewAudio, InterviewRawMaterial, ProductState } from "../../../../src/domain/types";
import { createSurrealConnection, type SurrealConnectionOptions } from "./connect";
import { applySchema } from "./apply-schema";
import { selectBm25QueryTokens, buildBm25Clause, reorderByRrfRank, RRF_RANK_CONSTANT } from "./constants";
import { NODE_MAPPINGS, STREAM_MAPPINGS, toRecord, fromRecord, type StreamMapping } from "./node-mapper";
import { collectEdges, turnRecordsOf, turnRecordsFromRawMaterials, type EdgeSpec } from "./edge-mapper";
import { diffById, diffEdges } from "./diff";
import {
  audioContentOf,
  audioRecordId,
  AUDIO_TABLE,
  KNOWLEDGE_CHUNK_TABLE,
  rawMaterialContentOf,
  rawMaterialRecordId,
  RAW_MATERIAL_TABLE,
} from "./cold-shapes";

const META_ID = "state_meta:main";

/** 各节点表上带 `DEFAULT time::now()` 的 datetime 列(对齐 001_nodes.surql)。
 *  3.x 坑:`UPSERT ... CONTENT` 覆盖已存在记录时**不重跑 DEFAULT**,这些 SCHEMAFULL
 *  datetime 列会变 NONE 而 coerce 失败。故 persist 用 UPSERT 全量覆盖时必须显式补值
 *  (从实体 rest 里的同名 ISO 取,转 Date;无则 now)。注:这些列的真值仍在 rest 内无损,
 *  typed 列只为满足 schema;loadState/fromRecord 行为不变(见该函数注释)。
 *  ⚠️ 新增带 DEFAULT 的 datetime 列时,务必同步此表,否则 UPSERT 覆盖会静默 coerce 失败。 */
export const DATETIME_DEFAULT_COLS: Record<string, readonly string[]> = {
  session: ["startedAt"],
  turn: ["timestamp"],
  note: ["createdAt"],
  point: ["updatedAt"],
  decision: ["updatedAt"],
  debt: ["updatedAt"],
  question: ["updatedAt"],
  theme: ["updatedAt"],
  memory: ["createdAt", "updatedAt"],
  memory_candidate: ["createdAt"],
  material: ["createdAt"],
  rag_chunk: ["createdAt"],
  search_brief: ["createdAt"],
  // R1a:blob 实体真表化(007_r1a_entities.surql)的 DEFAULT datetime 列。
  profile_suggestion: ["createdAt"],
  interview_annotation: ["createdAt"],
  chat_session: ["createdAt", "updatedAt"],
  memory_correction: ["createdAt"],
  podcast_episode: ["createdAt"],
  corpus_import: ["createdAt"],
  corpus_insight: ["createdAt"],
  playbook_patch: ["createdAt"],
  config_version: ["createdAt"],
  // R1b:流水表(008_r1b_event_streams.surql)的 DEFAULT datetime 列(即各自的 tsField)。
  audit_event: ["createdAt"],
  ai_run_event: ["createdAt"],
  workflow_run: ["startedAt"],
  operational_check: ["checkedAt"],
  // R2a:三冷层(009_r2a_cold.surql)的 DEFAULT datetime 列。冷层由独立仓库直读直写、不走
  // persist 的 UPSERT CONTENT 路径,登记于此仅为满足 node-mapper.test 的防漂移守卫(扫全部
  // migration 的 DEFAULT datetime 列)。冷层写全量提供 createdAt,不依赖 fillUpsertDefaults。
  raw_material: ["createdAt"],
  audio: ["createdAt"],
  knowledge_chunk: ["createdAt"],
};

/** P3-12:可选 datetime 列(option<datetime>,无 DEFAULT)。与 DATETIME_DEFAULT_COLS 的区别:
 *  缺值时【不】now-兜底(那会把未完成的 active session 误盖成"已完成"),而是从 CONTENT 里省略
 *  → SCHEMAFULL option<datetime> 落 NONE。仅当 rest 里存在合法值时才投影为 typed 列(值本身由
 *  clampPersistableEnums.optIsoDate 已保证合法/undefined)。此前 session.completedAt 定义了却从不
 *  投影(恒 NONE、死列),"新增实体列 5 步清单"的投影步被漏;补此机制让它成为真·可查询列。 */
export const OPTIONAL_DATETIME_COLS: Record<string, readonly string[]> = {
  session: ["completedAt"],
};

/** 把记录补成"可被 UPSERT CONTENT 全量覆盖"的形态:
 *  ① `rest` 必有(turn 表 rest 也 DEFAULT {},CONTENT 覆盖不重跑 DEFAULT);
 *  ② 该表所有 DEFAULT datetime 列补成 Date(值取自 rest 里同名 ISO,无则 now)。 */
function fillUpsertDefaults(table: string, rec: Record<string, unknown>): Record<string, unknown> {
  if (rec.rest === undefined) rec.rest = {};
  const rest = (rec.rest && typeof rec.rest === "object") ? rec.rest as Record<string, unknown> : {};
  for (const col of DATETIME_DEFAULT_COLS[table] ?? []) {
    const existing = rec[col] ?? rest[col];
    rec[col] = existing instanceof Date ? existing
      : (typeof existing === "string" || typeof existing === "number") ? new Date(existing)
      : new Date();
  }
  // P3-12:可选 datetime 列——有合法值才投影为 typed 列,缺值则从 CONTENT 省略(落 NONE),
  // 绝不 now-兜底(否则未完成会话被误盖成已完成)。
  for (const col of OPTIONAL_DATETIME_COLS[table] ?? []) {
    const existing = rec[col] ?? rest[col];
    if (existing instanceof Date) {
      rec[col] = existing;
    } else if ((typeof existing === "string" && !Number.isNaN(Date.parse(existing))) || typeof existing === "number") {
      rec[col] = new Date(existing);
    } else {
      delete rec[col];   // 缺失/非法 → CONTENT 不含该键 → option<datetime> 落 NONE
    }
  }
  return rec;
}

/** 运维尾巴:不进节点表、整体存 state_meta.rest 的 ProductState 键。
 *  导出供分区完整性守卫测试用(防将来新增 ProductState 数组未映射被静默丢弃)。
 *  R1b 收官:4 类流水也真表化(STREAM_MAPPINGS,append-only 事件流表),
 *  rest blob 只剩 schemaVersion——state_meta 从"实体仓库"降格为纯元数据行,P3 → 0。 */
export const META_KEYS = ["schemaVersion"] as const;

/** R1b:流水表保留期(天)。DB 保全史(窗口滑出不删)、内存只保滚动窗(MAX_EVENT_LOG=1000),
 *  保留期清理防 DB 无限增长:启动时(loadState 后)以此常量清一次 cutoff 之前的条目。
 *  刻意不接调度器(YAGNI:单用户本地产品,进程重启频度足够;后续阶段需要再加)。
 *  导出理由:保留期是运维口径,未来 ops 端点/隐私报告需引用同一数字(勿散落硬编码)。 */
export const EVENT_STREAM_RETENTION_DAYS = 90;

/** 流水复合记录 id 的时间戳段:必须确定性(同一实体永远算出同一 id,否则 UPSERT 裂成多条)。
 *  坏值(非 string/空,理论上已被 normalize 的 str 钳制挡住)统一钉到 epoch。
 *  ⚠️ 成立前提:全库流水时间戳须同为**毫秒精度 toISOString() 产物**——str() 只保 string 不保
 *  格式;复合 id 的字典序=时间序、isSlideOut 的 <= 比较、prune 的 range 边界三处都依赖这一
 *  统一格式(混入秒精度/带时区偏移的 ISO 变体,字典序即偏离时间序)。域层写入点全部走
 *  new Date().toISOString(),故当前安全;新增写入点勿引入其他时间格式。 */
function streamTs(entity: Record<string, unknown>, m: StreamMapping): string {
  const v = entity[m.tsField];
  return typeof v === "string" && v ? v : "1970-01-01T00:00:00.000Z";
}

/** 流水复合记录 id:`<table>:[<tsField ISO>, <领域 id>]`(R0 后继实测:RecordId 传数组可直接
 *  作 UPSERT/DELETE 目标参数;range 语法 `table:[$a]..[$b]` 边界数组内可用参数)。
 *  时间戳段格式前提见 streamTs 注释(毫秒精度 toISOString 统一格式)。 */
function streamRecordIdOf(m: StreamMapping, entity: Record<string, unknown> & { id: string }): RecordId {
  return new RecordId(m.table, [streamTs(entity, m), entity.id]);
}

/** 复合数组 record id → 领域 id(第二段)。⚠️ 不能走 recordIdToDomainId:String(数组) 会把
 *  两段拼成 "ts,id"。 */
function streamDomainIdOf(id: unknown): string {
  if (id instanceof RecordId && Array.isArray(id.id)) return String(id.id[1] ?? "");
  return recordIdToDomainId(id);
}

/** R1a:单例实体 ↔ 单记录表(<table>:main,内容整体存 data FLEXIBLE)。
 *  persist 走 digest 变更才写的专门 UPSERT 路径(同 state_meta 模式,非 diffById);
 *  loadState 以表数据为准、忽略旧 state_meta.rest 的 blob 残留。导出供分区守卫测试用。 */
export const SINGLETON_TABLES: ReadonlyArray<{ stateKey: "profile" | "systemConfig"; table: string }> = [
  { stateKey: "profile", table: "profile" },
  { stateKey: "systemConfig", table: "system_config" },
];

/** R1a:单例是否变更——persist"变更才写"与 summarizePersistDiff 诊断共用同一判据(防口径漂移)。 */
function singletonChanged(prev: ProductState, next: ProductState, stateKey: string): boolean {
  return stableStringify((prev as unknown as Record<string, unknown>)[stateKey])
    !== stableStringify((next as unknown as Record<string, unknown>)[stateKey]);
}

/** R1a 重载序:9 类数组实体的域层写入点**全部是 prepend(newest-first)**——已逐一核对:
 *  profile.ts:125(profileSuggestions)/raw-material.ts:113(interviewAnnotations)/
 *  knowledge.ts:205(chatSessions)/note-feedback.ts:53(memoryCorrections)/
 *  podcast.ts:100,212,331,443(podcastEpisodes)/corpus.ts:179-193(corpusImports/Insights/
 *  playbookPatches)/engine.ts:616(configVersions)。blob 时代整体序列化天然保序;真表化后
 *  SELECT 无 ORDER BY 按 record id 升序返回 → 重启即反序(用户可见列表倒挂)。故 loadState
 *  对这 9 表按 createdAt DESC 重排(id DESC
 *  决胜同毫秒,尽力确定性),与 prepend 语义一致。
 *  既有 12 表(memoryRecords/searchBriefs 等)的同类重载序问题**预先存在**,本阶段刻意不动
 *  (改动面控制),记档待下阶段统一治理。 */
const R1A_PREPEND_TABLES = new Set([
  "profile_suggestion","interview_annotation","chat_session","memory_correction",
  "podcast_episode","corpus_import","corpus_insight","playbook_patch","config_version"
]);

function sortNewestFirst(entities: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  return entities.sort((a, b) => {
    const byCreated = String(b.createdAt ?? "").localeCompare(String(a.createdAt ?? ""));
    return byCreated !== 0 ? byCreated : String(b.id ?? "").localeCompare(String(a.id ?? ""));
  });
}

/** E:权威库异步落库健康度。surreal 是唯一持久档权威库,持续 persist 失败=静默丢数据,
 *  须经此暴露给 /api/health。consecutiveFailures>0 即上次落库未成功(基线未推进,正自愈重试)。 */
export interface PersistHealth {
  consecutiveFailures: number;
  lastError?: string;
  lastErrorAt?: string;
}

/** A-18 真实性熔断:上一笔落库失败(重试耗尽)后,拒绝接受新的整状态写——
 *  否则每一笔"已确认 200"的写都可能在重启时静默蒸发。statusCode=503 由全局
 *  错误处理器直接映射(同 GovernanceInFlightError.statusCode=409 先例)。
 *  恢复:后台定时重试(scheduleRecoveryRetry)把当前内存态重新落库,成功即解除熔断。 */
export class PersistUnavailableError extends Error {
  statusCode = 503;
  constructor(lastError?: string) {
    super(
      `权威库落库失败,已拒绝新写以防静默丢数据(上次错误:${lastError ?? "unknown"})。` +
        "系统正在后台自动重试,恢复后写入将自动放行。"
    );
    this.name = "PersistUnavailableError";
  }
}

/** persist 失败后的后台恢复重试间隔。 */
const PERSIST_RECOVERY_RETRY_MS = 30_000;

/** 完整导入包中同一 turn id 出现了互相矛盾的内容/归属。只暴露 id，不把逐字稿写入错误或日志。 */
export class GovernanceImportTurnConflictError extends Error {
  statusCode = 422;
  code = "IMPORT_TURN_CONFLICT";
  constructor(turnId: string) {
    super(`导入包中的 turn ${turnId} 存在内容或会话归属冲突，已整体拒绝。`);
    this.name = "GovernanceImportTurnConflictError";
  }
}

/** 完整导入包中的 evidence anchor 找不到同会话 turn；拒绝恢复假来源。 */
export class GovernanceImportProvenanceError extends Error {
  statusCode = 422;
  code = "IMPORT_PROVENANCE_MISSING";
  constructor(turnId: string) {
    super(`导入包中的来源锚点 turn ${turnId} 不存在或会话归属不一致，已整体拒绝。`);
    this.name = "GovernanceImportProvenanceError";
  }
}

/**
 * 为治理 import 构造仅供 turn/edge 持久化的完整投影。
 *
 * hot state 继续保持 offloaded（session.turns=[]）；raw material 中的 turns 只临时挂回对应
 * session，使同一事务能够 UPSERT turn 并 RELATE part_of/derived_from。没有对应 hot session 的
 * legacy raw material 仍照常恢复到冷层，但不会伪造 session 节点。
 */
function buildGovernanceProvenanceProjection(nextHot: ProductState, cold: GovernanceColdSpec): ProductState {
  if (cold.rawMaterial?.action !== "replace" || cold.rawMaterial.materials.length === 0) return nextHot;

  type Turn = InterviewRawMaterial["turns"][number];
  const signatures = new Map<string, string>();
  const rawTurnsBySession = new Map<string, Turn[]>();

  const register = (turn: Turn, sessionId: string): Turn => {
    if (turn.sessionId && turn.sessionId !== sessionId) throw new GovernanceImportTurnConflictError(turn.id);
    const normalized = { ...turn, sessionId };
    const signature = stableStringify(normalized);
    const existing = signatures.get(turn.id);
    if (existing !== undefined && existing !== signature) throw new GovernanceImportTurnConflictError(turn.id);
    signatures.set(turn.id, signature);
    return normalized;
  };

  for (const session of nextHot.sessions) {
    for (const turn of session.turns ?? []) register(turn, session.id);
  }
  for (const material of cold.rawMaterial.materials) {
    const bucket = rawTurnsBySession.get(material.sessionId) ?? [];
    const existingIds = new Set(bucket.map((turn) => turn.id));
    for (const turn of material.turns) {
      const normalized = register(turn, material.sessionId);
      if (!existingIds.has(normalized.id)) {
        bucket.push(normalized);
        existingIds.add(normalized.id);
      }
    }
    rawTurnsBySession.set(material.sessionId, bucket);
  }

  let changed = false;
  const sessions = nextHot.sessions.map((session) => {
    const coldTurns = rawTurnsBySession.get(session.id);
    if (!coldTurns?.length) return session;
    const hotIds = new Set((session.turns ?? []).map((turn) => turn.id));
    const missing = coldTurns.filter((turn) => !hotIds.has(turn.id));
    if (missing.length === 0) return session;
    changed = true;
    return { ...session, turns: [...(session.turns ?? []), ...missing] };
  });
  return changed ? { ...nextHot, sessions } : nextHot;
}

/**
 * N-03/N-05:治理并发共享上下文。治理事务(热态 + 三冷层)与冷层直读直写共用**同一个嵌入式连接**
 * (见 createSurrealStores 注释),因此必须共享同一"治理在途"标志与"治理代际",否则批次 A 的 M1
 * 守卫只罩住热态整状态写(replaceState/resetState),冷层直写(audio/raw/knowledge put)与后台长任务
 * (auto-run 简报、知识重嵌)会绕过守卫在 reset/purge 后把数据/衍生物写回"已清空"的权威库(隐私假清空)。
 * - inFlightCount:治理事务在途计数(>0 时并发整状态写与冷层直写一律拒 GovernanceInFlightError/409)。
 *   计数而非 boolean——两个治理调用嵌套时 boolean 会被先完成者提前清零。
 * - generation:每次治理事务成功递增(reset/purge/import 都算)。后台长任务(可达 90s 联网)在起点捕获
 *   代际,落库前若代际已变(其间发生过治理)则丢弃基于治理前状态生成的陈旧产出(N-05)。
 */
export interface GovernanceContext {
  inFlightCount: number;
  generation: number;
}
export function createGovernanceContext(): GovernanceContext {
  return { inFlightCount: 0, generation: 0 };
}

/** R2b 治理事务:热态整状态如何得到下一态。
 *  - reset:createEmptyProductState()(revision 0),与 resetState() 完全同语义。
 *  - replace:normalizeProductState({...next, revision: current+1}),与 replaceState() 完全同语义
 *    (含可选 expectedRevision 乐观锁;治理路由目前不传,保留供对称)。 */
export type GovernanceHotSpec =
  | { kind: "reset" }
  | { kind: "replace"; next: ProductState; expectedRevision?: number };

/** R2b 治理事务:冷层三库的目标操作。字段缺省 = 该库不在本事务内触碰(preserve)。
 *  - wipe:清空该库(reset/purge)。
 *  - replace:整库替换为给定集合(import 恢复;materials/audios 为 [] 即等价清空)。
 *  knowledge 仅支持 wipe(import 的知识重建走提交后 best-effort,不入本事务)。 */
export interface GovernanceColdSpec {
  rawMaterial?: { action: "wipe" } | { action: "replace"; materials: InterviewRawMaterial[] };
  audio?: { action: "wipe" } | { action: "replace"; audios: InterviewAudio[] };
  knowledgeIndex?: { action: "wipe" };
}

export interface SurrealRepoHandle extends ProductStateRepository {
  /** 等待所有挂起的异步落库完成(测试/优雅关闭用)。注意:队列尾已吞错,flush 永远 resolve。 */
  flush(): Promise<void>;
  /** A-18:等待最后一笔整状态写的真实落库结果,失败 reject。主写路由用它实现写确认。 */
  confirmPersisted(): Promise<void>;
  /** R2b · 治理事务(reset/purge/import):热态整状态替换 + 冷层三库删/写在**单个 BEGIN...COMMIT**
   *  内原子完成。任一步失败 → 整体回滚(无部分提交):DB、内存热态 state、diff 基线 lastPersisted
   *  全部保持事务前原样,向调用方抛错(路由据此返回 500 + 回执标注整体回滚)。成功 → 同时推进
   *  state 与 lastPersisted 到新态(否则下一笔 persist 会以旧基线 diff、复活已删数据——最大陷阱)。
   *  仅当 createSurrealStores 装配(冷热共用一个嵌入式连接)时暴露;standalone / 非 surreal 档为
   *  undefined,路由回落既有 journal/best-effort。串入 persist 队列(不与 persist 交错)。
   *  local-object 文件删除留在事务外(文件系统无法入事务),由路由在事务前后处理。 */
  runGovernanceTransaction?(hot: GovernanceHotSpec, cold: GovernanceColdSpec): Promise<ProductState>;
  /** E:权威库落库健康度(连续失败计数/最后错误)。/api/health 用以感知 surreal 权威库静默丢数据。 */
  getPersistHealth(): PersistHealth;
  /** N-05:治理代际(reset/purge/import 每次成功 ++)。后台长任务(auto-run/scheduler)起点捕获,
   *  终写前比对——代际已变即治理在途期间发生过整库替换,基于治理前状态生成的产出必须丢弃。 */
  getGovernanceGeneration(): number;
  /** 关闭底层连接(测试/关闭用)。 */
  close(): Promise<void>;
  /** 仅测试/诊断用:直查底层 db(读边等)。生产路径不应依赖。 */
  query<T extends unknown[]>(surql: string, vars?: Record<string, unknown>): Promise<T>;
  /** 主题聚合:指向该 theme 的所有资产 id(图入边,含曾漏 decisions)。仅 surreal。 */
  recallThemeAssets(themeId: string): Promise<{ points: string[]; decisions: string[]; questions: string[]; memories: string[] }>;
  /** 溯源:沿 derived_from 取某资产的证据 turn。敏感纵深门控:来源资产 sensitivity='sensitive'
   *  (memory/memory_candidate/material)默认不溯源——A4 挡住敏感记忆本体后,证据 turn 原话
   *  不该再经溯源这条侧路泄出;includeSensitive 显式放行。point/decision 无 sensitivity 列不受影响。 */
  recallProvenanceTurns(table: string, id: string, opts?: { includeSensitive?: boolean }): Promise<Array<{ id: string; content: string; sessionId: string; role: string }>>;
  /** 记忆混合召回(HNSW 语义 + BM25 关键词,search::rrf 倒数排名融合)。
   *  传 queryText → 叠加 BM25(补 HNSW 对专名/精确词的盲区);无/空 queryText 或 BM25 在 3.x 不可用
   *  → 退化为纯 HNSW(现状)。A4 门控始终:默认仅 confirmed+normal;includeSensitive 含 sensitive。 */
  recallMemoriesByVector(embedding: number[], k: number, opts?: { includeSensitive?: boolean; queryText?: string }): Promise<Array<{ id: string; text: string }>>;
  /** rag_chunk 原生混合召回(HNSW+BM25+search::rrf,镜像 recallMemoriesByVector;方案一)。
   *  usage 门控走参数绑定、只出现在纯 SELECT 的 WHERE(LET 子查询保持纯索引,P2a 教训);
   *  无 embedding → BM25-only(无嵌入的降级摄入块也因此可达);embedding/queryText 皆缺 → []。 */
  recallRagChunks(opts: { embedding?: number[]; queryText?: string; k: number; usage?: "interview-context" | "memory-candidate" }): Promise<Array<{ id: string; text: string }>>;
  /** 图↔软链一致性审计(方案二):collectEdges(lastPersisted) 期望边集 vs DB 实际边集。
   *  排除 append-only 豁免的 part_of(降冷后内存不投影但 DB 保留是 H1 契约的正确行为)。
   *  串入 persist 队列执行(不跨半个落库事务出暂态假差异);只读、不修复、不阻断。 */
  auditGraphConsistency(): Promise<GraphConsistencyReport>;
  /** R1b:流水表保留期清理——range 删除各流水表 cutoff(ISO)之前的历史条目;仍在内存窗口内的
   *  行绝不删(见 pruneStreamsBefore)。启动时自动以 EVENT_STREAM_RETENTION_DAYS 调一次;
   *  此方法供测试/运维手动触发。串入 persist 队列(写操作,与落库事务互斥)。 */
  pruneEventStreams(cutoffIso: string): Promise<void>;
}

/** 方案二审计报告:missing=期望有而 DB 无(投影漏写),unexpected=DB 有而期望无(漏删/带外写入)。
 *  样本各截前 20 条(edgeKey 形如 `belongs_to_theme|point:pt_1->theme:th_1`),计数为全量。
 *  danglingProvenanceCount:④ 根修的对偶——内存 anchor 指向已被 A5 级联删除的 turn,持久层
 *  按 DB 真相未投影该 derived_from。它单列而不进 missing,但仍令 ok=false，防审计假绿。 */
export interface GraphConsistencyReport {
  ok: boolean;
  auditedEdgeTables: string[];
  expectedCount: number;
  actualCount: number;
  missingCount: number;
  unexpectedCount: number;
  missingInDb: string[];
  unexpectedInDb: string[];
  danglingProvenanceCount: number;
  /** P0-1 观测补盲(全系统审查):节点表内存↔DB 差异——此前只审 5 边表,rag_chunk 级联静默
   *  删除这类"节点在内存、不在 DB"的发散零信号。turn 表豁免(append-only,DB 合法多于内存)。 */
  nodeMissingCount: number;
  nodeUnexpectedCount: number;
  nodeMissingInDb: string[];
  nodeUnexpectedInDb: string[];
}

export type SurrealRepoOptions = SurrealConnectionOptions;

/** 瞬态 persist 冲突重试间隔(共 1+4 次尝试,累计 ~3.2s)。
 *  定性更正(E2E 根因闭环):此前观测到的 "failed transaction" 实为悬空溯源的确定性拒绝
 *  (H1×A5 碰撞,已由 keepOnlyLiveTurnProvenance 根修),重试对其无效也不再需要。
 *  本阶梯保留作纯保险:万一将来出现真正的时间性引擎冲突(并发读写/HNSW 维护),写侧自恢复;
 *  正常路径零开销(首试即成功不进阶梯)。 */
const PERSIST_RETRY_DELAYS_MS = [100, 300, 800, 2000] as const;

/** 瞬态可重试错误:嵌入式引擎乐观事务冲突报文。schema ASSERT/字段 coerce 等数据形状错误
 *  不匹配 → 不重试(重试必然再失败,徒增延迟且掩盖真错)。导出供单测钉住判别口径。
 *  R0-S3 实测(2026-07-10,P8 修复):真实写写冲突抛的是 InternalError,message 为
 *  "Query not executed: Transaction conflict: Transaction write conflict. This transaction can be retried"
 *  ——旧匹配 /failed transaction/i 对它完全失效,重试阶梯从未对真冲突生效。三段式并联:
 *  failed transaction(历史报文)| transaction conflict | can be retried(引擎自述可重试)。 */
export function isTransientPersistError(err: unknown): boolean {
  return /failed transaction|transaction conflict|can be retried/i.test(err instanceof Error ? err.message : String(err));
}

/** 瞬态冲突有界重试(1+4 次尝试,累计 ~3.2s):对同一嵌入式连接上写事务偶发的乐观冲突自恢复。
 *  单一实现——persist 写路径与 R2a 冷层写路径共用同一阶梯(勿复制第二份重试逻辑);
 *  非瞬态错误(schema ASSERT/字段 coerce)立即抛,不重试(重试必然再失败,徒增延迟且掩盖真错)。
 *  onRetrySuccess:重试后成功的回调(仅 attempt>0 触发),供调用方打诊断日志。 */
export async function runWithTransientRetry<T>(
  fn: () => Promise<T>,
  onRetrySuccess?: (attempt: number) => void
): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= PERSIST_RETRY_DELAYS_MS.length; attempt++) {
    try {
      if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, PERSIST_RETRY_DELAYS_MS[attempt - 1]));
      const result = await fn();
      if (attempt > 0) onRetrySuccess?.(attempt);
      return result;
    } catch (err) {
      lastErr = err;
      if (!isTransientPersistError(err)) break;
    }
  }
  throw lastErr;
}

export async function createSurrealProductStateRepository(opts: SurrealRepoOptions): Promise<SurrealRepoHandle> {
  const db = await createSurrealConnection(opts);
  await applySchema(db);
  return buildSurrealProductStateRepositoryOnConnection(db, { ownsConnection: true });
}

/** R2a:在一个已打开且已 applySchema 的共享连接上构建产品状态仓库(不自己开连接)。
 *  createSurrealStores 用它把热态与三冷层挂到同一嵌入式连接(surrealkv 同进程独占锁,
 *  且 R2b 治理事务要跨冷热单事务);ownsConnection=false 时 close() 不关连接(由 stores 统一关)。
 *  standalone 的 createSurrealProductStateRepository 走 ownsConnection=true,close() 自关(向后兼容)。 */
export async function buildSurrealProductStateRepositoryOnConnection(
  db: Surreal,
  cfg: {
    ownsConnection: boolean;
    /** R2b:仅 createSurrealStores 装配(冷热同连接)时提供 → 暴露 runGovernanceTransaction。
     *  onKnowledgeIndexWiped:治理事务用一条 SQL 直清知识表(不经仓库 deleteAll),提交成功后回调
     *  此钩子递增知识索引 epoch,让 R8-1 竞态守卫丢弃"清空前构建、清空后落库"的陈旧后台嵌入。 */
    governance?: { onKnowledgeIndexWiped: () => void };
    /** N-03/N-05:共享治理上下文(createSurrealStores 传入同一个对象给热态 + 三冷层)。缺省则各自
     *  新建一份(standalone/向后兼容:standalone 无治理能力、无冷层直写并发面,自持一份即可)。 */
    governanceContext?: GovernanceContext;
  }
): Promise<SurrealRepoHandle> {

  // 内存工作副本:同步接口的真相源。
  const loaded = await loadState(db);
  let state: ProductState = loaded.state;
  // diff 基线:上次成功落库的状态(非内存 state)。失败不更新 → 下次 diff 自动补回漏掉的增量(自愈)。
  // 处女库(无 state_meta):loadState 捏造 createInitialProductState 作内存态,但 DB 里并没有它——
  // 基线若也设成捏造态就是【基线谎言】:此后所有 diff 都以为种子实体已在库,演示资产/其边永不落库
  // (原生 recallThemeAssets 漏召回;图审计冒烟实测抓到)。基线设空 + 下方立即
  // enqueue 首次落库,让 DB 真实收敛到内存态。
  let lastPersisted: ProductState = loaded.fromDb ? loaded.state : createEmptyProductState();
  let persistQueue: Promise<void> = Promise.resolve();
  // E:权威库落库健康度。成功清零、失败累积——surreal 权威库持续写不进=静默丢数据,必须可观测。
  let persistHealth: PersistHealth = { consecutiveFailures: 0 };
  // R2b(M1 修复)/ N-03 / N-05:治理并发共享上下文(计数而非 boolean——两个治理调用嵌套时 boolean 会被
  // 先完成者提前清零)。runGovernanceTransaction 在**函数体内同步** ++inFlightCount(不在 .then 里,否则
  // counter 迟于并发写读到旧 state 才升起、护栏失效),executeGovernanceTransaction 结算的 finally 里 --。
  // replaceState/resetState 见到 >0 即抛 GovernanceInFlightError,拒绝并发整状态写抢在治理提交前后写回
  // 旧快照(数据复活)。N-03:createSurrealStores 把同一个 ctx 也传给三冷层仓库,冷层直写据此同样拒写。
  // N-05:治理成功递增 generation,后台长任务据此丢弃陈旧产出。缺省新建一份(standalone 无并发面)。
  const governanceCtx = cfg.governanceContext ?? createGovernanceContext();

  // A-18:最后一笔 enqueue 的原始结果(失败会 reject)。confirmPersisted() 暴露给主写路由
  // (PUT /api/state)await——把"200 但没落库"的谎言窗口在主数据通道上关死。
  let lastEnqueueResult: Promise<void> = Promise.resolve();
  let recoveryTimer: ReturnType<typeof setTimeout> | undefined;
  // C16/Issue3:与 snapshot 一并记住最近一笔整状态写的 purge 意图。A-18 恢复重放时必须带上
  // 同一 streamPurgeMode,否则 journal 满窗 import 失败后恢复回落 slide-out 会再踩缺口 #6。
  type PersistOpts = { streamPurgeMode?: "slide-out" | "governance-keep" };
  let lastEnqueuePersistOpts: PersistOpts | undefined;

  // A-18 熔断恢复:persist 失败后定时把【当前】内存态重新落库(旧自愈只等"下一笔写",
  // 但熔断拒写后不会再有下一笔——必须由后台重试主动恢复)。成功清零 → 熔断解除。
  function scheduleRecoveryRetry() {
    if (recoveryTimer) return;
    recoveryTimer = setTimeout(() => {
      recoveryTimer = undefined;
      if (persistHealth.consecutiveFailures > 0) {
        console.warn(JSON.stringify({ event: "surreal_persist_recovery_retry" }));
        enqueuePersist(state, lastEnqueuePersistOpts);
      }
    }, PERSIST_RECOVERY_RETRY_MS);
    recoveryTimer.unref?.();
  }

  function enqueuePersist(
    snapshot: ProductState,
    persistOpts?: PersistOpts,
  ): Promise<void> {
    // 每笔 enqueue 覆盖意图(含 undefined=默认 slide-out),保证恢复与最近一次写语义一致。
    lastEnqueuePersistOpts = persistOpts;
    const run = persistQueue.then(async () => {
      // 瞬态冲突有界重试(P4 真实业务 E2E 实测):原生召回读(HNSW/BM25/图遍历)与 persist
      // 写事务在同一嵌入式连接上并发时,surrealkv 乐观事务偶发 "failed transaction"——
      // P4 修通生产可达性之前原生读不存在,故此前从未暴露。读绝不串行化(教训 6fca26b4:
      // 不把任何东西塞进写串行化),写侧立即有界重试即可(runWithTransientRetry,冷层复用同阶梯);
      // 非瞬态错误(schema ASSERT 等)不重试直接 fail-loud。重试全败 → 基线不动。
      await runWithTransientRetry(
        () => persist(db, lastPersisted, snapshot, persistOpts),
        (attempt) => console.warn(JSON.stringify({ event: "surreal_persist_retried_ok", attempt }))
      );
      lastPersisted = snapshot;                 // 仅成功后推进基线
      persistHealth = { consecutiveFailures: 0 };
    });
    lastEnqueueResult = run;
    persistQueue = run.catch((err) => {
      // fail-loud:基线不动;熔断(replaceState/resetState 拒新写)+ 后台定时重试恢复。
      // 连续失败计数随告警一起出——surreal 权威库持续写不进=静默丢数据,/api/health 须能感知。
      persistHealth = {
        consecutiveFailures: persistHealth.consecutiveFailures + 1,
        lastError: String(err),
        lastErrorAt: new Date().toISOString()
      };
      console.error(JSON.stringify({
        event: "surreal_persist_failed",
        consecutiveFailures: persistHealth.consecutiveFailures,
        error: persistHealth.lastError,
        // 诊断(E2E 实测:失败跨满整个重试阶梯=该笔 diff 形状确定性触发引擎约束,非时间性冲突)。
        // 打 diff 摘要,把"哪种形状会触发"变成可观测。
        diff: summarizePersistDiff(lastPersisted, snapshot)
      }));
      scheduleRecoveryRetry();
    });
    return run;
  }

  // 处女库首次落库:把捏造的初始态真正写进 DB(见 lastPersisted 基线注释)。经正常串行队列,
  // 幂等(落库后 state_meta 存在,后续启动走 fromDb 分支)。
  if (!loaded.fromDb) enqueuePersist(state);

  // R1b 保留期清理(启动时一次):DB 保全史、内存只窗口 1000(MAX_EVENT_LOG),保留期防 DB
  // 无限增长。串行队列内执行(与首次落库/后续 persist 互斥);失败只告警不毒化队列——清理是
  // 卫生工作,不该阻塞业务写。不接调度器(YAGNI,见 EVENT_STREAM_RETENTION_DAYS 注释)。
  {
    const cutoff = new Date(Date.now() - EVENT_STREAM_RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();
    persistQueue = persistQueue
      .then(() => pruneStreamsBefore(db, cutoff, state))
      .catch((err) => {
        console.warn(JSON.stringify({ event: "surreal_event_stream_prune_failed", error: String(err) }));
      });
  }

  // 下一态计算(单一真值):resetState / replaceState / R2b 治理事务共用,杜绝 revision/normalize
  // 语义在治理路径漂移。这两个纯函数只算下一态、不落库、不改内存 state(由调用点决定何时应用)。
  function computeResetNextState(): ProductState {
    return createEmptyProductState();   // revision 0,与 resetState 完全同语义
  }
  function computeReplaceNextState(next: ProductState, opts?: ReplaceStateOptions): ProductState {
    const currentRevision = state.revision ?? 0;
    if (opts?.expectedRevision !== undefined && opts.expectedRevision !== currentRevision) {
      throw new StateRevisionConflictError(opts.expectedRevision, currentRevision);
    }
    return normalizeProductState({ ...next, revision: currentRevision + 1 });
  }

  /** R2b 治理事务执行体(已在 persist 队列内串行,读执行时刻的 lastPersisted)。
   *  单事务 = 热态 diff 语句(复用 buildPersistStatements,不复制第二份 diff)+ 冷层三库删/写。
   *  成功:推进 state 与 lastPersisted 到 nextHot(基线推进正确性是最大陷阱,测试钉死)。
   *  失败:抛错,state / lastPersisted 一律不动(DB 也已整体回滚 → 三者仍一致,下笔 persist 基线正确)。 */
  async function executeGovernanceTransaction(hot: GovernanceHotSpec, cold: GovernanceColdSpec): Promise<ProductState> {
    const nextHot = hot.kind === "reset" ? computeResetNextState() : computeReplaceNextState(hot.next, { ...(hot.expectedRevision !== undefined ? { expectedRevision: hot.expectedRevision } : {}) });

    // 完整备份把已降冷 turns 放在 raw_material，而 hot session.turns 保持为空。治理导入必须在
    // 同一事务中把这些 turns 投影成图节点/边，但不能把它们重新塞回 session 记录或内存热态。
    // 因此 projection 只供 buildPersistStatements 的 turn/edge 阶段消费；节点、单例、流水和
    // 提交后的 state/lastPersisted 仍严格使用 nextHot。
    const provenanceProjection = buildGovernanceProvenanceProjection(nextHot, cold);

    // ① 热态 diff 语句(相对执行时刻的 lastPersisted 基线;含 keepOnlyLiveTurnProvenance 的 async 预查)。
    // C16:reset|replace 一律强制 streamPurgeMode=governance-keep——跳过流水 isSlideOut 判别,
    // 凡有 remove 即全表 `DELETE WHERE id NOT IN keep`,关闭满窗 import 缺口 #6(prev 窗口残留)。
    const { surql: hotSurql, vars } = await buildPersistStatements(db, lastPersisted, nextHot, {
      provenanceProjection,
      rebuildProvenance: cold.rawMaterial?.action === "replace",
      streamPurgeMode: "governance-keep",
    });

    // ② 冷层语句(cold_ 前缀避免与热态 vars 撞名)。DELETE 全表 = wipe;replace = 全删 + 逐条 UPSERT。
    let coldSurql = "";
    let knowledgeWiped = false;
    let ci = 0;
    if (cold.rawMaterial) {
      coldSurql += `DELETE ${RAW_MATERIAL_TABLE};\n`;
      if (cold.rawMaterial.action === "replace") {
        for (const m of cold.rawMaterial.materials) {
          const idV = `cold_rm_id${ci}`, cV = `cold_rm${ci}`; ci += 1;
          vars[idV] = rawMaterialRecordId(m.sessionId);
          vars[cV] = rawMaterialContentOf(m);
          coldSurql += `UPSERT $${idV} CONTENT $${cV};\n`;
        }
      }
    }
    if (cold.audio) {
      coldSurql += `DELETE ${AUDIO_TABLE};\n`;
      if (cold.audio.action === "replace") {
        for (const a of cold.audio.audios) {
          const { role, content } = audioContentOf(a);
          const idV = `cold_au_id${ci}`, cV = `cold_au${ci}`; ci += 1;
          vars[idV] = audioRecordId(a.sessionId, role);
          vars[cV] = content;
          coldSurql += `UPSERT $${idV} CONTENT $${cV};\n`;
        }
      }
    }
    if (cold.knowledgeIndex?.action === "wipe") {
      coldSurql += `DELETE ${KNOWLEDGE_CHUNK_TABLE};\n`;
      knowledgeWiped = true;
    }

    // ③ 单事务提交(热态在前、冷层在后;同一原子 BEGIN...COMMIT,内部顺序不影响最终态)。
    //   S2:走 runWithTransientRetry(与 persist / 冷层写同一阶梯)——治理与队列外的后台冷写
    //   (deleteBySource/put,各自带重试)在同一嵌入式连接上可撞真瞬态写写冲突,重试自恢复;
    //   isTransientPersistError 对 schema ASSERT/维度错等确定性错误返回 false → 立即抛(fail-fast
    //   不受影响),只对真瞬态冲突重试。语句已在上方生成一次,重试只重发同一 tx(每次都整体回滚,
    //   基线不动,幂等安全)。
    await runWithTransientRetry(() => db.query("BEGIN TRANSACTION;\n" + hotSurql + coldSurql + "COMMIT TRANSACTION;", vars) as Promise<unknown>);

    // ④ 仅提交成功后推进内存态与基线(顺序无关,同步赋值,无 await 窗口 → 不可能被观测到半推进)。
    state = nextHot;
    lastPersisted = nextHot;
    persistHealth = { consecutiveFailures: 0 };   // 成功的写:清零健康度(与 persist 成功路径一致)
    if (knowledgeWiped) cfg.governance?.onKnowledgeIndexWiped();   // 递增知识 epoch(R8-1 竞态守卫)
    // N-05:治理成功 → 代际 ++(同步赋值,与 state/lastPersisted 推进在同一无 await 窗口)。auto-run/
    // scheduler 终写前比对代际,已变则丢弃基于治理前状态生成的陈旧简报(见 routes/search、research-scheduler)。
    governanceCtx.generation += 1;
    return structuredClone(state);
  }

  return {
    getState() { return structuredClone(state); },
    getPersistHealth() { return { ...persistHealth }; },
    getGovernanceGeneration() { return governanceCtx.generation; },   // N-05
    resetState() {
      // M1:治理事务在途 → 拒绝并发整状态写(否则读旧 state、排到治理之后、以新基线复活个人数据)。
      if (governanceCtx.inFlightCount > 0) throw new GovernanceInFlightError();
      // A-18 熔断:上一笔落库失败 → 拒新写(503),防"已确认 200"的写重启蒸发。
      if (persistHealth.consecutiveFailures > 0) throw new PersistUnavailableError(persistHealth.lastError);
      state = computeResetNextState();
      // C16:整库清空对称治理 keep 清扫(空 next 下 isSlideOut 本就恒 false,显式 flag 防恢复路径歧义)。
      enqueuePersist(state, { streamPurgeMode: "governance-keep" });
      return structuredClone(state);
    },
    replaceState(next: ProductState, replaceOpts?: ReplaceStateOptions) {
      // M1:同上——治理在途拒绝并发整状态写。执行处 GovernanceInFlightError.statusCode=409 → HTTP 409。
      if (governanceCtx.inFlightCount > 0) throw new GovernanceInFlightError();
      // A-18 熔断:同 resetState。
      if (persistHealth.consecutiveFailures > 0) throw new PersistUnavailableError(persistHealth.lastError);
      state = computeReplaceNextState(next, replaceOpts);
      // C16 journal 回落:import/purge 经 replaceStateDurable 传 streamPurgeMode=governance-keep,
      // 与 executeGovernanceTransaction 主路径语义对齐(memory 档忽略此字段)。
      enqueuePersist(state, replaceOpts?.streamPurgeMode
        ? { streamPurgeMode: replaceOpts.streamPurgeMode }
        : undefined);
      return structuredClone(state);
    },
    // R2b:仅 governance 配置就位(createSurrealStores 装配)时暴露治理事务;standalone 为 undefined。
    ...(cfg.governance
      ? {
          runGovernanceTransaction(hot: GovernanceHotSpec, cold: GovernanceColdSpec): Promise<ProductState> {
            // M1:**同步**升起在途计数(函数体内,非 .then)——从治理被请求那刻起、贯穿整个 await 期间,
            // 并发 replaceState/resetState 一律被拒;executeGovernanceTransaction 结算(成功已推进基线 /
            // 失败已回滚)后在 finally 里落下计数。executeGovernanceTransaction 自身走 db.query 不调
            // replaceState,故不自我拒绝。
            governanceCtx.inFlightCount += 1;
            // 串入 persist 队列:治理事务绝不与挂起的 persist 交错(否则热态 diff 基线在半途被改)。
            // 失败不毒化队列尾(tail 吞掉),但把失败原样传给调用方(返回 run,非 tail)。
            const run = persistQueue
              .then(() => executeGovernanceTransaction(hot, cold))
              .finally(() => { governanceCtx.inFlightCount -= 1; });
            persistQueue = run.then(() => undefined, () => undefined);
            return run;
          },
        }
      : {}),
    getInterviewSession(id: string) {
      return state.sessions.find((s) => s.id === id) ?? null;
    },
    async flush() { await persistQueue; },
    // A-18:等待最后一笔 enqueue 的真实结果——失败会 reject(flush 走的是已吞错的队列尾,
    // 永远 resolve)。主写路由(PUT /api/state)await 它,把"200 但没落库"关死在主数据通道上。
    async confirmPersisted() { await lastEnqueueResult; },
    // R2a:共享连接下(ownsConnection=false)不在此关连接——由 createSurrealStores 统一关一次,
    // 避免冷层仓库还在用连接时被产品仓库 close 提前关掉。standalone 仍自关(向后兼容)。
    async close() { await persistQueue; if (cfg.ownsConnection) await db.close(); },
    query<T extends unknown[]>(surql: string, vars?: Record<string, unknown>) { return db.query<T>(surql, vars) as Promise<T>; },
    async recallThemeAssets(themeId: string) {
      const t = new RecordId("theme", themeId);
      const pick = async (sql: string): Promise<string[]> => {
        const [rows] = await db.query<[unknown[]]>(sql, { t });
        const arr = (rows?.[0] as Array<unknown> | undefined) ?? [];
        return arr.map((r) => recordIdToDomainId((r as { id?: unknown })?.id ?? r));
      };
      const [points, decisions, questions, memories] = await Promise.all([
        pick("SELECT VALUE <-belongs_to_theme<-point FROM $t;"),
        pick("SELECT VALUE <-belongs_to_theme<-decision FROM $t;"),
        pick("SELECT VALUE <-belongs_to_theme<-question FROM $t;"),
        pick("SELECT VALUE <-about_theme<-memory FROM $t;")
      ]);
      return { points, decisions, questions, memories };
    },
    async recallProvenanceTurns(table: string, id: string, provOpts?: { includeSensitive?: boolean }) {
      const from = new RecordId(table, id);
      const includeSensitive = provOpts?.includeSensitive ?? false;
      // D 溯源门控:已放弃/已修正的观点、deprecated/deleted 的资产不再溯源——这些是用户或系统
      // 已废弃的认知,不该再把它们的证据 turn 原话喂进 LLM 引导。WHERE 作用在来源资产 $from 上,
      // 终态则查无、返回空。
      // 敏感纵深(方案三,审计报告 P2):sensitivity='sensitive' 的来源资产(memory/material 等)
      // 默认不溯源——A4 挡住敏感记忆本体后,其证据 turn 原话不该经溯源侧路泄出;
      // point/decision 等无 sensitivity 列的资产取值 NONE → IS NONE 放行,行为不变。
      const [rows] = await db.query<[Array<Record<string, unknown>>]>(
        "SELECT VALUE ->derived_from->turn.* FROM $from WHERE status NOT IN ['已放弃','已修正','deprecated','deleted'] AND (sensitivity IS NONE OR sensitivity = 'normal' OR $includeSensitive);",
        { from, includeSensitive }
      );
      const turns = (rows?.[0] as unknown as Array<Record<string, unknown>> | undefined) ?? [];
      return turns.map((t) => ({
        id: recordIdToDomainId(t.id), content: String(t.content ?? ""),
        sessionId: String(t.sessionId ?? ""), role: String(t.role ?? "")
      }));
    },
    async recallMemoriesByVector(embedding: number[], k: number, recallOpts?: { includeSensitive?: boolean; queryText?: string }) {
      const includeSensitive = recallOpts?.includeSensitive ?? false;
      const queryText = recallOpts?.queryText?.trim();

      // 纯 HNSW(现状 / 退化基线)。A4:status='confirmed' 必须;sensitivity 默认仅 normal。
      // 3.x:KNN 算子 <|k,ef|> 已按余弦相似度近似排序;ORDER BY 不能用函数表达式
      //      (报 "Missing order idiom vector"),故去掉 ORDER BY,靠 KNN 本身的近邻序。
      //      注:<|k,ef|> 只接受字面量($k 报 "expected an unsigned integer"),故 k/ef 插值。
      const ef = Math.max(k * 4, 40);
      const hnswOnly = async (): Promise<Array<{ id: string; text: string }>> => {
        const [rows] = await db.query<[Array<Record<string, unknown>>]>(
          `SELECT id, text FROM memory
             WHERE status = 'confirmed'
               AND (sensitivity = 'normal' OR $includeSensitive)
               AND embedding <|${k},${ef}|> $q;`,
          { q: embedding, includeSensitive }
        );
        const hits = (rows ?? []) as Array<{ id: unknown; text: unknown }>;
        return hits.map((h) => ({ id: recordIdToDomainId(h.id), text: String(h.text ?? "") }));
      };

      // fail-safe:无 queryText → 纯 HNSW(绝不破坏召回)。
      if (!queryText) return hnswOnly();

      try {
        // ③ 混合检索:HNSW(语义)+ BM25(关键词)→ search::rrf 倒数排名融合(实测 @3.0.2)。
        //
        // 3.0.2 实测要点(本轮 spike 锁定):
        //  · 官方签名 search::rrf($lists, $limit, $k):第2参=limit(返回上限)、第3参=k(RRF 衰减
        //    常量 1/(k+rank),默认 60)。perf/审计(#5):本轮 spike 坐实 `search::rrf([a,b],1,60)` 恰返
        //    1 行 → 第2=limit。此前把 60 放进 limit 槽、把 recall_k 放进 k 槽属**语义倒置**,已更正为
        //    `[$vec,$bm], Math.max(k,RRF_RANK_CONSTANT), RRF_RANK_CONSTANT`(limit=大候选池逼近精确、
        //    k=60 官方衰减)。$lists 每个结果集须为 [{id}, ...](即 `SELECT id`,不能 `SELECT VALUE id`
        //    裸 RecordId,否则恒返 [])。返回 [{ id, rrf_score }],按融合名次降序。limit 必传。
        //  · BM25 用 ngram(2,2) analyzer 时,裸 `@@ '多字词'`(及 @AND@/@OR@)对**多 token** query
        //    恒不命中(token 切分后匹配条件不满足);**单 token `@@` 才命中**。故把 queryText 经
        //    `search::analyze` 切成 ngram,逐 token `text @@ $tN` 用 OR 串联,等价 OR 召回。
        //  · ⚠️ KNN/BM25 子查询里**不能再叠加额外 AND 过滤**:`... AND embedding <|k,ef|> $q` 放进
        //    `LET` 绑定时索引路径失效、子查询恒空(同 P2a 的 KNN 脆弱性)。故两路保持「纯索引」,
        //    A4 门控移到**最终取回 SELECT**(强度等同:confirmed + sensitivity)。
        const tokensRes = await db.query<[string[]]>("RETURN search::analyze('zh', $t);", { t: queryText });
        const analyzed = Array.isArray(tokensRes?.[0]) ? (tokensRes[0] as unknown[]).map(String).filter(Boolean) : [];
        // R4a 择优+钳制(统一口径,见 constants.ts selectBm25QueryTokens):去重→含多字 gram 则丢单字
        // 1-gram(纯单字查询保留)→ 上限 32。ngram(1,3) 下若灌 1-gram,多字查询候选/延迟暴涨(实测)。
        const tokens = selectBm25QueryTokens(analyzed);
        // 语义性空:query 切不出 token(纯符号/空白)→ BM25 天然不适用,走纯 HNSW。
        // 非失败,但必须可观测(此前无声)。
        if (tokens.length === 0) {
          console.warn(JSON.stringify({ event: "surreal_hybrid_bm25_skipped", reason: "no_tokens", queryChars: queryText.length }));
          return hnswOnly();
        }

        const { clause: bmClause, vars: tokenVars } = buildBm25Clause(tokens);

        const results = await db.query<Array<Array<Record<string, unknown>>>>(
          `LET $vec = (SELECT id FROM memory WHERE embedding <|${k},${ef}|> $q);
           LET $bm  = (SELECT id FROM memory WHERE ${bmClause});
           LET $fused = search::rrf([$vec, $bm], ${Math.max(k, RRF_RANK_CONSTANT)}, ${RRF_RANK_CONSTANT});
           SELECT id, text FROM memory
             WHERE id IN $fused.map(|$r| $r.id)
               AND status = 'confirmed'
               AND (sensitivity = 'normal' OR $includeSensitive);`,
          { q: embedding, includeSensitive, ...tokenVars }
        );
        // 多语句:前 3 个 LET 返回 null,取最后一条 SELECT 的结果集(不能取 results[0])。
        const fusedRows = results[results.length - 1];
        // 融合为空可能是 A4 门控合法滤空,也可能是 rrf 在该 query 下无产出——用纯 HNSW
        // 复核一次(同门控的另一条真实检索路径,非伪造),并记日志使差异可查。
        const fused = (fusedRows ?? []) as Array<{ id: unknown; text: unknown }>;
        if (fused.length === 0) {
          console.warn(JSON.stringify({ event: "surreal_hybrid_fusion_empty", path: "memory", queryChars: queryText.length }));
          return hnswOnly();
        }
        return fused.map((h) => ({ id: recordIdToDomainId(h.id), text: String(h.text ?? "") }));
      } catch (err) {
        // 真实错误(search::rrf/BM25 在该环境不可用或报错)→ 如实上抛,由调用方暴露。
        // 不再静默退化纯 HNSW 冒充混合召回结果。
        console.warn(JSON.stringify({ event: "surreal_hybrid_recall_failed", error: err instanceof Error ? err.message : String(err) }));
        throw err;
      }
    },
    async recallRagChunks(ragOpts: { embedding?: number[]; queryText?: string; k: number; usage?: "interview-context" | "memory-candidate" }) {
      const k = Math.max(1, Math.floor(ragOpts.k));
      const ef = Math.max(k * 4, 40);
      const embedding = Array.isArray(ragOpts.embedding) && ragOpts.embedding.length > 0 ? ragOpts.embedding : undefined;
      const queryText = ragOpts.queryText?.trim();
      // usage 门控:值走参数绑定;未指定 usage → $anyUsage 恒真放行(与 A4 `(…='normal' OR $includeSensitive)` 同型)。
      const usageGate = "(usage = $usage OR $anyUsage)";
      const gateVars: Record<string, unknown> = { usage: ragOpts.usage ?? "", anyUsage: !ragOpts.usage };
      const toHits = (rows: unknown): Array<{ id: string; text: string }> =>
        ((rows ?? []) as Array<{ id: unknown; text: unknown }>).map((h) => ({ id: recordIdToDomainId(h.id), text: String(h.text ?? "") }));

      // 纯 HNSW 基线:直接 SELECT 可叠 AND 过滤(镜像 memory hnswOnly,P2a 脆弱性仅在 LET 子查询)。
      // 无 embedding → [](调用方回落域层排序,绝不伪造)。
      const hnswOnly = async (): Promise<Array<{ id: string; text: string }>> => {
        if (!embedding) return [];
        const [rows] = await db.query<[Array<Record<string, unknown>>]>(
          `SELECT id, text FROM rag_chunk WHERE ${usageGate} AND embedding <|${k},${ef}|> $q;`,
          { q: embedding, ...gateVars }
        );
        return toHits(rows);
      };

      if (!queryText) return hnswOnly();

      try {
        const tokensRes = await db.query<[string[]]>("RETURN search::analyze('zh', $t);", { t: queryText });
        const analyzed = Array.isArray(tokensRes?.[0]) ? (tokensRes[0] as unknown[]).map(String).filter(Boolean) : [];
        // R4a 择优+钳制(统一口径,见 constants.ts selectBm25QueryTokens):与 memory 路逐字同款。
        const tokens = selectBm25QueryTokens(analyzed);
        // 语义性空:切不出 token → BM25 天然不适用,走纯 HNSW(可观测,此前无声)。
        if (tokens.length === 0) {
          console.warn(JSON.stringify({ event: "surreal_rag_bm25_skipped", reason: "no_tokens", queryChars: queryText.length }));
          return hnswOnly();
        }

        const { clause: bmClause, vars: tokenVars } = buildBm25Clause(tokens);

        if (!embedding) {
          // BM25-only:无向量时关键词路单独可用——无嵌入的降级摄入块(HNSW 索引不含它们)由此可达。
          const [rows] = await db.query<[Array<Record<string, unknown>>]>(
            `SELECT id, text FROM rag_chunk WHERE ${usageGate} AND (${bmClause}) LIMIT ${k};`,
            { ...gateVars, ...tokenVars }
          );
          return toHits(rows);
        }

        // 混合:两路纯索引 LET → search::rrf 融合 → 最终 SELECT 叠 usage 门控(P2a:LET 内绝不加 AND)。
        // 末条 RETURN 融合名次:`WHERE id IN …` 取回不保序;memory 路径有域层三因子精排兜着可容忍,
        // rag 无精排、名次即最终序,必须按 rrf 名次在 JS 侧重排。
        // BM25 直查:融合空时兜底;融合非空时也必须并入——search::rrf 在 $bm 瞬时空/半空时
        // 仍可能只返 HNSW 路,丢掉无 embedding 的关键词块(P4 e2e 判别器 rc_y 的根因)。
        const bmOnly = async (): Promise<Array<{ id: string; text: string }>> => {
          const [bmRows] = await db.query<[Array<Record<string, unknown>>]>(
            `SELECT id, text FROM rag_chunk WHERE ${usageGate} AND (${bmClause}) LIMIT ${k};`,
            { ...gateVars, ...tokenVars }
          );
          return toHits(bmRows);
        };
        /** 融合空兜底:关键词块优先(无向量块只在 BM25 路),再补 HNSW。 */
        const mergeBm25ThenPrimary = (
          primary: Array<{ id: string; text: string }>,
          bm: Array<{ id: string; text: string }>
        ): Array<{ id: string; text: string }> => {
          if (bm.length === 0) return primary.slice(0, k);
          const seen = new Set<string>();
          const merged: Array<{ id: string; text: string }> = [];
          for (const hit of bm) {
            if (seen.has(hit.id)) continue;
            seen.add(hit.id);
            merged.push(hit);
            if (merged.length >= k) return merged;
          }
          for (const hit of primary) {
            if (seen.has(hit.id)) continue;
            seen.add(hit.id);
            merged.push(hit);
            if (merged.length >= k) break;
          }
          return merged;
        };
        /** 融合非空:保留 rrf 名次,并为 BM25 独有块(典型:无 embedding)预留名额——
         *  若 fused 已撑满 k,直接 append 会被截掉;故先截 primary 再并入 missing。 */
        const appendMissingBm25 = (
          primary: Array<{ id: string; text: string }>,
          bm: Array<{ id: string; text: string }>
        ): Array<{ id: string; text: string }> => {
          if (bm.length === 0) return primary.slice(0, k);
          const primaryIds = new Set(primary.map((h) => h.id));
          const missing: Array<{ id: string; text: string }> = [];
          const seenMissing = new Set<string>();
          for (const hit of bm) {
            if (primaryIds.has(hit.id) || seenMissing.has(hit.id)) continue;
            seenMissing.add(hit.id);
            missing.push(hit);
            if (missing.length >= k) break;
          }
          if (missing.length === 0) return primary.slice(0, k);
          const keepPrimary = Math.min(primary.length, Math.max(0, k - missing.length));
          return [...primary.slice(0, keepPrimary), ...missing].slice(0, k);
        };

        const results = await db.query<Array<unknown>>(
          `LET $vec = (SELECT id FROM rag_chunk WHERE embedding <|${k},${ef}|> $q);
           LET $bm  = (SELECT id FROM rag_chunk WHERE ${bmClause});
           LET $fused = search::rrf([$vec, $bm], ${Math.max(k, RRF_RANK_CONSTANT)}, ${RRF_RANK_CONSTANT});
           SELECT id, text FROM rag_chunk WHERE id IN $fused.map(|$r| $r.id) AND ${usageGate};
           RETURN $fused.map(|$r| $r.id);`,
          { q: embedding, ...gateVars, ...tokenVars }
        );
        const rows = toHits(results[results.length - 2]);
        // 融合为空可能是 usage 门控合法滤空——用 BM25∪HNSW 复核(同门控真实检索路径,非伪造)。
        if (rows.length === 0) {
          console.warn(JSON.stringify({ event: "surreal_hybrid_fusion_empty", path: "rag_chunk", queryChars: queryText.length }));
          try {
            const bm = await bmOnly();
            const hn = await hnswOnly();
            return mergeBm25ThenPrimary(hn, bm);
          } catch (bmErr) {
            console.warn(JSON.stringify({
              event: "surreal_rag_bm25_fallback_failed",
              error: bmErr instanceof Error ? bmErr.message : String(bmErr)
            }));
            return hnswOnly();
          }
        }
        const order = ((results[results.length - 1] ?? []) as unknown[]).map((rid) => recordIdToDomainId(rid));
        const fusedOrdered = reorderByRrfRank(rows, order);
        // 非空融合也并入 BM25 缺失项:保证无向量块不因 rrf/$bm 抖动从混合结果里消失。
        try {
          const bm = await bmOnly();
          return appendMissingBm25(fusedOrdered, bm);
        } catch (bmErr) {
          console.warn(JSON.stringify({
            event: "surreal_rag_bm25_union_failed",
            error: bmErr instanceof Error ? bmErr.message : String(bmErr)
          }));
          return fusedOrdered.slice(0, k);
        }
      } catch (err) {
        // 真实错误(search::rrf/BM25 报错)→ 如实上抛,由调用方暴露,不再退化掩盖。
        console.warn(JSON.stringify({ event: "surreal_rag_recall_failed", error: err instanceof Error ? err.message : String(err) }));
        throw err;
      }
    },
    async auditGraphConsistency() {
      // 串入 persist 队列:与落库事务互斥,五张边表的 SELECT 不会跨在半个 persist 中间(暂态假差异);
      // 基线取执行时刻的 lastPersisted(队列排空后 = 最新成功落库态,persist 失败时基线不动、
      // DB 也没动,比对依然成立)。审计只读、5 个小 SELECT 毫秒级——不构成写路径长阻塞
      // (教训 6fca26b4:长任务绝不进写串行化;这里刻意保持极小)。
      const run = persistQueue.then(() => runGraphAudit(db, lastPersisted));
      persistQueue = run.then(() => undefined, () => undefined); // 审计失败不毒化落库队列
      return run;
    },
    async pruneEventStreams(cutoffIso: string) {
      // 串入 persist 队列(写操作);memState 取执行时刻的内存态,保证不删窗口内条目。
      const run = persistQueue.then(() => pruneStreamsBefore(db, cutoffIso, state));
      persistQueue = run.then(() => undefined, () => undefined); // 清理失败不毒化落库队列
      await run;
    },
  };
}

/** ④ 根修:过滤 turn 端点已不存在的 derived_from 新增边(端点在本事务 upsert 集 → 必然存在,跳过;
 *  其余批量查 DB 实存)。只在存在此类候选时多一个 ms 级 SELECT(降冷 finalize / 重引入场景),
 *  常规流(anchor 指向活跃会话 turn)零额外开销。
 *  P0-2:removedSessionIds = 本事务将删除的 session——其 turn 将被 A5 在同一事务内级联删除,
 *  预查时刻仍实存,必须按 provenance.sessionId 直接判死,不能只信 DB 预查。 */
async function keepOnlyLiveTurnProvenance(
  db: Surreal,
  added: EdgeSpec[],
  nextTurnIds: Set<string>,
  removedSessionIds: Set<string>
): Promise<EdgeSpec[]> {
  const candidates = added.filter((e) => e.edge === "derived_from" && e.toTable === "turn" && !nextTurnIds.has(e.toId));
  if (candidates.length === 0) return added;
  const doomed = (e: EdgeSpec) => {
    const sid = e.data?.provenance?.sessionId;
    return typeof sid === "string" && removedSessionIds.has(sid);
  };
  const toCheck = candidates.filter((e) => !doomed(e));
  const ids = [...new Set(toCheck.map((e) => e.toId))];
  const live = new Set<string>();
  if (ids.length > 0) {
    // perf/审计(#2):record-direct 存在核对,免扫最大的 turn 表(随访谈无限增长)。
    //   ⚠️ `FROM $ids` 对不存在记录返回 undefined 占位(与 `WHERE id IN` 的「不返回不存在行」形态
    //   不同),故必须过滤(`r != null` 同时挡 null/undefined),使「存在的 turn id 集合」语义与旧版
    //   完全一致(否则 recordIdToDomainId(undefined) 会误产出 "undefined" 串污染 live 集)。
    //   mem:// 真库对拍(存在+不存在混合)+ 独立对抗验证:存在集逐一相同、ghost 不混入。
    const [rows] = await db.query<[unknown[]]>("SELECT VALUE id FROM $ids;", {
      ids: ids.map((id) => new RecordId("turn", id))
    });
    for (const r of rows ?? []) if (r != null) live.add(recordIdToDomainId(r));
  }
  const dropped = candidates.filter((e) => doomed(e) || !live.has(e.toId));
  if (dropped.length === 0) return added;
  console.warn(JSON.stringify({
    event: "surreal_dangling_provenance_dropped",
    count: dropped.length,
    sample: dropped.slice(0, 5).map((e) => `${e.fromTable}:${e.fromId}->turn:${e.toId}`)
  }));
  const droppedKeys = new Set(dropped.map((e) => `${e.fromTable}:${e.fromId}->${e.toId}`));
  return added.filter(
    (e) => !(e.edge === "derived_from" && e.toTable === "turn" && droppedKeys.has(`${e.fromTable}:${e.fromId}->${e.toId}`))
  );
}

/** persist 失败诊断:该笔 diff 的形状摘要(每表 upsert/delete 计数 + 边增删)。只在失败路径调用,
 *  正常路径零开销;计数足以定位"哪类 diff 触发引擎约束",不打内容(防敏感原话入日志)。 */
function summarizePersistDiff(prev: ProductState, next: ProductState): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  try {
    for (const m of NODE_MAPPINGS) {
      const prevArr = ((prev as unknown as Record<string, unknown>)[m.stateKey] as Array<{ id: string }>) ?? [];
      const nextArr = ((next as unknown as Record<string, unknown>)[m.stateKey] as Array<{ id: string }>) ?? [];
      const { upsert, removeIds } = diffById(prevArr, nextArr);
      if (upsert.length || removeIds.length) out[m.table] = `+${upsert.length}/-${removeIds.length}`;
    }
    // R1a:单例变更也进诊断(singletonChanged = 与 persist 完全同一判据)
    for (const s of SINGLETON_TABLES) {
      if (singletonChanged(prev, next, s.stateKey)) out[s.table] = "changed";
    }
    // R1b:流水表也进诊断(注意 "-" 计数含窗口滑出,实际是否 DELETE 见 persist 治理清除判定)
    for (const m of STREAM_MAPPINGS) {
      const prevArr = ((prev as unknown as Record<string, unknown>)[m.stateKey] as Array<{ id: string }>) ?? [];
      const nextArr = ((next as unknown as Record<string, unknown>)[m.stateKey] as Array<{ id: string }>) ?? [];
      const { upsert, removeIds } = diffById(prevArr, nextArr);
      if (upsert.length || removeIds.length) out[m.table] = `+${upsert.length}/-${removeIds.length}`;
    }
    const { added, removed } = diffEdges(collectEdges(prev), collectEdges(next));
    if (added.length || removed.length) {
      out.edges = `+${added.length}/-${removed.length}`;
      const byKind = (list: Array<{ edge: string }>) =>
        list.reduce<Record<string, number>>((acc, e) => { acc[e.edge] = (acc[e.edge] ?? 0) + 1; return acc; }, {});
      if (removed.length) out.edgesRemovedByKind = byKind(removed.filter((e) => e.edge !== "part_of"));
      if (added.length) out.edgesAddedByKind = byKind(added);
    }
  } catch {
    out.summaryError = true; // 诊断自身绝不再抛
  }
  return out;
}

/** 方案二:参与审计的边表 = edge-mapper 投影的全部边,排除 part_of(append-only 豁免,见接口注释)。
 *  promoted_from/corrects 是【已确认无消费者的历史预留死表】(edge-mapper 不投影、persist 不写、
 *  恒空),故不入审计;非"悬置待定"。若将来接线,照 002_relations.surql 注释的复活路径同步补入此表。 */
const AUDITED_EDGE_TABLES = ["belongs_to_theme", "about_theme", "derived_from", "contradicts", "evolves_into"] as const;
const AUDIT_SAMPLE_LIMIT = 20;

function edgeKeyOf(edge: string, fromTable: string, fromId: string, toTable: string, toId: string): string {
  return `${edge}|${fromTable}:${fromId}->${toTable}:${toId}`;
}

function recordTableOf(id: unknown): string {
  // 3.x SDK:RecordId.table 是 Table 对象,String() 得表名(本库表名均为纯 ASCII,无转义差异)。
  if (id instanceof RecordId) return String(id.table);
  const s = String(id);
  return s.includes(":") ? s.slice(0, s.indexOf(":")) : s;
}

/** 图↔软链一致性核对:期望边集(collectEdges 投影,同 persist 用的同一函数 = 单一真值)
 *  vs DB 实际边集。用 persist 之外的独立读路径核对 persist 的写结果——公理引擎的图层对偶
 *  (A1 在应用层查 evidenceAnchors,这里在 DB 层核 derived_from 等边的完备性)。 */
async function runGraphAudit(db: Surreal, baseline: ProductState): Promise<GraphConsistencyReport> {
  const expected = new Set<string>();
  for (const e of collectEdges(baseline)) {
    if (e.edge === "part_of") continue;
    expected.add(edgeKeyOf(e.edge, e.fromTable, e.fromId, e.toTable, e.toId));
  }
  const actual = new Set<string>();
  for (const table of AUDITED_EDGE_TABLES) {
    const [rows] = await db.query<[Array<{ in: unknown; out: unknown }>]>(`SELECT in, out FROM ${table};`);
    for (const r of rows ?? []) {
      actual.add(edgeKeyOf(table, recordTableOf(r.in), recordIdToDomainId(r.in), recordTableOf(r.out), recordIdToDomainId(r.out)));
    }
  }
  let missingInDb = [...expected].filter((key) => !actual.has(key));
  const unexpectedInDb = [...actual].filter((key) => !expected.has(key));

  // ④ 对偶:missing 里的 derived_from|…->turn:X,若 turn:X 在 DB 已不存在(A5 级联删过),
  // 是持久层按 DB 真相的主动丢弃(keepOnlyLiveTurnProvenance),非投影漂移 → 归 dangling 单列。
  let danglingProvenanceCount = 0;
  const provenanceMisses = missingInDb.filter((key) => key.startsWith("derived_from|") && key.includes("->turn:"));
  if (provenanceMisses.length > 0) {
    const turnIds = [...new Set(provenanceMisses.map((key) => key.slice(key.lastIndexOf("->turn:") + "->turn:".length)))];
    const [rows] = await db.query<[unknown[]]>("SELECT VALUE id FROM turn WHERE id IN $ids;", {
      ids: turnIds.map((id) => new RecordId("turn", id))
    });
    const live = new Set((rows ?? []).map((r) => recordIdToDomainId(r)));
    const dangling = new Set(provenanceMisses.filter((key) => !live.has(key.slice(key.lastIndexOf("->turn:") + "->turn:".length))));
    danglingProvenanceCount = dangling.size;
    missingInDb = missingInDb.filter((key) => !dangling.has(key));
  }

  // P0-1 观测补盲:节点表核对(内存基线 vs DB 实际 id 集)。turn 豁免(append-only);
  // R1b 流水表同理豁免(不在 NODE_MAPPINGS,DB 保全史合法多于内存窗口,核对必假阳性)。
  const nodeMissingInDb: string[] = [];
  const nodeUnexpectedInDb: string[] = [];
  for (const m of NODE_MAPPINGS) {
    const baselineIds = new Set(
      (((baseline as unknown as Record<string, unknown>)[m.stateKey] as Array<{ id: string }>) ?? []).map((e) => e.id)
    );
    const [rows] = await db.query<[unknown[]]>(`SELECT VALUE id FROM ${m.table};`);
    const dbIds = new Set((rows ?? []).map((r) => recordIdToDomainId(r)));
    for (const id of baselineIds) if (!dbIds.has(id)) nodeMissingInDb.push(`${m.table}:${id}`);
    for (const id of dbIds) if (!baselineIds.has(id)) nodeUnexpectedInDb.push(`${m.table}:${id}`);
  }

  return {
    // P0:dangling provenance 曾被移出 missing 后仍算 ok,导致备份恢复丢边时审计假绿。
    // 有悬空溯源即 fail-closed(仍单列 danglingProvenanceCount 便于诊断)。
    ok:
      missingInDb.length === 0 && unexpectedInDb.length === 0 &&
      danglingProvenanceCount === 0 &&
      nodeMissingInDb.length === 0 && nodeUnexpectedInDb.length === 0,
    auditedEdgeTables: [...AUDITED_EDGE_TABLES],
    expectedCount: expected.size,
    actualCount: actual.size,
    missingCount: missingInDb.length,
    unexpectedCount: unexpectedInDb.length,
    missingInDb: missingInDb.slice(0, AUDIT_SAMPLE_LIMIT),
    unexpectedInDb: unexpectedInDb.slice(0, AUDIT_SAMPLE_LIMIT),
    danglingProvenanceCount,
    nodeMissingCount: nodeMissingInDb.length,
    nodeUnexpectedCount: nodeUnexpectedInDb.length,
    nodeMissingInDb: nodeMissingInDb.slice(0, AUDIT_SAMPLE_LIMIT),
    nodeUnexpectedInDb: nodeUnexpectedInDb.slice(0, AUDIT_SAMPLE_LIMIT)
  };
}

/** 从 SurrealDB 读全部节点表 + state_meta,重建 ProductState(规范化)。
 *  空库(无 state_meta)→ 捏造初始态并以 fromDb:false 标记——调用方必须据此把 diff 基线设空
 *  并立即首落库,否则初始态只存在于内存与基线、永不进 DB(基线谎言,见 createSurrealProductStateRepository)。 */
async function loadState(db: Surreal): Promise<{ state: ProductState; fromDb: boolean }> {
  const [metaRows] = await db.query<[Array<{ revision: number; rest: Record<string, unknown> }>]>(
    `SELECT revision, rest FROM ${META_ID};`
  );
  const meta = metaRows?.[0];
  if (!meta) return { state: createInitialProductState(), fromDb: false };

  const assembled: Record<string, unknown> = { ...(meta.rest ?? {}), revision: meta.revision };
  // R1a 旧库新代码防错乱:单例键的 blob 残留一律先删、以单例表为准(历史数据按用户决策不迁移,
  // 残留是 007 之前写入的死数据;表无记录 → normalize 回退确定性默认值,与"从未写过单例"语义一致)。
  // 9 类数组实体无需显式删残留:下方 NODE_MAPPINGS 循环无条件以表数据覆盖(空表 → [],残留同样失效)。
  for (const s of SINGLETON_TABLES) {
    delete assembled[s.stateKey];
    const [rows] = await db.query<[Array<{ data?: Record<string, unknown> }>]>(`SELECT data FROM ${s.table}:main;`);
    const data = rows?.[0]?.data;
    if (data && typeof data === "object") assembled[s.stateKey] = data;
  }
  for (const m of NODE_MAPPINGS) {
    const [rows] = await db.query<[Array<Record<string, unknown>>]>(`SELECT * FROM ${m.table};`);
    const entities = (rows ?? []).map((r) => {
      const { id, ...rec } = r;
      return fromRecord(recordIdToDomainId(id), rec);
    });
    // R1a:9 类 prepend 数组按 createdAt DESC 重排,与内存态(newest-first)一致(见 R1A_PREPEND_TABLES)。
    assembled[m.stateKey] = R1A_PREPEND_TABLES.has(m.table) ? sortNewestFirst(entities) : entities;
  }
  // R1b:流水表只取内存滚动窗条数(窗口=storage.ts 钳制常量,超窗口的历史行留在 DB 不进内存,
  // roundtrip digest 与钳制后的内存态一致)。ORDER BY id DESC = 复合 id [tsField, 领域id] 的
  // (时间 DESC, id DESC) 序,与内存 newest-first prepend 语义一致(同 R1A_PREPEND_TABLES 的
  // "id 决胜同毫秒,尽力确定性"口径)。⚠️ 3.0.2 坑:ORDER BY 的字段必须出现在投影里
  // (SELECT id ... ORDER BY createdAt 报 "Missing order idiom"),SELECT * 天然满足。
  // 旧库 state_meta.rest 的流水键残留无需显式删:下方无条件以表数据覆盖(空表 → [])。
  for (const m of STREAM_MAPPINGS) {
    const limit = m.window !== undefined ? ` LIMIT ${m.window}` : "";
    const [rows] = await db.query<[Array<Record<string, unknown>>]>(
      `SELECT * FROM ${m.table} ORDER BY id DESC${limit};`
    );
    assembled[m.stateKey] = (rows ?? []).map((r) => {
      const { id, ...rec } = r;
      return fromRecord(streamDomainIdOf(id), rec);
    });
  }
  return { state: normalizeProductState(assembled), fromDb: true };
}

/** SurrealDB 记录 id → 领域 id 字符串。
 *  3.x SDK 实际返回 RecordId 对象(instanceof RecordId);其 .id 段是领域 id。
 *  fallback:string 形如 `point:pt_1` 取冒号后段;其他 toString()。 */
function recordIdToDomainId(id: unknown): string {
  if (id instanceof RecordId) return String(id.id);
  if (typeof id === "string") return id.includes(":") ? id.slice(id.indexOf(":") + 1) : id;
  const anyId = id as { id?: unknown } | undefined;
  return anyId?.id !== undefined ? String(anyId.id) : String(id);
}

/** diff-upsert 落库:只写 prev→next 的增量(节点/turn 按 id diff,边按身份集差),单事务。
 *  prev = lastPersisted(上次成功落库态);最终 DB 态与全量覆盖等价,但写放大降到 O(变更)。
 *  ⚠️ UPSERT CONTENT 不重跑列 DEFAULT,故 upsert 记录先过 fillUpsertDefaults(同 P1b)。 */
async function persist(
  db: Surreal,
  prev: ProductState,
  next: ProductState,
  options?: { streamPurgeMode?: "slide-out" | "governance-keep" },
): Promise<void> {
  // R2b:diff 语句生成与事务执行拆分——治理事务(runGovernanceTransaction)复用 buildPersistStatements
  // 把"热态整状态替换"的同一批 diff 语句拼进跨冷热的单事务,不复制第二份 diff 代码。
  const { surql, vars } = await buildPersistStatements(db, prev, next, options);
  await db.query("BEGIN TRANSACTION;\n" + surql + "COMMIT TRANSACTION;", vars);
}

/** R2b:生成 prev→next 的热态 diff 语句(不含 BEGIN/COMMIT),供 persist 与治理事务共用。
 *  返回的 surql 是若干以 `;\n` 结尾的语句;vars 为其绑定参数。调用方自行包裹事务边界。 */
async function buildPersistStatements(
  db: Surreal,
  prev: ProductState,
  next: ProductState,
  options: {
    provenanceProjection?: ProductState;
    rebuildProvenance?: boolean;
    /** 流水移除语义:默认 slide-out(保全史);治理整库替换强制 governance-keep(C16 关闭缺口 #6)。 */
    streamPurgeMode?: "slide-out" | "governance-keep";
  } = {},
): Promise<{ surql: string; vars: Record<string, unknown> }> {
  const provenanceProjection = options.provenanceProjection ?? next;
  const rebuildProvenance = options.rebuildProvenance === true;
  const streamPurgeMode = options.streamPurgeMode ?? "slide-out";
  let surql = "";
  const vars: Record<string, unknown> = {};
  let i = 0;

  // 1) 节点表:diffById → UPSERT 变更 + DELETE 移除
  // P0-2 根修配套:收集本事务将删除的 session id——它们的 turn 会被 A5 级联在**同一事务内**
  // 删掉,新增的 derived_from 若指向这些 turn,事务前的实存预查(keepOnlyLiveTurnProvenance)
  // 会误放行 → RELATE ENFORCED 拒 → 整事务确定性失败(审查实测)。边过滤须感知本批删除集。
  const removedSessionIds = new Set<string>();
  for (const m of NODE_MAPPINGS) {
    const prevArr = ((prev as unknown as Record<string, unknown>)[m.stateKey] as Array<{ id: string }>) ?? [];
    const nextArr = ((next as unknown as Record<string, unknown>)[m.stateKey] as Array<{ id: string }>) ?? [];
    const { upsert, removeIds } = diffById(prevArr, nextArr);
    if (m.table === "session") for (const id of removeIds) removedSessionIds.add(id);
    for (const entity of upsert) {
      const rv = `r${i++}`;
      vars[rv] = fillUpsertDefaults(m.table, toRecord(entity as Record<string, unknown>, m));
      vars[`${rv}_id`] = entity.id;
      surql += `UPSERT type::record('${m.table}', $${rv}_id) CONTENT $${rv};\n`;
    }
    if (removeIds.length) {
      const dv = `del_${m.table}`;
      vars[dv] = removeIds.map((id) => new RecordId(m.table, id));
      // perf/审计(#1):record-direct 删除,免整表扫。$dv 已是 RecordId[],`DELETE $dv` 按 id 直取
      //   (照本文件 :1039 既有 `DELETE $dv` 惯用法)。removeIds 源自 lastPersisted 必存在;对不存在
      //   id 静默 no-op。mem:// 真库对拍:剩余集与旧 `WHERE id IN` 逐位一致;A5 级联(删 session→清
      //   turn)record-direct 同样触发(已复验)。
      surql += `DELETE $${dv};\n`;
    }
  }

  // 2) turn 表:diffById,但**只 UPSERT 不 DELETE**(H1)。
  //    turn 是 append-only 冷层 occurrent:降冷(offloadCompletedSession)会从内存 state
  //    剥掉 session.turns,使 turnRecordsOf(next) 变空、diffById 把它们算进 removeIds。
  //    若执行该 DELETE,降冷会连带删掉 turn 节点 + derived_from/part_of 边 → 溯源召回失效。
  //    故 turn 永不删:只投影 upsert。`void removeIds` 显式弃用,避免 noUnusedLocals 报错。
  const nextTurnIds = new Set<string>();
  {
    const nextTurns = turnRecordsOf(provenanceProjection) as Array<Record<string, unknown> & { id: string }>;
    for (const t of nextTurns) nextTurnIds.add(String(t.id));
    const diff = diffById(
      turnRecordsOf(prev) as Array<Record<string, unknown> & { id: string }>,
      nextTurns,
    );
    // 完整 raw-material replace 是目标快照恢复，不是普通 hot diff。保留同 id 避开 Surreal 3.x
    // 同事务 delete→recreate 陷阱，删除不在备份中的旧 turn，再全量 UPSERT 目标 turns。
    if (rebuildProvenance) {
      if (nextTurns.length > 0) {
        vars.import_turn_keep = nextTurns.map((turn) => new RecordId("turn", turn.id));
        surql += "DELETE turn WHERE id NOT IN $import_turn_keep;\n";
      } else {
        surql += "DELETE turn;\n";
      }
    }
    const upsert = rebuildProvenance ? nextTurns : diff.upsert;
    void diff.removeIds;
    for (const t of upsert) {
      const tv = `t${i++}`;
      vars[tv] = fillUpsertDefaults("turn", { ...t });
      vars[`${tv}_id`] = t.id;
      surql += `UPSERT type::record('turn', $${tv}_id) CONTENT $${tv};\n`;
    }
  }

  // 3) 边:diffEdges → DELETE 移除(WHERE in/out)+ RELATE 新增
  {
    const targetEdges = collectEdges(provenanceProjection);
    const edgeDiff = diffEdges(collectEdges(prev), targetEdges);
    let addedRaw = edgeDiff.added;
    let removed = edgeDiff.removed;
    if (rebuildProvenance) {
      const importedTurnSession = new Map(
        (turnRecordsOf(provenanceProjection) as Array<Record<string, unknown> & { id: string }>).map((turn) => [
          String(turn.id),
          String(turn.sessionId ?? ""),
        ]),
      );
      for (const edge of targetEdges) {
        if (edge.edge !== "derived_from" || edge.toTable !== "turn") continue;
        const targetSession = importedTurnSession.get(edge.toId);
        if (!targetSession || targetSession !== edge.data?.provenance.sessionId) {
          throw new GovernanceImportProvenanceError(edge.toId);
        }
      }
      // 重导同一备份也必须修复数据库中已漂移的来源边，不能依赖 prev→next 是否发生领域变化。
      // 在同一事务内清空两张 provenance 边表，再按目标投影全量重建；其他业务边仍走增量 diff。
      surql += "DELETE derived_from;\nDELETE part_of;\n";
      const isProvenance = (edge: EdgeSpec) => edge.edge === "derived_from" || edge.edge === "part_of";
      addedRaw = [
        ...addedRaw.filter((edge) => !isProvenance(edge)),
        ...targetEdges.filter(isProvenance),
      ];
      removed = removed.filter((edge) => !isProvenance(edge));
    }
    // ④ 根修(H1×A5 碰撞,E2E 复现+diff 形状诊断指认):derived_from 的 turn 端点在
    // "会话被真正删除(reset/purge,A5 级联按隐私语义删其 turn)后,其资产又被重新引入
    // (seed/备份导入,turns 已降冷不随行)"时不存在 → RELATE ENFORCED 拒 → 整事务确定性
    // 失败,该快照永不落库(自愈掩成'下一笔成功')。按 DB 真相过滤悬空溯源:turn 真的没了,
    // 不投影该边不是丢数据(recallProvenanceTurns 对它本就只能返回空);响亮记数。
    // P0-2 补盲(全系统审查实测):还须感知**本事务**将级联删除的 turn——removedSessionIds
    // 的 turn 在预查时刻仍"实存",单靠 DB 预查必误放行。
    const added = await keepOnlyLiveTurnProvenance(db, addedRaw, nextTurnIds, removedSessionIds);
    for (const e of removed) {
      // H1:part_of(turn→session)与 turn 同为 append-only,降冷剥 turns 时 collectEdges(next)
      //     不再投影它 → 进 removed,但不应删(turn 节点还在,part_of 是其归属事实)。跳过。
      //     derived_from 无需特判:edge-mapper #② 改为从资产 anchor 投影,降冷时资产仍在 →
      //     边仍被投影 → 不进 removed;只有资产被真正删除时其 anchor 消失,边才正确进 removed 被删。
      if (e.edge === "part_of") continue;
      const xv = `x${i++}`;
      vars[`${xv}_f`] = new RecordId(e.fromTable, e.fromId);
      vars[`${xv}_t`] = new RecordId(e.toTable, e.toId);
      // perf/审计(#3):图遍历定向删,免整表扫边表(derived_from 等可积到数千条,confirm 资产/
      //   改 relatedThemeIds/origin 翻转高频触发)。`$f->edge WHERE out=$t` 从 f 的出边直取那一条。
      //   mem:// 真库对拍:只删 (f,t)、不误删同 f 其它出边 / 同 to 其它入边;part_of/derived_from/
      //   belongs_to_theme 各边表均验证;删后剩余边集与旧 `WHERE in/out` 逐一相同。
      surql += `DELETE $${xv}_f->${e.edge} WHERE out = $${xv}_t;\n`;
    }
    for (const e of added) {
      const ev = `e${i++}`;
      vars[`${ev}_f`] = new RecordId(e.fromTable, e.fromId);
      vars[`${ev}_t`] = new RecordId(e.toTable, e.toId);
      let rel = `RELATE $${ev}_f->${e.edge}->$${ev}_t`;
      if (e.data) { vars[`${ev}_d`] = e.data; rel += ` SET provenance = $${ev}_d.provenance`; }
      surql += rel + ";\n";
    }
  }

  // 4) R1a 单例表:profile:main / system_config:main。digest 变更才写(免每笔写放大);
  //    内容整体作 data FLEXIBLE object(ISO 字符串原样存,同 rest blob 语义,无 datetime coerce 问题)。
  for (const s of SINGLETON_TABLES) {
    if (singletonChanged(prev, next, s.stateKey)) {
      const sv = `s${i++}`;
      vars[sv] = { data: (next as unknown as Record<string, unknown>)[s.stateKey] ?? {} };
      surql += `UPSERT ${s.table}:main CONTENT $${sv};\n`;
    }
  }

  // 5) R1b 流水表:append-only 事件流(复合 id [tsField, 领域id])。
  //    · 常规路径只 UPSERT 新增/变更(事件语义上不可变,changed 理应恒空,出现了照常覆盖);
  //    · **窗口滑出绝不 DELETE**(照 turn/H1 模式):内存滚动窗(MAX_EVENT_LOG)把最旧条目挤出
  //      数组 → diffById 算进 removeIds,但那是内存瘦身不是用户删除,DB 保全史;
  //    · **治理清除例外**(reset/purge/import 整状态替换):隐私优先于保全史——与 turn 在
  //      reset/purge 下被 A5 级联清除同口径。判定:被移除条目不满足"滑出形态"(next 满窗且
  //      被移除者不新于窗口内最旧保留条目)即治理移除 → 全表 `DELETE WHERE id NOT IN keep`
  //      (须全表清扫而非按 id 删:diff 基线只见窗口内 1000 条,窗口外的历史行基线不知道,
  //      逐 id 删会留下窗口外残留 → purge(all) 后个人痕迹残留=隐私事故)。keep 用 NOT IN
  //      而非"先全删再重建",规避 3.x 同事务删建同 id 失败的坑(import 保留既有 id 时会踩)。
  //    · **C16 streamPurgeMode**(缺口 #6 closed):纯 diff 无法区分「滚动滑出」与「满窗 import
  //      替换」(备份恰满窗且全部新于活库时 removeIds 被误判为滑出)。治理路径(executeGovernance
  //      Transaction reset|replace + journal replaceStateDurable 的 streamPurgeMode=governance-keep)
  //      **恒** keep 清扫(DB 流水 = next keep 集,含「同 id 覆盖 + 窗口外孤儿」);默认 slide-out 仍保全史。
  for (const m of STREAM_MAPPINGS) {
    const prevArr = ((prev as unknown as Record<string, unknown>)[m.stateKey] as Array<Record<string, unknown> & { id: string }>) ?? [];
    const nextArr = ((next as unknown as Record<string, unknown>)[m.stateKey] as Array<Record<string, unknown> & { id: string }>) ?? [];
    const { upsert, removeIds } = diffById(prevArr, nextArr);
    const prevById = new Map(prevArr.map((e) => [e.id, e] as const));
    // 滑出形态:窗口存在且 next 满窗,且被移除条目不新于窗口内最旧保留条目(newest-first 数组
    // 的队尾)。operationalChecks 无窗口(window=undefined)→ 任何移除都是治理清除。
    const oldestKeptTs = nextArr.length > 0 ? streamTs(nextArr[nextArr.length - 1], m) : "";
    const isSlideOut = (id: string): boolean => {
      if (m.window === undefined || nextArr.length < m.window) return false;
      const e = prevById.get(id);
      return e !== undefined && streamTs(e, m) <= oldestKeptTs;
    };
    // governance-keep:整库替换意图 → 始终 DELETE WHERE id NOT IN keep(对齐 next;清窗口外孤儿)。
    // 即便 removeIds 为空(同 id 满窗覆盖)也须清扫,否则 ae_old 等保全史残留。
    // slide-out(默认):仅当存在非滑出移除时才清扫(常规 append 保全史)。
    const shouldPurgeStream = streamPurgeMode === "governance-keep"
      ? true
      : removeIds.some((id) => !isSlideOut(id));
    if (shouldPurgeStream) {
      const kv = `keep_${m.table}`;
      vars[kv] = nextArr.map((e) => streamRecordIdOf(m, e));
      surql += `DELETE ${m.table} WHERE id NOT IN $${kv};\n`;
    }
    for (const entity of upsert) {
      const before = prevById.get(entity.id);
      if (before && streamTs(before, m) !== streamTs(entity, m)) {
        // 防御:tsField 理应不可变(workflow_run.startedAt 等);若上游违约变了,复合 id 随之
        // 漂移,同一实体会裂成两条记录 → 先删旧 id,保证领域 id 在表内唯一。
        const dv = `sx${i++}`;
        vars[dv] = streamRecordIdOf(m, before);
        surql += `DELETE $${dv};\n`;
      }
      const sv = `se${i++}`;
      vars[sv] = fillUpsertDefaults(m.table, toRecord(entity, m));
      vars[`${sv}_id`] = streamRecordIdOf(m, entity);
      surql += `UPSERT $${sv}_id CONTENT $${sv};\n`;
    }
  }

  // 6) state_meta:revision 每写必变,总是 UPSERT(R1b 后 rest 只剩 schemaVersion;
  //    旧库里 rest 残留的 15 个真表化键会被本次全量覆盖顺带清除)
  const meta: Record<string, unknown> = {};
  for (const k of META_KEYS) meta[k] = (next as unknown as Record<string, unknown>)[k];
  vars.meta = meta;
  vars.rev = next.revision ?? 0;
  surql += `UPSERT ${META_ID} SET revision = $rev, rest = $meta;\n`;

  return { surql, vars };
}

/** R1b 保留期清理:删除各流水表 cutoff 之前的历史条目(复合 id range 删除,零索引)。
 *  每表的有效 cutoff 取 min(保留期 cutoff, 内存窗口内最旧条目)——绝不删仍在内存窗口内的行,
 *  否则重启后窗口凭空缩水。`table:..[$c]` 开区间尾:
 *  只删 ts 严格早于 cutoff 的行(1 元素边界数组按前缀序小于任何 [同 ts, id],实测 3.0.2 可用)。 */
async function pruneStreamsBefore(db: Surreal, cutoffIso: string, memState: ProductState): Promise<void> {
  // 坏格式 cutoff 早退(no-op + 警告):非法字符串在字典序比较下不可预期(可能大于一切合法 ISO,
  // 使内存窗口守卫失效、误扫全部窗口外历史)——运维手滑不该变成数据事故。
  if (Number.isNaN(Date.parse(cutoffIso))) {
    console.warn(JSON.stringify({ event: "surreal_event_stream_prune_invalid_cutoff", cutoffIso }));
    return;
  }
  // P3-14:逐表 try/catch——某张流水表 DELETE 失败(引擎瞬态/单表损坏)此前会让异常冒泡、
  // 中断整个循环,后续表永不清理(无界增长)。改为一表失败只记该表、继续清其余表;末尾把失败
  // 表清单汇总成一条 error 级日志(prune 是卫生工作、不阻塞业务写,但"哪些表没清成"必须可观测)。
  const failedTables: string[] = [];
  for (const m of STREAM_MAPPINGS) {
    const arr = ((memState as unknown as Record<string, unknown>)[m.stateKey] as Array<Record<string, unknown> & { id: string }>) ?? [];
    const memOldest = arr.length > 0 ? streamTs(arr[arr.length - 1], m) : undefined;
    const effective = memOldest !== undefined && memOldest < cutoffIso ? memOldest : cutoffIso;
    try {
      await db.query(`DELETE ${m.table}:..[$c];`, { c: effective });
    } catch (err) {
      failedTables.push(m.table);
      console.warn(JSON.stringify({ event: "surreal_event_stream_prune_table_failed", table: m.table, error: String(err) }));
    }
  }
  if (failedTables.length > 0) {
    console.error(JSON.stringify({ event: "surreal_event_stream_prune_incomplete", failedTables }));
  }
}
