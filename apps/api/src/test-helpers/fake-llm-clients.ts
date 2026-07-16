// 测试方案改造（真实性重构配套）：生产代码已剔除全部"离线确定性兜底"——LLM 能力
// 不可用即 503/429/502。测试因此不再依赖生产兜底路径充当"无 key 可跑"的替身，
// 而是在【provider 边界】注入确定性假 client（合法的测试替身），让路由测试走真实
// 的 LLM 代码路径（prompt 组装/解析/校验/落库全真）。
//
// 约定：每个 fake 返回结构完整、能通过各 intelligence 模块严格校验的 JSON——
// 生产解析器现在缺字段即抛错（宁缺毋滥的兜底填充已剔除），fake 必须给全必填字段。
import type {
  BailianChatClient,
  BailianCharacterInterviewClient,
  BailianEmbeddingClient
} from "../providers/bailian";

/** 关键字路由的假 chat client：按 messages 内容特征分发到对应的固定 JSON 产出。
 *  覆盖 finalize / pre-signals / turn-complete / 记忆抽取 / 认知关系 / 复盘 / 语料 /
 *  搜索洞察 / 播客脚本 / chat-RAG 全部消费点。 */
export function createFakeChatClient(overrides?: Partial<Record<FakeCapability, string>>): BailianChatClient {
  return {
    async complete({ messages }) {
      const text = messages.map((m) => m.content).join("\n");
      const capability = detectCapability(text);
      const override = overrides?.[capability];
      if (override !== undefined) return override;
      return CANNED[capability];
    }
  };
}

/** 恒抛错的 chat client：测"LLM 失败必须如实 5xx"。 */
export function createFailingChatClient(message = "provider unavailable (fake)"): BailianChatClient {
  return {
    async complete() {
      throw new Error(message);
    }
  };
}

/** 假专访追问 client：回一条固定追问（契约形状与真实 BailianCharacterInterviewResult 一致）。 */
export function createFakeInterviewClient(): BailianCharacterInterviewClient {
  return {
    async createAssistantTurn({ userText }) {
      return {
        providerId: "bailian-character",
        model: "fake-character-model",
        content: `（好奇地追问）你刚才提到「${userText.slice(0, 12)}」，能给一个具体发生过的时刻吗？`,
        intent: "百炼角色扮演追问"
      };
    }
  };
}

export function createFailingInterviewClient(message = "interview provider unavailable (fake)"): BailianCharacterInterviewClient {
  return {
    async createAssistantTurn() {
      throw new Error(message);
    }
  };
}

/** 确定性 1024 维假 embedding（文本哈希播种，同文本同向量）。 */
export function createFakeEmbeddingClient(): BailianEmbeddingClient {
  return {
    async embed(texts: string[]) {
      return texts.map((t) => {
        let seed = 7;
        for (let i = 0; i < t.length; i++) seed = (seed * 31 + t.charCodeAt(i)) % 100003;
        const vec = new Array<number>(1024);
        for (let i = 0; i < 1024; i++) {
          seed = (seed * 1103515245 + 12345) % 2147483648;
          vec[i] = (seed / 2147483648) * 2 - 1;
        }
        return vec;
      });
    }
  };
}

type FakeCapability =
  | "finalize"
  | "preSignals"
  | "turnComplete"
  | "memoryExtraction"
  | "cognitiveRelations"
  | "reviews"
  | "corpus"
  | "searchInsights"
  | "podcastScript"
  | "consolidate"
  | "chat";

function detectCapability(prompt: string): FakeCapability {
  if (prompt.includes("双轨笔记") && prompt.includes("keyQuote")) return "finalize";
  if (prompt.includes("pre_signals") || prompt.includes("interactionPreSignals") || prompt.includes("开场信号")) return "preSignals";
  if (prompt.includes("轮转判定器") || prompt.includes("是否已经说完")) return "turnComplete";
  if (prompt.includes("长期记住") && prompt.includes("candidates")) return "memoryExtraction";
  if (prompt.includes("认知关系审校员")) return "cognitiveRelations";
  if (prompt.includes("认知分析师") && prompt.includes("monthly")) return "reviews";
  if (prompt.includes("访谈方法论分析师")) return "corpus";
  if (prompt.includes("资料分析助手") && prompt.includes("interviewAngles")) return "searchInsights";
  if (prompt.includes("播客")) return "podcastScript";
  if (prompt.includes("整理一个人的长期记忆")) return "consolidate";
  return "chat";
}

const CANNED: Record<FakeCapability, string> = {
  finalize: JSON.stringify({
    summary: "这次对话把「测试主题」推进到了可验证阶段。",
    keyQuote: "我在测试里说过这句话。",
    saidTrack: ["用户复述了测试要点一。", "用户复述了测试要点二。", "用户复述了测试要点三。"],
    learnedTrack: ["被挑战的假设：测试即真实。", "新视角：先暴露再修复。"],
    nextQuestions: ["下次继续追问测试边界？"],
    points: [
      {
        title: "测试观点",
        content: "系统失败时应当如实暴露。",
        evidence: ["我在测试里说过这句话。"],
        themeRefs: []
      }
    ],
    questions: [
      { question: "测试问题：边界在哪里？", whyImportant: "决定系统的诚实度。", nextPrompt: "边界之外发生什么？", themeRefs: [] }
    ],
    decisions: [
      {
        title: "测试决策",
        choice: "选择暴露失败",
        tradeOff: "牺牲表面可用性",
        riskHypothesis: "用户可能不适应",
        reviewAt: "",
        evidence: ["我在测试里说过这句话。"],
        themeRefs: []
      }
    ],
    debts: [
      {
        concept: "测试知识债",
        context: "对话里提到但没讲清。",
        whyImportant: "补全后判断更准。",
        nextQuestion: "能举个具体例子吗？",
        evidence: ["我在测试里说过这句话。"],
        themeRefs: []
      }
    ],
    themes: [
      {
        name: "测试主题线",
        summary: "追踪测试与真实的张力。",
        representativeQuote: "我在测试里说过这句话。",
        nextQuestion: "下次追问测试盲区。",
        maturity: "萌芽"
      }
    ],
    profileSuggestions: []
  }),
  preSignals: JSON.stringify({
    emotionalTone: "engaged",
    hesitation: "low",
    knowledgeGap: "none",
    recommendedPace: "steady"
  }),
  turnComplete: JSON.stringify({ done: true, reason: "表达完整（fake）" }),
  memoryExtraction: JSON.stringify({
    candidates: [
      {
        text: "当系统失败时会如实暴露而不是伪装成功。",
        evidenceQuote: "我在测试里说过这句话。",
        sensitivity: "normal"
      }
    ]
  }),
  cognitiveRelations: JSON.stringify({ relations: [] }),
  reviews: JSON.stringify({
    monthly: {
      topTheme: "测试主题线",
      changedView: "从掩盖失败转向暴露失败。",
      avoidedQuestion: "被掩盖的失败有多少？",
      recommendedNextInterview: "下次聊聊暴露之后的修复。"
    },
    yearly: {
      coreQuestions: ["系统的诚实边界在哪里？"],
      changedViews: ["能用就能用，不能用就暴露。"],
      unresolvedPatterns: ["降级惯性"],
      importantDecisions: ["测试决策"],
      missingPerspectives: ["系统论"],
      nextYearFocus: "持续追踪真实性。"
    }
  }),
  corpus: JSON.stringify({
    dimensions: [
      {
        name: "追问动作",
        score: 4,
        finding: "样本擅长索要具体时刻。",
        example: "样本原话：那天下午你在哪里？",
        recommendedAction: "引擎应优先索要具体时刻。"
      }
    ],
    improvementPlan: [
      {
        title: "强化具体时刻索要",
        rationale: "样本用它打开细节。",
        action: "在追问模板中前置具体时刻问题。",
        expectedEngineChange: "追问更快落到事实。",
        evidence: "样本原话：那天下午你在哪里？"
      }
    ],
    patch: {
      title: "具体时刻优先",
      description: "先要时刻再要观点。",
      rules: ["先问『什么时候/在哪里』再问『怎么看』"],
      ruleTypes: ["concrete-moment"],
      impact: "medium"
    }
  }),
  searchInsights: JSON.stringify({
    summary: "这些资料只是追问线索，不是用户结论。",
    facts: ["来源[1]给出一个可核实的事实。", "来源[2]给出另一个事实。"],
    controversies: ["来源间存在方法论分歧。"],
    opposingViews: ["有观点认为相反成立。"],
    interviewAngles: ["把话题落到你上次的真实决策上。"],
    discussionTopics: ["这个变化影响了你哪个判断？"],
    sourceAngles: ["可引用来源[1]作为追问线索。"]
  }),
  podcastScript: "这是为测试生成的播客脚本正文。它基于真实笔记内容展开，长度足够被当作有效脚本。",
  consolidate: "当系统失败时会如实暴露而不是伪装成功（整合后的记忆表述）。",
  chat: "根据资料[1]，答案是：如实暴露失败。"
};
