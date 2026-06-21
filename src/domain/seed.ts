import type { ProductState } from "./types";

export const initialProductState: ProductState = {
  profile: {
    name: "Mia",
    role: "产品负责人",
    industry: "AI 产品 / 创业",
    currentFocus: "把语音专访式日记从 demo 梳理成真正能长期使用的认知产品",
    longTermGoal: "建立一个能持续追踪个人判断、决策和学习变化的私人认知系统",
    preferredStrength: "standard",
    explicitBoundaries: ["不要把短暂情绪直接写成长期人格结论"]
  },
  profileSuggestions: [],
  sessions: [],
  notes: [
    {
      id: "note-seed-1",
      sessionId: "session-seed-1",
      title: "团队救火和授权边界",
      summary: "这次不是单纯抱怨团队执行，而是在触碰放手之后能否承受短期失控的问题。",
      keyQuote: "再这样我就变成项目经理了。",
      saidTrack: ["用户不想继续亲自救火。", "用户担心团队判断力不足导致项目失控。"],
      learnedTrack: ["问题可能不是单个人能力，而是机制一直奖励等用户拍板。"],
      nextQuestions: ["如果用户不救火，最坏会发生什么？"],
      createdAt: "2026-06-05T09:00:00.000Z"
    }
  ],
  points: [
    {
      id: "point-seed-1",
      title: "我不该继续亲自救火",
      content: "亲自救火短期降低风险，但长期会让团队继续等待拍板。",
      status: "被挑战中",
      confidence: "AI 推断",
      evidence: ["再这样我就变成项目经理了。"],
      relatedThemeIds: ["theme-control"],
      important: true,
      updatedAt: "2026-06-05T09:00:00.000Z"
    }
  ],
  questions: [
    {
      id: "question-seed-1",
      question: "如果我不亲自救火，最坏会发生什么？",
      whyImportant: "这是判断授权边界时必须面对的真实代价。",
      status: "正在聚焦",
      appearances: 3,
      relatedThemeIds: ["theme-control"],
      nextPrompt: "把最坏情况说具体：延期、质量、客户、团队信任分别会怎样？",
      important: true,
      updatedAt: "2026-06-05T09:00:00.000Z"
    }
  ],
  decisions: [
    {
      id: "decision-seed-1",
      title: "是否继续亲自介入项目救火",
      decisionKind: "候选决策",
      confirmationStatus: "待用户确认",
      choice: "减少直接接管，改为定义判断标准和复盘机制。",
      tradeOff: "短期项目风险会增加，但团队才可能承担真实判断。",
      riskHypothesis: "如果没有用户兜底，团队会暴露关键判断缺口。",
      reviewAt: "2026-07-01",
      status: "待复盘",
      updatedAt: "2026-06-05T09:00:00.000Z"
    }
  ],
  debts: [
    {
      id: "debt-seed-1",
      concept: "组织惯性",
      context: "用户多次提到团队等自己拍板，可能不是个人能力问题，而是机制问题。",
      whyImportant: "它能帮助用户把“人不主动”转译成“系统奖励了什么”。",
      status: "待了解",
      nextQuestion: "上次提到组织惯性，你后来能用自己的话解释它了吗？",
      updatedAt: "2026-06-05T09:00:00.000Z"
    }
  ],
  themes: [
    {
      id: "theme-control",
      name: "控制感",
      summary: "用户经常在团队授权、项目风险和亲自下场之间摆动。",
      maturity: "聚焦",
      representativeQuote: "我不是不想管，是不想每次都替他们兜底。",
      appearances: 5,
      nextQuestion: "如果你允许短期失控，最坏会发生什么？",
      updatedAt: "2026-06-05T09:00:00.000Z",
      createdAt: "2026-06-05T09:00:00.000Z"
    },
    {
      id: "theme-role",
      name: "问题定义权",
      summary: "用户反复区分纯交付和真正的问题定义。",
      maturity: "重复",
      representativeQuote: "我不想把产品做成普通记录工具。",
      appearances: 3,
      nextQuestion: "你说的问题定义权，具体包括哪些不可让渡的判断？",
      updatedAt: "2026-06-08T09:00:00.000Z",
      createdAt: "2026-06-08T09:00:00.000Z"
    }
  ],
  memoryCorrections: [],
  searchBriefs: [],
  podcastEpisodes: [],
  corpusImports: [],
  corpusInsights: [],
  playbookPatches: [],
  memoryRecords: [],
  memoryCandidates: [],
  memoryEdges: [],
  importSources: [
    {
      id: "source-control-note",
      title: "团队授权与控制感：一篇随手记",
      sourceType: "text",
      content: "在团队授权和亲自下场之间反复摇摆，控制感是核心议题。不想每次都替团队兜底，又怕短期失控。授权意味着接受短暂的不确定性，而不是放弃判断权。",
      status: "chunked",
      sensitivity: "normal",
      relatedThemeIds: ["theme-control"],
      chunkIds: [],
      createdAt: "2026-06-06T09:00:00.000Z",
      updatedAt: "2026-06-06T09:00:00.000Z"
    }
  ],
  ragChunks: [],
  configVersions: [],
  auditEvents: [],
  aiRunEvents: [],
  workflowRuns: [],
  operationalChecks: [],
  revision: 0,
  systemConfig: {
    version: "local-demo-2026.06.10",
    providers: [
      {
        id: "bailian-responses",
        kind: "search",
        label: "百炼 Responses 内置联网",
        status: "needs-key",
        active: true,
        description: "使用 qwen3.7-plus Responses API 的 web_search / web_extractor / code_interpreter 内置工具生成联网素材。",
        lastCheckedAt: "2026-06-10T00:00:00.000Z"
      },
      {
        id: "local-demo-search",
        kind: "search",
        label: "Local Demo Search",
        status: "ready",
        active: false,
        description: "本地确定性搜索模拟器，用于在没有 API Key 时验证联网素材业务流。",
        lastCheckedAt: "2026-06-10T00:00:00.000Z"
      },
      {
        id: "anysearch",
        kind: "search",
        label: "AnySearch",
        status: "needs-key",
        active: false,
        description: "外接 AnySearch /v1/search，可用 API key 或显式匿名模式生成真实来源素材。",
        lastCheckedAt: "2026-06-10T00:00:00.000Z"
      },
      {
        id: "bailian-qwen-tts",
        kind: "voice",
        label: "百炼 CosyVoice",
        status: "needs-key",
        active: true,
        description: "使用 cosyvoice-v3-plus 和默认 longyuan_v3 把播客脚本渲染为真实音频；Qwen-TTS 作为短文本声音设计备选。",
        lastCheckedAt: "2026-06-10T00:00:00.000Z"
      },
      {
        id: "bailian-character",
        kind: "llm",
        label: "百炼角色扮演 qwen-plus-character",
        status: "needs-key",
        active: true,
        description: "参考百炼角色扮演模型，用于自然专访口吻、多角色前缀和 partial assistant 输出。",
        lastCheckedAt: "2026-06-10T00:00:00.000Z"
      },
      {
        id: "browser-local-storage",
        kind: "storage",
        label: "Browser LocalStorage",
        status: "ready",
        active: true,
        description: "当前原型的数据持久化底座。",
        lastCheckedAt: "2026-06-10T00:00:00.000Z"
      },
      {
        id: "deterministic-engine",
        kind: "llm",
        label: "Deterministic Interview Engine",
        status: "ready",
        active: true,
        description: "本地规则引擎，模拟专访追问、总结和资产沉淀。",
        lastCheckedAt: "2026-06-10T00:00:00.000Z"
      }
    ],
    search: {
      activeProvider: "bailian",
      recencyDays: 14,
      maxSources: 5,
      allowWebInInterview: true
    },
    voice: {
      ttsProvider: "bailian",
      defaultVoice: "longanyang",
      podcastVoice: "longanhuan",
      podcastFormat: "solo",
      realtimeMode: "cascade"
    },
    models: {
      planningModel: "qwen3.7-plus",
      interviewModel: "qwen-plus-character",
      synthesisModel: "qwen3.7-plus"
    },
    interview: {
      playbookVersion: "base-v1",
      launchMode: "immersive",
      silenceHoldMs: 1200,
      maxFollowUpDepth: 4,
      guidanceEnabled: true,
      guidanceFrequency: "medium",
      maxGuidancePerTurn: 2,
      minGuidanceIntervalMs: 5000,
      challengeBudgetPerSession: 3
    },
    memory: {
      includeSensitiveMemoriesInContext: false,
      includePendingCandidatesInContext: false,
      externalMaterialMemoryPolicy: "review-only"
    },
    research: {
      autoScheduleEnabled: false,
      scheduleIntervalMin: 1440
    }
  }
};
