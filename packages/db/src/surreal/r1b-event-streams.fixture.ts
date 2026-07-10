import type { AiRunEvent, AuditEvent, OperationalCheckEvidence, ProductState, WorkflowRun } from "../../../../src/domain/types";

/** R1b 测试 fixture:4 类流水实体(append-only 事件流表)。
 *  数组按**生产 prepend 序**构造(newest-first,时间戳越新越靠前)——域层写入点全是队首插入
 *  (withAuditEvent/withAiRunEvent/engine.ts:203);loadState 按复合记录 id DESC 取回,
 *  digest 等价断言依赖这一序一致(同 R1a fixture 口径)。
 *  时间戳全部走 tsOf(idx):idx 越大越新、彼此唯一,窗口滑出/prune/range 断言可精确锚定。 */

const BASE_MS = Date.parse("2026-06-01T00:00:00.000Z");

/** 第 idx 秒的 ISO 时间戳(idx 越大越新)。 */
export function tsOf(idx: number): string {
  return new Date(BASE_MS + idx * 1000).toISOString();
}

/** [fromIdx, toIdx] 闭区间的审计事件,newest-first(toIdx 在队首)。批量场景(超窗口)用。 */
export function makeAuditEvents(fromIdx: number, toIdx: number): AuditEvent[] {
  const out: AuditEvent[] = [];
  for (let i = toIdx; i >= fromIdx; i--) {
    out.push({
      id: `ae_${i}`,
      type: "memory_referenced",
      label: `审计事件${i}`,
      detail: `细节${i}`,
      severity: i % 3 === 0 ? "warning" : "info",
      entityType: "memory",
      entityId: `m_${i}`,
      createdAt: tsOf(i)
    });
  }
  return out;
}

export function buildR1bFixtureState(base: ProductState): ProductState {
  const aiRunEvents: AiRunEvent[] = [
    { id: "ar_2", workflow: "interview_turn_generation", providerId: "dashscope", status: "degraded", entityType: "interview_session", entityId: "se_2", inputSummary: "追问上下文", outputSummary: "降级回复", degradedReason: "timeout", latencyMs: 9000, createdAt: tsOf(12), metrics: { timeToFirstTokenMs: 800 } },
    { id: "ar_1", workflow: "interview_preparation", providerId: "local-workflow-runtime", status: "succeeded", entityType: "interview_session", entityId: "se_1", inputSummary: "准备输入", outputSummary: "准备完成", latencyMs: 1200, estimatedTokens: 300, workflowRunId: "wr_1", createdAt: tsOf(11) }
  ];
  const workflowRuns: WorkflowRun[] = [
    { id: "wr_2", workflow: "context_pack_build", status: "running", providerId: "local-workflow-runtime", entityType: "interview_session", entityId: "se_2", inputSummary: "构建中", outputSummary: "", startedAt: tsOf(22), traceId: "trace-wr_2" },
    { id: "wr_1", workflow: "interview_preparation", status: "succeeded", providerId: "local-workflow-runtime", entityType: "interview_session", entityId: "se_1", inputSummary: "准备输入", outputSummary: "准备完成", startedAt: tsOf(21), completedAt: tsOf(23), latencyMs: 2000, traceId: "trace-wr_1", metadata: { securityInterceptionCount: 0 } }
  ];
  const operationalChecks: OperationalCheckEvidence[] = [
    { id: "oc_2", kind: "workflow-runtime-smoke", label: "工作流冒烟", status: "skipped", summary: { passed: 0, failed: 0, skipped: 3 }, detail: "无凭据跳过", requiredEnv: ["DASHSCOPE_API_KEY"], checkedAt: tsOf(32), generatedAt: tsOf(33) },
    { id: "oc_1", kind: "provider-smoke", label: "provider 冒烟", status: "passed", summary: { passed: 2, failed: 0, skipped: 0 }, detail: "全部通过", requiredEnv: [], checkedAt: tsOf(31), generatedAt: tsOf(31), metadata: { durationMs: 40 } }
  ];
  return {
    ...base,
    // 既有本体数组清空(同 R1a fixture:聚焦 R1b 面,既有表往返已有专测)。
    sessions: [], notes: [], points: [], questions: [], decisions: [], debts: [], themes: [],
    memoryRecords: [], memoryCandidates: [], searchBriefs: [], importSources: [], ragChunks: [],
    profileSuggestions: [], interviewAnnotations: [], chatSessions: [], memoryCorrections: [],
    podcastEpisodes: [], corpusImports: [], corpusInsights: [], playbookPatches: [], configVersions: [],
    auditEvents: makeAuditEvents(1, 3),
    aiRunEvents,
    workflowRuns,
    operationalChecks
  };
}
