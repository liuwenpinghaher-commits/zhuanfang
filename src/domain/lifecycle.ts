import type { CorpusInsight, PodcastEpisode, ProductState, SearchBrief } from "./types";

export interface GeneratedArtifactRemovalCounts {
  searchBriefs: number;
  podcastEpisodes: number;
  corpusInsights: number;
}

export interface GeneratedArtifactCleanupResult {
  nextState: ProductState;
  removed: GeneratedArtifactRemovalCounts;
}

export function deleteSearchBrief(state: ProductState, briefId: string): ProductState {
  return {
    ...state,
    searchBriefs: state.searchBriefs.filter((brief) => brief.id !== briefId)
  };
}

export function deletePodcastEpisode(state: ProductState, episodeId: string): ProductState {
  return {
    ...state,
    podcastEpisodes: state.podcastEpisodes.filter((episode) => episode.id !== episodeId)
  };
}

export function deleteCorpusInsightBundle(state: ProductState, insightId: string): ProductState {
  const insight = state.corpusInsights.find((item) => item.id === insightId);
  if (!insight) {
    return state;
  }

  return {
    ...state,
    corpusImports: state.corpusImports.filter((item) => item.id !== insight.importId),
    corpusInsights: state.corpusInsights.filter((item) => item.id !== insightId),
    playbookPatches: state.playbookPatches.filter(
      (patch) => patch.sourceInsightId !== insightId || patch.status === "applied"
    )
  };
}

export function dedupeGeneratedArtifacts(state: ProductState): GeneratedArtifactCleanupResult {
  const search = keepFirstBy(state.searchBriefs, searchBriefKey);
  const podcasts = keepFirstBy(state.podcastEpisodes, podcastEpisodeKey);
  const corpus = keepFirstBy(state.corpusInsights, corpusInsightKey);
  const removedInsightIds = new Set(corpus.removedItems.map((insight) => insight.id));
  const removedImportIds = new Set(corpus.removedItems.map((insight) => insight.importId));

  return {
    nextState: {
      ...state,
      searchBriefs: search.items,
      podcastEpisodes: podcasts.items,
      corpusImports: state.corpusImports.filter((item) => !removedImportIds.has(item.id)),
      corpusInsights: corpus.items,
      playbookPatches: state.playbookPatches.filter(
        (patch) => !removedInsightIds.has(patch.sourceInsightId) || patch.status === "applied"
      )
    },
    removed: {
      searchBriefs: search.removed,
      podcastEpisodes: podcasts.removed,
      corpusInsights: corpus.removed
    }
  };
}

function keepFirstBy<T>(items: T[], getKey: (item: T) => string): { items: T[]; removed: number; removedItems: T[] } {
  const seen = new Set<string>();
  const kept: T[] = [];
  const removedItems: T[] = [];

  for (const item of items) {
    const key = getKey(item);
    if (seen.has(key)) {
      removedItems.push(item);
      continue;
    }
    seen.add(key);
    kept.push(item);
  }

  return {
    items: kept,
    removed: removedItems.length,
    removedItems
  };
}

function normalizeKey(value: string): string {
  return value.trim().toLowerCase();
}

function searchBriefKey(brief: SearchBrief): string {
  return `${brief.provider}:${normalizeKey(brief.topic)}`;
}

function podcastEpisodeKey(episode: PodcastEpisode): string {
  const sourcePrefix =
    episode.sourceType && episode.sourceId
      ? `${episode.sourceType}:${episode.sourceId}`
      : episode.noteId;
  return `${sourcePrefix}:${episode.format}:${normalizeKey(episode.voice)}:${normalizeKey(episode.title)}`;
}

function corpusInsightKey(insight: CorpusInsight): string {
  return normalizeKey(insight.title);
}
