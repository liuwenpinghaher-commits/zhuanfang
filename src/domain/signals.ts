import type {
  InterviewSession,
  InterviewTransparencyItem,
  InterviewTurn,
  RealtimeSessionSignal,
  RealtimeSignal,
  RealtimeTurnState,
  ProductState,
} from "./types";

import { cloneState, makeId, nowIso, withAuditEvent, withAiRunEvent } from "./utils";

export function appendRealtimeSignalTrace(
  session: InterviewSession,
  signal: RealtimeSignal,
  realtimeState: RealtimeTurnState,
  options: {
    transcript?: string;
    assistantTurn?: InterviewTurn | null;
    createdAt?: string;
  } = {}
): InterviewSession {
  const transcript = options.transcript?.trim();
  const assistantTurn = options.assistantTurn ?? null;
  const trace: RealtimeSessionSignal = {
    id: makeId("realtime-signal"),
    eventType: deriveRealtimeSignalEventType(realtimeState, assistantTurn),
    phase: realtimeState.phase,
    ...(transcript ? { transcript } : {}),
    inputLevel: Math.max(0, Math.min(1, signal.inputLevel)),
    silenceMs: Math.max(0, Math.round(signal.silenceMs)),
    shouldInterrupt: realtimeState.shouldInterrupt,
    ...(realtimeState.backchannel ? { backchannel: realtimeState.backchannel } : {}),
    nextAction: realtimeState.nextAction,
    ...(assistantTurn ? { assistantTurnId: assistantTurn.id, assistantIntent: assistantTurn.intent } : {}),
    createdAt: options.createdAt ?? nowIso()
  };

  return {
    ...session,
    realtimeSignals: [...(session.realtimeSignals ?? []), trace].slice(-24)
  };
}
export function buildRealtimeTurnState(session: InterviewSession, signal: RealtimeSignal): RealtimeTurnState {
  const silenceHoldMs = Math.max(300, session.enginePolicy?.silenceHoldMs ?? 1200);
  if (signal.isAssistantSpeaking && (signal.isUserSpeaking || signal.inputLevel > 0.2)) {
    return {
      phase: "listening",
      nextAction: "用户开口打断，停止输出，把控制权还给用户。",
      shouldInterrupt: true,
      confidence: Math.min(1, signal.inputLevel + 0.35)
    };
  }

  if (signal.isUserSpeaking || signal.inputLevel > 0.2) {
    return {
      phase: "listening",
      nextAction: "持续听用户说完，不抢话。",
      shouldInterrupt: false,
      confidence: Math.min(1, signal.inputLevel + 0.2)
    };
  }

  if (signal.silenceMs < silenceHoldMs) {
    const shouldBackchannel = signal.silenceMs >= Math.min(700, Math.round(silenceHoldMs * 0.6));
    return {
      phase: "holding",
      nextAction: `保持留白，等待用户自然补完。当前阈值 ${silenceHoldMs}ms。`,
      backchannel: shouldBackchannel ? "嗯，我在听。" : undefined,
      shouldInterrupt: false,
      confidence: 0.72
    };
  }

  if (session.turns.length === 0) {
    return {
      phase: "speaking",
      nextAction: session.card.suggestedOpening,
      shouldInterrupt: false,
      confidence: 0.82
    };
  }

  return {
    phase: "thinking",
    nextAction: "先镜像用户刚才的锚点，再提出一个追问。",
    shouldInterrupt: false,
    confidence: 0.8
  };
}
function buildSessionPlaybookReferences(state: ProductState, session: InterviewSession): InterviewTransparencyItem["playbookReferences"] {
  const appliedRules = session.enginePolicy?.appliedPlaybookRules ?? [];
  if (appliedRules.length === 0) {
    return [];
  }

  const appliedRuleSet = new Set(appliedRules);
  const playbookVersion = session.enginePolicy?.playbookVersion ?? "";
  const versionMatchedPatches = state.playbookPatches.filter((patch) =>
    playbookVersion.includes(`patch-${patch.id.slice(-4)}`)
  );
  const ruleMatchedPatches = state.playbookPatches.filter((patch) =>
    patch.rules.some((rule) => appliedRuleSet.has(rule))
  );
  const patches = versionMatchedPatches.length > 0 ? versionMatchedPatches : ruleMatchedPatches;

  return patches
    .map((patch) => {
      const insight = state.corpusInsights.find((item) => item.id === patch.sourceInsightId);
      const corpusImport = insight ? state.corpusImports.find((item) => item.id === insight.importId) : undefined;
      const rules = patch.rules.filter((rule) => appliedRuleSet.has(rule));
      const sourceImportId = insight?.importId ?? patch.sourceImportId;
      const sourceTitle = corpusImport?.title ?? patch.sourceTitle;
      const sourceUrl = corpusImport?.sourceUrl ?? patch.sourceUrl;

      return {
        patchId: patch.id,
        title: patch.title,
        status: patch.status,
        impact: patch.impact,
        sourceInsightId: patch.sourceInsightId,
        ...(sourceImportId ? { sourceImportId } : {}),
        ...(sourceTitle ? { sourceTitle } : {}),
        ...(sourceUrl ? { sourceUrl } : {}),
        rules: (rules.length > 0 ? rules : patch.rules).slice(0, 4)
      };
    })
    .filter((reference) => reference.rules.length > 0);
}
function deriveRealtimeSignalEventType(
  realtimeState: RealtimeTurnState,
  assistantTurn: InterviewTurn | null
): RealtimeSessionSignal["eventType"] {
  if (assistantTurn) {
    return "assistant_response";
  }
  if (realtimeState.shouldInterrupt) {
    return "interruption";
  }
  if (realtimeState.phase === "holding") {
    return "hold";
  }
  return "listening";
}
function formatRealtimeSignalTrace(signal: RealtimeSessionSignal) {
  const labels: Record<RealtimeSessionSignal["eventType"], string> = {
    listening: "持续聆听",
    hold: "留白",
    interruption: "打断",
    assistant_response: "语音追问",
    user_started_speaking: "用户开口",
    user_stopped_speaking: "用户停顿",
    user_input_transcribed: "用户转写",
    agent_state_changed: "Agent 状态切换",
    agent_speech_committed: "语音追问完成",
    agent_speech_interrupted: "语音追问被截断",
    metrics_collected: "指标采集",
    guidance_triggered: "引导触发",
    guidance_delivered: "引导送达"
  };
  const transcript = signal.transcript ? `｜${signal.transcript}` : "";
  const assistantIntent = signal.assistantIntent ? `｜${signal.assistantIntent}` : "";
  const backchannel = signal.backchannel ? `｜${signal.backchannel}` : "";
  return `${labels[signal.eventType]} · ${signal.phase} · ${signal.silenceMs}ms${backchannel}${assistantIntent}${transcript}`;
}
function isAgendaHistoryReference(reference: string) {
  return reference.startsWith("主动搜集依据（");
}
function summarizeControlFeedback(content: string) {
  if (content.includes("换个角度")) {
    return "控制反馈：不同角度";
  }
  if (content.includes("放慢")) {
    return "控制反馈：放慢一点";
  }
  if (content.includes("更直接")) {
    return "控制反馈：更直接";
  }
  if (content.includes("跳过")) {
    return "控制反馈：跳过";
  }
  if (content.includes("阶段总结")) {
    return "控制反馈：阶段总结";
  }
  if (content.includes("不保存")) {
    return "控制反馈：本次不保存";
  }
  return "控制反馈：已调整";
}
export function uniqueStrings(values: string[]) {
  return Array.from(new Set(values.filter((value) => value.trim().length > 0)));
}

export interface TruncateAssistantTurnInput {
  turnId?: string;
  providerTurnId?: string;
  spokenTextSoFar: string;
  reason?: "user_interrupt" | "provider_error";
  truncatedAt?: string;
}

export interface TruncateAssistantTurnResult {
  session: InterviewSession;
  truncatedTurn: InterviewTurn | null;
  changed: boolean;
}

export function truncateAssistantTurn(
  session: InterviewSession,
  input: TruncateAssistantTurnInput
): TruncateAssistantTurnResult {
  const turns = session.turns ?? [];
  const reason = input.reason ?? "user_interrupt";
  const truncatedAt = input.truncatedAt ?? nowIso();

  const targetIndex = (() => {
    if (input.turnId) {
      const byId = turns.findIndex((turn) => turn.id === input.turnId && turn.role === "assistant");
      if (byId >= 0) return byId;
    }
    if (input.providerTurnId) {
      const byProvider = turns.findIndex(
        (turn) => turn.role === "assistant" && turn.providerTurnId === input.providerTurnId
      );
      if (byProvider >= 0) return byProvider;
    }
    for (let index = turns.length - 1; index >= 0; index -= 1) {
      const turn = turns[index];
      if (turn.role === "assistant" && !turn.truncated) {
        return index;
      }
    }
    return -1;
  })();

  if (targetIndex < 0) {
    return { session, truncatedTurn: null, changed: false };
  }

  const target = turns[targetIndex];
  const originalChars = target.content.length;
  const spoken = input.spokenTextSoFar ?? "";
  const spokenChars = Math.min(spoken.length, originalChars);

  if (spokenChars === originalChars && !target.truncated) {
    return { session, truncatedTurn: target, changed: false };
  }

  const nextContent = spokenChars > 0 ? spoken.slice(0, spokenChars) : "";
  const nextTurn: InterviewTurn = {
    ...target,
    content: nextContent,
    truncated: {
      spokenChars,
      originalChars,
      reason,
      truncatedAt
    }
  };
  const nextTurns = [...turns];
  nextTurns[targetIndex] = nextTurn;
  return {
    session: { ...session, turns: nextTurns },
    truncatedTurn: nextTurn,
    changed: true
  };
}

// ============================================================================
// Interruption context helpers — used by Bailian WebSocket client to frame
// interrupt prompts sent to the realtime omni model.
// ============================================================================

export type InterruptionScene = "key_insight" | "anchor_probe" | "perspective_shift" | "transition" | "backchannel";

export function getInterruptionScene(strategy?: string): InterruptionScene {
  switch (strategy) {
    case "blindspot_probe":
    case "mechanism_reversal_probe":
      return "key_insight";
    case "concrete_example_probe":
    case "debt_followup":
      return "anchor_probe";
    case "perspective_shift":
    case "synthesis":
      return "perspective_shift";
    case "mirror":
      return "transition";
    default:
      return "perspective_shift";
  }
}

export function buildInterruptionContext(params: {
  spokenSoFar: string;
  unspokenContent: string;
  strategy?: string;
  userInput: string;
}): string {
  const scene = getInterruptionScene(params.strategy);
  const spoken = params.spokenSoFar.trim();
  const unspoken = params.unspokenContent.trim();
  const user = params.userInput.trim();

  switch (scene) {
    case "key_insight":
      return "";
    case "anchor_probe":
      return [
        "【打断恢复 — 追问锚点】",
        `你刚才追问的核心问题是："${spoken}"`,
        unspoken ? `还没问完的部分："${unspoken}"` : "",
        `用户说："${user}"`,
        "请结合用户的新内容调整你的追问方式，但保持原问题的核心方向。先简短回应用户，再重新追问。"
      ].filter(Boolean).join("\n");
    case "perspective_shift":
      return [
        "【打断恢复 — 视角重构】",
        `你刚才表达的观点是："${spoken}"`,
        unspoken ? `还没说完的部分："${unspoken}"` : "",
        `用户说："${user}"`,
        "请先简短补充你之前未说完的观点（可以结合用户新说的内容调整表述），再回应当前问题。"
      ].filter(Boolean).join("\n");
    case "transition":
      return "";
    case "backchannel":
      return "";
    default:
      return "";
  }
}
