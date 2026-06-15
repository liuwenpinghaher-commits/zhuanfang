/**
 * Shared intel-task execution logic used by both the HTTP route handler and the
 * in-process scheduler.  Keeping it here (rather than in src/domain/intel.ts)
 * lets it import the provider clients, which are server-side concerns.
 */
import { ingestIntelItems, type TriagedIntelItem } from "../../../src/domain/intel";
import type { IntelTask, ProductState, SourceHighlight } from "../../../src/domain/types";
import { triageIntelResults } from "./intelligence/intel-triage-llm";
import type { AnySearchClient } from "./providers/anysearch";
import type { BailianChatClient, BailianSearchClient } from "./providers/bailian";

export interface IntelRunClients {
  bailianSearchClient?: BailianSearchClient;
  anySearchClient?: AnySearchClient;
  bailianChatClient?: BailianChatClient;
}

/** Typed error thrown when the run cannot proceed (mapped to 502/503 in the route). */
export class IntelRunError extends Error {
  constructor(
    message: string,
    public readonly code: 502 | 503
  ) {
    super(message);
    this.name = "IntelRunError";
  }
}

/**
 * Run a single intel task: search → triage → ingest.
 * Sets `task.lastRunAt` in the returned `nextState`.
 *
 * Throws `IntelRunError` for provider/configuration problems the caller should
 * surface as 502/503.  Other errors (unexpected) propagate as-is.
 */
export async function runIntelTaskOnce(
  state: ProductState,
  task: IntelTask,
  clients: IntelRunClients
): Promise<{ count: number; nextState: ProductState }> {
  const topic = task.keywords.join(" ") || task.name;
  const searchInput = {
    topic,
    maxSources: state.systemConfig.search.maxSources,
    recencyDays: state.systemConfig.search.recencyDays
  };

  let sources: SourceHighlight[] = [];
  try {
    if (task.provider === "anysearch" && clients.anySearchClient) {
      sources = (await clients.anySearchClient.createSearchBrief({ ...searchInput, providerId: "anysearch" })).sources;
    } else if (clients.bailianSearchClient) {
      sources = (await clients.bailianSearchClient.createSearchBrief({ ...searchInput, providerId: "bailian" })).sources;
    }
  } catch (error) {
    throw new IntelRunError(error instanceof Error ? error.message : "Intel search failed.", 502);
  }

  if (sources.length === 0) {
    throw new IntelRunError("No search provider configured (need DASHSCOPE/ANYSEARCH key).", 503);
  }

  let triaged: TriagedIntelItem[] = [];
  if (clients.bailianChatClient) {
    try {
      triaged = await triageIntelResults(task.name, task.keywords, sources, clients.bailianChatClient);
    } catch {
      // fall through to untriaged fallback
    }
  }
  if (triaged.length === 0) {
    triaged = sources.slice(0, 8).map((source) => ({
      title: source.title,
      url: source.url,
      publisher: source.publisher,
      summary: source.snippet,
      relevance: 50,
      claims: [],
      category: "未分类"
    }));
  }

  // ingestIntelItems already stamps task.lastRunAt = nowIso() internally.
  return ingestIntelItems(state, task, triaged);
}
