import { initialProductState } from "./seed";
import type {
  AssetStatus,
  CognitiveRadar,
  CorpusImportInput,
  CorpusInsight,
  CorpusTurn,
  DualTrackNote,
  FinalizeResult,
  InterviewCard,
  InterviewControlAction,
  InterviewMode,
  InterviewSession,
  InterviewStrength,
  InterviewTurn,
  MonthlyReview,
  PlaybookPatch,
  PodcastEpisode,
  ProductState,
  RealtimeSignal,
  RealtimeTurnState,
  SearchBrief,
  SearchBriefInput,
  SearchProviderId,
  SearchResult,
  SourceHighlight,
  SystemStatus,
  YearlyReview
} from "./types";

const modeLabels: Record<InterviewMode, string> = {
  daily: "日常复盘",
  decision: "决策专访",
  point: "观点专访",
  learning: "学习专访",
  organization: "组织/关系专访",
  "long-term": "长期主题专访"
};

const nowIso = () => new Date().toISOString();

const makeId = (prefix: string) => `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;

const cloneState = (state: ProductState): ProductState => JSON.parse(JSON.stringify(state)) as ProductState;

interface CreateSessionOptions {
  searchBriefId?: string;
}

export function createInitialProductState(): ProductState {
  return cloneState(initialProductState);
}

export function buildInterviewCard(state: ProductState, searchBriefId?: string): InterviewCard {
  const topTheme = state.themes.find((theme) => theme.name === "控制感") ?? state.themes[0];
  const openDebt = state.debts.find((debt) => debt.status === "待了解") ?? state.debts[0];
  const reference = topTheme?.representativeQuote ?? state.profile.confirmedMemories[0] ?? "你最近有一个反复出现的问题。";
  const title = topTheme?.name === "控制感" ? "你对“救火”和放手的真实边界" : `继续追踪：${topTheme.name}`;
  const searchBrief = searchBriefId
    ? state.searchBriefs.find((brief) => brief.id === searchBriefId)
    : state.searchBriefs[0];
  const sourceReferences = searchBrief
    ? [`联网素材：${searchBrief.summary}`, ...searchBrief.sources.slice(0, 2).map((source) => `${source.publisher}：${source.title}`)]
    : [];

  return {
    title,
    whyNow: searchBrief
      ? `你最近多次提到${topTheme.name}，同时“${searchBrief.topic}”出现了可借用的外部素材，适合把个人问题放进更大的语境里看。`
      : `你最近多次提到${topTheme.name}，但还没有把“最坏会发生什么”说具体。`,
    suggestedOpening: searchBrief
      ? `我们先从一个外部素材切入：${searchBrief.discussionTopics[0]} 这和你最近说的“救火”有什么真实关系？`
      : "我们先不急着找解决方案，先把你说的“救火”具体拆开：你到底在替谁承担什么判断？",
    historyReferences: [...sourceReferences, reference, ...state.profile.confirmedMemories].slice(0, 4),
    potentialTension: searchBrief?.sourceAngles[0] ?? "你一边想授权，一边又担心放手之后项目失控。",
    suggestedPerspectives: searchBrief ? ["系统论", "商业", "组织行为", "形式科学"] : ["系统论", "心理学", "形式科学"],
    likelyOutputs: [
      "一个更准确的长期问题",
      "一条关于授权边界的观点",
      openDebt ? `知识债回访：${openDebt.concept}` : "一个新的知识债候选",
      ...(searchBrief ? [`素材引用：${searchBrief.sources[0]?.title}`] : [])
    ],
    sourceHighlights: searchBrief?.sources.slice(0, 3)
  };
}

export function createSessionDraft(
  state: ProductState,
  mode: InterviewMode = "daily",
  strength: InterviewStrength = state.profile.preferredStrength,
  options: CreateSessionOptions = {}
): InterviewSession {
  const card = buildInterviewCard(state, options.searchBriefId);
  return {
    id: makeId("session"),
    mode,
    strength,
    status: "active",
    title: `${modeLabels[mode]}：${card.title}`,
    card,
    guide: {
      topicHint: card.title,
      dailyBrief: { suggestedTopic: card.title, openingQuestion: card.suggestedOpening, contextNote: card.whyNow },
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
      suggestedOpening: card.suggestedOpening,
      strategyChecklist: [],
    },
    turns: [],
    startedAt: nowIso()
  };
}

export function buildSearchBrief(
  state: ProductState,
  topic: string,
  provider: SearchProviderId = state.systemConfig.search.activeProvider
): { brief: SearchBrief; nextState: ProductState } {
  const normalizedTopic = topic.trim() || "本周值得讨论的 AI 产品变化";
  const sources = createDemoSources(normalizedTopic, provider, state.systemConfig.search.maxSources);
  return createSearchBriefFromInput(state, {
    topic: normalizedTopic,
    provider,
    status: provider === "local-demo" ? "ready" : "needs-review",
    summary: `${normalizedTopic} 正在影响用户的产品判断、团队分工和长期主题，适合在专访里作为外部参照，而不是替代个人经验。`,
    facts: [
      `${normalizedTopic} 已经进入可讨论的业务流程层面，而不只是工具热闹。`,
      "外部资料只能作为追问线索，需要回到用户自己的具体事件里验证。",
      `本轮最多保留 ${state.systemConfig.search.maxSources} 个来源，避免专访被素材淹没。`
    ],
    controversies: [
      "争议：AI 产品商业化应该先看效率指标，还是先看组织是否愿意改变判断方式。",
      "争议：热点可能帮助用户看清问题，也可能成为逃避个人真实张力的借口。"
    ],
    opposingViews: [
      "反方观点：外部趋势不一定适用于用户当前行业和团队阶段。",
      "反方观点：如果没有可复盘行动，素材越多反而越容易稀释判断。"
    ],
    interviewAngles: [
      `专访角度：${normalizedTopic} 和用户最近的真实选择有什么关系？`,
      "专访角度：追一个具体项目，而不是泛泛讨论行业趋势。"
    ],
    discussionTopics: [
      `专访切入：${normalizedTopic} 对你当前判断的真实影响是什么？`,
      "哪些外部说法只是热闹，哪些能解释你最近的具体困境？",
      "如果把外部趋势落到一个项目决策上，最小验证动作是什么？"
    ],
    sourceAngles: [
      "外部趋势可能正在放大你对授权、风险和产品节奏的矛盾。",
      "不要把热点直接当结论，先追问它与你自己的历史原话是否互相印证。",
      "素材只提供角度，最终资产仍以用户确认和专访证据为准。"
    ],
    sources
  });
}

export function createSearchBriefFromInput(
  state: ProductState,
  input: SearchBriefInput
): { brief: SearchBrief; nextState: ProductState } {
  const brief: SearchBrief = {
    ...input,
    topic: input.topic.trim() || "本周值得讨论的 AI 产品变化",
    sources: input.sources,
    status: input.status,
    sourceTrace: input.sourceTrace ?? [],
    appliedToSessionIds: [],
    createdAt: nowIso(),
    id: makeId("search-brief")
  };

  return {
    brief,
    nextState: {
      ...cloneState(state),
      searchBriefs: [brief, ...state.searchBriefs]
    }
  };
}

function createDemoSources(topic: string, provider: SearchProviderId, maxSources: number): SourceHighlight[] {
  const sourceTemplates = [
    {
      publisher: provider === "anysearch" ? "AnySearch" : "Local Signals",
      suffix: "行业讨论",
      snippet: "多个团队开始把 AI 工具从演示型能力转向可衡量的业务流程改造。"
    },
    {
      publisher: "Product Ops Review",
      suffix: "商业化观察",
      snippet: "真正有效的 AI 产品通常先改变工作流，再进入规模化获客。"
    },
    {
      publisher: "Founder Interview Notes",
      suffix: "创始人访谈",
      snippet: "受访者反复提到：AI 产品落地的关键不是模型参数，而是组织是否愿意改变判断方式。"
    },
    {
      publisher: "Research Digest",
      suffix: "研究摘录",
      snippet: "用户信任来自可解释的引用、边界和复盘机制。"
    },
    {
      publisher: "Market Watch",
      suffix: "市场快照",
      snippet: "热点信息需要经过来源可信度、相关度和可行动性过滤。"
    }
  ];

  return sourceTemplates.slice(0, Math.max(3, Math.min(maxSources, sourceTemplates.length))).map((template, index) => ({
    id: makeId(`source-${index + 1}`),
    title: `${topic}：${template.suffix}`,
    url: `https://example.local/${provider}/${encodeURIComponent(topic)}/${index + 1}`,
    publisher: template.publisher,
    publishedAt: new Date(Date.UTC(2026, 5, Math.max(1, 10 - index))).toISOString(),
    snippet: template.snippet,
    relevanceScore: 0.94 - index * 0.07,
    usage: index === 0 ? "topic-suggestion" : index === 1 ? "interview-context" : "post-note-reference"
  }));
}

export function receiveUserTurn(session: InterviewSession, userText: string): InterviewSession {
  const trimmed = userText.trim();
  if (!trimmed) {
    return session;
  }

  const assistant = buildAssistantTurn(session, trimmed);

  return receiveUserTurnWithAssistant(session, trimmed, {
    content: assistant.content,
    intent: assistant.intent,
    referencedMemory: assistant.referencedMemory
  });
}

export function receiveUserTurnWithAssistant(
  session: InterviewSession,
  userText: string,
  assistant: { content: string; intent: string; referencedMemory?: string }
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
        referencedMemory: assistant.referencedMemory ?? session.card.historyReferences[0]
      }
    ],
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

function controlFeedback(
  session: InterviewSession,
  action: InterviewControlAction
): { nextStrength: InterviewStrength; content: string } {
  const anchor = session.askedAnchor ?? "这个问题";
  switch (action) {
    case "skip":
      return {
        nextStrength: session.strength,
        content: `可以，先跳过“${anchor}”。我会把它放进线索池，不在本轮继续追。我们换到一个更低压力的问题：这件事里你现在最确定的一点是什么？`
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
        content: `我们换个角度：如果从系统视角看，“${anchor}”不是个人问题，而是机制一直在奖励某种行为，那它奖励的是什么？`
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

function buildAssistantTurn(session: InterviewSession, userText: string): InterviewTurn {
  const pairIndex = Math.floor(session.turns.length / 2);
  const anchor = extractAnchor(userText);
  const lower = userText.toLowerCase();
  const mentionsRescue = userText.includes("兜底") || userText.includes("救火");
  const mentionsLoss = userText.includes("失控") || userText.includes("延期") || userText.includes("最坏");

  let intent = "追问机制";
  let content = `你刚才的锚点是“${anchor}”。如果不从谁对谁错看，而从机制看：这个系统现在到底奖励谁等你来兜底？`;

  if (pairIndex === 0 && mentionsRescue) {
    intent = "追问机制";
    content = mentionsLoss
      ? "你把“兜底”和“失控”放在了一起。这里我想追具体一点：如果你不兜底，最坏的代价是什么，是延期、质量，还是你对团队判断力的信任会被击穿？"
      : "你说不想再兜底。这里先别急着找方法：你现在替他们兜住的到底是执行，还是判断的责任？";
  } else if (pairIndex === 1 && mentionsLoss) {
    intent = "挑战前提";
    content = "你已经说到了最坏情况。那我挑战一下：你是不是默认了“短期失控一定比长期依赖更糟”？这个前提还成立吗？";
  } else if (session.mode === "point" || lower.includes("我觉得")) {
    intent = "反方观点";
    content = `如果把“${anchor}”当成一个观点，它最强的反例是什么？有没有一个场景里你会承认这个判断不成立？`;
  } else if (session.mode === "learning") {
    intent = "学习复述";
    content = `先不用讲你看了多少资料。你能不能用自己的话解释“${anchor}”，再说它能解释你当前哪个真实问题？`;
  } else if (pairIndex >= 2) {
    intent = "阶段总结";
    content = "我先收一下：你不是单纯在说团队不主动，而是在问自己愿不愿意承受放手之后的短期代价。这里最值得下次继续的是：你到底能接受哪一种失控？";
  }

  return {
    id: makeId("turn-assistant"),
    role: "assistant",
    content,
    intent,
    timestamp: nowIso(),
    referencedMemory: session.card.historyReferences[0]
  };
}

function extractAnchor(text: string): string {
  const candidates = ["兜底", "救火", "失控", "判断", "授权", "机制", "责任", "团队", "项目"];
  const found = candidates.find((candidate) => text.includes(candidate));
  if (found) {
    return found;
  }
  const normalized = text.replace(/[，。！？、,.!?]/g, " ");
  const longest = normalized
    .split(/\s+/)
    .filter(Boolean)
    .sort((a, b) => b.length - a.length)[0];
  return longest?.slice(0, 12) || "这个问题";
}

export function finalizeSession(state: ProductState, session: InterviewSession): FinalizeResult {
  const completedAt = nowIso();
  const userTurns = session.turns.filter((turn) => turn.role === "user");
  const assistantTurns = session.turns.filter((turn) => turn.role === "assistant");
  const keyQuote = pickKeyQuote(userTurns.map((turn) => turn.content));
  const anchor = extractAnchor(keyQuote);

  const note: DualTrackNote = {
    id: makeId("note"),
    sessionId: session.id,
    title: session.title,
    summary: `这次访谈把“${anchor}”从一个情绪化表达推进到了责任边界和机制代价的问题。`,
    keyQuote,
    saidTrack: [
      keyQuote,
      "用户不只是想减少介入，也在担心放手后的短期风险。",
      "用户开始把问题从个人能力转向机制和责任分配。"
    ],
    learnedTrack: [
      "真正的分歧可能不是要不要救火，而是能不能承受不救火的代价。",
      "如果机制一直奖励等待用户拍板，团队很难自然承担判断。",
      "下次需要把“最坏情况”拆成可验证的风险，而不是笼统的失控。"
    ],
    nextQuestions: [
      "如果你不亲自救火，最坏会发生什么？",
      "你愿意用哪一个小范围项目测试放手？"
    ],
    createdAt: completedAt
  };

  const completedSession: InterviewSession = {
    ...session,
    status: "completed",
    completedAt
  };

  if (session.doNotSave) {
    return {
      note,
      nextState: {
        ...cloneState(state),
        sessions: [completedSession, ...state.sessions]
      }
    };
  }

  const nextState = cloneState(state);
  nextState.sessions = [completedSession, ...nextState.sessions];
  nextState.notes = [note, ...nextState.notes];
  nextState.points = [
    {
      id: makeId("point"),
      title: "我需要重新定义救火和授权的边界",
      content: "继续兜底能降低短期风险，但会延长团队对我拍板的依赖。",
      status: "被挑战中",
      confidence: "待验证",
      evidence: [keyQuote],
      relatedThemeIds: ["theme-control"],
      important: true,
      updatedAt: completedAt
    },
    ...nextState.points
  ];
  nextState.questions = [
    {
      id: makeId("question"),
      question: "如果我不救火，最坏会发生什么？",
      whyImportant: "这个问题决定用户能否从抽象授权推进到真实代价评估。",
      status: "正在聚焦",
      appearances: 1,
      relatedThemeIds: ["theme-control"],
      nextPrompt: "把最坏情况拆成延期、质量、客户、团队信任四类风险。",
      important: true,
      updatedAt: completedAt
    },
    ...nextState.questions
  ];
  nextState.decisions = [
    {
      id: makeId("decision"),
      title: "是否继续亲自救火",
      decisionKind: "候选决策",
      confirmationStatus: "待用户确认",
      choice: "先选一个低风险项目减少直接兜底。",
      tradeOff: "短期会暴露团队判断缺口，但能验证机制是否真的可承压。",
      riskHypothesis: "没有用户兜底时，项目可能延期，但团队会更快暴露真正缺口。",
      reviewAt: "2026-07-10",
      status: "待复盘",
      updatedAt: completedAt
    },
    ...nextState.decisions
  ];
  nextState.debts = [
    {
      id: makeId("debt"),
      concept: "授权机制",
      context: "本次访谈中，用户把救火和团队承担判断联系起来。",
      whyImportant: "它能帮助用户区分“给任务”和“给判断权”。",
      status: "待了解",
      nextQuestion: "你能不能用一个项目例子说明什么叫真正授权？",
      updatedAt: completedAt
    },
    ...nextState.debts
  ];
  nextState.themes = nextState.themes.map((theme) =>
    theme.name === "控制感"
      ? {
          ...theme,
          maturity: "聚焦",
          appearances: theme.appearances + 1,
          representativeQuote: keyQuote,
          nextQuestion: "如果你允许短期失控，最坏会发生什么？",
          updatedAt: completedAt
        }
      : theme
  );

  if (!nextState.themes.some((theme) => theme.name === "控制感")) {
    nextState.themes.unshift({
      id: "theme-control",
      name: "控制感",
      summary: "用户正在探索放手、授权和短期失控之间的关系。",
      maturity: "聚焦",
      representativeQuote: keyQuote,
      appearances: 1,
      nextQuestion: "如果你允许短期失控，最坏会发生什么？",
      updatedAt: completedAt
    });
  }

  if (assistantTurns.length === 0) {
    note.learnedTrack.push("本次没有形成足够的 AI 追问，应标记为轻量记录。");
  }

  return { note, nextState };
}

function pickKeyQuote(quotes: string[]): string {
  return (
    quotes
      .filter(Boolean)
      .sort((a, b) => scoreQuote(b) - scoreQuote(a))[0] ?? "这次我还没有说清楚真正的问题。"
  );
}

function scoreQuote(quote: string): number {
  const signalWords = ["不是", "兜底", "救火", "最坏", "失控", "判断", "机制", "责任"];
  return quote.length + signalWords.filter((word) => quote.includes(word)).length * 20;
}

export function buildMonthlyReview(state: ProductState): MonthlyReview {
  const topTheme = [...state.themes].sort((a, b) => b.appearances - a.appearances)[0];
  const openQuestion = state.questions.find((question) => question.status !== "阶段性回答");

  return {
    topTheme: topTheme?.name ?? "暂无长期主题",
    changedView: "你正在从“团队不主动”转向“机制是否让团队承担判断”。",
    avoidedQuestion: openQuestion?.question ?? "还没有形成明确的回避问题。",
    recommendedNextInterview: topTheme?.nextQuestion ?? "从最近一条关键原话继续。",
    metrics: {
      notes: state.notes.length,
      points: state.points.length,
      questions: state.questions.length,
      knowledgeDebts: state.debts.length,
      themes: state.themes.length
    }
  };
}

export function markMemoryCorrection(state: ProductState, text: string): ProductState {
  return {
    ...state,
    memoryCorrections: [
      {
        id: makeId("correction"),
        text,
        createdAt: nowIso()
      },
      ...state.memoryCorrections
    ]
  };
}

export function toggleAssetImportance(state: ProductState, assetId: string): ProductState {
  return {
    ...state,
    points: state.points.map((point) =>
      point.id === assetId ? { ...point, important: !point.important, updatedAt: nowIso() } : point
    ),
    questions: state.questions.map((question) =>
      question.id === assetId ? { ...question, important: !question.important, updatedAt: nowIso() } : question
    )
  };
}

export function searchProductAssets(state: ProductState, query: string): SearchResult {
  const normalized = query.trim().toLowerCase();
  const match = (values: string[]) =>
    !normalized || values.some((value) => value.toLowerCase().includes(normalized));

  const notes = state.notes.filter((note) =>
    match([note.title, note.summary, note.keyQuote, ...note.saidTrack, ...note.learnedTrack, ...note.nextQuestions])
  );
  const points = state.points.filter((point) =>
    match([point.title, point.content, point.status, point.confidence, ...point.evidence])
  );
  const questions = state.questions.filter((question) =>
    match([question.question, question.whyImportant, question.status, question.nextPrompt])
  );
  const decisions = state.decisions.filter((decision) =>
    match([decision.title, decision.choice, decision.tradeOff, decision.riskHypothesis, decision.status])
  );
  const debts = state.debts.filter((debt) =>
    match([debt.concept, debt.context, debt.whyImportant, debt.status, debt.nextQuestion])
  );
  const themes = state.themes.filter((theme) =>
    match([theme.name, theme.summary, theme.maturity, theme.representativeQuote, theme.nextQuestion])
  );

  return {
    query,
    total: notes.length + points.length + questions.length + decisions.length + debts.length + themes.length,
    notes,
    points,
    questions,
    decisions,
    debts,
    readings: [],
    themes
  };
}

export function updateKnowledgeDebtStatus(
  state: ProductState,
  debtId: string,
  status: Extract<AssetStatus, "待了解" | "能复述" | "已应用" | "不相关">
): ProductState {
  return {
    ...state,
    debts: state.debts.map((debt) =>
      debt.id === debtId
        ? {
            ...debt,
            status,
            updatedAt: nowIso()
          }
        : debt
    )
  };
}

export function updatePointStatus(
  state: ProductState,
  pointId: string,
  status: Extract<AssetStatus, "临时想法" | "稳定观点" | "被挑战中" | "已修正" | "已放弃">
): ProductState {
  return {
    ...state,
    points: state.points.map((point) =>
      point.id === pointId ? { ...point, status, confidence: "用户确认", updatedAt: nowIso() } : point
    )
  };
}

export function updateQuestionStatus(
  state: ProductState,
  questionId: string,
  status: Extract<AssetStatus, "开放" | "反复出现" | "正在聚焦" | "阶段性回答">
): ProductState {
  return {
    ...state,
    questions: state.questions.map((question) =>
      question.id === questionId ? { ...question, status, updatedAt: nowIso() } : question
    )
  };
}

export function createQuestionFromNote(state: ProductState, noteId: string, nextQuestionIndex: number): ProductState {
  const note = state.notes.find((item) => item.id === noteId);
  const question = note?.nextQuestions[nextQuestionIndex];
  if (!note || !question) {
    return state;
  }

  return {
    ...state,
    questions: [
      {
        id: makeId("question-from-note"),
        question,
        whyImportant: `来自访谈《${note.title}》的下次回访问题。`,
        status: "开放",
        appearances: 1,
        relatedThemeIds: ["theme-control"],
        nextPrompt: question,
        important: true,
        updatedAt: nowIso()
      },
      ...state.questions
    ]
  };
}

export function buildCognitiveRadar(state: ProductState): CognitiveRadar {
  const noteText = state.notes.flatMap((note) => [note.summary, ...note.saidTrack, ...note.learnedTrack]).join(" ");
  const countSignal = (signals: string[]) => signals.reduce((count, signal) => count + (noteText.includes(signal) ? 1 : 0), 0);
  const max = Math.max(6, state.notes.length + state.points.length + state.questions.length);

  return {
    depth: [
      { label: "事实", value: Math.max(1, countSignal(["发生", "事件", "项目"])), max },
      { label: "机制", value: Math.max(1, countSignal(["机制", "系统", "奖励"])), max },
      { label: "感受", value: Math.max(1, countSignal(["担心", "不想", "怕"])), max },
      { label: "意义", value: Math.max(1, countSignal(["意味着", "边界", "长期"])), max },
      { label: "验证", value: Math.max(1, countSignal(["验证", "复盘", "测试"])), max }
    ],
    perspectives: [
      { label: "系统论", value: state.themes.filter((theme) => theme.summary.includes("机制") || theme.summary.includes("系统")).length + 1, max },
      { label: "心理学", value: countSignal(["担心", "信任", "控制感"]), max },
      { label: "形式科学", value: state.questions.length, max },
      { label: "叙事", value: state.notes.length, max }
    ],
    assets: [
      { label: "观点", value: state.points.length, max },
      { label: "问题", value: state.questions.length, max },
      { label: "决策", value: state.decisions.length, max },
      { label: "知识债", value: state.debts.length, max }
    ],
    statuses: [
      { label: "用户确认", value: state.points.filter((point) => point.confidence === "用户确认").length, max },
      { label: "待验证", value: state.points.filter((point) => point.confidence === "待验证").length, max },
      { label: "被挑战", value: state.points.filter((point) => point.status === "被挑战中").length, max },
      { label: "已应用", value: state.debts.filter((debt) => debt.status === "已应用").length, max }
    ]
  };
}

export function generatePodcastEpisode(
  state: ProductState,
  noteId: string,
  options: { format: PodcastEpisode["format"]; voice: string }
): { episode: PodcastEpisode; nextState: ProductState } {
  const note = state.notes.find((item) => item.id === noteId) ?? state.notes[0];
  const createdAt = nowIso();
  const title = `播客：${note.title}`;
  const script = [
    `开场：今天我们回到《${note.title}》。`,
    `关键原话：“${note.keyQuote}”`,
    `第一部分，我说了什么：${note.saidTrack.slice(0, 2).join("；")}`,
    `第二部分，我学到了什么：${note.learnedTrack.slice(0, 2).join("；")}`,
    `收束问题：${note.nextQuestions[0] ?? "下一次从这个问题继续。"}`
  ].join("\n");
  const episode: PodcastEpisode = {
    id: makeId("podcast"),
    noteId: note.id,
    title,
    format: options.format,
    voice: options.voice,
    status: "ready",
    scriptReviewStatus: "待确认",
    durationSec: Math.max(180, Math.round(script.length * 0.8)),
    script,
    chapters: [
      {
        title: "开场与背景",
        startsAtSec: 0,
        summary: note.summary
      },
      {
        title: "关键原话",
        startsAtSec: 45,
        summary: note.keyQuote
      },
      {
        title: "复盘与下一问",
        startsAtSec: 120,
        summary: note.nextQuestions[0] ?? "保留一个下次追问。"
      }
    ],
    audioUrl: `local-audio://${title.replace(/\s+/g, "-")}.mp3`,
    shownotes: [
      `来源笔记：${note.title}`,
      `关键原话：${note.keyQuote}`,
      ...note.nextQuestions.slice(0, 2).map((question) => `下次追问：${question}`)
    ],
    createdAt
  };

  return {
    episode,
    nextState: {
      ...cloneState(state),
      podcastEpisodes: [episode, ...state.podcastEpisodes]
    }
  };
}

export function analyzeImportedInterview(
  state: ProductState,
  input: CorpusImportInput
): { insight: CorpusInsight; nextState: ProductState } {
  const createdAt = nowIso();
  const importId = makeId("corpus");
  const insightId = makeId("insight");
  const turns = parseCorpusTurns(input.content);
  const hostTurns = turns.filter((turn) => turn.speaker.includes("主持") || turn.speaker.includes("访谈"));
  const challengeCount = turns.filter((turn) => turn.move === "challenge").length;
  const followUpCount = turns.filter((turn) => turn.move === "follow-up").length;
  const concreteExample = turns.find((turn) => turn.content.includes("具体") || turn.content.includes("时刻"))?.content ?? turns[0]?.content ?? input.content.slice(0, 60);
  const patch: PlaybookPatch = {
    id: makeId("patch"),
    title: "先索要具体时刻，再做机制反转",
    description: "优秀样本不是直接给结论，而是先让被访者落到具体事件，再把事件翻译为机制问题。",
    sourceInsightId: insightId,
    status: "proposed",
    rules: [
      "当用户使用抽象评价时，先追问一个具体时刻。",
      "当用户已经给出具体例子后，再从机制、奖励和代价角度反问。",
      "每轮只改变一个追问动作，避免把访谈变成建议清单。"
    ],
    impact: "medium",
    createdAt
  };
  const insight: CorpusInsight = {
    id: insightId,
    importId,
    title: `${input.title}：访谈逻辑分析`,
    dimensions: [
      {
        name: "追问动作",
        score: Math.min(5, 2 + followUpCount + challengeCount),
        finding: "样本先要求具体化，再把回答推进到机制层。",
        example: concreteExample,
        recommendedAction: '在当前引擎中增加"具体时刻 -> 机制反转"的追问序列。'
      },
      {
        name: "节奏控制",
        score: Math.min(5, 3 + Math.floor(hostTurns.length / 2)),
        finding: "主持人没有急着总结，而是在回答后保留一个二次追问空间。",
        example: hostTurns[0]?.content ?? "样本中主持人先接住回答，再推进问题。",
        recommendedAction: "用户停顿时保留短留白，不立即补问题。"
      },
      {
        name: "反方推动",
        score: Math.min(5, 2 + challengeCount),
        finding: "样本会把用户叙述翻转成机制假设，帮助形成可挑战观点。",
        example: turns.find((turn) => turn.move === "challenge")?.content ?? "如果反过来看，是不是机制奖励了报喜不报忧？",
        recommendedAction: "在观点专访中增加反例和反方假设。"
      }
    ],
    improvementPlan: [],
    recommendedPatches: [patch],
    createdAt
  };

  return {
    insight,
    nextState: {
      ...cloneState(state),
      corpusImports: [
        {
          id: importId,
          title: input.title,
          mediaType: input.mediaType,
          content: input.content,
          sourceUrl: input.sourceUrl,
          status: "analyzed",
          turns,
          createdAt
        },
        ...state.corpusImports
      ],
      corpusInsights: [insight, ...state.corpusInsights],
      playbookPatches: [patch, ...state.playbookPatches]
    }
  };
}

function parseCorpusTurns(content: string): CorpusTurn[] {
  return content
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, index) => {
      const [rawSpeaker, ...rest] = line.split(/[:：]/);
      const speaker = rest.length > 0 ? rawSpeaker.trim() : index % 2 === 0 ? "主持人" : "被访者";
      const text = (rest.length > 0 ? rest.join("：") : line).trim();
      const isHost = speaker.includes("主持") || speaker.includes("访谈");
      const move: CorpusTurn["move"] = !isHost
        ? "answer"
        : index === 0
          ? "opening"
          : text.includes("反过来") || text.includes("是不是") || text.includes("代价")
            ? "challenge"
            : text.includes("具体") || text.includes("能不能") || text.includes("为什么")
              ? "follow-up"
              : "reflection";

      return {
        speaker,
        content: text,
        move
      };
    });
}

export function approvePlaybookPatch(state: ProductState, patchId: string): ProductState {
  const appliedAt = nowIso();
  const patch = state.playbookPatches.find((item) => item.id === patchId);
  if (!patch) {
    return state;
  }

  const applyPatchStatus = (item: PlaybookPatch): PlaybookPatch =>
    item.id === patchId
      ? {
          ...item,
          status: "applied",
          appliedAt
        }
      : item;

  return {
    ...cloneState(state),
    playbookPatches: state.playbookPatches.map(applyPatchStatus),
    corpusInsights: state.corpusInsights.map((insight) => ({
      ...insight,
      recommendedPatches: insight.recommendedPatches.map(applyPatchStatus)
    })),
    systemConfig: {
      ...state.systemConfig,
      version: `${state.systemConfig.version}+${patch.id.slice(-4)}`,
      interview: {
        ...state.systemConfig.interview,
        playbookVersion: `${state.systemConfig.interview.playbookVersion}+patch-${patch.id.slice(-4)}`
      }
    }
  };
}

export function buildSystemStatus(state: ProductState): SystemStatus {
  const activeSearch = state.systemConfig.search.activeProvider;
  const voiceProvider = state.systemConfig.voice.ttsProvider;
  const observations = [
    state.systemConfig.search.allowWebInInterview
      ? "联网素材允许进入专访上下文，但必须显示来源。"
      : "联网素材只用于会前准备，不进入会中追问。",
    state.systemConfig.voice.realtimeEnabled
      ? "实时语音已启用，需要检查打断、留白和转写稳定性。"
      : "实时语音当前为预留配置，原型使用文本模拟。",
    state.playbookPatches.some((patch) => patch.status === "applied")
      ? "已有用户确认的访谈策略补丁影响当前引擎。"
      : "当前引擎使用 base-v1 访谈策略。"
  ];

  return {
    configVersion: state.systemConfig.version,
    activeProviders: {
      search: activeSearch,
      voice: voiceProvider,
      interviewModel: state.systemConfig.models.interviewModel
    },
    providers: state.systemConfig.providers,
    observations
  };
}

export function buildRealtimeTurnState(session: InterviewSession, signal: RealtimeSignal): RealtimeTurnState {
  if (signal.isUserSpeaking || signal.inputLevel > 0.2) {
    return {
      phase: "listening",
      nextAction: "持续听用户说完，不抢话。",
      shouldInterrupt: false,
      confidence: Math.min(1, signal.inputLevel + 0.2)
    };
  }

  if (signal.silenceMs < 1200) {
    return {
      phase: "holding",
      nextAction: "保持留白，等待用户自然补完。",
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

export function buildYearlyReview(state: ProductState): YearlyReview {
  const coreQuestions = state.questions.slice(0, 3).map((question) => question.question);
  const changedViews = state.points
    .filter((point) => point.status === "已修正" || point.status === "被挑战中")
    .slice(0, 3)
    .map((point) => point.title);
  const unresolvedPatterns = state.themes
    .filter((theme) => theme.maturity !== "关闭")
    .slice(0, 3)
    .map((theme) => `${theme.name}：${theme.nextQuestion}`);
  const importantDecisions = state.decisions.slice(0, 3).map((decision) => decision.title);
  const usedPerspectiveWords = state.notes.map((note) => `${note.summary} ${note.learnedTrack.join(" ")}`).join(" ");
  const missingPerspectives = ["哲学", "人类学", "叙事"].filter((perspective) => !usedPerspectiveWords.includes(perspective));

  return {
    coreQuestions,
    changedViews: changedViews.length > 0 ? changedViews : ["从“团队不主动”转向“机制是否让团队承担判断”。"],
    unresolvedPatterns,
    importantDecisions,
    missingPerspectives,
    nextYearFocus: "继续追踪控制感、授权机制和问题定义权之间的关系。"
  };
}
