import type { FastifyInstance } from "fastify";
import { getRuntimeMetricsSnapshot, recordVoiceLatency } from "../observability/runtime-metrics";

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

/** plugin factory:注入 getPersistHealth(surreal 权威库的落库健康度探针)。
 *  无探针(memory 档 / 测试)→ health 只回 ok。探针报连续失败 → 响应附 persist.degraded,
 *  让运维/监控能感知 surreal 权威库静默写失败(=丢数据风险)。
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
      const persistDegraded = Boolean(ph && ph.consecutiveFailures > 0);
      // GV: separate liveness (ok) from readiness (ready). Docker/process probes use ok;
      // operators / readiness gates should require ready && !persist.degraded.
      const metrics = getRuntimeMetricsSnapshot();
      return {
        ok: true,
        ready: !persistDegraded,
        service: "interview-product-api",
        ...(persistDegraded
          ? { persist: { degraded: true, consecutiveFailures: ph!.consecutiveFailures, lastErrorAt: ph!.lastErrorAt } }
          : {}),
        metrics: {
          voice: {
            sampleCount: metrics.voice.sampleCount,
            ttfaP50Ms: metrics.voice.ttfaP50Ms,
            ttfaP95Ms: metrics.voice.ttfaP95Ms,
            interruptCount: metrics.voice.interruptCount
          },
          recall: {
            eventCount: metrics.recall.eventCount,
            hit: metrics.recall.hit,
            empty: metrics.recall.empty,
            low_score: metrics.recall.low_score,
            error: metrics.recall.error
          }
        }
      };
    });

    server.get("/api/system/runtime-metrics", async () => getRuntimeMetricsSnapshot());

    server.post("/api/system/runtime-metrics/voice", async (request) => {
      const body = request.body && typeof request.body === "object" ? (request.body as Record<string, unknown>) : {};
      const pathRaw = typeof body.path === "string" ? body.path : "cascade";
      const path =
        pathRaw === "omni" || pathRaw === "livekit" || pathRaw === "interrupt" || pathRaw === "cascade"
          ? pathRaw
          : "unknown";
      const num = (k: string) =>
        typeof body[k] === "number" && Number.isFinite(body[k] as number) ? (body[k] as number) : undefined;
      recordVoiceLatency({
        path,
        ttfaMs: num("ttfaMs"),
        vadEndToSttMs: num("vadEndToSttMs"),
        sttToLlmMs: num("sttToLlmMs"),
        llmTtftMs: num("llmTtftMs"),
        ttsTtfbMs: num("ttsTtfbMs"),
        interrupted: body.interrupted === true,
        sessionId: typeof body.sessionId === "string" ? body.sessionId : undefined
      });
      return { ok: true, metrics: getRuntimeMetricsSnapshot().voice };
    });

    // 方案二:图↔软链双表示一致性审计(公理引擎的图层对偶)。无能力档位(memory)→ 501;
    // 审计自身失败 → 500 且不吞错误细节。只读、不修复——发现漂移由运维决定处置。
    server.get("/api/ops/graph-consistency", async (_request, reply) => {
      const run = auditGraphConsistency?.();
      if (!run) {
        return reply.code(501).send({ error: "当前 PRODUCT_STORE 档位无图一致性审计能力(需 surreal 权威)。" });
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
