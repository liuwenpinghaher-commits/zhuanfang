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

export function normalizeProductState(value: unknown): ProductState {
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
  return pruneDanglingContainmentRefs(clampPersistableEnums(pruneDanglingThemeRefs(normalized)));
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

function clampPersistableEnums(state: ProductState): ProductState {
  return {
    ...state,
    sessions: state.sessions.map((s) => ({
      ...s,
      title: str(s.title),
      mode: clampEnum(s.mode, SESSION_MODES, "daily"),
      strength: clampEnum(s.strength, SESSION_STRENGTHS, "standard"),
      status: clampEnum(s.status, SESSION_STATUSES, "active"),
      turns: (s.turns ?? []).map((t) => ({
        ...t,
        sessionId: str((t as { sessionId?: unknown }).sessionId) || s.id,
        content: str(t.content),
        role: clampEnum(t.role, TURN_ROLES, "user")
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
      learnedTrack: strArr(n.learnedTrack)
    })),
    points: state.points.map((p) => ({
      ...p,
      title: str(p.title),
      content: str(p.content),
      status: clampEnum(p.status, POINT_STATUSES, "临时想法"),
      // 置信钳制 fail-closed:坏值不得冒充「用户确认」(A3 精神)。
      confidence: clampEnum(p.confidence, POINT_CONFIDENCES, "待验证")
    })),
    decisions: state.decisions.map((d) => ({
      ...d,
      title: str(d.title),
      choice: str(d.choice),
      decisionKind: clampEnum(d.decisionKind, DECISION_KINDS, "候选决策"),
      confirmationStatus: clampEnum(d.confirmationStatus, DECISION_CONFIRMATIONS, "待用户确认"),
      status: clampEnum(d.status, DECISION_STATUSES, "待复盘")
    })),
    debts: state.debts.map((d) => ({ ...d, concept: str(d.concept), context: str(d.context), status: clampEnum(d.status, DEBT_STATUSES, "待了解") })),
    questions: state.questions.map((q) => ({ ...q, question: str(q.question), whyImportant: str(q.whyImportant), status: clampEnum(q.status, QUESTION_STATUSES, "开放") })),
    themes: state.themes.map((t) => ({ ...t, name: str(t.name), summary: str(t.summary), representativeQuote: str(t.representativeQuote), maturity: clampEnum(t.maturity, THEME_MATURITIES, "萌芽") })),
    memoryRecords: state.memoryRecords.map((m) => ({
      ...m,
      text: str(m.text),
      sourceType: (str(m.sourceType) || "profile") as typeof m.sourceType,
      sourceId: str(m.sourceId),
      evidenceQuote: str(m.evidenceQuote),   // R1-F2:DEFAULT '' 兜底
      // 坏值绝不冒充 confirmed(会越权进召回);敏感度坏值按敏感处理(隔离而非放行)。
      status: clampEnum(m.status, MEMORY_STATUSES, "deprecated"),
      sensitivity: clampEnum(m.sensitivity ?? "normal", SENSITIVITIES, "sensitive")
    })),
    memoryCandidates: state.memoryCandidates.map((c) => ({
      ...c,
      text: str(c.text),
      sourceType: (str(c.sourceType) || "profile") as typeof c.sourceType,
      sourceId: str(c.sourceId),
      status: clampEnum(c.status, CANDIDATE_STATUSES, "pending"),
      sensitivity: clampEnum(c.sensitivity ?? "normal", SENSITIVITIES, "sensitive")
    })),
    importSources: state.importSources.map((s) => ({
      ...s,
      title: str(s.title),
      content: str(s.content),
      sourceType: clampEnum(s.sourceType, MATERIAL_SOURCE_TYPES, "text"),
      status: "chunked" as const,
      // R1-F1:缺失→normal(与 material schema DEFAULT 'normal' 对齐)。此前独缺 ?? "normal" 致缺失被
      // 钳成 sensitive → 合法参考资料静默从 RAG/chat 剔除。畸形非法值仍 fail-closed 到 sensitive。
      sensitivity: clampEnum(s.sensitivity ?? "normal", SENSITIVITIES, "sensitive")
    })),
    ragChunks: state.ragChunks.map((c) => ({
      // usage 坏值 fail-closed 到 memory-candidate(不会被注入访谈上下文)。
      ...c,
      sourceId: str(c.sourceId),
      text: str(c.text),
      title: str(c.title),          // R1-F2:DEFAULT '' 兜底
      keywords: strArr(c.keywords), // R1-F2:array<string> 兜底
      usage: clampEnum(c.usage, RAG_USAGES, "memory-candidate")
    })),
    searchBriefs: state.searchBriefs.map((b) => ({
      ...b,
      topic: str(b.topic),
      summary: str(b.summary),   // R1-F2:DEFAULT '' 兜底
      provider: (str(b.provider) || "local-demo") as SearchProviderId,
      status: clampEnum(b.status, BRIEF_STATUSES, "needs-review")
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
      status: clampEnum(s.status, SUGGESTION_STATUSES, "pending")
    })),
    interviewAnnotations: state.interviewAnnotations.map((a) => ({
      ...a,
      sessionId: str(a.sessionId),
      turnId: str(a.turnId),
      text: str(a.text)
    })),
    chatSessions: state.chatSessions.map((c) => ({ ...c, title: str(c.title) })),
    memoryCorrections: state.memoryCorrections.map((c) => ({ ...c, text: str(c.text) })),
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
      sourceId: optStr(p.sourceId)
    })),
    corpusImports: state.corpusImports.map((c) => ({
      ...c,
      title: str(c.title),
      content: str(c.content),
      mediaType: clampEnum(c.mediaType, CORPUS_MEDIA_TYPES, "text"),
      sourceUrl: optStr(c.sourceUrl),
      status: "analyzed" as const
    })),
    corpusInsights: state.corpusInsights.map((c) => ({
      ...c,
      importId: str(c.importId),
      title: str(c.title)
    })),
    playbookPatches: state.playbookPatches.map((p) => ({
      ...p,
      title: str(p.title),
      sourceInsightId: str(p.sourceInsightId),
      sourceImportId: optStr(p.sourceImportId),
      // status 坏值绝不冒充 applied(会让未生效补丁参与策略路由);impact 坏值按最低档。
      status: clampEnum(p.status, PATCH_STATUSES, "proposed"),
      impact: clampEnum(p.impact, PATCH_IMPACTS, "low")
    })),
    configVersions: state.configVersions.map((v) => ({
      ...v,
      version: str(v.version),
      reason: str(v.reason),
      // changedBy 坏值绝不冒充 user(A3 精神:坏数据不得伪装用户行为);active 非严格 true 一律 false。
      changedBy: clampEnum(v.changedBy, CONFIG_CHANGED_BY, "system"),
      active: v.active === true
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
      entityId: str(e.entityId)
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
      outputSummary: str(e.outputSummary)
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
      traceId: str(r.traceId)
    })),
    operationalChecks: state.operationalChecks.map((c) => ({
      ...c,
      kind: str(c.kind) as typeof c.kind,
      label: str(c.label),
      // status 坏值绝不冒充 passed。
      status: clampEnum(c.status, OP_CHECK_STATUSES, "failed"),
      detail: str(c.detail)
    }))
  };
}

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
  const defaultVoice = isInvalidVoiceId(voiceConfig.defaultVoice) ? "longanyang" : voiceConfig.defaultVoice;
  const podcastVoice = isInvalidVoiceId(voiceConfig.podcastVoice) ? "longanhuan" : voiceConfig.podcastVoice;

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
  } catch {
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
