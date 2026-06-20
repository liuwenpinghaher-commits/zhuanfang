import type { SearchProviderId } from "../domain/types";

export const searchProviderLabels: Record<SearchProviderId, string> = {
  "local-demo": "Local Demo Search",
  bailian: "百炼内置联网",
  anysearch: "AnySearch"
};

/**
 * Canonical ordered list of all registered search providers.
 * Derived from searchProviderLabels — the single source of truth.
 * All UI lists (ConfigView, SearchIntelligenceView) must import this.
 */
export const searchProviderIds = Object.keys(searchProviderLabels) as SearchProviderId[];
