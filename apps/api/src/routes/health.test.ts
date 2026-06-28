import { describe, it, expect } from "vitest";
import Fastify from "fastify";
import { registerHealthRoutes } from "./health";

describe("health route", () => {
  it("无探针(sqlite/测试)→ ok:true,无 persist 字段", async () => {
    const app = Fastify();
    await app.register(registerHealthRoutes());
    const res = await app.inject({ method: "GET", url: "/api/health" });
    expect(res.json()).toEqual({ ok: true, service: "interview-product-api" });
    await app.close();
  });

  it("E:探针报连续失败 → 响应附 persist.degraded(运维/监控可感知静默丢数据)", async () => {
    const app = Fastify();
    await app.register(registerHealthRoutes(() => ({ consecutiveFailures: 3, lastErrorAt: "2026-06-28T00:00:00.000Z" })));
    const res = await app.inject({ method: "GET", url: "/api/health" });
    const body = res.json() as { ok: boolean; persist?: { degraded: boolean; consecutiveFailures: number; lastErrorAt?: string } };
    expect(body.ok).toBe(true);
    expect(body.persist).toEqual({ degraded: true, consecutiveFailures: 3, lastErrorAt: "2026-06-28T00:00:00.000Z" });
    await app.close();
  });

  it("E:探针报 0 失败(健康)→ 不附 persist 字段", async () => {
    const app = Fastify();
    await app.register(registerHealthRoutes(() => ({ consecutiveFailures: 0 })));
    const res = await app.inject({ method: "GET", url: "/api/health" });
    expect((res.json() as { persist?: unknown }).persist).toBeUndefined();
    await app.close();
  });
});
