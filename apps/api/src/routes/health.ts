import type { FastifyInstance } from "fastify";

/** E:权威库落库健康度快照(内联,避免跨包 import PersistHealth)。 */
type PersistHealthLite = { consecutiveFailures: number; lastError?: string; lastErrorAt?: string };

/** 方案二:图↔软链一致性审计报告(内联 lite 型,避免跨包 import GraphConsistencyReport)。 */
type GraphAuditLite = {
  ok: boolean;
  auditedEdgeTables: string[];
  expectedCount: number;
  actualCount: number;
  missingCount: number;
  unexpectedCount: number;
  missingInDb: string[];
  unexpectedInDb: string[];
  /** 悬空溯源(anchor 指向已被 A5 级联删除的 turn,持久层按 DB 真相主动未投影):非漂移,单列。 */
  danglingProvenanceCount: number;
  nodeMissingCount: number;
  nodeUnexpectedCount: number;
  nodeMissingInDb: string[];
  nodeUnexpectedInDb: string[];
};

/** plugin factory:注入 getPersistHealth(dual-surreal/surreal 权威库的落库健康度探针)。
 *  无探针(sqlite / 测试)→ health 只回 ok。探针报连续失败 → 响应附 persist.degraded,
 *  让运维/监控能感知 dual-surreal 下权威库静默写失败(=丢数据风险)。
 *  方案二:auditGraphConsistency 挂 /api/ops/graph-consistency——刻意不放 /api/health 前缀
 *  (该前缀 auth 豁免,审计样本含内部实体 id,不该无认证可见;且审计语义是"运维主动核对",
 *  不该被监控轮询隐式高频触发)。 */
export function registerHealthRoutes(
  getPersistHealth?: () => PersistHealthLite | undefined,
  auditGraphConsistency?: () => Promise<GraphAuditLite> | undefined
) {
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
    // 方案二:图↔软链双表示一致性审计(公理引擎的图层对偶)。无能力档位(sqlite/dual)→ 501;
    // 审计自身失败 → 500 且不吞错误细节。只读、不修复——发现漂移由运维决定处置。
    server.get("/api/ops/graph-consistency", async (_request, reply) => {
      const run = auditGraphConsistency?.();
      if (!run) {
        return reply.code(501).send({ error: "当前 PRODUCT_STORE 档位无图一致性审计能力(需 surreal / dual-surreal 权威)。" });
      }
      try {
        const report = await run;
        return { ok: report.ok, report };
      } catch (err) {
        // 审计修复(F5):底层错误 message 可能含内部表名/查询结构,仅非生产 profile 回传。
        const detail = (process.env.DEPLOYMENT_PROFILE ?? "").trim().toLowerCase() !== "production"
          ? (err instanceof Error ? err.message : String(err))
          : undefined;
        return reply.code(500).send({ error: "图一致性审计执行失败。", ...(detail ? { detail } : {}) });
      }
    });
  };
}
