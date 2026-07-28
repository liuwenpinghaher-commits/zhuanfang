import type { SearchBriefInput, SearchProviderId, SourceHighlight } from "../domain/types";
import { searchProviderLabels } from "./contracts";
import {
  completeCapabilityTask,
  createIdleCapabilityTask,
  degradeCapabilityTask,
  failCapabilityTask,
  startCapabilityTask,
  type CapabilityTask
} from "./task";

export interface SearchProviderInput {
  topic: string;
  providerId: SearchProviderId;
  maxSources: number;
  recencyDays: number;
}

export interface SearchProviderOutput {
  input: SearchBriefInput;
  degradedReason?: string;
}

export interface SearchProvider {
  id: SearchProviderId;
  label: string;
  description: string;
  requiresApiKey: boolean;
  search(input: SearchProviderInput): Promise<SearchProviderOutput>;
}

export interface SearchCapabilityRun {
  result: SearchBriefInput;
  task: CapabilityTask<SearchBriefInput>;
}

const localDemoSearchProvider: SearchProvider = {
  id: "local-demo",
  label: searchProviderLabels["local-demo"],
  description: "本地确定性搜索 provider，用于无网络和无 API key 场景。",
  requiresApiKey: false,
  async search(input) {
    // local-demo is fabricated placeholder research — always needs-review, never "ready".
    return {
      input: buildSearchInput(input, true)
    };
  }
};

function createShellSearchProvider(id: Exclude<SearchProviderId, "local-demo">, label: string): SearchProvider {
  return {
    id,
    label,
    description: `${label} 接入壳，真实 API key 配置前使用本地可复核输出。`,
    requiresApiKey: true,
    async search(input) {
      return {
        input: buildSearchInput(input, true),
        degradedReason: `${label} API key 未配置，已使用本地壳生成需复核简报。`
      };
    }
  };
}

const providers: Record<SearchProviderId, SearchProvider> = {
  "local-demo": localDemoSearchProvider,
  bailian: createShellSearchProvider("bailian", searchProviderLabels.bailian),
  anysearch: createShellSearchProvider("anysearch", searchProviderLabels.anysearch)
};

export function getSearchProvider(providerId: SearchProviderId): SearchProvider {
  return providers[providerId];
}

export async function executeSearchProvider(input: SearchProviderInput): Promise<SearchCapabilityRun> {
  const provider = getSearchProvider(input.providerId);
  const runningTask = startCapabilityTask(createIdleCapabilityTask<SearchBriefInput>("联网搜索"), provider.id);

  try {
    const output = await provider.search(input);
    return {
      result: output.input,
      task: output.degradedReason
        ? degradeCapabilityTask(runningTask, output.input, output.degradedReason)
        : completeCapabilityTask(runningTask, output.input)
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "搜索 provider 调用失败。";
    return {
      result: buildSearchInput(input, true),
      task: failCapabilityTask(runningTask, message)
    };
  }
}

function buildSearchInput(input: SearchProviderInput, needsReview: boolean): SearchBriefInput {
  const topic = input.topic.trim() || "本周值得讨论的 AI 产品变化";
  // Defense in depth: local-demo never presents as ready real research.
  const effectiveNeedsReview = needsReview || input.providerId === "local-demo";

  return {
    topic,
    provider: input.providerId,
    status: effectiveNeedsReview ? "needs-review" : "ready",
    summary: `${topic} 正在影响用户的产品判断、团队分工和长期主题，适合在专访里作为外部参照，而不是替代个人经验。`,
    facts: [
      `${topic} 已经从单点工具演示进入流程改造讨论，适合追问具体业务环节。`,
      `近 ${input.recencyDays} 天的材料需要和用户自己的原话交叉验证，不能直接当结论。`,
      `来源上限为 ${input.maxSources} 个，系统会优先保留能带入专访的问题素材。`
    ],
    controversies: [
      "争议：AI 产品商业化到底先验证效率提升，还是先验证用户是否愿意改变工作流。",
      "争议：外部热点会带来机会，也可能放大用户已有的焦虑和控制感。"
    ],
    opposingViews: [
      "反方观点：热点并不等于趋势，很多讨论只是短期噪声。",
      "反方观点：即使技术成熟，组织不改变决策机制也很难获得真实收益。"
    ],
    interviewAngles: [
      `专访角度：${topic} 和用户最近反复出现的真实困境有什么关系？`,
      "专访角度：把外部素材落到一个具体项目、一次冲突或一个选择上追问。"
    ],
    discussionTopics: [
      `专访切入：${topic} 对你当前判断的真实影响是什么？`,
      "哪些外部说法只是热闹，哪些能解释你最近的具体困境？",
      "如果把外部趋势落到一个项目决策上，最小验证动作是什么？"
    ],
    sourceAngles: [
      "外部趋势可能正在放大你对授权、风险和产品节奏的矛盾。",
      "不要把热点直接当结论，先追问它与你自己的历史原话是否互相印证。",
      "素材只提供角度，最终资产仍以用户确认和专访证据为准。"
    ],
    sources: createProviderSources(topic, input)
  };
}

function createProviderSources(topic: string, input: SearchProviderInput): SourceHighlight[] {
  const sourceTemplates = [
    {
      publisher:
        input.providerId === "anysearch"
          ? "AnySearch"
          : input.providerId === "local-demo"
            ? "Local Signals"
            : getSearchProvider(input.providerId).label,
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
  const limit = Math.max(3, Math.min(input.maxSources, sourceTemplates.length));

  return sourceTemplates.slice(0, limit).map((template, index) => ({
    id: `source-${input.providerId}-${Date.now()}-${index + 1}`,
    title: `${topic}：${template.suffix}`,
    // ponytail: 本地降级占位 URL,非真实来源;真实来源由 provider 返回
    url: `https://example.local/${input.providerId}/${encodeURIComponent(topic)}/${index + 1}`,
    publisher: template.publisher,
    publishedAt: new Date(Date.UTC(2026, 5, Math.max(1, 10 - index))).toISOString(),
    snippet: `${template.snippet} 搜索窗口：近 ${input.recencyDays} 天。`,
    relevanceScore: 0.94 - index * 0.07,
    usage: index === 0 ? "topic-suggestion" : index === 1 ? "interview-context" : "post-note-reference"
  }));
}
