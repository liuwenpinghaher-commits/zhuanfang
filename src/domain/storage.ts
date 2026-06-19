import { createInitialProductState, createEmptyProductState } from "./engine";
import { withMemoryCandidateReview } from "./memoryReview";
import type { ImportSource, ProductState, ProviderConfig, SearchBrief, SearchProviderId, SystemConfig } from "./types";

const STORAGE_KEY = "interview-product-state-v1";

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
    sessions: Array.isArray(candidate.sessions) ? migrateSessionStatuses(candidate.sessions) : fallback.sessions,
    notes: Array.isArray(candidate.notes) ? candidate.notes : fallback.notes,
    points: Array.isArray(candidate.points) ? candidate.points : fallback.points,
    questions: Array.isArray(candidate.questions) ? candidate.questions : fallback.questions,
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
    readings: Array.isArray(candidate.readings) ? candidate.readings : fallback.readings,
    memoryRecords: Array.isArray(candidate.memoryRecords) ? candidate.memoryRecords : fallback.memoryRecords,
    memoryCandidates: Array.isArray(candidate.memoryCandidates)
      ? candidate.memoryCandidates.map((c) => withMemoryCandidateReview(c, { legacyBackfill: true, preserveExisting: true }))
      : fallback.memoryCandidates,
    memoryEdges: Array.isArray(candidate.memoryEdges) ? candidate.memoryEdges : fallback.memoryEdges,
    importSources: Array.isArray(candidate.importSources) ? normalizeImportSources(candidate.importSources) : fallback.importSources,
    ragChunks: Array.isArray(candidate.ragChunks) ? candidate.ragChunks : fallback.ragChunks,
    intelTasks: Array.isArray(candidate.intelTasks) ? candidate.intelTasks : fallback.intelTasks,
    intelItems: Array.isArray(candidate.intelItems) ? candidate.intelItems : fallback.intelItems,
    configVersions: Array.isArray(candidate.configVersions) ? candidate.configVersions : fallback.configVersions,
    auditEvents: Array.isArray(candidate.auditEvents) ? candidate.auditEvents : fallback.auditEvents,
    aiRunEvents: Array.isArray(candidate.aiRunEvents) ? candidate.aiRunEvents : fallback.aiRunEvents,
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
      }
    }
  };
  return pruneDanglingThemeRefs(normalized);
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
    const t = theme as import("./types").LongTermTheme;
    return {
      ...t,
      kind: t.kind ?? "theme",
      pinned: t.pinned ?? false,
      createdAt: t.createdAt ?? t.updatedAt,
      lastActiveAt: t.lastActiveAt ?? t.updatedAt
    };
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
    return { ...src, searchBriefId };
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

  return {
    ...searchConfig,
    activeProvider: activeProvider === "local-demo" ? fallbackConfig.search.activeProvider : activeProvider
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
    points: state.points.map((p) => ({ ...p, relatedThemeIds: pruneRequired(p.relatedThemeIds) })),
    questions: state.questions.map((q) => ({ ...q, relatedThemeIds: pruneRequired(q.relatedThemeIds) })),
    decisions: state.decisions.map((d) => ({ ...d, relatedThemeIds: pruneOptional(d.relatedThemeIds) })),
    debts: state.debts.map((d) => ({ ...d, relatedThemeIds: pruneOptional(d.relatedThemeIds) })),
    readings: state.readings.map((r) => ({ ...r, relatedThemeIds: pruneRequired(r.relatedThemeIds) })),
    intelTasks: state.intelTasks.map((t) => ({ ...t, relatedThemeIds: pruneRequired(t.relatedThemeIds) }))
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
