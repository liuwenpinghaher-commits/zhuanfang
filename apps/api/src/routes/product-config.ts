import type { FastifyInstance } from "fastify";
import { applySystemConfigChange, rollbackSystemConfigVersion } from "../../../../src/domain/engine";
import type { ConfigVersion, ProductState, SystemConfig } from "../../../../src/domain/types";
import type { ProductStateRepository } from "../product-state-repository";

interface UpdateProductConfigPayload {
  config?: unknown;
  reason?: unknown;
}

export async function registerProductConfigRoutes(server: FastifyInstance, repository: ProductStateRepository) {
  server.patch("/api/product-config", async (request, reply) => {
    const state = repository.getState();
    const payload = normalizeObject<UpdateProductConfigPayload>(request.body);
    if (!isSystemConfigLike(payload.config)) {
      return reply.code(422).send({ error: "A complete product system config is required." });
    }

    const nextState = applySystemConfigChange(state, payload.config, {
      changedBy: "user",
      reason: normalizeOptionalString(payload.reason) ?? "保存产品策略配置"
    });
    if (nextState === state) {
      return reply.code(409).send({ error: "Product system config has no changes." });
    }

    repository.replaceState(nextState);
    return {
      configVersion: nextState.configVersions[0],
      state: nextState
    };
  });

  server.post("/api/product-config/versions/:id/rollback", async (request, reply) => {
    const state = repository.getState();
    const versionId = getRouteId(request.params);
    const targetVersion = findConfigVersion(state, versionId);
    if (!targetVersion) {
      return reply.code(404).send({ error: "Product config version not found." });
    }

    const nextState = rollbackSystemConfigVersion(state, targetVersion.id);
    if (nextState === state) {
      return reply.code(409).send({ error: "Product config version is already active." });
    }

    repository.replaceState(nextState);
    return {
      configVersion: nextState.configVersions[0],
      state: nextState
    };
  });
}

function normalizeObject<T>(value: unknown): Partial<T> {
  return value && typeof value === "object" ? (value as Partial<T>) : {};
}

function normalizeOptionalString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function getRouteId(params: unknown) {
  return normalizeObject<{ id: string }>(params).id;
}

function findConfigVersion(state: ProductState, versionId: unknown): ConfigVersion | undefined {
  return typeof versionId === "string" ? state.configVersions.find((version) => version.id === versionId) : undefined;
}

function isSystemConfigLike(value: unknown): value is SystemConfig {
  if (!value || typeof value !== "object") {
    return false;
  }

  const config = value as Partial<SystemConfig>;
  return Boolean(
    typeof config.version === "string" &&
      Array.isArray(config.providers) &&
      isRecord(config.search) &&
      isRecord(config.voice) &&
      isRecord(config.models) &&
      isRecord(config.interview) &&
      isRecord(config.memory)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object");
}
