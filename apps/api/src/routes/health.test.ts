import { describe, it, expect, beforeEach } from "vitest";
import Fastify from "fastify";
import { registerHealthRoutes } from "./health";
import { resetRuntimeMetricsForTests } from "../observability/runtime-metrics";

describe("health route", () => {
  beforeEach(() => resetRuntimeMetricsForTests());

it("无探针(sqlite/测试)→ ok:true ready:true,无 persist 字段", async () => {
    const app = Fastify();
    await app.register(registerHealthRoutes());
    const res = await app.inject({ method: "GET", url: "/api/health" });
    expect(res.json()).toMatchObject({ ok: true, ready: true, service: "interview-product-api" });
    await app.close();
  });

  it("E:探针报连续失败 → ready:false + persist.degraded(运维/监控可感知静默丢数据)", async () => {
    const app = Fastify();
    await app.register(registerHealthRoutes(() => ({ consecutiveFailures: 3, lastErrorAt: "2026-06-28T00:00:00.000Z" })));
    const res = await app.inject({ method: "GET", url: "/api/health" });
    const body = res.json() as {
      ok: boolean;
      ready?: boolean;
      persist?: { degraded: boolean; consecutiveFailures: number; lastErrorAt?: string };
    };
    expect(body.ok).toBe(true);
    expect(body.ready).toBe(false);
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

  it("GET /api/health 透出 PCM TTFB 与开场出声，不改写 ttsTtfb", async () => {
    const app = Fastify();
    await app.register(registerHealthRoutes());
    const posted = await app.inject({
      method: "POST",
      url: "/api/system/runtime-metrics/voice",
      payload: {
        path: "cascade",
        ttsTtfbMs: 50,
        ttsPcmTtfbMs: 180,
        openingAudible: true,
        playbackContextState: "running",
        takeFloor: false
      }
    });
    expect(posted.statusCode).toBe(200);
    const abortPosted = await app.inject({
      method: "POST",
      url: "/api/system/runtime-metrics/voice",
      payload: { path: "cascade", falseTriggerKind: "opening_second_turn_abort" }
    });
    expect(abortPosted.statusCode).toBe(200);
    const res = await app.inject({ method: "GET", url: "/api/health" });
    const voice = (res.json() as {
      metrics: {
        voice: {
          openingAudibleCount?: number;
          playbackContextState?: string;
          takeFloorCount?: number;
          falseTriggerByKind?: { opening_second_turn_abort?: number };
          segments?: {
            ttsTtfb?: { p50Ms?: number; definition?: string };
            ttsPcmTtfb?: { p50Ms?: number; definition?: string };
          };
        };
      };
    }).metrics.voice;
    expect(voice.openingAudibleCount).toBe(1);
    expect(voice.playbackContextState).toBe("running");
    expect(voice.takeFloorCount).toBe(0);
    expect(voice.falseTriggerByKind?.opening_second_turn_abort).toBe(1);
    expect(voice.segments?.ttsTtfb?.p50Ms).toBe(50);
    expect(voice.segments?.ttsTtfb?.definition).toBe("speak_call");
    expect(voice.segments?.ttsPcmTtfb?.p50Ms).toBe(180);
    expect(voice.segments?.ttsPcmTtfb?.definition).toBe("pcm_scheduled");
    await app.close();
  });
});

describe("ops graph-consistency route(方案二)", () => {
  const report = {
    ok: true, auditedEdgeTables: ["belongs_to_theme"], expectedCount: 1, actualCount: 1,
    missingCount: 0, unexpectedCount: 0, missingInDb: [] as string[], unexpectedInDb: [] as string[],
    danglingProvenanceCount: 0,
    nodeMissingCount: 0, nodeUnexpectedCount: 0, nodeMissingInDb: [] as string[], nodeUnexpectedInDb: [] as string[]
  };
  it("无审计能力(sqlite/dual 档位探针返回 undefined)→ 501", async () => {
    const app = Fastify();
    await app.register(registerHealthRoutes(undefined, () => undefined));
    const res = await app.inject({ method: "GET", url: "/api/ops/graph-consistency" });
    expect(res.statusCode).toBe(501);
    await app.close();
  });
  it("未注入审计探针 → 同样 501(不因缺探针 500)", async () => {
    const app = Fastify();
    await app.register(registerHealthRoutes());
    const res = await app.inject({ method: "GET", url: "/api/ops/graph-consistency" });
    expect(res.statusCode).toBe(501);
    await app.close();
  });
  it("有审计能力 → 200,report 原样透出", async () => {
    const app = Fastify();
    await app.register(registerHealthRoutes(undefined, () => Promise.resolve(report)));
    const res = await app.inject({ method: "GET", url: "/api/ops/graph-consistency" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, report });
    await app.close();
  });
  it("审计执行失败 → 500 且带错误细节(fail-loud,不吞)", async () => {
    const app = Fastify();
    await app.register(registerHealthRoutes(undefined, () => Promise.reject(new Error("db down"))));
    const res = await app.inject({ method: "GET", url: "/api/ops/graph-consistency" });
    expect(res.statusCode).toBe(500);
    expect((res.json() as { detail?: string }).detail).toContain("db down");
    await app.close();
  });
});
