import type { FastifyInstance } from "fastify";
import {
  createIntelTask,
  deleteIntelTask,
  ingestIntelItems,
  intelItemToKnowledgeDebt,
  updateIntelItemStatus,
  type TriagedIntelItem
} from "../../../../src/domain/intel";
import type { IntelItem, SearchProviderId, SourceHighlight } from "../../../../src/domain/types";
import { triageIntelResults } from "../intelligence/intel-triage-llm";
import type { AnySearchClient } from "../providers/anysearch";
import type { BailianChatClient, BailianSearchClient } from "../providers/bailian";
import type { ProductStateRepository } from "../product-state-repository";

interface IntelRouteOptions {
  bailianSearchClient?: BailianSearchClient;
  anySearchClient?: AnySearchClient;
  bailianChatClient?: BailianChatClient;
}

export async function registerIntelRoutes(
  server: FastifyInstance,
  repository: ProductStateRepository,
  options: IntelRouteOptions = {}
) {
  server.post("/api/intel/tasks", async (request, reply) => {
    const payload = (request.body ?? {}) as Record<string, unknown>;
    const name = typeof payload.name === "string" ? payload.name : "";
    const keywords = Array.isArray(payload.keywords)
      ? (payload.keywords as unknown[]).filter((item): item is string => typeof item === "string")
      : typeof payload.keywords === "string"
        ? (payload.keywords as string).split(/[,，、\s]+/)
        : [];
    if (keywords.filter((keyword) => keyword.trim()).length === 0) {
      return reply.code(422).send({ error: "At least one keyword is required." });
    }
    const { task, nextState } = createIntelTask(repository.getState(), {
      name,
      keywords,
      provider: typeof payload.provider === "string" ? (payload.provider as SearchProviderId) : undefined,
      frequency: payload.frequency === "daily" || payload.frequency === "weekly" ? payload.frequency : "manual"
    });
    repository.replaceState(nextState);
    return { task, state: nextState };
  });

  server.post("/api/intel/tasks/:id/run", async (request, reply) => {
    const state = repository.getState();
    const task = state.intelTasks.find((item) => item.id === getId(request.params));
    if (!task) {
      return reply.code(404).send({ error: "Intel task not found." });
    }

    const topic = task.keywords.join(" ") || task.name;
    const searchInput = {
      topic,
      maxSources: state.systemConfig.search.maxSources,
      recencyDays: state.systemConfig.search.recencyDays
    };

    let sources: SourceHighlight[] = [];
    try {
      if (task.provider === "anysearch" && options.anySearchClient) {
        sources = (await options.anySearchClient.createSearchBrief({ ...searchInput, providerId: "anysearch" })).sources;
      } else if (options.bailianSearchClient) {
        sources = (await options.bailianSearchClient.createSearchBrief({ ...searchInput, providerId: "bailian" })).sources;
      }
    } catch (error) {
      return reply.code(502).send({ error: error instanceof Error ? error.message : "Intel search failed." });
    }

    if (sources.length === 0) {
      return reply.code(503).send({ error: "No search provider configured (need DASHSCOPE/ANYSEARCH key)." });
    }

    let triaged: TriagedIntelItem[] = [];
    if (options.bailianChatClient) {
      try {
        triaged = await triageIntelResults(task.name, task.keywords, sources, options.bailianChatClient);
      } catch {
        // fall through to untriaged
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

    const { count, nextState } = ingestIntelItems(state, task, triaged);
    repository.replaceState(nextState);
    return { count, state: nextState };
  });

  server.patch("/api/intel/items/:id", async (request, reply) => {
    const status = (request.body as { status?: unknown })?.status;
    if (status !== "unread" && status !== "saved" && status !== "ignored") {
      return reply.code(422).send({ error: "Valid status is required." });
    }
    const nextState = updateIntelItemStatus(repository.getState(), getId(request.params), status as IntelItem["status"]);
    repository.replaceState(nextState);
    return { state: nextState };
  });

  server.post("/api/intel/items/:id/to-debt", async (request, reply) => {
    const { debt, nextState } = intelItemToKnowledgeDebt(repository.getState(), getId(request.params));
    if (!debt) {
      return reply.code(404).send({ error: "Intel item not found." });
    }
    repository.replaceState(nextState);
    return { debt, state: nextState };
  });

  server.delete("/api/intel/tasks/:id", async (request) => {
    const nextState = deleteIntelTask(repository.getState(), getId(request.params));
    repository.replaceState(nextState);
    return { state: nextState };
  });
}

function getId(params: unknown): string {
  const value = params && typeof params === "object" ? (params as { id?: unknown }).id : undefined;
  return typeof value === "string" ? value : "";
}
