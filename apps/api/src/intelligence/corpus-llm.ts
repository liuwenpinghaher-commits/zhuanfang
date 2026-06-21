// LLM analysis of an imported interview SAMPLE: extract the interviewer's
// techniques (questioning moves, pacing, challenge style) into scored
// dimensions, an improvement plan for our engine, and a playbook patch.
// Replaces the keyword-template analyzer. Throws on failure so the route falls
// back to the deterministic analyzeImportedInterview.
import { analyzeImportedInterview, sanitizeExternalMaterialBlock, type CorpusLlmAnalysis } from "../../../../src/domain/engine";
import type { CorpusImportInput, CorpusInsight, ProductState } from "../../../../src/domain/types";
import type { BailianChatClient } from "../providers/bailian";
import { asObject, asString, asStringArray, parseJsonObjectLoose} from "./llm-json";

const IMPACTS = new Set(["low", "medium", "high"]);

const SYSTEM_PROMPT = [
  "你是一位访谈方法论分析师。用户导入了一段【优秀专访样本】，希望从中学习提问技法来改进自己的 AI 专访引擎。",
  "你的任务：分析这段样本里主持人的提问技法——索要具体事实/细节的方式、追问节奏、挑战与反方推动、视角切换、留白控制等。",
  "产出：① 若干评分维度（1-5 分）；② 给我们引擎的改进计划；③ 一条可落地的 PlaybookPatch（提炼成几条可执行规则）。",
  "铁律：只基于样本真实出现的技法，给出样本里的原话作为 example/evidence；不要编造。只输出一个 JSON 对象。"
].join("\n");

/**
 * Build the LLM user message for corpus analysis. Pure so the prompt construction
 * (including the optional user-supplied analysis focus) is unit-testable. When a
 * non-empty `focus` is provided, an explicit instruction steers the model toward
 * the technique the user wants to learn; a blank/omitted focus changes nothing.
 */
export function buildCorpusUserMessage(title: string, content: string, focus?: string): string {
  const trimmedFocus = focus?.trim();
  const lines = [
    `样本标题：${title}`,
    "",
    "=== 专访样本内容 ===",
    sanitizeExternalMaterialBlock(content, "（样本片段已清洗）").slice(0, 6000),
    "=== 样本结束 ===",
    ""
  ];
  if (trimmedFocus) {
    lines.push(`用户特别希望你重点关注：${trimmedFocus}`, "");
  }
  lines.push(
    "请输出以下结构的 JSON：",
    `{
  "dimensions": [{"name":"维度名(如 追问动作/节奏控制/反方推动)","score":1到5的整数,"finding":"这个样本在该维度做得怎样","example":"样本里的一句原话","recommendedAction":"我们引擎该怎么学"}],
  "improvementPlan": [{"title":"改进点","rationale":"样本为什么这么做","action":"我们引擎具体怎么改","expectedEngineChange":"确认后引擎行为会怎样变","evidence":"样本里的原话"}],
  "patch": {"title":"PlaybookPatch 标题","description":"一句话说明这条补丁","rules":["可执行规则1","规则2","规则3"],"ruleTypes":["与每条规则一一对应,取值 concrete-moment(索要具体时刻)/mechanism-reversal(机制反转)/follow-up(一般追问)"],"impact":"low|medium|high"}
}`
  );
  return lines.join("\n");
}

export async function analyzeCorpusWithLlm(
  state: ProductState,
  input: CorpusImportInput,
  chatClient: BailianChatClient,
  focus?: string
): Promise<{ insight: CorpusInsight; nextState: ProductState }> {
  const raw = await chatClient.complete({
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: buildCorpusUserMessage(input.title, input.content, focus) }
    ],
    responseFormat: "json",
    temperature: 0.4
  });

  const analysis = parseCorpusAnalysis(raw);
  return analyzeImportedInterview(state, input, analysis);
}

function parseCorpusAnalysis(raw: string): CorpusLlmAnalysis {
  const json = parseJsonObjectLoose(raw);
  if (!json) {
    throw new Error("LLM returned unparseable JSON");
  }

  const dimensions = asArray(json.dimensions)
    .map((item) => {
      const obj = asObject(item);
      return {
        name: asString(obj.name),
        score: typeof obj.score === "number" ? obj.score : Number(obj.score) || 3,
        finding: asString(obj.finding),
        example: asString(obj.example),
        recommendedAction: asString(obj.recommendedAction)
      };
    })
    .filter((dimension) => dimension.name && dimension.finding);

  if (dimensions.length === 0) {
    throw new Error("Corpus analysis produced no usable dimensions.");
  }

  const improvementPlan = asArray(json.improvementPlan)
    .map((item) => {
      const obj = asObject(item);
      return {
        title: asString(obj.title),
        rationale: asString(obj.rationale),
        action: asString(obj.action),
        expectedEngineChange: asString(obj.expectedEngineChange),
        evidence: asString(obj.evidence)
      };
    })
    .filter((item) => item.title && item.action);

  const patchObj = asObject(json.patch);
  const impactRaw = asString(patchObj.impact);
  const validRuleTypes = new Set(["concrete-moment", "mechanism-reversal", "follow-up"]);
  const ruleTypes = asStringArray(patchObj.ruleTypes).filter((type): type is "concrete-moment" | "mechanism-reversal" | "follow-up" =>
    validRuleTypes.has(type)
  );
  const patch = {
    title: asString(patchObj.title),
    description: asString(patchObj.description),
    rules: asStringArray(patchObj.rules),
    impact: (IMPACTS.has(impactRaw) ? impactRaw : "medium") as "low" | "medium" | "high",
    ...(ruleTypes.length ? { ruleTypes } : {})
  };

  return { dimensions, improvementPlan, patch };
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}
