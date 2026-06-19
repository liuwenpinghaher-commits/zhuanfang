import type {
  InterviewAgentContext,
  InterviewCard,
  InterviewControlAction,
  InterviewGuide,
  InterviewMode,
  InterviewSession,
  InterviewStrategyDecision,
  InterviewStrategyId,
  InterviewStrength,
  InterviewTurn,
} from "./types";

import { cloneState, makeId, nowIso, withAuditEvent, withAiRunEvent, extractAnchor, isLongUserAnswer, buildMirroredFollowUp, findPendingControlAction, applyPendingControlToFollowUp, sanitizeExternalMaterialText } from "./utils";
import { decideInterviewStrategy } from "./strategy";
import { buildRealtimeVoiceInstructions } from "./voice-instructions";

// 通用信号：用户在表达"不想再承担/想放手"类的压力回避意图
function mentionsAvoidance(text: string): boolean {
  return ["不想", "不愿", "不再", "想放手", "放权", "放手", "脱手", "退出", "兜底", "救火", "背锅", "担责"].some((s) => text.includes(s));
}

// 通用信号：用户在触及代价/风险/最坏情况
function mentionsWorstCase(text: string): boolean {
  return ["最坏", "代价", "失控", "延期", "崩", "出问题", "风险", "后果", "损失", "垮"].some((s) => text.includes(s));
}

function buildAssistantTurn(session: InterviewSession, userText: string): InterviewTurn & { strategyDecision: InterviewStrategyDecision } {
  const decision = decideInterviewStrategy(session, userText);
  const pairIndex = Math.floor(session.turns.length / 2);
  const anchor = extractAnchor(userText);
  const lower = userText.toLowerCase();
  const hasAvoidance = mentionsAvoidance(userText);
  const hasWorstCase = mentionsWorstCase(userText);

  let intent = decision.label;
  // 默认 content 基于锚点的通用机制追问，不绑定特定场景词
  let content = `你刚才的锚点是"${anchor}"。如果不从谁对谁错看，而从机制看：这个系统现在到底在奖励什么行为？`;

  if (decision.strategy === "concrete_example_probe") {
    content = `先别急着概括成判断。你能讲一个最近的具体时刻吗：当时谁在场，发生了什么，哪一句话让你觉得"${anchor}"？`;
  } else if (decision.strategy === "mechanism_reversal_probe") {
    content = `反过来看，这个具体时刻里可能不是某个人不主动，而是机制奖励了某种等待。如果把它当成一个系统问题，谁因为等待获得了安全感，谁承担了真实代价？`;
  } else if (decision.strategy === "debt_followup") {
    const debt = session.guide.openDebts.find((item) => item.concept === session.guide.debtToAddress) ?? session.guide.openDebts[0];
    content = debt
      ? `我想回访一个知识债：上次提到的"${debt.concept}"，你现在能用自己的话解释它吗？如果还不能，卡住你的到底是概念本身，还是它和你团队现场的关系？`
      : `我想回访一个知识债："${session.guide.debtToAddress}"。你现在能用自己的话解释它和这件事的关系吗？`;
  } else if (decision.strategy === "perspective_shift") {
    const perspective = decision.perspective ?? session.guide.recommendedPerspectives[0] ?? "系统论";
    const memory = decision.referencedMemory ?? session.card.historyReferences[0];
    content = `如果从${perspective}视角看，我先引用一条你的历史："${memory}"。这件事里真正被系统奖励的行为是什么？谁因为等待而少承担了判断责任？`;
  } else if (decision.strategy === "blindspot_probe") {
    const concept = decision.blindspotConcept ?? session.guide.blindspotCandidates[0]?.concept ?? "可承受的短期代价边界";
    content = `你有没有想过"${concept}"也在影响这件事？如果不是某个人不主动，而是这个默认习惯一直被保留下来，你最该验证的一个信号是什么？`;
  } else if (decision.strategy === "synthesis") {
    content = `我们先收束一下：你反复提到的不是"${anchor}"本身，而是它背后的判断机制。到现在为止，最值得验证的一个假设是什么？`;
  } else if (pairIndex === 0 && hasAvoidance) {
    intent = "追问机制";
    content = hasWorstCase
      ? `你把"${anchor}"和代价放在了一起。这里我想追具体一点：如果你真的放手，最坏的代价是什么——是执行延误、质量下滑，还是你对团队判断力的信任会被击穿？`
      : `你说不想再承担"${anchor}"。这里先别急着找方法：你现在替他们承担的到底是执行的压力，还是判断的责任？`;
  } else if (pairIndex === 1 && hasWorstCase) {
    intent = "挑战前提";
    content = `你已经说到了最坏情况。那我挑战一下：你是不是默认了"短期出现代价一定比长期依赖更糟"？这个前提还成立吗？`;
  } else if (session.mode === "point" || lower.includes("我觉得")) {
    intent = "反方观点";
    content = `如果把"${anchor}"当成一个观点，它最强的反例是什么？有没有一个场景里你会承认这个判断不成立？`;
  } else if (session.mode === "learning") {
    intent = "学习复述";
    content = `先不用讲你看了多少资料。你能不能用自己的话解释"${anchor}"，再说它能解释你当前哪个真实问题？`;
  } else if (pairIndex >= 2) {
    intent = "阶段总结";
    content = `我先收一下：你不是单纯在说"${anchor}"，而是在问自己愿不愿意承受放手之后的短期代价。这里最值得下次继续的是：你到底能接受哪一种代价？`;
  }

  if (isLongUserAnswer(userText)) {
    content = buildMirroredFollowUp(userText, content);
  }

  const pendingControl = findPendingControlAction(session);
  if (pendingControl) {
    content = applyPendingControlToFollowUp(pendingControl, userText, content);
  }

  return {
    id: makeId("turn-assistant"),
    role: "assistant",
    content,
    intent,
    timestamp: nowIso(),
    referencedMemory: decision.referencedMemory ?? session.card.historyReferences[0],
    strategy: decision.strategy,
    depth: decision.depth,
    strategyDecision: {
      ...decision,
      label: intent
    }
  };
}
function controlFeedback(
  session: InterviewSession,
  action: InterviewControlAction
): { nextStrength: InterviewStrength; content: string } {
  const anchor = session.askedAnchor ?? "这个问题";
  switch (action) {
    case "skip":
      return {
        nextStrength: session.strength,
        content: `可以，先跳过"${anchor}"。我会把它放进线索池，不在本轮继续追。我们换到一个更低压力的问题：这件事里你现在最确定的一点是什么？`
      };
    case "softer":
      return {
        nextStrength: "gentle",
        content: "收到，我会放慢一点，先不做尖锐挑战。我们先把事实和你的真实感受分开讲清楚。"
      };
    case "sharper":
      return {
        nextStrength: "sharp",
        content: "收到，我会更直接一点。接下来我会优先检查前提、代价和你可能回避的地方。"
      };
    case "different-angle":
      return {
        nextStrength: session.strength,
        content: `我们换个角度：如果从系统视角看，"${anchor}"不是个人问题，而是机制一直在奖励某种行为，那它奖励的是什么？`
      };
    case "summary":
      return {
        nextStrength: session.strength,
        content: "我先做阶段总结：你不是单纯在说要不要继续介入，而是在问自己能不能承受放手后的短期代价。下一步最值得问的是：这个代价能否被小范围验证？"
      };
    case "do-not-save":
      return {
        nextStrength: session.strength,
        content: "本次我会按不保存处理。你仍然可以继续说，但结束后不会沉淀到长期档案。"
      };
  }
}
export function receiveUserTurn(session: InterviewSession, userText: string): InterviewSession {
  const trimmed = userText.trim();
  if (!trimmed) {
    return session;
  }

  // ponytail: 启发式注入清洗，非安全边界；模型侧仍需防御
  const sanitized = sanitizeExternalMaterialText(trimmed, trimmed);

  const assistant = buildAssistantTurn(session, sanitized);

  return receiveUserTurnWithAssistant(session, sanitized, {
    content: assistant.content,
    intent: assistant.intent,
    referencedMemory: assistant.referencedMemory,
    strategyDecision: assistant.strategyDecision
  });
}
export function receiveUserTurnWithAssistant(
  session: InterviewSession,
  userText: string,
  assistant: { content: string; intent: string; referencedMemory?: string; strategyDecision?: InterviewStrategyDecision }
): InterviewSession {
  const trimmed = userText.trim();
  if (!trimmed) {
    return session;
  }

  const timestamp = nowIso();
  const userTurn: InterviewTurn = {
    id: makeId("turn-user"),
    role: "user",
    content: trimmed,
    intent: "用户表达",
    timestamp
  };

  return {
    ...session,
    turns: [
      ...session.turns,
      userTurn,
      {
        id: makeId("turn-assistant"),
        role: "assistant",
        content: assistant.content,
        intent: assistant.intent,
        timestamp,
        referencedMemory: assistant.referencedMemory ?? session.card.historyReferences[0],
        strategy: assistant.strategyDecision?.strategy,
        depth: assistant.strategyDecision?.depth
      }
    ],
    strategyTrace: assistant.strategyDecision
      ? [...(session.strategyTrace ?? []), assistant.strategyDecision]
      : session.strategyTrace,
    askedAnchor: extractAnchor(trimmed)
  };
}
export function updateInterviewControl(session: InterviewSession, action: InterviewControlAction): InterviewSession {
  const timestamp = nowIso();
  const feedback = controlFeedback(session, action);
  return {
    ...session,
    strength: feedback.nextStrength,
    doNotSave: action === "do-not-save" ? true : session.doNotSave,
    turns: [
      ...session.turns,
      {
        id: makeId("turn-control"),
        role: "assistant",
        content: feedback.content,
        intent: "控制反馈",
        timestamp,
        referencedMemory: session.card.historyReferences[0]
      }
    ]
  };
}

// ============================================================================
// LiveKit cascaded-pipeline helpers — minimal interview session lifecycle
// for the Python agent (`/api/realtime-voice/agent-context|agent-turn`).
// ============================================================================

export interface CreateInterviewSessionInput {
  id: string;
  title: string;
  createdAt?: string;
  mode?: InterviewMode;
  strength?: InterviewStrength;
}

export function createInterviewSession(input: CreateInterviewSessionInput): InterviewSession {
  const card: InterviewCard = {
    title: input.title,
    whyNow: "",
    suggestedOpening: "",
    historyReferences: [],
    potentialTension: "",
    suggestedPerspectives: [],
    likelyOutputs: [],
    sourceHighlights: [],
  };

  const guide: InterviewGuide = {
    topicHint: "",
    dailyBrief: { suggestedTopic: "", openingQuestion: "", contextNote: "" },
    perspectiveCoverage: {},
    missingPerspectives: [],
    recommendedPerspectives: [],
    perspectiveRationale: "",
    relevantMemories: [],
    graphReferences: [],
    opinionEvolution: [],
    statedPositions: [],
    openDebts: [],
    blindspotCandidates: [],
    knowledgeFragments: [],
    suggestedOpening: "",
    strategyChecklist: [],
  };

  return {
    id: input.id,
    mode: input.mode ?? "daily",
    strength: input.strength ?? "standard",
    status: "active",
    title: input.title,
    card,
    guide,
    turns: [],
    realtimeSignals: [],
    startedAt: input.createdAt ?? nowIso(),
  };
}

export interface AddTurnInput {
  role: "user" | "assistant";
  content: string;
  strategy?: string;
  intent?: string;
  referencedMemory?: string;
}

const VALID_STRATEGY_IDS: ReadonlySet<InterviewStrategyId> = new Set<InterviewStrategyId>([
  "mechanism_probe",
  "concrete_example_probe",
  "mechanism_reversal_probe",
  "debt_followup",
  "perspective_shift",
  "blindspot_probe",
  "premise_challenge",
  "synthesis",
]);

function coerceStrategyId(value: string | undefined): InterviewStrategyId | undefined {
  if (!value) return undefined;
  return VALID_STRATEGY_IDS.has(value as InterviewStrategyId) ? (value as InterviewStrategyId) : undefined;
}

export function addTurn(session: InterviewSession, input: AddTurnInput): InterviewSession {
  const strategy = coerceStrategyId(input.strategy);
  const turn: InterviewTurn = {
    id: makeId(`turn-${input.role}`),
    role: input.role,
    content: input.content,
    intent: input.intent ?? (input.role === "user" ? "用户表达" : "主持人发言"),
    timestamp: nowIso(),
    ...(strategy ? { strategy } : {}),
    ...(input.referencedMemory ? { referencedMemory: input.referencedMemory } : {}),
  };
  return {
    ...session,
    turns: [...session.turns, turn],
  };
}

export function buildInterviewAgentContext(session: InterviewSession): InterviewAgentContext {
  const instructions = buildRealtimeVoiceInstructions(session);
  const history: Array<{ role: "user" | "assistant"; text: string }> = [];
  for (const turn of session.turns) {
    if (turn.role === "user" || turn.role === "assistant") {
      history.push({ role: turn.role, text: turn.content });
    }
  }
  const lastUserTurn = [...session.turns].reverse().find((turn) => turn.role === "user");
  const activeStrategies = session.enginePolicy?.appliedPlaybookRules?.slice(0, 5) ?? [];

  return {
    instructions,
    sessionTitle: session.title,
    turnCount: session.turns.length,
    latestUserTurn: lastUserTurn?.content ?? null,
    history: history.slice(-20),
    activeStrategies,
  };
}
