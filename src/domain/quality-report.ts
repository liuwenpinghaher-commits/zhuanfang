// quality-report.ts — buildInterviewQualityReport + buildQualityOperationsReport
// and their private helpers.
//
// Extracted from engine.ts (Section E & F) to break the engine <-> strategy
// circular import: strategy.ts calls buildQualityOperationsReport (which used
// to live in engine.ts), while engine.ts re-exports from strategy.ts.
//
// engine.ts continues to re-export both public functions so all existing
// `import { ... } from "./engine"` call-sites remain unaffected.

import type {
  InterviewQualityReport,
  InterviewSession,
  ProductState,
  QualityOperationsReport,
  QualityRemediationAction,
} from "./types";

// ============================================================================
// Section E: Interview-quality report
// ============================================================================

export function buildInterviewQualityReport(session: InterviewSession): InterviewQualityReport {
  const trace = session.strategyTrace ?? [];
  const perspectivesUsed = Array.from(
    new Set(trace.map((item) => item.perspective).filter((item): item is string => Boolean(item))),
  );
  const depthsReached = Array.from(new Set(trace.map((item) => item.depth)));
  const perspectiveDecisions = trace.filter((item) => item.strategy === "perspective_shift");
  const perspectiveWithHistory = perspectiveDecisions.filter((item) => Boolean(item.referencedMemory)).length;
  const historyReferenceRate = perspectiveDecisions.length === 0 ? 0 : perspectiveWithHistory / perspectiveDecisions.length;
  const transcript = session.turns.map((turn) => turn.content).join("\n");
  const forbiddenTerms = ["作为AI", "作为 AI", "我不能提供", "免责声明"].filter((term) => transcript.includes(term));
  const baseGates = [
    buildQualityGate(
      "perspective_coverage",
      "视角覆盖",
      perspectivesUsed.length >= 2,
      "至少 2 个推荐视角进入追问",
      `${perspectivesUsed.length} 个：${perspectivesUsed.join(" / ") || "无"}`,
      "避免专访只在单一解释框架里循环。",
    ),
    buildQualityGate(
      "debt_followup",
      "知识债回访",
      trace.some((item) => item.strategy === "debt_followup"),
      "至少回访 1 个未完成知识债",
      trace.some((item) => item.strategy === "debt_followup") ? "已回访" : "未回访",
      "保证会话不是孤立聊天，而是延续长期学习线索。",
    ),
    buildQualityGate(
      "blindspot_probe",
      "盲区探测",
      trace.some((item) => item.strategy === "blindspot_probe"),
      "至少引入 1 个盲区候选",
      trace.find((item) => item.strategy === "blindspot_probe")?.blindspotConcept ?? "未触达",
      "让访谈能挑战用户尚未主动提到的解释维度。",
    ),
    buildQualityGate(
      "history_reference_rate",
      "历史引用率",
      historyReferenceRate >= 1,
      "视角提问 100% 引用历史",
      `${Math.round(historyReferenceRate * 100)}%`,
      "每次视角切换都必须落回用户自己的历史材料。",
    ),
    buildQualityGate(
      "meta_depth",
      "元认知深度",
      depthsReached.includes("meta") || depthsReached.includes("synthesis"),
      "至少触达 1 次元认知或综合层",
      depthsReached.join(" / ") || "无",
      "真正的专访需要从事实推进到机制和自我观察。",
    ),
    buildQualityGate(
      "forbidden_terms",
      "禁用客服化表达",
      forbiddenTerms.length === 0,
      "禁用词 0 次",
      forbiddenTerms.length === 0 ? "0 次" : forbiddenTerms.join(" / "),
      "避免输出像客服、免责声明或模型自述。",
    ),
  ] satisfies InterviewQualityReport["gates"];
  const realtimeGate = buildRealtimeTurnTakingGate(session);
  const gates = realtimeGate ? [...baseGates, realtimeGate] : baseGates;

  return {
    score: Math.round((gates.filter((gate) => gate.passed).length / gates.length) * 100),
    gates,
    perspectivesUsed,
    depthsReached,
    forbiddenTerms,
    historyReferenceRate,
    generatedAt: new Date().toISOString(),
  };
}

function buildRealtimeTurnTakingGate(
  session: InterviewSession,
): InterviewQualityReport["gates"][number] | undefined {
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
    "用实时信号验证短暂停顿留白、用户打断交还控制权、语音追问可追溯。",
  );
}

// ============================================================================
// Section F: Quality-operations report
// ============================================================================

export function buildQualityOperationsReport(state: ProductState): QualityOperationsReport {
  const completedSessions = state.sessions.filter((session) => session.status === "completed");
  const qualityScores = completedSessions.map(
    (session) => session.qualityReport?.score ?? buildInterviewQualityReport(session).score,
  );
  const assistantTurns = state.sessions.flatMap((session) => session.turns.filter((turn) => turn.role === "assistant"));
  const referencedAssistantTurns = assistantTurns.filter((turn) => Boolean(turn.referencedMemory));
  const strategyTraces = completedSessions.flatMap((session) => session.strategyTrace ?? []);
  const meaningfulFollowups = strategyTraces.filter((item) =>
    [
      "debt_followup",
      "perspective_shift",
      "blindspot_probe",
      "mechanism_reversal_probe",
      "premise_challenge",
      "synthesis",
    ].includes(item.strategy),
  );
  const forbiddenTerms = completedSessions.flatMap((session) => session.qualityReport?.forbiddenTerms ?? []);
  const searchBriefsWithSources = state.searchBriefs.filter((brief) => brief.sources.length > 0);
  const contextPackEvidence = scoreContextPackRelevance(state);
  const memoryCandidatePrecisionScore = scoreMemoryCandidatePrecision(state);
  const playbookComparisons = buildPlaybookQualityComparisons(completedSessions);
  const metrics = [
    buildQualityOperationsMetric(
      "interview_naturalness",
      "专访自然度",
      qualityScores.length > 0 ? average(qualityScores) : 70,
      "完成会话平均质量分 >= 80",
      qualityScores.length > 0
        ? `${qualityScores.length} 个完成会话，平均 ${average(qualityScores)} 分。`
        : "还没有完成会话质量分。",
    ),
    buildQualityOperationsMetric(
      "followup_relevance",
      "追问相关性",
      strategyTraces.length > 0
        ? Math.round((meaningfulFollowups.length / strategyTraces.length) * 100)
        : 70,
      "至少 70% 追问进入机制、视角、盲区或总结层",
      strategyTraces.length > 0
        ? `${meaningfulFollowups.length}/${strategyTraces.length} 个策略动作进入深层追问。`
        : "还没有策略轨迹可评估。",
    ),
    buildQualityOperationsMetric(
      "memory_citation",
      "记忆引用",
      assistantTurns.length > 0
        ? Math.round((referencedAssistantTurns.length / assistantTurns.length) * 100)
        : 70,
      "助手追问引用历史或上下文 >= 80%",
      assistantTurns.length > 0
        ? `${referencedAssistantTurns.length}/${assistantTurns.length} 个助手回合带有引用。`
        : "还没有助手回合可评估。",
    ),
    buildQualityOperationsMetric(
      "context_pack_relevance",
      "ContextPack 相关性",
      contextPackEvidence.score,
      "会话或 ContextPack workflow 必须带入主题相关记忆、来源或图谱依据",
      contextPackEvidence.detail,
    ),
    buildQualityOperationsMetric(
      "memory_candidate_precision",
      "候选记忆精度",
      memoryCandidatePrecisionScore.score,
      "已审核候选中用户确认率 >= 80%，pending 候选需要及时处理",
      memoryCandidatePrecisionScore.detail,
    ),
    buildQualityOperationsMetric(
      "sensitive_leakage",
      "敏感泄漏",
      forbiddenTerms.length > 0 ? 0 : state.memoryCorrections.length > 0 ? 80 : 100,
      "禁用客服化表达 0 次，记忆修正后需复核",
      forbiddenTerms.length > 0
        ? `发现禁用表达：${Array.from(new Set(forbiddenTerms)).join(" / ")}。`
        : state.memoryCorrections.length > 0
          ? `${state.memoryCorrections.length} 条记忆修正待后续专访验证。`
          : "未发现禁用表达或记忆污染信号。",
    ),
    buildQualityOperationsMetric(
      "source_faithfulness",
      "来源忠实度",
      state.searchBriefs.length > 0
        ? Math.round((searchBriefsWithSources.length / state.searchBriefs.length) * 100)
        : 100,
      "进入系统的联网素材必须保留来源",
      state.searchBriefs.length > 0
        ? `${searchBriefsWithSources.length}/${state.searchBriefs.length} 份搜索简报保留来源。`
        : "还没有联网素材，暂未触发来源风险。",
    ),
  ] satisfies QualityOperationsReport["metrics"];
  const risks = buildQualityRisks(state, metrics);
  const remediationActions = buildAllRemediationActions(state, metrics, playbookComparisons);

  return {
    generatedAt: new Date().toISOString(),
    overallScore: Math.round(average(metrics.map((metric) => metric.score))),
    metrics,
    playbookComparisons,
    recentAuditEvents: (state.auditEvents ?? []).slice(0, 6),
    recentAiRunEvents: (state.aiRunEvents ?? []).slice(0, 6),
    risks,
    remediationActions,
  };
}

// ============================================================================
// Private helpers
// ============================================================================

function buildQualityOperationsMetric(
  id: QualityOperationsReport["metrics"][number]["id"],
  label: string,
  score: number,
  target: string,
  detail: string,
): QualityOperationsReport["metrics"][number] {
  return { id, label, score, target, detail, status: score >= 80 ? "pass" as const : score >= 60 ? "watch" as const : "risk" as const };
}

function buildQualityRisks(
  state: ProductState,
  metrics: QualityOperationsReport["metrics"],
): string[] {
  const risks: string[] = [];
  for (const metric of metrics) {
    if (metric.score < 60) {
      risks.push(`${metric.label} 风险 — ${metric.detail}。建议：提升 "${metric.label}" 是当前优先级最高的质量优化方向。`);
    } else if (metric.score < 80) {
      risks.push(`${metric.label} 待提升 — ${metric.detail}。建议：关注 "${metric.label}" 的持续改善路径。`);
    }
  }

  const buildFailureState = findFailedRealtimeTurnTakingGate(state);
  if (buildFailureState) {
    risks.push(`构建流程异常 — ${buildFailureState}。建议：检查最近一次 ContextPack 构建流程的异常原因。`);
  }

  return risks;
}

function buildQualityGuardrails(state: ProductState) {
  const guards: string[] = [];
  if (state.systemConfig.memory.includeSensitiveMemoriesInContext) {
    guards.push("敏感长期记忆已允许进入模型上下文，每次追问前检查引用透明度。");
  }
  if (state.systemConfig.memory.includePendingCandidatesInContext) {
    guards.push("待审核记忆候选已允许进入模型上下文，确保引用时注明候选状态。");
  }
  if (state.memoryCandidates.some((candidate) => candidate.status === "pending" && candidate.sensitivity === "sensitive")) {
    guards.push("存在敏感待审候选，不将其带入模型上下文。");
  }
  return guards;
}

// Re-exported so strategy.ts can call it without going through engine barrel.
export { buildQualityGuardrails };

function buildRemediationAction(
  state: ProductState,
  metricId: QualityOperationsReport["metrics"][number]["id"],
  source: string,
  priority: "high" | "medium" | "low",
  label: string,
  description: string,
): QualityRemediationAction {
  return {
    id: `remediate-${metricId}-${state.systemConfig.version}`,
    sourceMetricId: metricId,
    priority,
    owner: "interview_director" as const,
    title: label,
    action: description,
    evidence: "",
    nextInterviewInstruction: "",
  };
}

function buildAllRemediationActions(
  state: ProductState,
  metrics: QualityOperationsReport["metrics"],
  playbookComparisons: QualityOperationsReport["playbookComparisons"],
): QualityRemediationAction[] {
  const allActions: QualityRemediationAction[] = [];

  for (const metric of metrics) {
    if (metric.score >= 80) continue;

    if (metric.id === "interview_naturalness" && metric.score < 70) {
      allActions.push(buildRemediationAction(state, "interview_naturalness", "quality-remediation", "high", "降低追问密度，增加留白", "自然度偏低，先检查本轮策略轨迹中是否追问过于频繁或没有给用户留卡顿空间。"));
    }
    if (metric.id === "memory_citation") {
      allActions.push(buildRemediationAction(state, "memory_citation", "quality-remediation", metric.score < 60 ? "high" : "medium", "增强历史引用", "记忆引用率偏低，确保 ContextPack 构建时带上历史相关记忆和知识债。"));
    }
    if (metric.id === "context_pack_relevance" && metric.score < 70) {
      allActions.push(buildRemediationAction(state, "context_pack_relevance", "quality-remediation", "high", "补充 ContextPack 相关性", "ContextPack 主题相关记忆或来源不足，检查 topicHint 和 searchBrief 是否完整传入。"));
    }
    if (metric.id === "memory_candidate_precision" && metric.score < 70) {
      allActions.push(buildRemediationAction(state, "memory_candidate_precision", "quality-remediation", "medium", "提高候选记忆精度", "候选记忆精度偏低，检查候选记忆是否过多、重复或敏感。"));
    }
  }

  if (metrics.find((m) => m.id === "sensitive_leakage")?.score === 0) {
    allActions.push(buildRemediationAction(state, "sensitive_leakage", "quality-remediation", "high", "立即检查禁用客服化表达", '系统检测到 AI 问答中出现了"作为AI"或"免责声明"等禁用表达，这会破坏用户对被访角色的信任。'));
  }

  const promoteAction = playbookComparisons.find((row) => row.recommendation === "promote");
  if (promoteAction) {
    allActions.push(buildRemediationAction(state, "followup_relevance", "playbook-optimizer", "low", `考虑提升 Playbook 版本 ${promoteAction.playbookVersion}`, `该版本平均质量分 ${promoteAction.averageQualityScore}，比当前版本高 ${promoteAction.deltaFromBaseline} 分。`));
  }

  const rollbackAction = playbookComparisons.find((row) => row.recommendation === "rollback");
  if (rollbackAction) {
    allActions.push(buildRemediationAction(state, "interview_naturalness", "playbook-optimizer", "high", `考虑回滚 Playbook 版本 ${rollbackAction.playbookVersion}`, `该版本平均质量分 ${rollbackAction.averageQualityScore}，比当前版本低 ${Math.abs(rollbackAction.deltaFromBaseline)} 分。`));
  }

  return uniqueQualityRemediationActions(allActions);
}

function uniqueQualityRemediationActions(actions: QualityRemediationAction[]) {
  return [...new Map(actions.map((action) => [action.id, action])).values()].sort(
    (a, b) => priorityRank(a.priority) - priorityRank(b.priority),
  );
}

function priorityRank(priority: QualityRemediationAction["priority"]) {
  return priority === "high" ? 0 : priority === "medium" ? 1 : 2;
}

function findFailedRealtimeTurnTakingGate(state: ProductState) {
  const recentBuilds = state.workflowRuns.filter(
    (run) => run.workflow === "context_pack_build" || run.workflow === "memory_projection",
  );
  const failedBuild = recentBuilds.find((build) => build.status === "failed");
  if (failedBuild) {
    return `最近一次 ${failedBuild.workflow} workflow 失败：${failedBuild.outputSummary}`;
  }
  return undefined;
}

function average(values: number[]) {
  if (values.length === 0) {
    return 0;
  }
  return Math.round(values.reduce((sum, value) => sum + value, 0) / values.length);
}

function buildQualityGate(
  id: InterviewQualityReport["gates"][number]["id"],
  label: string,
  passed: boolean,
  target: string,
  detail: string,
  remediation: string,
): InterviewQualityReport["gates"][number] {
  return { id, label, passed, target, actual: passed ? "达标" : "未达标", detail: `${detail} ${remediation}` };
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
    const memoryCount =
      numericMetadata(metadata, "confirmedMemoryCount") + numericMetadata(metadata, "memoryRecordCount");
    const sourceCount =
      numericMetadata(metadata, "sourceHighlightCount") + numericMetadata(metadata, "ragChunkCount");
    const graphCount = numericMetadata(metadata, "graphReferenceCount");
    return (
      typeof metadata.topicHint === "string" &&
      metadata.topicHint.trim().length > 0 &&
      memoryCount + sourceCount + graphCount > 0
    );
  });
  const evidenceTotal = state.sessions.length + contextPackRuns.length;
  const relevantTotal = sessionsWithContext.length + relevantContextPackRuns.length;

  if (evidenceTotal === 0) {
    return { score: 70, detail: "还没有会话或 ContextPack workflow 可评估。" };
  }

  return {
    score: Math.round((relevantTotal / evidenceTotal) * 100),
    detail: `${sessionsWithContext.length}/${state.sessions.length} 个会话具备上下文依据，${relevantContextPackRuns.length}/${contextPackRuns.length} 个 ContextPack workflow 带有主题相关证据。`,
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
      detail: pendingCount > 0 ? `还没有已审核候选，${pendingCount} 个仍待审核。` : "还没有候选记忆进入审核，暂未触发精度风险。",
    };
  }

  return {
    score: Math.round((approvedCount / reviewedCount) * 100),
    detail: `${approvedCount}/${reviewedCount} 个已审核候选被确认，${pendingCount} 个仍待审核。`,
  };
}

function numericMetadata(metadata: Record<string, string | number | boolean>, key: string) {
  const value = metadata[key];
  return typeof value === "number" ? value : 0;
}

function buildPlaybookQualityComparisons(
  completedSessions: InterviewSession[],
): QualityOperationsReport["playbookComparisons"] {
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
      recommendation: "watch" as const,
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
        recommendation: recommendPlaybookVersion(row.averageQualityScore, deltaFromBaseline),
      };
    })
    .sort(
      (a, b) => b.averageQualityScore - a.averageQualityScore || a.playbookVersion.localeCompare(b.playbookVersion),
    );
}

function recommendPlaybookVersion(
  averageQualityScore: number,
  deltaFromBaseline: number,
): QualityOperationsReport["playbookComparisons"][number]["recommendation"] {
  if (deltaFromBaseline >= 10 && averageQualityScore >= 80) {
    return "promote";
  }
  if (deltaFromBaseline <= -10 || averageQualityScore < 60) {
    return "rollback";
  }
  return "watch";
}
