import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Fastify from "fastify";
import { createEmptyProductState } from "../../../../src/domain/engine";
import { createInMemoryProductStateRepository } from "../product-state-repository";
import { registerSystemRoutes } from "./system";

describe("GET/PATCH /api/system/config production lock", () => {
  const stateRepo = createInMemoryProductStateRepository(createEmptyProductState());
  const prodEnv: Record<string, string | undefined> = { DEPLOYMENT_PROFILE: "production" };
  const localEnv: Record<string, string | undefined> = {};
  const prodApp = Fastify();
  const localApp = Fastify();

  beforeAll(async () => {
    await registerSystemRoutes(prodApp, stateRepo, {
      stateStore: "memory",
      env: prodEnv,
      envFilePath: "/tmp/zf-prod.env"
    });
    await registerSystemRoutes(localApp, stateRepo, {
      stateStore: "memory",
      env: localEnv,
      envFilePath: "/tmp/zf-dev.env"
    });
    await prodApp.ready();
    await localApp.ready();
  });

  afterAll(async () => {
    await prodApp.close();
    await localApp.close();
  });

  it("production GET hides env path and marks config not editable", async () => {
    const res = await prodApp.inject({ method: "GET", url: "/api/system/config" });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { editable?: boolean; envFilePath?: string };
    expect(body.editable).toBe(false);
    expect(body.envFilePath).toBeUndefined();
  });

  it("production PATCH refuses key changes", async () => {
    const res = await prodApp.inject({
      method: "PATCH",
      url: "/api/system/config",
      payload: { updates: { ANYSEARCH_LANGUAGE: "en-US" } }
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toContain("不能从页面改钥匙");
    expect(prodEnv.ANYSEARCH_LANGUAGE).toBeUndefined();
  });

  it("non-production PATCH still writes allowlisted keys", async () => {
    const res = await localApp.inject({
      method: "PATCH",
      url: "/api/system/config",
      payload: { updates: { ANYSEARCH_LANGUAGE: "en-US" } }
    });
    expect(res.statusCode).toBe(200);
    expect(localEnv.ANYSEARCH_LANGUAGE).toBe("en-US");
    const get = await localApp.inject({ method: "GET", url: "/api/system/config" });
    expect(get.json().editable).toBe(true);
    expect(get.json().envFilePath).toBe("/tmp/zf-dev.env");
  });
});
