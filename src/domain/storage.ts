import { createInitialProductState, createEmptyProductState } from "./engine";
import { withMemoryCandidateReview } from "./memoryReview";
import type { ImportSource, ProductState, ProviderConfig, SearchBrief, SearchProviderId, SystemConfig } from "./types";

const STORAGE_KEY = "interview-product-state-v1";
// ponytail: 有界常量 — normalize 时保留的最大已审 candidate 数(pending 全留)
const MAX_REVIEWED_CANDIDATES = 200;
// ponytail: rolling window for audit/aiRun event logs (newest-first). Bounds the largest
// unbounded growth source so the full-state-PUT model can't grow past the 28MB body limit.
// R1b:导出供持久层流水表(STREAM_MAPPINGS)复用同一窗口常量——loadState 取窗口条数、
// persist 判定"窗口滑出 vs 治理清除"都以此为准,勿在别处硬编码 1000。
export const MAX_EVENT_LOG = 1000;
// ponytail: 有界常量 — normalize 时保留的最大旁注数
const MAX_ANNOTATIONS = 500;
const MAX_CHAT_SESSIONS = 50;

/** A-19 可观测性选项:clamp(可持久化性规整)实际改写了哪些字段。
 *  - 提供 onClamped:调用方拿到「路径: 原值 → 规整值」明细自行处置(写入口 PUT /api/state
 *    据此 422 拒收畸形数据,不再静默改写用户数据)。
 *  - 省略:改写发生时 console.warn 一条汇总(读回/内部路径的兜底可观测,绝不再无声)。 */
export interface NormalizeProductStateOptions {
  onClamped?: (violations: string[]) => void;
}

export function normalizeProductState(value: unknown, opts?: NormalizeProductStateOptions): ProductState {
  const fallback = createInitialProductState();
  if (!value || typeof value !== "object") {
    return fallback;
  }

  const candidate = value as Partial<ProductState>;
  const systemConfig = candidate.systemConfig ?? fallback.systemConfig;
  const normalizedSearchConfig = normalizeSearchConfig(systemConfig, fallback.systemConfig);
  const normalizedVoiceConfig = normalizeVoiceConfig(systemConfig, fallback.systemConfig);
  const normalizedModelConfig = normalizeModelConfig(systemConfig, fallback.systemConfig);
  const normalizedProviders = normalizeProviderActivation(
    mergeProviderConfigs(fallback.systemConfig.providers, systemConfig.providers),
    normalizedSearchConfig.activeProvider,
    normalizedVoiceConfig.ttsProvider
  );

  const normalized: ProductState = {
    ...fallback,
    ...candidate,
    profile: {
      ...fallback.profile,
      ...candidate.profile
    },
    profileSuggestions: Array.isArray(candidate.profileSuggestions)
      ? candidate.profileSuggestions
      : fallback.profileSuggestions,
    interviewAnnotations: Array.isArray(candidate.interviewAnnotations)
      ? candidate.interviewAnnotations.slice(0, MAX_ANNOTATIONS)
      : fallback.interviewAnnotations,
    chatSessions: Array.isArray(candidate.chatSessions)
      ? candidate.chatSessions.slice(0, MAX_CHAT_SESSIONS)
      : fallback.chatSessions,
    sessions: Array.isArray(candidate.sessions) ? migrateSessionStatuses(candidate.sessions) : fallback.sessions,
    notes: Array.isArray(candidate.notes) ? candidate.notes : fallback.notes,
    points: Array.isArray(candidate.points) ? backfillPointDefaults(candidate.points) : fallback.points,
    questions: Array.isArray(candidate.questions) ? backfillQuestionDefaults(candidate.questions) : fallback.questions,
    decisions: Array.isArray(candidate.decisions) ? candidate.decisions : fallback.decisions,
    debts: Array.isArray(candidate.debts) ? candidate.debts : fallback.debts,
    themes: Array.isArray(candidate.themes) ? migrateThemesToTracks(candidate.themes) : fallback.themes,
    memoryCorrections: Array.isArray(candidate.memoryCorrections)
      ? candidate.memoryCorrections
      : fallback.memoryCorrections,
    searchBriefs: Array.isArray(candidate.searchBriefs)
      ? normalizeSearchBriefs(candidate.searchBriefs)
      : fallback.searchBriefs,
    podcastEpisodes: Array.isArray(candidate.podcastEpisodes)
      ? candidate.podcastEpisodes
      : fallback.podcastEpisodes,
    corpusImports: Array.isArray(candidate.corpusImports) ? candidate.corpusImports : fallback.corpusImports,
    corpusInsights: Array.isArray(candidate.corpusInsights) ? candidate.corpusInsights : fallback.corpusInsights,
    playbookPatches: Array.isArray(candidate.playbookPatches)
      ? candidate.playbookPatches
      : fallback.playbookPatches,
    memoryRecords: Array.isArray(candidate.memoryRecords)
      ? mergeLegacyMemoryEdges(candidate.memoryRecords, (candidate as Record<string, unknown>).memoryEdges)
      : fallback.memoryRecords,
    memoryCandidates: Array.isArray(candidate.memoryCandidates)
      ? (() => {
          // ponytail: pending 全留 + 最近 200 已审,防 state 膨胀
          const mapped = candidate.memoryCandidates.map((c) =>
            withMemoryCandidateReview(c, { legacyBackfill: true, preserveExisting: true })
          );
          const pending = mapped.filter((c) => c.status === "pending");
          const reviewed = mapped
            .filter((c) => c.status !== "pending")
            .sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""))
            .slice(0, MAX_REVIEWED_CANDIDATES);
          return [...pending, ...reviewed];
        })()
      : fallback.memoryCandidates,
    importSources: Array.isArray(candidate.importSources) ? normalizeImportSources(candidate.importSources) : fallback.importSources,
    ragChunks: Array.isArray(candidate.ragChunks) ? candidate.ragChunks : fallback.ragChunks,
    configVersions: Array.isArray(candidate.configVersions) ? candidate.configVersions : fallback.configVersions,
    // ponytail: rolling window on the two highest-frequency log arrays — every interview
    // turn appends an aiRunEvent + an auditEvent (newest-first), and nothing else capped
    // them. Without this the whole ProductState grows unbounded and (via full-state PUT)
    // eventually hits the 28MB body limit, killing all writes. 1000 most-recent kept.
    auditEvents: Array.isArray(candidate.auditEvents) ? candidate.auditEvents.slice(0, MAX_EVENT_LOG) : fallback.auditEvents,
    aiRunEvents: Array.isArray(candidate.aiRunEvents) ? candidate.aiRunEvents.slice(0, MAX_EVENT_LOG) : fallback.aiRunEvents,
    // 审计修复(P3-32):workflowRuns 此前无封顶(audit/aiRun 有 1000);与它们对齐滚动窗。
    workflowRuns: Array.isArray(candidate.workflowRuns) ? migrateWorkflowRuns(candidate.workflowRuns).slice(0, MAX_EVENT_LOG) : fallback.workflowRuns,
    operationalChecks: Array.isArray(candidate.operationalChecks) ? candidate.operationalChecks : fallback.operationalChecks,
    revision: typeof candidate.revision === "number" ? candidate.revision : fallback.revision,
    schemaVersion: 2,
    systemConfig: {
      ...fallback.systemConfig,
      ...systemConfig,
      providers: normalizedProviders,
      search: normalizedSearchConfig,
      voice: normalizedVoiceConfig,
      models: normalizedModelConfig,
      interview: {
        ...fallback.systemConfig.interview,
        ...systemConfig.interview
      },
      memory: {
        ...fallback.systemConfig.memory,
        ...systemConfig.memory
      },
      research: {
        autoScheduleEnabled: false,
        scheduleIntervalMin: 1440,
        ...systemConfig.research
      }
    }
  };
  // R3: intel 子系统已删除。`...candidate` spread 会带入历史 intelTasks/intelItems,显式丢弃。
  // readings 字段在 R1 中已删除,同样通过 spread 透传,一并清除。
  // M1: memoryEdges 退役 —— 其主题归属已由 mergeLegacyMemoryEdges 折进 record.relatedThemeIds,
  // 这里删除经 spread 透传的原始 memoryEdges 数组,使该字段从持久化状态彻底消失。
  const legacy = normalized as unknown as Record<string, unknown>;
  delete legacy.intelTasks;
  delete legacy.intelItems;
  delete legacy.readings;
  delete legacy.memoryEdges;
  // 审计修复(P3-48):purge 路由曾把响应装饰键 spread 进 state 对象,经前端回写永久寄生——同 intel 死键一并清。
  delete legacy.artifactPurge;
  delete legacy.deletedScope;
  delete legacy.deletedCount;
  const pruned = pruneDanglingThemeRefs(normalized);
  const clamped = clampPersistableEnums(pruned);
  // A-19:clamp 改写数据必须可观测——钳制前后 diff 出被改写的字段。此前两侧(写入+读回)
  // 全程零日志零标记,畸形值被静默改成默认值(1970 哨兵日期/空串/丢整条向量)是比 wedge
  // 更隐蔽的数据失真。
  const violations: string[] = [];
  collectClampViolations(pruned, clamped, "", violations, MAX_CLAMP_VIOLATIONS);
  if (violations.length > 0) {
    if (opts?.onClamped) {
      opts.onClamped(violations);
    } else {
      console.warn(JSON.stringify({
        event: "persistable_values_clamped",
        count: violations.length,
        sample: violations.slice(0, 5)
      }));
    }
  }
  return pruneDanglingContainmentRefs(clamped);
}

/** A-19:钳制前后的结构化 diff(有界)。同型数组逐元素、对象逐键;命中差异即记
 *  「路径: 原值 → 规整值」。纯结构游走,量级与 clamp 本身同为 O(state)。 */
const MAX_CLAMP_VIOLATIONS = 50;

function shortValue(value: unknown): string {
  if (value === undefined) return "undefined";
  let s: string;
  try {
    s = JSON.stringify(value) ?? "undefined";
  } catch {
    s = String(value);
  }
  return s.length > 60 ? `${s.slice(0, 60)}…` : s;
}

function collectClampViolations(before: unknown, after: unknown, path: string, out: string[], limit: number): void {
  if (out.length >= limit || Object.is(before, after)) return;
  if (Array.isArray(before) && Array.isArray(after)) {
    if (before.length !== after.length) {
      out.push(`${path}: 数组被规整(长度 ${before.length}→${after.length})`);
      return;
    }
    for (let i = 0; i < before.length && out.length < limit; i++) {
      collectClampViolations(before[i], after[i], `${path}[${i}]`, out, limit);
    }
    return;
  }
  if (before && after && typeof before === "object" && typeof after === "object") {
    const keys = new Set([...Object.keys(before as object), ...Object.keys(after as object)]);
    for (const key of keys) {
      if (out.length >= limit) return;
      collectClampViolations(
        (before as Record<string, unknown>)[key],
        (after as Record<string, unknown>)[key],
        path ? `${path}.${key}` : key,
        out,
        limit
      );
    }
    return;
  }
  out.push(`${path}: ${shortValue(before)} → ${shortValue(after)}`);
}

// ── 审计修复(P0-3):可持久化性规整 · 枚举钳制 ─────────────────────────────
// SurrealDB SCHEMAFULL 的 ASSERT 白名单是全系统唯一的枚举强制点;API 边界(PUT/import/旧备份)
// 可送进非法值 → normalize 放行 → persist 事务被 ASSERT 拒 → 基线冻结 wedge,其后所有写永不落
// 权威库(真实业务 E2E 实测)。在 normalize 统一钳制:非法值规整为**最保守**的合法值(敏感度失败
// 即敏感、记忆失败即弃用、简报失败即待复核——一律 fail-closed,绝不因坏值放大权限/可见性)。
// ⚠️ 与 packages/db/src/surreal/migrations/001_nodes.surql 的 ASSERT 清单保持同步。
function clampEnum<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return (allowed as readonly string[]).includes(value as string) ? (value as T) : fallback;
}

const SESSION_MODES = ["daily", "decision", "point", "learning", "organization", "long-term"] as const;
const SESSION_STRENGTHS = ["gentle", "standard", "sharp"] as const;
const SESSION_STATUSES = ["active", "completed"] as const;
const TURN_ROLES = ["user", "assistant"] as const;
const POINT_STATUSES = ["临时想法", "稳定观点", "被挑战中", "已修正", "已放弃"] as const;
const POINT_CONFIDENCES = ["用户确认", "AI 推断", "待验证"] as const;
const DECISION_KINDS = ["候选决策", "用户决策"] as const;
const DECISION_CONFIRMATIONS = ["待用户确认", "用户确认"] as const;
const DECISION_STATUSES = ["待复盘", "已复盘"] as const;
const DEBT_STATUSES = ["待了解", "能复述", "已应用", "不相关"] as const;
const QUESTION_STATUSES = ["开放", "反复出现", "正在聚焦", "阶段性回答"] as const;
const THEME_MATURITIES = ["萌芽", "重复", "聚焦", "成型", "变化", "关闭"] as const;
const MEMORY_STATUSES = ["confirmed", "deprecated", "deleted"] as const;
const SENSITIVITIES = ["normal", "sensitive"] as const;
const CANDIDATE_STATUSES = ["pending", "approved", "rejected"] as const;
const MATERIAL_SOURCE_TYPES = ["text", "webpage"] as const;
const RAG_USAGES = ["interview-context", "memory-candidate"] as const;
const BRIEF_STATUSES = ["ready", "needs-review"] as const;
// R1a(blob 实体真表化):以下白名单与 007_r1a_entities.surql 的 ASSERT 逐一对齐(fail-closed 一致)。
const SUGGESTION_STATUSES = ["pending", "approved", "rejected"] as const;
const PODCAST_FORMATS = ["solo", "host-guest"] as const;
const PODCAST_STATUSES = ["draft", "generating", "ready"] as const;
const SCRIPT_REVIEW_STATUSES = ["待确认", "用户确认"] as const;
const CORPUS_MEDIA_TYPES = ["text", "audio"] as const;
const PATCH_STATUSES = ["proposed", "applied", "reverted"] as const;
const PATCH_IMPACTS = ["low", "medium", "high"] as const;
const CONFIG_CHANGED_BY = ["user", "system"] as const;
// R1b(流水实体真表化):以下白名单与 008_r1b_event_streams.surql 的 ASSERT 逐一对齐。
// type/entityType/workflow/providerId/kind 等宽面高频演进枚举刻意只 str() 不 clampEnum
// (schema 侧对应不 ASSERT,见 008 头注),防"每加一个事件类型都要 schema 迁移"。
const AUDIT_SEVERITIES = ["info", "warning", "critical"] as const;
const AI_RUN_STATUSES = ["succeeded", "degraded", "failed"] as const;
const WORKFLOW_RUN_STATUSES = ["queued", "running", "succeeded", "degraded", "failed"] as const;
const OP_CHECK_STATUSES = ["passed", "failed", "skipped"] as const;

/** 必填 string 兜底(真实业务 E2E 实测补全 P0 家族):SurrealDB SCHEMAFULL 的 `TYPE string` 列
 *  收到非 string(null/数字/缺失)时 persist coerce 失败 → wedge。坏数据(手工 PUT/坏 import/LLM
 *  漏字段)不该冻结权威库,统一兜空串(fail-closed:宁可空串落库也不 wedge)。
 *  回归审查 R1-F2:不仅无 DEFAULT 列,`TYPE string DEFAULT ''` 列(UPSERT CONTENT 不重跑 DEFAULT)
 *  同样会被 null/数字 wedge——故本兜底覆盖 001 的**全部** TYPE string 列(含 DEFAULT '')。 */
function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** 必填 array<string> 兜底(回归审查 R1-F2 补 P0-3 缺口):SurrealDB `TYPE array<string>` 列收到
 *  非数组(null/字符串/数字)或含非 string 元素时 persist coerce 失败 → wedge。非数组→[]、含非
 *  string 元素→只留 string。⚠️ 与 001_nodes.surql 的 array<string> 列(saidTrack/learnedTrack/keywords)同步。 */
function strArr(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((x): x is string => typeof x === "string") : [];
}

/** 可选 string 兜底(R1a):SurrealDB `TYPE option<string>` 列接受 NONE(缺失)但不接受
 *  null/数字等非 string 值——坏值统一规整为 undefined(toRecord 会跳过 undefined 不落列)。
 *  精确沿用 normalizeImportSources 对 searchBriefId 的既有处理口径。 */
function optStr(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** 必填 int 列兜底(N-01,补 P0-3/R1-F2 家族的**数值变体**缺口):SurrealDB SCHEMAFULL 的
 *  `TYPE int DEFAULT 0` 列(question/theme.appearances)收到非 int(字符串数字 "3" / 小数 3.7 /
 *  null / bool),或 **UPSERT CONTENT 覆盖已存在记录时缺该字段**(→ NONE,CONTENT 不重跑 DEFAULT)时,
 *  持久层 coerce 失败 → 确定性 wedge 权威库、基线冻结、连坐同批无辜实体(mem:// 真库 spike 实证:
 *  '3' / 3.7 / null / NONE 四形态各自 `Expected int but found ...`)。`Number.isFinite` 是**严格**判定
 *  (不 coerce:"3" / true / null / NaN / Infinity 全判 false)——fail-closed 从严:畸形输入一律归下界
 *  默认,绝不 parseFloat 救活("3" 不猜成 3,与 str() 兜空串同精神)。Math.floor 去小数;Math.max(0,·)
 *  钳负(appearances 是出现计数,语义无负数——负值 spike 虽不 wedge 但仍是脏值,一并规整)。
 *  缺字段(undefined)→ 0,确保覆盖写时该 core 列**恒有合法 int**(专治 found NONE 变体)。 */
function intCount(value: unknown): number {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value as number)) : 0;
}

/** 可选 int 列兜底(N-01):SurrealDB `TYPE option<int>` 列(memory.importance)接受 NONE(缺失 →
 *  toRecord 跳过不落列 → 合法),但不接受 null / 字符串 / 小数(spike 实证 null → `Expected none|int
 *  but found NULL` → wedge)。严格整数则 Math.floor 保留(option<int> 无 ASSERT、无下界,负整数合法
 *  不 wedge,照任务口径不额外钳负);否则 undefined —— fail-closed:畸形值不落库、退化为"无重要度"
 *  (消费点 `importance ?? 5` 已有中性兜底,见 storage.test MemoryRecord migration)。 */
function optInt(value: unknown): number | undefined {
  return Number.isFinite(value) ? Math.floor(value as number) : undefined;
}

/** N-01-embedding:嵌入向量维度。与 003_index.surql 的 `HNSW DIMENSION 1024`(memory_emb/rag_emb)、
 *  009_r2a_cold.surql 的 kc_emb 及 packages/db constants.ts EMBEDDING_DIMENSION 三处对齐;
 *  node-mapper.test 的防漂移守卫从 migration 解析 HNSW DIMENSION 与本常量机检相等,任一漂移即变红。
 *  刻意在域层本地声明(非 import packages/db):src/domain 是核心域,不反向依赖持久层适配器(node-mapper
 *  等是 packages/db → src/domain 的单向依赖)。 */
export const EMBEDDING_DIMENSION = 1024;

/** 必填/可选 array<float> 列兜底(N-01-embedding,补 P0-3/R1-F2 家族的**向量数组变体**缺口):
 *  memory.embedding / rag_chunk.embedding 是 `TYPE option<array<float>>` 且各带 HNSW DIMENSION 1024 索引
 *  的 core 列(node-mapper NODE_MAPPINGS.core 含 "embedding" → 落 typed 列)。mem:// 真库 spike 实证两类
 *  确定性 wedge 权威库(基线冻结、连坐同批无辜实体):
 *    ① 类型 coerce 失败 —— null → `Expected none|array<float> but found NULL`;非数组("x")、含非数值
 *       元素(['a','b'])→ 同族 coerce 报错;
 *    ② 维度不符 —— 任意**非 1024 维**有限数值数组(3 维/512 维/空 [])→ HNSW 建索引时
 *       `Incorrect vector dimension (N). Expected a vector of 1024 dimension.`。
 *  外部输入面真实存在:import/PUT 携带旧版本/第三方编辑/被截断的备份,其 embedding 维度任意或元素畸形。
 *
 *  fail-closed 从严:**仅当**「是数组 ∧ 长度恰为 1024 ∧ 每个元素都是有限数值」才原样保留(map(Number)
 *  归一为 number),否则整个 → undefined(toRecord 跳过 undefined → 列为 NONE,option 合法、不 wedge)。
 *  - 为何**在此钳维度**(而非"仅查有限数值、把维度交给 HNSW 层"):spike 证明维度不符本身就是确定性
 *    wedge,把它留给 HNSW = 留一个 N-01 同款楔死洞;坏备份的 512/3 维正是外部输入面的真实形态。
 *  - 为何**不误伤合法向量**:合法 embedding 恒由本地/云端 embed client 产出、恒 1024 维有限数值
 *    (EMBEDDING_DIMENSION),维度钳制对它是恒等操作,绝不裁掉真向量。
 *  - 为何仍查 `every(Number.isFinite)`:spike 另证 NaN/Infinity 能过 SurrealDB 的 float coerce(正确维度下
 *    不报错),但会污染 COSINE 索引语义(相似度成噪声);Number.isFinite 严格排除 NaN/Infinity/字符串数字,
 *    与 intCount/optInt 同精神(不 coerce、不救活)。⚠️ 与 003_index.surql / ARRAY_FLOAT_CLAMPED_COLS 同步。 */
function optFloatArray(value: unknown): number[] | undefined {
  return Array.isArray(value) && value.length === EMBEDDING_DIMENSION && value.every((x) => Number.isFinite(x))
    ? value.map(Number)
    : undefined;
}

/** N-01-datetime:坏日期规整的固定哨兵。**非真实时刻**——仅为让持久层 fillUpsertDefaults 的
 *  `new Date(rest[col])` 得到合法 Date、让 normalize 保持纯函数(禁 Date.now)。刻意与
 *  surreal-product-state-repository.ts 的 streamTs 对非串/空 tsField 的兜底哨兵**同值**:流水复合 id
 *  `<table>:[<tsField ISO>, <id>]` 与 typed 列由此对齐,坏 tsField 下二者不漂移。 */
const DATE_SENTINEL = "1970-01-01T00:00:00.000Z";

/** 必填 datetime 列兜底(N-01-datetime,补 P0-3/R1-F2/N-01 家族的**日期变体**缺口):
 *  session.startedAt / turn.timestamp / *.createdAt / *.updatedAt 等 `TYPE datetime DEFAULT time::now()`
 *  typed 列——**不在** NODE_MAPPINGS.core(日期不入核心、随 rest 落库),但 persist 的 fillUpsertDefaults
 *  会把 rest 里的同名 ISO **提升为 typed 列**(`new Date(rest[col])`)。mem:// 真库 spike 实证:**存在
 *  且非法**的日期值确定性 wedge 权威库(基线冻结、连坐同批无辜实体):
 *    · "not-a-date" / 空串 "" / NaN → fillUpsertDefaults 的 `new Date(bad)` = Invalid Date → SDK
 *      `InvalidDateError: The provided date is invalid` → 整事务被拒(spike:consecutiveFailures=1)。
 *    · 对照:null / 缺字段 落到 `new Date()`(now)分支不 wedge —— 但仍统一规整(见下)。
 *  外部输入面真实存在:import/PUT 携旧备份、第三方编辑、LLM 漏/坏字段,日期串任意畸形。
 *
 *  fail-closed 从严:**仅**「是 string ∧ `Date.parse` 可解析(⟺ fillUpsertDefaults 的 new Date 不产出
 *  Invalid Date,同一 [[DateParse]] 规范)」才原样保留(不重写、不篡改真实时刻);否则 → 固定哨兵。
 *  - 为何**用固定哨兵而非 new Date()/Date.now()**:normalize 是**纯函数**(loadState/replaceState 都调、
 *    测试对其输出有确定性预期),注入当前时刻会破坏确定性 + 把坏数据伪装成"刚发生";本仓库亦禁 Date.now。
 *    哨兵是**非真实时刻的显式占位**(坏日期已规整为哨兵,不代表真实发生时间)。
 *  - 为何**缺失/null 也→哨兵**(而非交给 fillUpsertDefaults 落 now):normalize 侧确定性化"缺字段",且
 *    与持久层 streamTs 的 missing→哨兵口径一致(否则流水复合 id=哨兵而 typed 列=now,二者漂移)。
 *  合法日期恒被保留、绝不误伤。⚠️ 与 DATETIME_CLAMPED_COLS + node-mapper.test 的 datetime 守卫同步。 */
function isoDate(value: unknown): string {
  return typeof value === "string" && !Number.isNaN(Date.parse(value)) ? value : DATE_SENTINEL;
}

/** 可选 datetime 列兜底(option<datetime>,N-01-datetime):session.completedAt 是 `TYPE option<datetime>`
 *  无 DEFAULT 的 typed 列——**不在** DATETIME_DEFAULT_COLS、persist 不提升(值留 rest FLEXIBLE),故坏值
 *  **当前不 wedge**(spike 实证 completedAt="not-a-date" 时 consecutiveFailures=0、typed 列 NONE)。此处
 *  仍钳制是**纵深防御 + 一致性**:合法日期串保留、非法→undefined(toRecord 跳过 → 列 NONE),口径对齐
 *  optStr/optInt(可选列坏值一律 undefined 不落列);若将来该列被登记进 DATETIME_DEFAULT_COLS(改为提升),
 *  undefined 已提前免疫 wedge。(冷层 audio.recordingStartedAt 同为 option<datetime> 但不走本管线,故不在此。) */
function optIsoDate(value: unknown): string | undefined {
  return typeof value === "string" && !Number.isNaN(Date.parse(value)) ? value : undefined;
}

function clampPersistableEnums(state: ProductState): ProductState {
  return {
    ...state,
    sessions: state.sessions.map((s) => ({
      ...s,
      title: str(s.title),
      mode: clampEnum(s.mode, SESSION_MODES, "daily"),
      strength: clampEnum(s.strength, SESSION_STRENGTHS, "standard"),
      status: clampEnum(s.status, SESSION_STATUSES, "active"),
      // N-01-datetime:startedAt 是 `TYPE datetime` typed 列(坏串经 fillUpsertDefaults 提升即 wedge);
      // completedAt 是 `TYPE option<datetime>`(坏值留 rest 不 wedge,纵深防御→undefined)。
      startedAt: isoDate(s.startedAt),
      completedAt: optIsoDate((s as { completedAt?: unknown }).completedAt),
      turns: (s.turns ?? []).map((t) => ({
        ...t,
        sessionId: str((t as { sessionId?: unknown }).sessionId) || s.id,
        content: str(t.content),
        role: clampEnum(t.role, TURN_ROLES, "user"),
        // N-01-datetime:turn.timestamp 是 `TYPE datetime` typed 列(经 fillUpsertDefaults 提升,坏串 wedge)。
        timestamp: isoDate((t as { timestamp?: unknown }).timestamp)
      }))
    })),
    notes: state.notes.map((n) => ({
      ...n,
      sessionId: str(n.sessionId),
      title: str(n.title),
      summary: str(n.summary),
      // R1-F2:DEFAULT '' 的 keyQuote + array<string> 的 saidTrack/learnedTrack 兜底。
      keyQuote: str(n.keyQuote),
      saidTrack: strArr(n.saidTrack),
      learnedTrack: strArr(n.learnedTrack),
      createdAt: isoDate(n.createdAt) // N-01-datetime:note.createdAt datetime typed 列
    })),
    points: state.points.map((p) => ({
      ...p,
      title: str(p.title),
      content: str(p.content),
      status: clampEnum(p.status, POINT_STATUSES, "临时想法"),
      // 置信钳制 fail-closed:坏值不得冒充「用户确认」(A3 精神)。
      confidence: clampEnum(p.confidence, POINT_CONFIDENCES, "待验证"),
      // N-01:`TYPE bool` 列坏值(如 "yes")→ coerce 失败 wedge(spike 实证)。严格 `=== true`
      // (镜像 config_version.active 口径):非严格 true 一律 false,fail-closed。此为最终权威钳制;
      // backfillPointDefaults 的 `?? false` 只在管线更早处补 undefined 缺省,方向一致、不冲突
      //(undefined→false→false;"yes"→"yes"→false),此处始终最后跑、恒产出合法 bool。
      important: p.important === true,
      updatedAt: isoDate((p as { updatedAt?: unknown }).updatedAt) // N-01-datetime:point.updatedAt datetime typed 列
    })),
    decisions: state.decisions.map((d) => ({
      ...d,
      title: str(d.title),
      choice: str(d.choice),
      decisionKind: clampEnum(d.decisionKind, DECISION_KINDS, "候选决策"),
      confirmationStatus: clampEnum(d.confirmationStatus, DECISION_CONFIRMATIONS, "待用户确认"),
      status: clampEnum(d.status, DECISION_STATUSES, "待复盘"),
      updatedAt: isoDate((d as { updatedAt?: unknown }).updatedAt) // N-01-datetime:decision.updatedAt datetime typed 列
    })),
    debts: state.debts.map((d) => ({ ...d, concept: str(d.concept), context: str(d.context), status: clampEnum(d.status, DEBT_STATUSES, "待了解"), updatedAt: isoDate((d as { updatedAt?: unknown }).updatedAt) })), // N-01-datetime:debt.updatedAt
    // N-01:appearances 是 `TYPE int` core 列,坏值/缺字段 wedge(spike 实证)→ intCount 恒产出合法 int。
    // N-01-datetime:question/theme.updatedAt 是 datetime typed 列(经 fillUpsertDefaults 提升,坏串 wedge)。
    questions: state.questions.map((q) => ({ ...q, question: str(q.question), whyImportant: str(q.whyImportant), status: clampEnum(q.status, QUESTION_STATUSES, "开放"), appearances: intCount(q.appearances), updatedAt: isoDate((q as { updatedAt?: unknown }).updatedAt) })),
    themes: state.themes.map((t) => ({ ...t, name: str(t.name), summary: str(t.summary), representativeQuote: str(t.representativeQuote), maturity: clampEnum(t.maturity, THEME_MATURITIES, "萌芽"), appearances: intCount(t.appearances), updatedAt: isoDate((t as { updatedAt?: unknown }).updatedAt) })),
    memoryRecords: state.memoryRecords.map((m) => ({
      ...m,
      text: str(m.text),
      sourceType: (str(m.sourceType) || "profile") as typeof m.sourceType,
      sourceId: str(m.sourceId),
      evidenceQuote: str(m.evidenceQuote),   // R1-F2:DEFAULT '' 兜底
      // 坏值绝不冒充 confirmed(会越权进召回);敏感度坏值按敏感处理(隔离而非放行)。
      status: clampEnum(m.status, MEMORY_STATUSES, "deprecated"),
      sensitivity: clampEnum(m.sensitivity ?? "normal", SENSITIVITIES, "sensitive"),
      // N-01:importance 是 `TYPE option<int>` core 列,null/字符串/小数 wedge(spike 实证 null →
      // Expected none|int but found NULL)。optInt:整数保留、坏值→undefined(toRecord 跳过→NONE 合法)。
      importance: optInt(m.importance),
      // N-01-embedding:embedding 是 `TYPE option<array<float>>` + HNSW 1024 的 core 列,null/非数组/
      // 含非数值元素/非 1024 维一律 wedge(spike 实证)。optFloatArray:仅合法 1024 维有限数值原样留,
      // 否则→undefined(toRecord 跳过→NONE 合法)。合法向量恒 1024 维,不误伤。
      embedding: optFloatArray(m.embedding),
      // N-01-datetime:memory.createdAt/updatedAt 均 datetime typed 列(经 fillUpsertDefaults 提升,坏串 wedge)。
      createdAt: isoDate(m.createdAt),
      updatedAt: isoDate(m.updatedAt)
    })),
    memoryCandidates: state.memoryCandidates.map((c) => ({
      ...c,
      text: str(c.text),
      sourceType: (str(c.sourceType) || "profile") as typeof c.sourceType,
      sourceId: str(c.sourceId),
      status: clampEnum(c.status, CANDIDATE_STATUSES, "pending"),
      sensitivity: clampEnum(c.sensitivity ?? "normal", SENSITIVITIES, "sensitive"),
      createdAt: isoDate(c.createdAt) // N-01-datetime:memory_candidate.createdAt datetime typed 列
    })),
    importSources: state.importSources.map((s) => ({
      ...s,
      title: str(s.title),
      content: str(s.content),
      sourceType: clampEnum(s.sourceType, MATERIAL_SOURCE_TYPES, "text"),
      status: "chunked" as const,
      // R1-F1:缺失→normal(与 material schema DEFAULT 'normal' 对齐)。此前独缺 ?? "normal" 致缺失被
      // 钳成 sensitive → 合法参考资料静默从 RAG/chat 剔除。畸形非法值仍 fail-closed 到 sensitive。
      sensitivity: clampEnum(s.sensitivity ?? "normal", SENSITIVITIES, "sensitive"),
      createdAt: isoDate((s as { createdAt?: unknown }).createdAt) // N-01-datetime:material.createdAt datetime typed 列
    })),
    ragChunks: state.ragChunks.map((c) => ({
      // usage 坏值 fail-closed 到 memory-candidate(不会被注入访谈上下文)。
      ...c,
      sourceId: str(c.sourceId),
      text: str(c.text),
      title: str(c.title),          // R1-F2:DEFAULT '' 兜底
      keywords: strArr(c.keywords), // R1-F2:array<string> 兜底
      usage: clampEnum(c.usage, RAG_USAGES, "memory-candidate"),
      // N-01-embedding:同 memory.embedding —— `TYPE option<array<float>>` + HNSW 1024 的 core 列,
      // 坏值/非 1024 维确定性 wedge(spike 实证)。optFloatArray fail-closed:非法→undefined→NONE。
      embedding: optFloatArray(c.embedding),
      createdAt: isoDate((c as { createdAt?: unknown }).createdAt) // N-01-datetime:rag_chunk.createdAt datetime typed 列
    })),
    searchBriefs: state.searchBriefs.map((b) => ({
      ...b,
      topic: str(b.topic),
      summary: str(b.summary),   // R1-F2:DEFAULT '' 兜底
      provider: (str(b.provider) || "local-demo") as SearchProviderId,
      status: clampEnum(b.status, BRIEF_STATUSES, "needs-review"),
      createdAt: isoDate((b as { createdAt?: unknown }).createdAt) // N-01-datetime:search_brief.createdAt datetime typed 列
    })),
    // ── R1a:blob 实体真表化后的钳制(与 007_r1a_entities.surql 核心列/ASSERT 对齐)───────
    profileSuggestions: state.profileSuggestions.map((s) => ({
      ...s,
      // field 刻意不钳到合法画像列(钳到真列是 fail-open:坏建议 approve 会写错画像字段),
      // 只保证是 string 可落库(schema 侧 TYPE string 无 ASSERT);非法 field 由域层
      // approveProfileSuggestion 白名单守卫真拒绝(置 rejected + 警示审计,画像不动)。
      field: str(s.field) as typeof s.field,
      currentValue: str(s.currentValue),
      suggestedValue: str(s.suggestedValue),
      sourceSessionId: str(s.sourceSessionId),
      status: clampEnum(s.status, SUGGESTION_STATUSES, "pending"),
      createdAt: isoDate((s as { createdAt?: unknown }).createdAt) // N-01-datetime:profile_suggestion.createdAt
    })),
    interviewAnnotations: state.interviewAnnotations.map((a) => ({
      ...a,
      sessionId: str(a.sessionId),
      turnId: str(a.turnId),
      text: str(a.text),
      createdAt: isoDate((a as { createdAt?: unknown }).createdAt) // N-01-datetime:interview_annotation.createdAt
    })),
    // N-01-datetime:chat_session.createdAt/updatedAt 均 datetime typed 列。
    chatSessions: state.chatSessions.map((c) => ({ ...c, title: str(c.title), createdAt: isoDate((c as { createdAt?: unknown }).createdAt), updatedAt: isoDate((c as { updatedAt?: unknown }).updatedAt) })),
    memoryCorrections: state.memoryCorrections.map((c) => ({ ...c, text: str(c.text), createdAt: isoDate((c as { createdAt?: unknown }).createdAt) })), // N-01-datetime:memory_correction.createdAt
    podcastEpisodes: state.podcastEpisodes.map((p) => ({
      ...p,
      noteId: str(p.noteId),
      title: str(p.title),
      voice: str(p.voice),
      format: clampEnum(p.format, PODCAST_FORMATS, "solo"),
      // status 坏值 fail-closed 到 draft(绝不冒充 ready 展示不存在的音频);
      // scriptReviewStatus 坏值绝不冒充「用户确认」(镜像 decision confirmationStatus 口径)。
      status: clampEnum(p.status, PODCAST_STATUSES, "draft"),
      scriptReviewStatus: clampEnum(p.scriptReviewStatus, SCRIPT_REVIEW_STATUSES, "待确认"),
      sourceType: optStr(p.sourceType) as typeof p.sourceType,
      sourceId: optStr(p.sourceId),
      createdAt: isoDate((p as { createdAt?: unknown }).createdAt) // N-01-datetime:podcast_episode.createdAt
    })),
    corpusImports: state.corpusImports.map((c) => ({
      ...c,
      title: str(c.title),
      content: str(c.content),
      mediaType: clampEnum(c.mediaType, CORPUS_MEDIA_TYPES, "text"),
      sourceUrl: optStr(c.sourceUrl),
      status: "analyzed" as const,
      createdAt: isoDate((c as { createdAt?: unknown }).createdAt) // N-01-datetime:corpus_import.createdAt
    })),
    corpusInsights: state.corpusInsights.map((c) => ({
      ...c,
      importId: str(c.importId),
      title: str(c.title),
      createdAt: isoDate((c as { createdAt?: unknown }).createdAt) // N-01-datetime:corpus_insight.createdAt
    })),
    playbookPatches: state.playbookPatches.map((p) => ({
      ...p,
      title: str(p.title),
      sourceInsightId: str(p.sourceInsightId),
      sourceImportId: optStr(p.sourceImportId),
      // status 坏值绝不冒充 applied(会让未生效补丁参与策略路由);impact 坏值按最低档。
      status: clampEnum(p.status, PATCH_STATUSES, "proposed"),
      impact: clampEnum(p.impact, PATCH_IMPACTS, "low"),
      createdAt: isoDate((p as { createdAt?: unknown }).createdAt) // N-01-datetime:playbook_patch.createdAt
    })),
    configVersions: state.configVersions.map((v) => ({
      ...v,
      version: str(v.version),
      reason: str(v.reason),
      // changedBy 坏值绝不冒充 user(A3 精神:坏数据不得伪装用户行为);active 非严格 true 一律 false。
      changedBy: clampEnum(v.changedBy, CONFIG_CHANGED_BY, "system"),
      active: v.active === true,
      createdAt: isoDate((v as { createdAt?: unknown }).createdAt) // N-01-datetime:config_version.createdAt
    })),
    // ── R1b:流水实体真表化后的钳制(与 008_r1b_event_streams.surql 核心列/ASSERT 对齐)────
    auditEvents: state.auditEvents.map((e) => ({
      ...e,
      // type/entityType 宽面枚举只保证 string 可落库(schema 不 ASSERT,见 008 头注)。
      type: str(e.type) as typeof e.type,
      label: str(e.label),
      detail: str(e.detail),
      // severity 坏值钳到 warning:既不虚报 critical(假警报)也不降为 info(掩盖问题)。
      severity: clampEnum(e.severity, AUDIT_SEVERITIES, "warning"),
      entityType: str(e.entityType) as typeof e.entityType,
      entityId: str(e.entityId),
      // N-01-datetime:createdAt 是流水 tsField —— 既是 datetime typed 列(经 fillUpsertDefaults 提升,坏串 wedge),
      // 又是复合记录 id `<table>:[createdAt, id]` 的时间段(坏串会被 streamTs 原样当 id、破坏字典序=时间序);
      // isoDate→哨兵同时治两者(哨兵与 streamTs 兜底同值,复合 id 与 typed 列对齐)。
      createdAt: isoDate((e as { createdAt?: unknown }).createdAt)
    })),
    aiRunEvents: state.aiRunEvents.map((e) => ({
      ...e,
      workflow: str(e.workflow) as typeof e.workflow,
      providerId: str(e.providerId),
      // status 坏值绝不冒充 succeeded(质量报告/健康统计会误读)。
      status: clampEnum(e.status, AI_RUN_STATUSES, "failed"),
      entityType: str(e.entityType) as typeof e.entityType,
      entityId: str(e.entityId),
      inputSummary: str(e.inputSummary),
      outputSummary: str(e.outputSummary),
      createdAt: isoDate((e as { createdAt?: unknown }).createdAt) // N-01-datetime:ai_run_event.createdAt(tsField,同上)
    })),
    workflowRuns: state.workflowRuns.map((r) => ({
      ...r,
      workflow: str(r.workflow) as typeof r.workflow,
      status: clampEnum(r.status, WORKFLOW_RUN_STATUSES, "failed"),
      // providerId 类型是单值字面量;legacy 值已由 migrateWorkflowRuns 先行迁移,坏值兜到唯一合法值。
      providerId: (typeof r.providerId === "string" && r.providerId ? r.providerId : "local-workflow-runtime") as typeof r.providerId,
      entityType: str(r.entityType) as typeof r.entityType,
      entityId: str(r.entityId),
      inputSummary: str(r.inputSummary),
      outputSummary: str(r.outputSummary),
      traceId: str(r.traceId),
      startedAt: isoDate((r as { startedAt?: unknown }).startedAt) // N-01-datetime:workflow_run.startedAt(tsField,同上)
    })),
    operationalChecks: state.operationalChecks.map((c) => ({
      ...c,
      kind: str(c.kind) as typeof c.kind,
      label: str(c.label),
      // status 坏值绝不冒充 passed。
      status: clampEnum(c.status, OP_CHECK_STATUSES, "failed"),
      detail: str(c.detail),
      checkedAt: isoDate((c as { checkedAt?: unknown }).checkedAt) // N-01-datetime:operational_check.checkedAt(tsField,同上)
    }))
  };
}

/** N-01 防漂移登记:**标量**数值/布尔 typed **core** 列的坏值兜底覆盖集(节点表名 → 列名,与
 *  NODE_MAPPINGS.table 对齐)。SurrealDB SCHEMAFULL 的 `TYPE int/float/bool`(及 option 变体)core 列
 *  被非法值 / 缺字段 coerce 失败即确定性 wedge 权威库(mem:// 真库 spike 实证);本表是"每个此类
 *  core 列都必须有兜底"的机器可查清单。node-mapper.test 的防漂移守卫扫 migrations 的标量数值/bool
 *  typed core 列,断言逐一落在本集内——未来新增此类列忘了钳制会变红(把静默数据缺陷变成响亮的
 *  测试失败,镜像 DATETIME_DEFAULT_COLS 守卫)。
 *  注:兜底实现分布两处——多数在 clampPersistableEnums(本文件),reviewScore 在 memoryReview.ts
 *  (clampReviewScore + Number.isFinite,域层既有先例);本表只登记"已被守卫",不区分实现位置。
 *  ⚠️ 刻意只含**标量**数值/bool:embedding(option<array<float>>)是同族 wedge 但形态是**数组**
 *  (元素级 coerce + 维度约束,非标量),归 ARRAY_FLOAT_CLAMPED_COLS(下方,独立守卫)——本守卫的
 *  类型正则据此排除 array<float>,两族按类型正则干净分区,互不重叠。 */
export const NUMERIC_BOOL_CLAMPED_COLS: Record<string, readonly string[]> = {
  question:         ["appearances"],   // int         · clampPersistableEnums intCount
  theme:            ["appearances"],   // int         · clampPersistableEnums intCount
  memory:           ["importance"],    // option<int> · clampPersistableEnums optInt
  point:            ["important"],     // bool        · clampPersistableEnums === true
  config_version:   ["active"],        // bool        · clampPersistableEnums === true(R1a 既有)
  memory_candidate: ["reviewScore"],   // float       · memoryReview.ts clampReviewScore(域层先例)
};

/** N-01-embedding 防漂移登记:**array<float>** typed **core** 列(向量嵌入)的坏值兜底覆盖集
 *  (节点表名 → 列名,与 NODE_MAPPINGS.table 对齐)。与 NUMERIC_BOOL_CLAMPED_COLS 分立的原因:
 *  array<float> 的 wedge 形态是**元素级 coerce + HNSW 维度约束**(非标量的整体 coerce),兜底靠
 *  optFloatArray(长度==1024 ∧ 全有限数值,否则→NONE),类型正则也另立一支。node-mapper.test 的
 *  array<float> 防漂移守卫扫 migrations 里 `TYPE (option<)?array<float>` 的 NODE_MAPPINGS core 列,
 *  断言逐一落在本集内(双向:漏钳→missing 红;登记表有 schema 不存在的陈旧项→stale 红)——未来新增
 *  array<float> core 列忘了钳制会变红(镜像 NUMERIC_BOOL_CLAMPED_COLS / DATETIME_DEFAULT_COLS 守卫)。
 *  注:knowledge_chunk.embedding(009,同 option<array<float>>+HNSW)是冷层直写、不在 NODE_MAPPINGS、
 *  不走 clampPersistableEnums,故不登记于此;其 embedding 恒由 embed client 产出、无外部输入面(详见报告)。 */
export const ARRAY_FLOAT_CLAMPED_COLS: Record<string, readonly string[]> = {
  memory:    ["embedding"],   // option<array<float>> + HNSW 1024 · clampPersistableEnums optFloatArray
  rag_chunk: ["embedding"],   // option<array<float>> + HNSW 1024 · clampPersistableEnums optFloatArray
};

/** N-01-datetime 防漂移登记:**datetime**(含 option<datetime>)typed 列的坏值兜底覆盖集(节点表名 →
 *  列名,与 NODE_MAPPINGS.table / STREAM_MAPPINGS.table / "turn" 对齐)。与前两族登记表分立的根本原因:
 *  datetime 列**不在** NODE_MAPPINGS.core(日期不入核心、随 rest 落库),而是 persist 的 fillUpsertDefaults
 *  从 rest **提升**为 typed 列(`new Date(rest[col])`)→ **存在且非法**的日期串在提升时 coerce 成
 *  Invalid Date → SDK InvalidDateError → 确定性 wedge 权威库(mem:// spike 实证:"not-a-date"/""/NaN
 *  各 consecutiveFailures=1)。故 node-mapper.test 的 datetime 守卫**不能**用 core.has(col) 过滤(datetime
 *  不在 core),改用"clampable 表"集(NODE ∪ STREAM ∪ {turn};排除冷层 raw_material/audio/knowledge_chunk
 *  ——它们由冷层仓库直写、不走 clampPersistableEnums/fillUpsertDefaults 提升管线)。
 *  必填 datetime(DEFAULT time::now())→ isoDate(非法→固定哨兵);option<datetime>(session.completedAt)→
 *  optIsoDate(非法→undefined→NONE)。守卫扫 clampable 表上 `TYPE (option<)?datetime` 列,断言逐一落在本集
 *  内(双向:漏钳→missing 红、陈旧→stale 红)——镜像 NUMERIC_BOOL_CLAMPED_COLS / ARRAY_FLOAT_CLAMPED_COLS。 */
export const DATETIME_CLAMPED_COLS: Record<string, readonly string[]> = {
  session:              ["startedAt", "completedAt"], // startedAt datetime→isoDate · completedAt option<datetime>→optIsoDate
  turn:                 ["timestamp"],                // turn 不在 NODE_MAPPINGS(persist 单列处理),但经 fillUpsertDefaults 提升
  note:                 ["createdAt"],
  point:                ["updatedAt"],
  decision:             ["updatedAt"],
  debt:                 ["updatedAt"],
  question:             ["updatedAt"],
  theme:                ["updatedAt"],
  memory:               ["createdAt", "updatedAt"],
  memory_candidate:     ["createdAt"],
  material:             ["createdAt"],
  rag_chunk:            ["createdAt"],
  search_brief:         ["createdAt"],
  profile_suggestion:   ["createdAt"],
  interview_annotation: ["createdAt"],
  chat_session:         ["createdAt", "updatedAt"],
  memory_correction:    ["createdAt"],
  podcast_episode:      ["createdAt"],
  corpus_import:        ["createdAt"],
  corpus_insight:       ["createdAt"],
  playbook_patch:       ["createdAt"],
  config_version:       ["createdAt"],
  audit_event:          ["createdAt"],   // 流水 tsField(复合 id 时间段 + typed 列)
  ai_run_event:         ["createdAt"],   // 流水 tsField
  workflow_run:         ["startedAt"],   // 流水 tsField
  operational_check:    ["checkedAt"],   // 流水 tsField
};

// ── 审计修复(P0-1 chunk 变体):悬空派生块修剪 ────────────────────────────
// rag_chunk 是纯派生、可重建的索引块,sourceId 指向 importSource 或 memoryRecord。
// 来源已不存在的块 = 孤儿:域层召回会引用不可跳转的来源,且手工包导入时 surreal 的
// cascade_material_delete 会在 DB 侧删掉它而 hot 保留 → 三份真相静默发散(审计实测)。
// 统一在 normalize 修剪:hot 先行删除,持久层经正常 diff 同步删 DB 行,绝无发散。
// note 刻意**不**修剪:种子数据即含无会话 note(note-seed-1),产品语义允许 note 独立存在;
// 其 DB 侧级联已由 006 migration 收缩(session 级联只删 turn)。
function pruneDanglingContainmentRefs(state: ProductState): ProductState {
  const sourceIds = new Set<string>(state.importSources.map((s) => s.id));
  const memoryIds = new Set<string>(state.memoryRecords.map((m) => m.id));
  const keptChunks = state.ragChunks.filter((c) => sourceIds.has(c.sourceId) || memoryIds.has(c.sourceId));
  if (keptChunks.length === state.ragChunks.length) {
    return state;
  }
  return { ...state, ragChunks: keptChunks };
}

// ponytail: backfill only the asset fields read unguarded downstream — point.evidence
// is spread in searchProductAssets (crashes if undefined), important drives the toggle,
// relatedThemeIds is pruned by theme cleanup. decisions/debts read these optionally, so
// they need no backfill.
function backfillPointDefaults(points: ProductState["points"]): ProductState["points"] {
  return points.map((point) => ({
    ...point,
    important: point.important ?? false,
    evidence: Array.isArray(point.evidence) ? point.evidence : [],
    relatedThemeIds: Array.isArray(point.relatedThemeIds) ? point.relatedThemeIds : []
  }));
}

function backfillQuestionDefaults(questions: ProductState["questions"]): ProductState["questions"] {
  return questions.map((question) => ({
    ...question,
    important: question.important ?? false,
    relatedThemeIds: Array.isArray(question.relatedThemeIds) ? question.relatedThemeIds : []
  }));
}

function migrateSessionStatuses(value: unknown[]): import("./types").InterviewSession[] {
  return value.map((session) => {
    if (!session || typeof session !== "object") return session as import("./types").InterviewSession;
    const raw = session as Record<string, unknown>;
    if (raw["status"] === "draft") {
      return { ...raw, status: "active" } as import("./types").InterviewSession;
    }
    return raw as unknown as import("./types").InterviewSession;
  });
}

function migrateThemesToTracks(value: unknown[]): import("./types").LongTermTheme[] {
  return value.map((theme) => {
    if (!theme || typeof theme !== "object") return theme as import("./types").LongTermTheme;
    // R4: 清除历史 localStorage 残留的死字段(kind/pinned/lastActiveAt,类型已删),避免死数据随 spread 透传
    const copy = { ...(theme as Record<string, unknown>) };
    delete copy.kind;
    delete copy.pinned;
    delete copy.lastActiveAt;
    const t = copy as unknown as import("./types").LongTermTheme;
    return {
      ...t,
      createdAt: t.createdAt ?? t.updatedAt
    };
  });
}

// M1: 退役 state.memoryEdges,把历史边的主题归属一次性、幂等、无损地折进
// record.relatedThemeIds(与七类资产统一的内嵌软链)。兼容两种历史边形态:
//   · 简化形 { fromMemoryRecordId, themeId }
//   · 富形   { fromMemoryRecordId, targetType:"long_term_theme", targetId }(其余 targetType 丢弃)
// 非主题边按 R4 老语义丢弃并告警(count)。后续 pruneDanglingThemeRefs 会再裁掉指向已删主题的 id。
function legacyMemoryEdgeThemeMap(value: unknown): Map<string, string[]> {
  const map = new Map<string, string[]>();
  if (!Array.isArray(value)) return map;
  let dropped = 0;
  for (const raw of value) {
    if (!raw || typeof raw !== "object") {
      dropped += 1;
      continue;
    }
    const edge = raw as Record<string, unknown>;
    const fromMemoryRecordId = edge.fromMemoryRecordId;
    let themeId: string | undefined;
    if (typeof edge.themeId === "string") {
      themeId = edge.themeId;
    } else if (edge.targetType === "long_term_theme" && typeof edge.targetId === "string") {
      themeId = edge.targetId;
    }
    if (typeof fromMemoryRecordId !== "string" || !themeId) {
      dropped += 1;
      continue;
    }
    const existing = map.get(fromMemoryRecordId) ?? [];
    if (!existing.includes(themeId)) existing.push(themeId);
    map.set(fromMemoryRecordId, existing);
  }
  if (dropped > 0) {
    console.warn(JSON.stringify({ event: "memory_edges_migration_dropped", count: dropped }));
  }
  return map;
}

function mergeLegacyMemoryEdges(
  records: import("./types").MemoryRecord[],
  legacyEdges: unknown
): import("./types").MemoryRecord[] {
  const byRecord = legacyMemoryEdgeThemeMap(legacyEdges);
  if (byRecord.size === 0) return records;
  return records.map((record) => {
    const fromEdges = byRecord.get(record.id);
    if (!fromEdges || fromEdges.length === 0) return record;
    // 幂等 + 无损:并集已有 relatedThemeIds 与历史边归属(去重,保序:先已有后新增)。
    const merged = [...(record.relatedThemeIds ?? [])];
    for (const id of fromEdges) if (!merged.includes(id)) merged.push(id);
    return { ...record, relatedThemeIds: merged };
  });
}

function migrateWorkflowRuns(value: unknown[]): import("./types").WorkflowRun[] {
  return value.map((run) => {
    if (!run || typeof run !== "object") return run as import("./types").WorkflowRun;
    const r = run as Record<string, unknown>;
    // Migrate legacy "mastra-runtime" providerId to "local-workflow-runtime"
    if (r.providerId === "mastra-runtime") {
      return { ...r, providerId: "local-workflow-runtime" } as import("./types").WorkflowRun;
    }
    return run as import("./types").WorkflowRun;
  });
}

function normalizeSearchBriefs(value: unknown[]): SearchBrief[] {
  return value
    .filter((item): item is Partial<SearchBrief> => Boolean(item && typeof item === "object"))
    .map((brief) => ({
      ...brief,
      facts: normalizeBriefList(brief.facts, [brief.summary ?? "搜索简报已生成，需结合来源复核。"]),
      controversies: normalizeBriefList(brief.controversies, brief.sourceAngles ?? ["外部资料存在解释分歧，需要在专访中澄清。"]),
      opposingViews: normalizeBriefList(brief.opposingViews, ["需要补充反方观点，避免把外部素材直接当结论。"]),
      interviewAngles: normalizeBriefList(brief.interviewAngles, brief.discussionTopics ?? ["从外部素材切入，追问一个具体事件。"])
    })) as SearchBrief[];
}

function normalizeImportSources(value: unknown[]): ImportSource[] {
  return value.map((item) => {
    if (!item || typeof item !== "object") return item as ImportSource;
    const src = item as ImportSource;
    const searchBriefId = typeof src.searchBriefId === "string" && src.searchBriefId ? src.searchBriefId : undefined;
    // v2 软标签：旧数据无此字段时补空数组
    const relatedThemeIds = Array.isArray(src.relatedThemeIds) ? src.relatedThemeIds : [];
    return { ...src, searchBriefId, relatedThemeIds };
  });
}

function normalizeBriefList(value: unknown, fallback: unknown) {
  if (Array.isArray(value)) {
    const items = value
      .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
      .map((item) => item.trim());
    if (items.length > 0) {
      return items;
    }
  }
  if (Array.isArray(fallback)) {
    const items = fallback
      .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
      .map((item) => item.trim());
    if (items.length > 0) {
      return items;
    }
  }
  if (typeof fallback === "string" && fallback.trim()) {
    return [fallback.trim()];
  }
  return ["需要补充结构化素材。"];
}

function mergeProviderConfigs(defaultProviders: ProviderConfig[], persistedProviders: unknown) {
  if (!Array.isArray(persistedProviders)) {
    return defaultProviders;
  }

  const providerById = new Map(defaultProviders.map((provider) => [provider.id, provider]));
  for (const provider of persistedProviders) {
    if (!provider || typeof provider !== "object") {
      continue;
    }

    const candidate = provider as ProviderConfig;
    if (typeof candidate.id !== "string" || !candidate.id) {
      continue;
    }

    providerById.set(candidate.id, {
      ...providerById.get(candidate.id),
      ...candidate
    });
  }

  return Array.from(providerById.values());
}

function normalizeSearchConfig(systemConfig: Partial<SystemConfig>, fallbackConfig: SystemConfig) {
  const searchConfig = {
    ...fallbackConfig.search,
    ...systemConfig.search
  };
  const activeProvider = searchConfig.activeProvider as SearchProviderId;
  // ponytail: reset unknown/removed providers (e.g. legacy tavily/exa/brave) and the
  // local-demo placeholder to the real default, so the config dropdown never holds a
  // value with no matching option.
  const validProviders = new Set<SearchProviderId>(["bailian", "anysearch"]);

  return {
    ...searchConfig,
    activeProvider: validProviders.has(activeProvider) ? activeProvider : fallbackConfig.search.activeProvider
  };
}

// P2-11: Known-invalid legacy placeholder voice IDs that are rejected with HTTP 418
// by the TTS backend. Only these specific values (and empty/non-string) are corrected;
// any other non-empty string (including custom enrolled clone voices) is kept as-is.
// ponytail: 只纠正已知非法 legacy 占位值;custom 克隆声音原样保留
const KNOWN_INVALID_VOICE_IDS = new Set(["warm-interviewer", "calm-host", "local-demo"]);

function isInvalidVoiceId(voice: unknown): boolean {
  return typeof voice !== "string" || voice.trim() === "" || KNOWN_INVALID_VOICE_IDS.has(voice);
}

function normalizeVoiceConfig(systemConfig: Partial<SystemConfig>, fallbackConfig: SystemConfig) {
  const voiceConfig = {
    ...fallbackConfig.voice,
    ...systemConfig.voice
  };

  // Migration: the legacy "s2s" realtime path was removed in Phase 3 (commit
  // eb5e4011). Force any persisted s2s config to bailian (default).
  const realtimeMode = (voiceConfig.realtimeMode as string) === "s2s" ? "bailian" : voiceConfig.realtimeMode;

  // P2-11: Correct only known-invalid legacy placeholder values (e.g. "warm-interviewer",
  // "calm-host") that are rejected with HTTP 418 by the TTS backend.
  // Custom enrolled clone voices (e.g. "custom-voice-xxx", "cosyvoice-clone-xxx") are
  // preserved as-is — this is a blacklist correction, NOT a whitelist enforcement.
  // ponytail: 只纠正已知非法 legacy 占位值;custom 克隆声音原样保留
  const defaultVoice = isInvalidVoiceId(voiceConfig.defaultVoice) ? "longanlingxin" : voiceConfig.defaultVoice;
  const podcastVoice = isInvalidVoiceId(voiceConfig.podcastVoice) ? "longanlingxin" : voiceConfig.podcastVoice;

  return {
    ...voiceConfig,
    realtimeMode,
    defaultVoice,
    podcastVoice,
    podcastFormat: voiceConfig.podcastFormat || fallbackConfig.voice.podcastFormat,
    ttsProvider: voiceConfig.ttsProvider === "local-demo" ? fallbackConfig.voice.ttsProvider : voiceConfig.ttsProvider
  };
}

function normalizeModelConfig(systemConfig: Partial<SystemConfig>, fallbackConfig: SystemConfig) {
  const modelConfig = {
    ...fallbackConfig.models,
    ...systemConfig.models
  };

  return {
    ...modelConfig,
    planningModel:
      modelConfig.planningModel === "local-planner" ? fallbackConfig.models.planningModel : modelConfig.planningModel,
    interviewModel:
      modelConfig.interviewModel === "local-rules-interviewer"
        ? fallbackConfig.models.interviewModel
        : modelConfig.interviewModel,
    synthesisModel:
      modelConfig.synthesisModel === "local-synthesizer"
        ? fallbackConfig.models.synthesisModel
        : modelConfig.synthesisModel
  };
}

function normalizeProviderActivation(
  providers: ProviderConfig[],
  activeSearchProvider: SearchProviderId,
  activeTtsProvider: SystemConfig["voice"]["ttsProvider"]
) {
  return providers.map((provider) => {
    if (provider.id === "bailian-responses") {
      return { ...provider, active: activeSearchProvider === "bailian" };
    }
    if (provider.id === "local-demo-search") {
      return { ...provider, active: activeSearchProvider === "local-demo" };
    }
    if (provider.id === "anysearch") {
      return { ...provider, active: activeSearchProvider === "anysearch" };
    }
    if (provider.id === "bailian-qwen-tts") {
      return { ...provider, active: activeTtsProvider === "bailian" };
    }

    return provider;
  });
}

/**
 * P1-24: Remove dangling relatedThemeIds from all asset types.
 * Called after themes have been migrated, so the valid id set is final.
 */
function pruneDanglingThemeRefs(state: ProductState): ProductState {
  const validIds = new Set(state.themes.map((t) => t.id));

  function pruneOptional(ids: string[] | undefined): string[] | undefined {
    if (!Array.isArray(ids)) return ids;
    return ids.filter((id) => validIds.has(id));
  }

  function pruneRequired(ids: string[]): string[] {
    return ids.filter((id) => validIds.has(id));
  }

  return {
    ...state,
    sessions: state.sessions.map((s) => ({ ...s, relatedThemeIds: pruneOptional(s.relatedThemeIds) })),
    notes: state.notes.map((n) => ({ ...n, relatedThemeIds: pruneOptional(n.relatedThemeIds) })),
    points: state.points.map((p) => ({ ...p, relatedThemeIds: pruneRequired(p.relatedThemeIds ?? []) })),
    questions: state.questions.map((q) => ({ ...q, relatedThemeIds: pruneRequired(q.relatedThemeIds ?? []) })),
    decisions: state.decisions.map((d) => ({ ...d, relatedThemeIds: pruneOptional(d.relatedThemeIds) })),
    debts: state.debts.map((d) => ({ ...d, relatedThemeIds: pruneOptional(d.relatedThemeIds) })),
    importSources: state.importSources.map((src) => ({ ...src, relatedThemeIds: pruneOptional(src.relatedThemeIds) })),
    // M1: memory records now carry relatedThemeIds too — prune dangling theme links alongside the seven assets.
    memoryRecords: state.memoryRecords.map((m) => ({ ...m, relatedThemeIds: pruneOptional(m.relatedThemeIds) }))
  };
}

/** Stable signature of state CONTENT, ignoring the revision field (used to detect real changes vs revision-only churn). */
export function productStateContentSignature(state: ProductState): string {
  return JSON.stringify({ ...state, revision: 0 });
}

/**
 * P3-11:某状态是否与首次运行的示例(demo)种子内容逐字一致。
 * 灾备场景——权威库被清空/损坏后重启,GET /api/state 会返回 createInitialProductState() 的
 * 完整 demo 态。若此时本地有离线改动,冲突弹窗会把这份"服务器版本"当成远端权威呈现;用户若
 * "采用服务器版本"就会用示例数据覆盖真实记录。用内容签名(忽略 revision)比对:空库重启返回的
 * demo 无论 revision 都命中,供 UI 打上"疑似示例/初始数据"指纹提示,而不是让用户盲选。
 */
export function isPristineDemoState(state: ProductState): boolean {
  return productStateContentSignature(state) === productStateContentSignature(createInitialProductState());
}

/** 本地缓存损坏标记（sessionStorage）。loadProductState 在 useState 初始化器里跑,
 *  没法直接弹 notice——用标记让 App 挂载后如实告知用户,绝不把"本地数据损坏"
 *  静默掩盖成"看起来正常的初始数据"。 */
export const CACHE_CORRUPTION_MARKER_KEY = "interview-product:cache-corrupted";

export function loadProductState(): ProductState {
  if (typeof window === "undefined") {
    return createInitialProductState();
  }

  const raw = window.localStorage.getItem(STORAGE_KEY);
  if (!raw) {
    return createInitialProductState();
  }

  try {
    return normalizeProductState(JSON.parse(raw));
  } catch (error) {
    console.warn(JSON.stringify({
      event: "local_cache_corrupted",
      error: error instanceof Error ? error.message : String(error)
    }));
    try {
      window.sessionStorage.setItem(CACHE_CORRUPTION_MARKER_KEY, new Date().toISOString());
    } catch {
      // sessionStorage 不可用（隐私模式等）:只剩 console 信号。
    }
    return createInitialProductState();
  }
}

export function saveProductState(state: ProductState) {
  if (typeof window !== "undefined") {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch {
      // localStorage 只是本地快照缓存（服务器才是真相源）。配额超限 / 隐私模式下
      // setItem 会抛 QuotaExceededError——绝不能让它冒泡炸掉渲染，静默跳过即可。
      console.warn(JSON.stringify({ event: "local_snapshot_skipped" }));
    }
  }
}

export function resetProductState(): ProductState {
  const state = createEmptyProductState();
  if (typeof window !== "undefined") {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  }
  return state;
}
