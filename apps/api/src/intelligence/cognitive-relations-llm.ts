// 轻量推理(本体论欠账②)· LLM 语义精判半。
//
// 输入:域层 collectCandidatePointPairs 粗筛出的「同主题、不同 id」观点对。
// 输出:CognitiveRelations —— 每对判为 contradict(语义对立)/ supersede(后者修正深化前者)/ none。
// 域层 applyCognitiveRelations 再把它写回 state(双向 contradictsPointIds / supersededByPointId)。
//
// Fail-safe 铁律(绝不阻塞 finalize):无 chatClient / 无候选对 / 预算耗尽 / 解析失败 /
// 任意抛错 → 返回空关系。判定走【批量单次】LLM 调用(候选对已在域层封顶,prompt 有界)。
import type { PointAsset } from "../../../../src/domain/types";
import type { CognitiveRelations } from "../../../../src/domain/reasoning";
import type { BailianChatClient } from "../providers/bailian";
import type { LlmBudget } from "../llm-budget";
import { asArray, asObject, asString, parseJsonObjectLoose } from "./llm-json";

const EMPTY: CognitiveRelations = { contradicts: [], supersedes: [] };

const SYSTEM_PROMPT = [
  "你是一位严谨的认知关系审校员。下面给你若干【观点对】(都来自同一长期主题),逐对判断它们的关系,只能选一种:",
  "  · contradict(语义对立):两条观点在【同一问题】上给出互相冲突、不能同时为真的判断(例:「应该集权拍板」vs「应该充分放权」)。",
  "  · supersede(修正/取代):后产生的一条是对前一条的【修正、纠偏或更成熟的深化】,使前一条不再代表当前立场(不是简单补充,而是立场升级/改写)。判 supersede 时必须指出哪一条更新(newer)。",
  "  · none(无关或仅相关):角度不同、各自成立、只是话题相关、或你拿不准 —— 一律判 none。",
  "判定铁律:【宁可判 none,绝不硬凑】。只有当你能明确说出「它们在同一个具体问题上对立 / 后者明确改写了前者」时才判 contradict/supersede;模糊、互补、并列、只是措辞不同,都判 none。",
  "newer 只能取该对里给出的两个 id 之一;不要臆造新 id。",
  "只输出一个 JSON 对象,不要 Markdown、不要解释。"
].join("\n");

/**
 * 让 LLM 对候选观点对做语义判定。
 * @param pairs   域层粗筛出的观点对(已 symmetric 去重、已封顶)。
 * @param chatClient  无则直接返回空(离线/无 key)。
 * @param budget  per-session 预算;tryConsume 失败(超预算)→ 返回空。
 * @param sessionId  预算计数 key(沿用 finalize/memory-extraction 的 session.id)。
 */
export async function judgeCognitiveRelations(
  pairs: Array<[PointAsset, PointAsset]>,
  chatClient: BailianChatClient | undefined,
  budget: LlmBudget,
  sessionId: string
): Promise<CognitiveRelations> {
  // 无候选对:连预算都不消费(纯省),直接空。
  if (pairs.length === 0) return EMPTY;
  if (!chatClient) return EMPTY;
  if (!budget.tryConsume(sessionId)) {
    console.warn(JSON.stringify({ event: "llm_budget_exceeded", capability: "cognitive_relations", sessionId }));
    return EMPTY;
  }

  // 合法对集合(归一键 a|b,按 id 字典序),用于丢弃 LLM 回的「没送过的对 / 幻觉 id」。
  const validPairs = new Map<string, [string, string]>();
  for (const [a, b] of pairs) {
    validPairs.set(pairKey(a.id, b.id), a.id < b.id ? [a.id, b.id] : [b.id, a.id]);
  }

  try {
    const raw = await chatClient.complete({
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: buildPrompt(pairs) }
      ],
      responseFormat: "json",
      temperature: 0.2,
      maxTokens: 2000
    });
    return parseRelations(raw, validPairs);
  } catch (error) {
    console.warn(JSON.stringify({
      event: "cognitive_relations_fallback",
      sessionId,
      error: error instanceof Error ? error.message : String(error)
    }));
    return EMPTY;
  }
}

function buildPrompt(pairs: Array<[PointAsset, PointAsset]>): string {
  const blocks = pairs.map(([a, b], i) => {
    return [
      `对 ${i + 1}:`,
      `  a(id=${a.id}, 时间=${a.updatedAt}): ${a.title} —— ${a.content}`,
      `  b(id=${b.id}, 时间=${b.updatedAt}): ${b.title} —— ${b.content}`
    ].join("\n");
  });
  return [
    "=== 待判定的观点对 ===",
    blocks.join("\n"),
    "=== 结束 ===",
    "",
    "请输出 JSON(relations 逐对给出;判 none 的可省略或显式写 none):",
    `{"relations":[{"a":"a的id","b":"b的id","verdict":"contradict|supersede|none","newer":"仅 supersede 时填:a或b的id,表示更新的那条"}]}`
  ].join("\n");
}

function parseRelations(raw: string, validPairs: Map<string, [string, string]>): CognitiveRelations {
  const json = parseJsonObjectLoose(raw);
  if (!json) return EMPTY;

  const contradicts: Array<[string, string]> = [];
  const supersedes: Array<{ oldId: string; newId: string }> = [];
  const seen = new Set<string>(); // 同一对只采一次

  for (const item of asArray(json.relations)) {
    const obj = asObject(item);
    const aId = asString(obj.a);
    const bId = asString(obj.b);
    if (!aId || !bId) continue;

    const key = pairKey(aId, bId);
    const canonical = validPairs.get(key);
    if (!canonical || seen.has(key)) continue; // 丢弃没送过的对 / 重复

    const verdict = asString(obj.verdict);
    if (verdict === "contradict") {
      seen.add(key);
      contradicts.push([canonical[0], canonical[1]]);
    } else if (verdict === "supersede") {
      const newer = asString(obj.newer);
      // newer 必须是该对里的 id 之一(无幻觉);否则丢弃这条判定。
      if (newer !== aId && newer !== bId) continue;
      seen.add(key);
      const older = newer === aId ? bId : aId;
      supersedes.push({ oldId: older, newId: newer });
    }
    // none / 未知 verdict:略过(不计入 seen,本就无副作用)。
  }

  return { contradicts, supersedes };
}

function pairKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}
