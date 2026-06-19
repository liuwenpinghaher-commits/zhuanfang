import type {
  InterviewEnginePolicy,
  InterviewSession,
  InterviewStrategyDecision,
  InterviewStrategyId,
  InterviewQualityReport,
  ProductState,
  QualityOperationsReport,
  QualityRemediationAction,
} from "./types";

import { cloneState, makeId, nowIso, withAuditEvent, withAiRunEvent, extractAnchor, noQualityEvidenceScore } from "./utils";

import { buildInterviewQualityReport, buildQualityOperationsReport } from "./quality-report";
import { collectAppliedPlaybookRules, collectAppliedPlaybookRuleTypes } from "./context-pack";

function average(values: number[]) {
  if (values.length === 0) {
    return 0;
  }
  return Math.round(values.reduce((sum, value) => sum + value, 0) / values.length);
}
export function buildInterviewEnginePolicy(state: ProductState): InterviewEnginePolicy {
  return {
    allowWebInInterview: state.systemConfig.search.allowWebInInterview,
    maxFollowUpDepth: state.systemConfig.interview.maxFollowUpDepth,
    silenceHoldMs: state.systemConfig.interview.silenceHoldMs,
    playbookVersion: state.systemConfig.interview.playbookVersion,
    appliedPlaybookRules: collectAppliedPlaybookRules(state),
    appliedPlaybookRuleTypes: collectAppliedPlaybookRuleTypes(state),
    qualityGuardrails: buildQualityGuardrails(state),
    memory: { ...state.systemConfig.memory },
    guidanceEnabled: state.systemConfig.interview.guidanceEnabled ?? true,
    guidanceFrequency: state.systemConfig.interview.guidanceFrequency ?? "medium",
    maxGuidancePerTurn: state.systemConfig.interview.maxGuidancePerTurn ?? 2,
    minGuidanceIntervalMs: state.systemConfig.interview.minGuidanceIntervalMs ?? 5000,
    challengeBudgetPerSession: state.systemConfig.interview.challengeBudgetPerSession ?? 3
  };
}
function buildPlaybookQualityComparisons(completedSessions: InterviewSession[]): QualityOperationsReport["playbookComparisons"] {
  const groups = new Map<string, InterviewSession[]>();

  for (const session of completedSessions) {
    const version = session.enginePolicy?.playbookVersion ?? "unknown";
    groups.set(version, [...(groups.get(version) ?? []), session]);
  }

  const rows = Array.from(groups.entries()).map(([playbookVersion, sessions]) => {
    const reports = sessions.map((session) => session.qualityReport ?? buildInterviewQualityReport(session));
    return {
      playbookVersion,
      sessionCount: sessions.length,
      averageQualityScore: average(reports.map((report) => report.score)),
      averageMemoryCitationRate: average(reports.map((report) => Math.round(report.historyReferenceRate * 100))),
      deltaFromBaseline: 0,
      recommendation: "watch" as const
    };
  });

  if (rows.length === 0) {
    return [];
  }

  const baseline =
    rows.find((row) => row.playbookVersion === "base-v1") ??
    rows.find((row) => !row.playbookVersion.includes("+patch-")) ??
    [...rows].sort((a, b) => a.averageQualityScore - b.averageQualityScore)[0];

  return rows
    .map((row) => {
      const deltaFromBaseline = row.averageQualityScore - baseline.averageQualityScore;
      return {
        ...row,
        deltaFromBaseline,
        recommendation: recommendPlaybookVersion(row.averageQualityScore, deltaFromBaseline)
      };
    })
    .sort((a, b) => b.averageQualityScore - a.averageQualityScore || a.playbookVersion.localeCompare(b.playbookVersion));
}
function buildQualityGate(
  id: InterviewQualityReport["gates"][number]["id"],
  label: string,
  passed: boolean,
  target: string,
  actual: string,
  detail: string
): InterviewQualityReport["gates"][number] {
  return { id, label, passed, target, actual, detail };
}
function buildQualityGuardrails(state: ProductState) {
  return buildQualityOperationsReport(state)
    .remediationActions.map((action) => action.nextInterviewInstruction)
    .slice(0, 4);
}
function buildQualityOperationsMetric(
  id: QualityOperationsReport["metrics"][number]["id"],
  label: string,
  score: number,
  target: string,
  detail: string
): QualityOperationsReport["metrics"][number] {
  const boundedScore = Math.max(0, Math.min(100, Math.round(score)));
  return {
    id,
    label,
    score: boundedScore,
    target,
    status: boundedScore >= 85 ? "pass" : boundedScore >= 70 ? "watch" : "risk",
    detail
  };
}
function buildQualityRemediationActions(
  state: ProductState,
  metrics: QualityOperationsReport["metrics"],
  playbookComparisons: QualityOperationsReport["playbookComparisons"]
): QualityRemediationAction[] {
  const metricById = new Map(metrics.map((metric) => [metric.id, metric]));
  const completedSessionCount = state.sessions.filter((session) => session.status === "completed").length;
  const assistantTurnCount = state.sessions.flatMap((session) => session.turns.filter((turn) => turn.role === "assistant")).length;
  const strategyTraceCount = state.sessions.flatMap((session) => session.strategyTrace ?? []).length;
  const pendingCandidateCount = state.memoryCandidates.filter((candidate) => candidate.status === "pending").length;
  const reviewedCandidateCount = state.memoryCandidates.filter((candidate) => candidate.status === "approved" || candidate.status === "rejected").length;
  const contextEvidenceCount = state.sessions.length + state.workflowRuns.filter((run) => run.workflow === "context_pack_build").length;
  const actions: QualityRemediationAction[] = [];

  if (state.memoryCorrections.length > 0) {
    const metric = metricById.get("sensitive_leakage");
    actions.push({
      id: "quality-remediation-sensitive-leakage",
      sourceMetricId: "sensitive_leakage",
      priority: "high",
      owner: "memory_review",
      title: "先处理记忆修正",
      action: `复核 ${state.memoryCorrections.length} 条记忆修正，必要时废弃或改写相关长期记忆。`,
      evidence: metric?.detail ?? "存在记忆修正记录。",
      nextInterviewInstruction: "先确认上一轮记忆修正，避免把被纠正的表述当作已确认事实；必要时用一句话向用户核对。"
    });
  }

  const interviewNaturalness = metricById.get("interview_naturalness");
  const failedRealtimeTurnGate = findFailedRealtimeTurnTakingGate(state);
  if (failedRealtimeTurnGate) {
    actions.push({
      id: "quality-remediation-realtime-turn-taking",
      sourceMetricId: "interview_naturalness",
      priority: "high",
      owner: "interview_director",
      title: "修复实时轮替",
      action: "下一场实时语音必须先修复留白、打断和追问响应节奏，避免用户未说完就进入追问。",
      evidence: failedRealtimeTurnGate.actual,
      nextInterviewInstruction: "实时轮替质量门未通过：先延长留白，用户打断时立刻停止输出；只有转写完成且超过静默阈值后再生成下一句追问。"
    });
  }

  if (completedSessionCount > 0 && interviewNaturalness && interviewNaturalness.status !== "pass") {
    actions.push({
      id: "quality-remediation-interview-naturalness",
      sourceMetricId: "interview_naturalness",
      priority: interviewNaturalness.status === "risk" ? "high" : "medium",
      owner: "interview_director",
      title: "补齐专访质量门",
      action: "下一场必须主动覆盖未通过质量门，优先补视角、历史引用、知识债和元认知收束。",
      evidence: interviewNaturalness.detail,
      nextInterviewInstruction: "上一轮质量门未达标：本轮每次追问都要落到具体事实、历史引用或机制假设，并在末段做一次元认知收束。"
    });
  }

  const followupRelevance = metricById.get("followup_relevance");
  if (strategyTraceCount > 0 && followupRelevance && followupRelevance.status !== "pass") {
    actions.push({
      id: "quality-remediation-followup-relevance",
      sourceMetricId: "followup_relevance",
      priority: followupRelevance.status === "risk" ? "high" : "medium",
      owner: "interview_director",
      title: "提高追问相关性",
      action: "减少泛泛复述，优先使用机制追问、盲区探测、知识债回访和综合收束。",
      evidence: followupRelevance.detail,
      nextInterviewInstruction: "本轮不要停留在情绪复述；每个关键回答后追一个机制、代价、盲区或验证标准。"
    });
  }

  const memoryCitation = metricById.get("memory_citation");
  if (assistantTurnCount > 0 && memoryCitation && memoryCitation.status !== "pass") {
    actions.push({
      id: "quality-remediation-memory-citation",
      sourceMetricId: "memory_citation",
      priority: memoryCitation.status === "risk" ? "high" : "medium",
      owner: "interview_director",
      title: "补强历史引用",
      action: "视角切换和关键追问必须引用已确认记忆、搜索来源或明确说明没有可用依据。",
      evidence: memoryCitation.detail,
      nextInterviewInstruction: "视角切换前先引用一条已确认历史或本次 ContextPack 依据，避免凭空总结用户。"
    });
  }

  const contextPackRelevance = metricById.get("context_pack_relevance");
  if (contextEvidenceCount > 0 && contextPackRelevance && contextPackRelevance.status !== "pass") {
    actions.push({
      id: "quality-remediation-context-pack",
      sourceMetricId: "context_pack_relevance",
      priority: contextPackRelevance.status === "risk" ? "high" : "medium",
      owner: "interview_director",
      title: "重建 ContextPack",
      action: "启动下一场前检查主题、已确认记忆、联网素材和图谱依据是否进入 ContextPack。",
      evidence: contextPackRelevance.detail,
      nextInterviewInstruction: "如果本轮 ContextPack 证据不足，先围绕主题补问事实来源，不要直接推进抽象结论。"
    });
  }

  const memoryCandidatePrecision = metricById.get("memory_candidate_precision");
  if ((pendingCandidateCount > 0 || reviewedCandidateCount > 0) && memoryCandidatePrecision && memoryCandidatePrecision.status !== "pass") {
    actions.push({
      id: "quality-remediation-memory-candidate-precision",
      sourceMetricId: "memory_candidate_precision",
      priority: memoryCandidatePrecision.status === "risk" ? "high" : "medium",
      owner: "memory_review",
      title: "清理候选记忆",
      action: `先处理 ${pendingCandidateCount} 条待审核候选，降低错误候选进入长期记忆的概率。`,
      evidence: memoryCandidatePrecision.detail,
      nextInterviewInstruction: "不要把待审核候选记忆当作确定事实；引用前必须标明待确认或改成核对问题。"
    });
  }

  const sourceFaithfulness = metricById.get("source_faithfulness");
  if (state.searchBriefs.length > 0 && sourceFaithfulness && sourceFaithfulness.status !== "pass") {
    actions.push({
      id: "quality-remediation-source-faithfulness",
      sourceMetricId: "source_faithfulness",
      priority: sourceFaithfulness.status === "risk" ? "high" : "medium",
      owner: "interview_director",
      title: "修复来源忠实度",
      action: "没有来源的联网简报不能直接进入专访知识引用，先补来源或降级为假设。",
      evidence: sourceFaithfulness.detail,
      nextInterviewInstruction: "引用外部信息时必须带来源；没有来源的内容只能作为待验证假设。"
    });
  }

  const rollbackComparison = playbookComparisons.find((comparison) => comparison.recommendation === "rollback");
  if (rollbackComparison) {
    actions.push({
      id: `quality-remediation-playbook-${rollbackComparison.playbookVersion}`,
      priority: "high",
      owner: "interview_director",
      title: "回滚低质 Playbook",
      action: `暂停 ${rollbackComparison.playbookVersion}，回到表现更稳定的 playbook 版本。`,
      evidence: `平均质量 ${rollbackComparison.averageQualityScore} 分，相对基线 ${rollbackComparison.deltaFromBaseline}。`,
      nextInterviewInstruction: `不要继续沿用 ${rollbackComparison.playbookVersion} 的低质访谈技法，先回到基线追问策略。`
    });
  }

  if (state.aiRunEvents.some((event) => event.status === "failed" || event.status === "degraded")) {
    const latest =
      state.aiRunEvents.find((event) => event.status === "failed") ??
      state.aiRunEvents.find((event) => event.status === "degraded");
    actions.push({
      id: "quality-remediation-provider-degraded",
      priority: "medium",
      owner: "provider_ops",
      title: "复核 Provider 降级",
      action: "检查模型、搜索、TTS 或 workflow provider 配置，确认降级路径不会污染用户体验。",
      evidence: latest?.degradedReason ?? latest?.outputSummary ?? "存在降级 AI 运行事件。",
      nextInterviewInstruction: "如果本轮 provider 降级，明确走短句追问和本地上下文，不要伪装成完整联网或语音能力。"
    });
  }

  if (state.auditEvents.some((event) => event.severity === "critical")) {
    const latest = state.auditEvents.find((event) => event.severity === "critical");
    actions.push({
      id: "quality-remediation-critical-audit",
      priority: "high",
      owner: "provider_ops",
      title: "处理 critical 审计事件",
      action: "暂停相关自动化沉淀，先处理 critical 审计事件后再恢复写入长期记忆。",
      evidence: latest?.detail ?? "存在 critical 审计事件。",
      nextInterviewInstruction: "本轮不要自动沉淀敏感或高风险结论；需要用户明确确认后再写入记忆。"
    });
  }

  return uniqueQualityRemediationActions(actions)
    .sort((left, right) => {
      const priorityDelta = qualityActionPriorityRank(right) - qualityActionPriorityRank(left);
      if (priorityDelta !== 0) {
        return priorityDelta;
      }
      return qualityActionSourceRank(right) - qualityActionSourceRank(left);
    })
    .slice(0, 8);
}
function buildQualityRisks(state: ProductState, metrics: QualityOperationsReport["metrics"]) {
  const risks = [
    ...metrics
      .filter((metric) => metric.status === "risk")
      .map((metric) => `${metric.label}低于目标：${metric.detail}`),
    ...(state.memoryCorrections.length > 0
      ? ["最近有记忆修正，需要确认后续专访不会继续引用错误表达。"]
      : []),
    ...(state.aiRunEvents.some((event) => event.status === "failed")
      ? ["存在失败 AI 运行事件，需要检查 provider 配置和用户提示。"]
      : []),
    ...(state.aiRunEvents.some((event) => event.status === "degraded")
      ? ["存在降级 AI 运行事件，需要检查 provider 配置和用户提示。"]
      : []),
    ...(state.auditEvents.some((event) => event.severity === "critical")
      ? ["存在 critical 审计事件，需要先处理再继续自动化沉淀。"]
      : [])
  ];
  return Array.from(new Set(risks)).slice(0, 6);
}
function buildRealtimeTurnTakingGate(session: InterviewSession): InterviewQualityReport["gates"][number] | undefined {
  const signals = session.realtimeSignals ?? [];
  if (signals.length === 0) {
    return undefined;
  }

  const holdCount = signals.filter((signal) => signal.eventType === "hold").length;
  const interruptionCount = signals.filter((signal) => signal.eventType === "interruption").length;
  const responseCount = signals.filter((signal) => signal.eventType === "assistant_response").length;
  const violations = signals.filter((signal) => {
    if (signal.eventType === "hold") {
      return signal.phase !== "holding" || signal.shouldInterrupt;
    }
    if (signal.eventType === "interruption") {
      return signal.phase !== "listening" || !signal.shouldInterrupt;
    }
    if (signal.eventType === "assistant_response") {
      return !signal.assistantTurnId || signal.shouldInterrupt;
    }
    return false;
  });

  return buildQualityGate(
    "realtime_turn_taking",
    "实时轮替",
    violations.length === 0,
    "实时语音留白、打断和追问响应必须有可回溯信号，且不能在用户未说完时抢话。",
    `留白 ${holdCount} 次，打断 ${interruptionCount} 次，语音追问 ${responseCount} 次，异常 ${violations.length} 次。`,
    "用实时信号验证短暂停顿留白、用户打断交还控制权、语音追问可追溯。"
  );
}
export function decideInterviewStrategy(session: InterviewSession, userText: string): InterviewStrategyDecision {
  const previousUserTurns = session.turns.filter((turn) => turn.role === "user").length;
  const trace = session.strategyTrace ?? [];
  const perspectiveShiftCount = trace.filter((item) => item.strategy === "perspective_shift").length;
  const nextPerspective = session.guide.recommendedPerspectives[perspectiveShiftCount];
  const referencedMemory = pickReferencedMemory(session, userText);
  const maxFollowUpDepth = Math.max(1, session.enginePolicy?.maxFollowUpDepth ?? 4);
  const base = {
    turnIndex: previousUserTurns + 1,
    referencedMemory
  };

  if (
    hasConcreteMomentPlaybookRule(session) &&
    previousUserTurns === 0 &&
    isAbstractInterviewClaim(userText) &&
    !hasStrategy(trace, "concrete_example_probe")
  ) {
    return {
      ...base,
      strategy: "concrete_example_probe",
      label: "索要具体时刻",
      reason: "已应用语料学习补丁：抽象评价先落到具体时刻。",
      depth: "surface"
    };
  }

  if (
    hasMechanismReversalPlaybookRule(session) &&
    previousUserTurns >= 1 &&
    trace.at(-1)?.strategy === "concrete_example_probe" &&
    hasConcreteInterviewMoment(userText) &&
    !hasStrategy(trace, "mechanism_reversal_probe")
  ) {
    return {
      ...base,
      strategy: "mechanism_reversal_probe",
      label: "机制反转",
      reason: "已应用语料学习补丁：具体例子之后从机制、奖励和代价角度反问。",
      depth: "mechanism"
    };
  }

  if (previousUserTurns >= 1 && hasReachedStageSummaryWindow(session) && trace.at(-1)?.strategy !== "synthesis") {
    return {
      ...base,
      strategy: "synthesis",
      label: "阶段总结",
      reason: "访谈已超过 10 分钟，先阶段总结，避免继续发散。",
      depth: "synthesis"
    };
  }

  if ((previousUserTurns === 1 || previousUserTurns === 2) && session.guide.debtToAddress && !hasStrategy(trace, "debt_followup")) {
    return {
      ...base,
      strategy: "debt_followup",
      label: "知识债追问",
      reason: `第 2-3 轮回访未完成知识债：${session.guide.debtToAddress}`,
      depth: "mechanism"
    };
  }

  if (previousUserTurns >= 7 && session.guide.blindspotCandidates.length > 0 && !hasStrategy(trace, "blindspot_probe")) {
    const candidate = session.guide.blindspotCandidates[0];
    return {
      ...base,
      strategy: "blindspot_probe",
      label: "盲区探测",
      reason: `对话进入中后段，引入盲区候选：${candidate.concept}`,
      depth: "meta",
      blindspotConcept: candidate.concept
    };
  }

  if (previousUserTurns >= 3 && nextPerspective) {
    return {
      ...base,
      strategy: "perspective_shift",
      label: "视角切换",
      reason: `按引导稿补充推荐视角：${nextPerspective}`,
      depth: perspectiveShiftCount === 0 ? "mechanism" : "meta",
      perspective: nextPerspective
    };
  }

  if (previousUserTurns >= maxFollowUpDepth && trace.at(-1)?.strategy !== "synthesis") {
    return {
      ...base,
      strategy: "synthesis",
      label: "阶段总结",
      reason: `已达到本会话配置的连续追问深度上限：${maxFollowUpDepth}`,
      depth: "synthesis"
    };
  }

  if (previousUserTurns === 1 && hasWorstCaseSignal(userText)) {
    return {
      ...base,
      strategy: "premise_challenge",
      label: "挑战前提",
      reason: "用户已经触及最坏情况或代价边界，检查其隐含前提是否成立。",
      depth: "mechanism"
    };
  }

  if (previousUserTurns >= Math.max(3, session.guide.recommendedPerspectives.length + 4)) {
    return {
      ...base,
      strategy: "synthesis",
      label: "阶段总结",
      reason: "已有多轮材料，先收束为可验证假设。",
      depth: "synthesis"
    };
  }

  return {
    ...base,
    strategy: "mechanism_probe",
    label: "追问机制",
    reason: "默认从用户表达中的锚点推进到机制层。",
    depth: previousUserTurns === 0 ? "surface" : "mechanism"
  };
}
function findFailedRealtimeTurnTakingGate(state: ProductState) {
  for (const session of state.sessions) {
    if (session.status !== "completed") {
      continue;
    }
    const report = session.qualityReport ?? buildInterviewQualityReport(session);
    const realtimeGate = report.gates.find((gate) => gate.id === "realtime_turn_taking");
    if (realtimeGate && !realtimeGate.passed) {
      return realtimeGate;
    }
  }
  return undefined;
}
function hasConcreteInterviewMoment(text: string) {
  const momentSignals = ["昨天", "今天", "上周", "会议", "当时", "他说", "她说", "负责人", "客户", "项目"];
  return momentSignals.some((signal) => text.includes(signal));
}
function hasAppliedRuleType(session: InterviewSession, ruleType: string) {
  return (session.enginePolicy?.appliedPlaybookRuleTypes ?? []).includes(ruleType);
}
function hasConcreteMomentPlaybookRule(session: InterviewSession) {
  // Prefer the explicit classification; fall back to legacy keyword matching for
  // patches created before ruleType existed.
  if (hasAppliedRuleType(session, "concrete-moment")) {
    return true;
  }
  return (session.enginePolicy?.appliedPlaybookRules ?? []).some((rule) => rule.includes("具体时刻"));
}
function hasMechanismReversalPlaybookRule(session: InterviewSession) {
  if (hasAppliedRuleType(session, "mechanism-reversal")) {
    return true;
  }
  return (session.enginePolicy?.appliedPlaybookRules ?? []).some(
    (rule) => rule.includes("机制") && rule.includes("奖励") && rule.includes("代价")
  );
}
function hasReachedStageSummaryWindow(session: InterviewSession) {
  const startedAtMs = new Date(session.startedAt).getTime();
  if (!Number.isFinite(startedAtMs)) {
    return false;
  }
  return Date.now() - startedAtMs >= 10 * 60 * 1000;
}
function hasStrategy(trace: InterviewStrategyDecision[], strategy: InterviewStrategyId) {
  return trace.some((item) => item.strategy === strategy);
}
// 通用信号：用户触及代价/风险/最坏情况，不依赖特定场景词
function hasWorstCaseSignal(text: string): boolean {
  return ["最坏", "代价", "失控", "延期", "崩", "出问题", "风险", "后果", "损失", "垮"].some((s) => text.includes(s));
}
function isAbstractInterviewClaim(text: string) {
  const abstractSignals = ["整体", "总是", "一直", "就是", "都", "不主动", "很难", "不愿意", "承担", "判断", "增长", "团队"];
  const concreteSignals = ["昨天", "今天", "上周", "会议", "那次", "当时", "他说", "她说", "客户", "项目", "具体"];
  const hasAbstractSignal = abstractSignals.some((signal) => text.includes(signal));
  const hasConcreteSignal = concreteSignals.some((signal) => text.includes(signal));
  return hasAbstractSignal && !hasConcreteSignal;
}
function numericMetadata(metadata: Record<string, string | number | boolean>, key: string) {
  const value = metadata[key];
  return typeof value === "number" ? value : 0;
}
function pickReferencedMemory(session: InterviewSession, userText: string) {
  const anchor = extractAnchor(userText);
  return (
    session.guide.relevantMemories.find((memory) => memory.includes(anchor)) ??
    session.card.historyReferences.find((memory) => memory.includes(anchor)) ??
    session.guide.relevantMemories[0] ??
    session.card.historyReferences[0]
  );
}
function qualityActionPriorityRank(action: QualityRemediationAction) {
  return action.priority === "high" ? 3 : action.priority === "medium" ? 2 : 1;
}
function qualityActionSourceRank(action: QualityRemediationAction) {
  const rank: Partial<Record<QualityOperationsReport["metrics"][number]["id"], number>> = {
    sensitive_leakage: 70,
    interview_naturalness: 60,
    memory_citation: 50,
    followup_relevance: 40,
    context_pack_relevance: 30,
    memory_candidate_precision: 20,
    source_faithfulness: 10
  };
  return action.sourceMetricId ? rank[action.sourceMetricId] ?? 0 : 0;
}
function recommendPlaybookVersion(
  averageQualityScore: number,
  deltaFromBaseline: number
): QualityOperationsReport["playbookComparisons"][number]["recommendation"] {
  if (deltaFromBaseline >= 10 && averageQualityScore >= 80) {
    return "promote";
  }
  if (deltaFromBaseline <= -10 || averageQualityScore < 60) {
    return "rollback";
  }
  return "watch";
}
function scoreContextPackRelevance(state: ProductState) {
  const sessionsWithContext = state.sessions.filter((session) => {
    const hasTopic = Boolean(session.guide.topicHint || session.card.title);
    const hasMemory = session.card.historyReferences.length > 0 || session.guide.relevantMemories.length > 0;
    const hasExternalSource = (session.card.sourceHighlights ?? []).length > 0;
    const hasGraphReference = session.guide.graphReferences.length > 0;
    return hasTopic && (hasMemory || hasExternalSource || hasGraphReference);
  });
  const contextPackRuns = state.workflowRuns.filter((run) => run.workflow === "context_pack_build");
  const relevantContextPackRuns = contextPackRuns.filter((run) => {
    const metadata = run.metadata ?? {};
    const memoryCount = numericMetadata(metadata, "confirmedMemoryCount") + numericMetadata(metadata, "memoryRecordCount");
    const sourceCount = numericMetadata(metadata, "sourceHighlightCount") + numericMetadata(metadata, "ragChunkCount");
    const graphCount = numericMetadata(metadata, "graphReferenceCount");
    return typeof metadata.topicHint === "string" && metadata.topicHint.trim().length > 0 && memoryCount + sourceCount + graphCount > 0;
  });
  const evidenceTotal = state.sessions.length + contextPackRuns.length;
  const relevantTotal = sessionsWithContext.length + relevantContextPackRuns.length;

  if (evidenceTotal === 0) {
    return {
      score: noQualityEvidenceScore,
      detail: "还没有会话或 ContextPack workflow 可评估。"
    };
  }

  return {
    score: Math.round((relevantTotal / evidenceTotal) * 100),
    detail: `${sessionsWithContext.length}/${state.sessions.length} 个会话具备上下文依据，${relevantContextPackRuns.length}/${contextPackRuns.length} 个 ContextPack workflow 带有主题相关证据。`
  };
}
function scoreMemoryCandidatePrecision(state: ProductState) {
  const approvedCount = state.memoryCandidates.filter((candidate) => candidate.status === "approved").length;
  const rejectedCount = state.memoryCandidates.filter((candidate) => candidate.status === "rejected").length;
  const pendingCount = state.memoryCandidates.filter((candidate) => candidate.status === "pending").length;
  const reviewedCount = approvedCount + rejectedCount;

  if (reviewedCount === 0) {
    return {
      score: pendingCount > 0 ? 50 : 100,
      detail:
        pendingCount > 0
          ? `还没有已审核候选，${pendingCount} 个仍待审核。`
          : "还没有候选记忆进入审核，暂未触发精度风险。"
    };
  }

  return {
    score: Math.round((approvedCount / reviewedCount) * 100),
    detail: `${approvedCount}/${reviewedCount} 个已审核候选被确认，${pendingCount} 个仍待审核。`
  };
}
function uniqueQualityRemediationActions(actions: QualityRemediationAction[]) {
  const seen = new Set<string>();
  return actions.filter((action) => {
    if (seen.has(action.id)) {
      return false;
    }
    seen.add(action.id);
    return true;
  });
}
