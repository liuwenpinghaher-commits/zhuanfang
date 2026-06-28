import { createInitialProductState, createEmptyProductState } from "./engine";
import { withMemoryCandidateReview } from "./memoryReview";
import type { ImportSource, ProductState, ProviderConfig, SearchBrief, SearchProviderId, SystemConfig } from "./types";

const STORAGE_KEY = "interview-product-state-v1";
// ponytail: 有界常量 — normalize 时保留的最大已审 candidate 数(pending 全留)
const MAX_REVIEWED_CANDIDATES = 200;
// ponytail: rolling window for audit/aiRun event logs (newest-first). Bounds the largest
// unbounded growth source so the full-state-PUT model can't grow past the 28MB body limit.
const MAX_EVENT_LOG = 1000;
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
    workflowRuns: Array.isArray(candidate.workflowRuns) ? migrateWorkflowRuns(candidate.workflowRuns) : fallback.workflowRuns,
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
  return pruneDanglingThemeRefs(normalized);
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
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  }
}

export function resetProductState(): ProductState {
  const state = createEmptyProductState();
  if (typeof window !== "undefined") {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  }
  return state;
}
