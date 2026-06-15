import type {
  CorpusImportInput,
  CorpusInsight,
  CorpusTurn,
  PlaybookPatch,
  ProductState,
  SystemConfig,
} from "./types";

import { cloneState, makeId, nowIso, withAuditEvent, withAiRunEvent, sanitizeExternalMaterialText, sanitizeExternalMaterialBlock, pickSearchBriefText } from "./utils";
import { withGeneratedArtifactWorkflowRun, withSystemConfigVersion, removeVersionSuffix } from "./engine";
import { withMemoryCandidateReview } from "./memoryReview";

/** LLM-produced analysis content. When supplied, it replaces the deterministic
 *  templated dimensions/plan/patch while reusing all the state-plumbing below. */
export interface CorpusLlmAnalysis {
  dimensions: Array<{ name: string; score: number; finding: string; example: string; recommendedAction: string }>;
  improvementPlan: Array<{ title: string; rationale: string; action: string; expectedEngineChange: string; evidence: string }>;
  patch: { title: string; description: string; rules: string[]; impact: "low" | "medium" | "high" };
}

function clampCorpusScore(value: number): number {
  if (!Number.isFinite(value)) {
    return 3;
  }
  return Math.max(1, Math.min(5, Math.round(value)));
}

export function analyzeImportedInterview(
  state: ProductState,
  input: CorpusImportInput,
  analysis?: CorpusLlmAnalysis
): { insight: CorpusInsight; nextState: ProductState } {
  const createdAt = nowIso();
  const importId = makeId("corpus");
  const insightId = makeId("insight");
  const sanitizedInput: CorpusImportInput = {
    ...input,
    title: sanitizeExternalMaterialText(input.title, "导入专访样本"),
    content: sanitizeExternalMaterialBlock(input.content, "导入样本片段已清洗，需回到原始材料核验。")
  };
  const turns = parseCorpusTurns(sanitizedInput.content);
  const hostTurns = turns.filter((turn) => turn.speaker.includes("主持") || turn.speaker.includes("访谈"));
  const challengeCount = turns.filter((turn) => turn.move === "challenge").length;
  const followUpCount = turns.filter((turn) => turn.move === "follow-up").length;
  const concreteExample =
    turns.find((turn) => turn.content.includes("具体") || turn.content.includes("时刻"))?.content ??
    turns[0]?.content ??
    sanitizedInput.content.slice(0, 60);
  const patch: PlaybookPatch = {
    id: makeId("patch"),
    title: analysis?.patch.title?.trim() || "先索要具体时刻，再做机制反转",
    description:
      analysis?.patch.description?.trim() ||
      "优秀样本不是直接给结论，而是先让被访者落到具体事件，再把事件翻译为机制问题。",
    sourceInsightId: insightId,
    sourceImportId: importId,
    sourceTitle: sanitizedInput.title,
    ...(sanitizedInput.sourceUrl ? { sourceUrl: sanitizedInput.sourceUrl } : {}),
    status: "proposed",
    rules:
      analysis?.patch.rules?.filter((rule) => rule.trim()).length
        ? analysis.patch.rules.filter((rule) => rule.trim())
        : [
            "当用户使用抽象评价时，先追问一个具体时刻。",
            "当用户已经给出具体例子后，再从机制、奖励和代价角度反问。",
            "每轮只改变一个追问动作，避免把访谈变成建议清单。"
          ],
    impact: analysis?.patch.impact ?? "medium",
    createdAt
  };
  const dimensions = analysis?.dimensions?.length
    ? analysis.dimensions.slice(0, 6).map((dimension) => ({
        name: dimension.name,
        score: clampCorpusScore(dimension.score),
        finding: dimension.finding,
        example: dimension.example,
        recommendedAction: dimension.recommendedAction
      }))
    : [
        {
          name: "追问动作",
          score: Math.min(5, 2 + followUpCount + challengeCount),
          finding: "样本先要求具体化，再把回答推进到机制层。",
          example: concreteExample,
          recommendedAction: "在当前引擎中增加“具体时刻 -> 机制反转”的追问序列。"
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
      ];
  const improvementPlan = analysis?.improvementPlan?.length
    ? analysis.improvementPlan.slice(0, 6).map((item) => ({
        title: item.title,
        rationale: item.rationale,
        action: item.action,
        expectedEngineChange: item.expectedEngineChange,
        evidence: item.evidence
      }))
    : [
        {
          title: "具体时刻优先",
          rationale: "样本面对抽象评价时没有立刻解释或建议，而是先把被访者带回一个可复盘的具体场景。",
          action: "用户使用“很难、很乱、不主动”等抽象评价时，先追问最近一次具体时刻。",
          expectedEngineChange: "确认后，引擎会在抽象评价后优先触发“索要具体时刻”的追问动作。",
          evidence: concreteExample
        },
        {
          title: "机制反转追问",
          rationale: "样本在拿到具体例子后，会把个体表现翻转成机制、奖励和代价问题。",
          action: "用户给出具体事件后，从机制奖励、隐性代价或反方假设继续追问。",
          expectedEngineChange: "确认后，引擎会在具体例子之后更稳定地触发“机制反转”策略。",
          evidence: turns.find((turn) => turn.move === "challenge")?.content ?? "如果反过来看，是不是机制奖励了报喜不报忧？"
        },
        {
          title: "单步节奏控制",
          rationale: "样本每轮只推进一个动作，避免把自然专访变成建议清单。",
          action: "一次只问一个问题；用户停顿时先留白，再补短反馈。",
          expectedEngineChange: "确认后，引擎会更偏向短反馈、留白和单步追问，而不是连续输出多个建议。",
          evidence: hostTurns[0]?.content ?? "样本中主持人先接住回答，再推进问题。"
        }
      ];
  const insight: CorpusInsight = {
    id: insightId,
    importId,
    title: `${sanitizedInput.title}：访谈逻辑分析`,
    dimensions,
    improvementPlan,
    recommendedPatches: [patch],
    createdAt
  };

  const stateWithCreationEvents = withAiRunEvent(
    withAuditEvent(
      withExternalCorpusMemoryCandidate({
        ...cloneState(state),
        corpusImports: [
          {
            id: importId,
            title: sanitizedInput.title,
            mediaType: sanitizedInput.mediaType,
            content: sanitizedInput.content,
            sourceUrl: sanitizedInput.sourceUrl,
            status: "analyzed",
            turns,
            createdAt
          },
          ...state.corpusImports
        ],
        corpusInsights: [insight, ...state.corpusInsights],
        playbookPatches: [patch, ...state.playbookPatches]
      }, sanitizedInput, importId, insight, createdAt),
      {
        type: "corpus_import_analyzed",
        label: "语料样本已分析",
        detail: `《${sanitizedInput.title}》生成 ${insight.dimensions.length} 个分析维度和 ${insight.recommendedPatches.length} 个 PlaybookPatch。`,
        severity: "info",
        entityType: "corpus_import",
        entityId: importId,
        createdAt
      }
    ),
    {
      workflow: "reference_interview_learning",
      providerId: "deterministic-engine",
      status: "succeeded",
      entityType: "corpus_import",
      entityId: importId,
      inputSummary: `${sanitizedInput.mediaType} 样本：${sanitizedInput.title}`,
      outputSummary: `生成补丁：${patch.title}`,
      estimatedTokens: sanitizedInput.content.length,
      createdAt
    }
  );
  const nextState = withGeneratedArtifactWorkflowRun(stateWithCreationEvents, {
    workflow: "import_ingestion",
    entityType: "corpus_import",
    entityId: importId,
    inputSummary: `${sanitizedInput.mediaType} 样本：${sanitizedInput.title}`
  });

  return {
    insight,
    nextState
  };
}
export function approvePlaybookPatch(state: ProductState, patchId: string): ProductState {
  const patch = state.playbookPatches.find((item) => item.id === patchId);
  if (!patch || patch.status !== "proposed") {
    return state;
  }

  const appliedAt = nowIso();
  const applyPatchStatus = (item: PlaybookPatch): PlaybookPatch =>
    item.id === patchId
      ? {
          ...item,
          status: "applied",
          appliedAt
        }
      : item;

  const stateWithPatch = {
    ...cloneState(state),
    playbookPatches: state.playbookPatches.map(applyPatchStatus),
    corpusInsights: state.corpusInsights.map((insight) => ({
      ...insight,
      recommendedPatches: insight.recommendedPatches.map(applyPatchStatus)
    }))
  };
  const nextConfig: SystemConfig = {
    ...state.systemConfig,
    version: `${state.systemConfig.version}+${patch.id.slice(-4)}`,
    interview: {
      ...state.systemConfig.interview,
      playbookVersion: `${state.systemConfig.interview.playbookVersion}+patch-${patch.id.slice(-4)}`
    }
  };
  const nextState = withSystemConfigVersion(stateWithPatch, nextConfig, {
    changedBy: "user",
    reason: `应用 PlaybookPatch：${patch.title}`,
    createdAt: appliedAt
  });

  return withAuditEvent(nextState, {
    type: "playbook_patch_applied",
    label: "PlaybookPatch 已应用",
    detail: `《${patch.title}》已进入访谈引擎，配置版本更新为 ${nextState.systemConfig.version}。`,
    severity: "warning",
    entityType: "playbook_patch",
    entityId: patch.id,
    createdAt: appliedAt
  });
}
export function formatCorpusMoveLabel(move: CorpusTurn["move"]) {
  const labels: Record<CorpusTurn["move"], string> = {
    opening: "开场",
    "follow-up": "追问",
    challenge: "反方挑战",
    reflection: "复述",
    answer: "回答"
  };
  return labels[move];
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
export function revertPlaybookPatch(state: ProductState, patchId: string): ProductState {
  const revertedAt = nowIso();
  const patch = state.playbookPatches.find((item) => item.id === patchId);
  if (!patch || patch.status !== "applied") {
    return state;
  }

  const suffix = patch.id.slice(-4);
  const applyPatchStatus = (item: PlaybookPatch): PlaybookPatch =>
    item.id === patchId
      ? {
          ...item,
          status: "reverted",
          revertedAt
        }
      : item;

  const stateWithPatch = {
    ...cloneState(state),
    playbookPatches: state.playbookPatches.map(applyPatchStatus),
    corpusInsights: state.corpusInsights.map((insight) => ({
      ...insight,
      recommendedPatches: insight.recommendedPatches.map(applyPatchStatus)
    }))
  };
  const nextConfig: SystemConfig = {
    ...state.systemConfig,
    version: removeVersionSuffix(state.systemConfig.version, `+${suffix}`),
    interview: {
      ...state.systemConfig.interview,
      playbookVersion: removeVersionSuffix(state.systemConfig.interview.playbookVersion, `+patch-${suffix}`)
    }
  };
  const nextState = withSystemConfigVersion(stateWithPatch, nextConfig, {
    changedBy: "user",
    reason: `回滚 PlaybookPatch：${patch.title}`,
    createdAt: revertedAt,
    rollbackTarget: nextConfig.version
  });

  return withAuditEvent(nextState, {
    type: "playbook_patch_reverted",
    label: "PlaybookPatch 已回滚",
    detail: `《${patch.title}》已从访谈引擎移除，配置版本恢复为 ${nextState.systemConfig.version}。`,
    severity: "warning",
    entityType: "playbook_patch",
    entityId: patch.id,
    createdAt: revertedAt
  });
}

function withExternalCorpusMemoryCandidate(
  state: ProductState,
  input: CorpusImportInput,
  importId: string,
  insight: CorpusInsight,
  createdAt: string
): ProductState {
  if (state.systemConfig.memory.externalMaterialMemoryPolicy !== "auto-candidate") {
    return state;
  }

  const candidate = withMemoryCandidateReview({
    id: makeId("memory-candidate"),
    text: `用户正在把《${input.title}》作为外部专访样本，用来改进自己的专访追问逻辑和节奏判断。`,
    status: "pending",
    sourceType: "corpus_import",
    sourceId: importId,
    evidenceQuote: pickSearchBriefText(
      insight.dimensions.map((dimension) => dimension.example),
      input.content.slice(0, 80) || input.title
    ),
    reason: `外部语料样本《${input.title}》已生成 PlaybookPatch；根据当前记忆策略，只生成待审核候选，用户确认后才进入长期记忆。`,
    sensitivity: "normal",
    createdAt
  });

  return {
    ...state,
    memoryCandidates: [candidate, ...state.memoryCandidates]
  };
}
