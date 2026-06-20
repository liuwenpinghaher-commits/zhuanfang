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
  MemoryCorrection,
} from "./types";

import { cloneState, makeId, nowIso, withAuditEvent, withAiRunEvent, extractAnchor, isLongUserAnswer, buildMirroredFollowUp, findPendingControlAction, applyPendingControlToFollowUp, sanitizeExternalMaterialText } from "./utils";
import { decideInterviewStrategy } from "./strategy";
import { buildRealtimeVoiceInstructions } from "./voice-instructions";

// ponytail: 这两个是启发式关键词信号(非穷尽、偏管理/职场语料);真正 scenario-agnostic
// 的追问需 LLM 驱动生成,留作升级路径。当前词表覆盖常见表达,缺词时回退到通用追问模板。
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
  // 默认 content 基于锚点的通用机制追问，不绑定特定场景词（不预设职场/带团队语境）。
  let content = `你刚才的锚点是"${anchor}"。先别停在对错上：让它一直这样的，背后是什么在推动？`;

  if (decision.strategy === "concrete_example_probe") {
    content = `先别急着概括成判断。你能讲一个最近的具体时刻吗：当时是什么场景，发生了什么，哪一句话或哪个瞬间让你觉得"${anchor}"？`;
  } else if (decision.strategy === "mechanism_reversal_probe") {
    content = `反过来看，这个具体时刻里也许不是某个人的问题，而是某种安排让事情自然往这个方向走。如果把它当成一个机制问题：是什么让"${anchor}"反复发生，谁从中得到了好处，谁承担了代价？`;
  } else if (decision.strategy === "debt_followup") {
    const debt = session.guide.openDebts.find((item) => item.concept === session.guide.debtToAddress) ?? session.guide.openDebts[0];
    content = debt
      ? `我想回访一个知识债：上次提到的"${debt.concept}"，你现在能用自己的话解释它吗？如果还不能，卡住你的到底是概念本身，还是它和你眼前这件事的关系？`
      : `我想回访一个知识债："${session.guide.debtToAddress}"。你现在能用自己的话解释它和这件事的关系吗？`;
  } else if (decision.strategy === "perspective_shift") {
    const perspective = decision.perspective ?? session.guide.recommendedPerspectives[0] ?? "另一个";
    const memory = decision.referencedMemory ?? session.card.historyReferences[0];
    content = memory
      ? `换到${perspective}视角，我先引用一条你说过的话："${memory}"。从这个角度看，"${anchor}"这件事真正在被什么推动？`
      : `换到${perspective}视角看"${anchor}"：从这个角度，事情真正在被什么推动？`;
  } else if (decision.strategy === "blindspot_probe") {
    const concept = decision.blindspotConcept ?? session.guide.blindspotCandidates[0]?.concept ?? "你还没留意到的那一面";
    content = `你有没有想过"${concept}"也在影响这件事？如果不是某个人的问题，而是这个被默认保留下来的习惯一直在起作用，你最该先验证的一个信号是什么？`;
  } else if (decision.strategy === "synthesis") {
    content = `我们先收束一下：你反复回到的不是"${anchor}"本身，而是它背后那层更让你在意的东西。到现在为止，最值得验证的一个假设是什么？`;
  } else if (pairIndex === 0 && hasAvoidance) {
    intent = "追问机制";
    // scenario-agnostic：用户表达了"想放下/不想再承担"类意图，就顺着他自己的锚点追
    // "放不下的到底是什么"，不预设职场/带团队的具体代价。
    content = hasWorstCase
      ? `你把"${anchor}"和你担心的代价放在了一起。先具体一点：如果你真的放下它，你最怕发生的那一幕是什么？`
      : `你说想放下"${anchor}"。先别急着找办法：现在真正让你放不下的，是这件事本身，还是它牵动的某个你更在意的东西？`;
  } else if (pairIndex === 1 && hasWorstCase) {
    intent = "挑战前提";
    // 用户已触及"最坏情况/代价"，挑战其隐含前提，但不替他假设代价的内容。
    content = `你已经说到了最坏的情况。我挑战一个藏在里面的前提：你是不是默认了"现在不动"一定比"承受那个代价"更安全？这个前提真的成立吗？`;
  } else if (session.mode === "point" || lower.includes("我觉得")) {
    intent = "反方观点";
    content = `如果把"${anchor}"当成一个观点，它最强的反例是什么？有没有一个场景里你会承认这个判断不成立？`;
  } else if (session.mode === "learning") {
    intent = "学习复述";
    content = `先不用讲你看了多少资料。你能不能用自己的话解释"${anchor}"，再说它能解释你当前哪个真实问题？`;
  } else if (pairIndex >= 2) {
    intent = "阶段总结";
    // 通用收束：扣回用户自己的锚点，不预设"放手/短期代价"这类职场框架。
    content = `我先收一下：你反复回到的其实是"${anchor}"。到这里为止，最值得你下次继续想清楚的一个问题是什么？`;
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
        content: `我们换个角度：先不把"${anchor}"当成某个人的问题，而当成一个被什么推动着的局面——那真正在推动它的，是什么？`
      };
    case "summary":
      return {
        nextStrength: session.strength,
        content: `我先做阶段总结：你反复回到的其实是"${anchor}"背后那层更在意的东西。下一步最值得问的是：它能不能被一个小一点的具体例子先验证一下？`
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
    askedAnchor: extractAnchor(trimmed),
    // The pending control directive was applied to this turn's prompt — clear it.
    pendingControl: undefined
  };
}
export function updateInterviewControl(session: InterviewSession, action: InterviewControlAction): InterviewSession {
  const timestamp = nowIso();
  const feedback = controlFeedback(session, action);
  return {
    ...session,
    strength: feedback.nextStrength,
    doNotSave: action === "do-not-save" ? true : session.doNotSave,
    // Structured directive for the next turn's prompt (robust, not话术-matched).
    pendingControl: action,
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

/**
 * Canonical Chinese label for each interview strategy. Single source of truth so
 * the UI badge and the strategy engine (`decideInterviewStrategy`) agree on wording
 * instead of re-deriving labels per surface. Mirrors the `label` fields produced in
 * `decideInterviewStrategy` (strategy.ts).
 */
export const INTERVIEW_STRATEGY_LABELS: Record<InterviewStrategyId, string> = {
  mechanism_probe: "追问机制",
  concrete_example_probe: "索要具体时刻",
  mechanism_reversal_probe: "机制反转",
  debt_followup: "知识债追问",
  perspective_shift: "视角切换",
  blindspot_probe: "盲区探测",
  premise_challenge: "挑战前提",
  synthesis: "阶段总结",
};

/**
 * Strategies that only fire when a learned PlaybookPatch (corpus learning) is
 * applied. Used by the UI to show an "应用技法" badge ONLY for turns where the
 * corpus learning genuinely changed the question — not for every default strategy.
 */
export const PLAYBOOK_DRIVEN_STRATEGIES: ReadonlySet<InterviewStrategyId> = new Set<InterviewStrategyId>([
  "concrete_example_probe",
  "mechanism_reversal_probe",
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

export function buildInterviewAgentContext(
  session: InterviewSession,
  corrections: MemoryCorrection[] = []
): InterviewAgentContext {
  const instructions = buildRealtimeVoiceInstructions(session, undefined, corrections);
  const history: Array<{ role: "user" | "assistant"; text: string }> = [];
  for (const turn of session.turns) {
    if (turn.role === "user" || turn.role === "assistant") {
      history.push({ role: turn.role, text: turn.content });
    }
  }
  const lastUserTurn = [...session.turns].reverse().find((turn) => turn.role === "user");

  return {
    instructions,
    sessionTitle: session.title,
    turnCount: session.turns.length,
    latestUserTurn: lastUserTurn?.content ?? null,
    history: history.slice(-20),
  };
}
