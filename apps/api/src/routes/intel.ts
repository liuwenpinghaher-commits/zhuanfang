import type { FastifyInstance } from "fastify";
import {
  createIntelTask,
  deleteIntelTask,
  intelItemToKnowledgeDebt,
  updateIntelItemStatus
} from "../../../../src/domain/intel";
import type { IntelItem, SearchProviderId } from "../../../../src/domain/types";
import { IntelRunError, runIntelTaskOnce } from "../intel-run";
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

    try {
      const { count, nextState } = await runIntelTaskOnce(state, task, options);
      repository.replaceState(nextState);
      return { count, state: nextState };
    } catch (error) {
      if (error instanceof IntelRunError) {
        return reply.code(error.code).send({ error: error.message });
      }
      throw error;
    }
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
