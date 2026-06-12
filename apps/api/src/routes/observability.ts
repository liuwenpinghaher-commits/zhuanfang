import type { FastifyInstance } from "fastify";
import type { ProductStateRepository } from "../product-state-repository";

export function registerObservabilityRoutes(app: FastifyInstance, stateRepo: ProductStateRepository) {
  app.get("/api/observability/health", async () => {
    const state = await stateRepo.getState();
    const providers = state.systemConfig.providers || [];
    const activeProviders = providers.filter((p: any) => p.active);

    return {
      status: "ok",
      uptime: process.uptime(),
      memory: process.memoryUsage(),
      providers: {
        total: providers.length,
        active: activeProviders.length,
        details: activeProviders.map((p: any) => ({ id: p.id, kind: p.kind, status: p.status })),
      },
    };
  });

  app.get("/api/observability/metrics", async () => {
    const state = await stateRepo.getState();
    const aiRuns = state.aiRunEvents || [];

    const totalRuns = aiRuns.length;
    const failedRuns = aiRuns.filter((r: any) => r.status === "failed").length;
    const degradedRuns = aiRuns.filter((r: any) => r.degradedReason).length;
    const totalLatency = aiRuns.reduce((sum: number, r: any) => sum + (r.latencyMs || 0), 0);
    const totalTokens = aiRuns.reduce((sum: number, r: any) => sum + (r.estimatedTokens || 0), 0);

    return {
      aiRuns: { total: totalRuns, failed: failedRuns, degraded: degradedRuns },
      latency: { totalMs: totalLatency, avgMs: totalRuns > 0 ? totalLatency / totalRuns : 0 },
      tokens: { total: totalTokens, avgPerRun: totalRuns > 0 ? totalTokens / totalRuns : 0 },
      sessions: { total: state.sessions.length, completed: state.sessions.filter((s: any) => s.status === "completed").length },
    };
  });
}
