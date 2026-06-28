import type { FastifyInstance } from "fastify";

/** E:权威库落库健康度快照(内联,避免跨包 import PersistHealth)。 */
type PersistHealthLite = { consecutiveFailures: number; lastError?: string; lastErrorAt?: string };

/** plugin factory:注入 getPersistHealth(dual-surreal/surreal 权威库的落库健康度探针)。
 *  无探针(sqlite / 测试)→ health 只回 ok。探针报连续失败 → 响应附 persist.degraded,
 *  让运维/监控能感知 dual-surreal 下权威库静默写失败(=丢数据风险)。 */
export function registerHealthRoutes(getPersistHealth?: () => PersistHealthLite | undefined) {
  return async function healthPlugin(server: FastifyInstance) {
    server.get("/api/health", async () => {
      const ph = getPersistHealth?.();
      return {
        ok: true,
        service: "interview-product-api",
        ...(ph && ph.consecutiveFailures > 0
          ? { persist: { degraded: true, consecutiveFailures: ph.consecutiveFailures, lastErrorAt: ph.lastErrorAt } }
          : {})
      };
    });
  };
}
