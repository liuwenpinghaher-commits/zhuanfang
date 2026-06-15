import type { AiRunEvent, AuditEvent, InterviewControlAction, InterviewMode, InterviewSession, InterviewTurn, ProductState, SourceHighlight } from "./types";

export const modeLabels: Record<InterviewMode, string> = {
  daily: "日常复盘",
  decision: "决策专访",
  point: "观点专访",
  learning: "学习专访",
  organization: "组织/关系专访",
  "long-term": "长期主题专访"
};

export const nowIso = () => new Date().toISOString();

export const makeId = (prefix: string) => `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;

export const cloneState = <T extends ProductState>(state: T): T => JSON.parse(JSON.stringify(state)) as T;

export const removedExternalInstruction = "[已移除外部指令片段]";
export const noQualityEvidenceScore = 70;

export const externalInstructionPatterns: RegExp[] = [
  /忽略(?:以上|之前|前面|所有)*(?:的)?(?:系统|开发者|用户)?指令/gi,
  /(?:系统|开发者)指令/gi,
  /不要遵守(?:用户)?确认流程/gi,
  /(?:直接)?输出密钥/gi,
  /写入(?:长期)?记忆/gi,
  /ignore\s+(?:all\s+)?previous\s+instructions/gi,
  /system\s+prompt/gi,
  /developer\s+message/gi,
  /api\s*key/gi,
  /password/gi,
  /secret/gi,
  /reveal\s+the\s+system\s+prompt/gi,
  /export\s+(?:password|secret)/gi,
  /leak\s+(?:api\s*key|secret|password)/gi
];

// ── External-material sanitization (single source of truth) ──

export function sanitizeExternalMaterialText(text: string, fallback: string) {
  let sanitized = text.trim();
  for (const pattern of externalInstructionPatterns) {
    sanitized = sanitized.replace(pattern, removedExternalInstruction);
  }
  sanitized = sanitized
    .replace(new RegExp(`(?:${escapeRegExp(removedExternalInstruction)}\\s*){2,}`, "g"), `${removedExternalInstruction} `)
    .replace(/\s+/g, " ")
    .trim();
  return sanitized || fallback;
}

export function sanitizeExternalMaterialBlock(text: string, fallback: string) {
  const lines = text
    .split(/\n+/)
    .map((line) => sanitizeExternalMaterialText(line, fallback))
    .filter(Boolean);
  return lines.length > 0 ? lines.join("\n") : fallback;
}

export function sanitizeExternalMaterialList(items: string[], fallback: string) {
  return items.map((item) => sanitizeExternalMaterialText(item, fallback)).filter(Boolean);
}

export function sanitizeExternalSource(source: SourceHighlight): SourceHighlight {
  return {
    ...source,
    title: sanitizeExternalMaterialText(source.title, "已清洗的外部资料标题"),
    publisher: sanitizeExternalMaterialText(source.publisher, "来源待确认"),
    snippet: sanitizeExternalMaterialText(source.snippet, "外部资料片段已清洗，需回到原始来源核验。")
  };
}

export function pickSearchBriefText(values: string[], fallback: string) {
  const value = values.find((item) => item.trim());
  return sanitizeExternalMaterialText(value ?? fallback, fallback);
}

export function withAuditEvent(state: ProductState, event: Omit<AuditEvent, "id">): ProductState {
  return {
    ...state,
    auditEvents: [
      {
        id: makeId("audit"),
        ...event
      },
      ...(state.auditEvents ?? [])
    ]
  };
}

export function withAiRunEvent(state: ProductState, event: Omit<AiRunEvent, "id">): ProductState {
  return {
    ...state,
    aiRunEvents: [
      {
        id: makeId("ai-run"),
        ...event
      },
      ...(state.aiRunEvents ?? [])
    ]
  };
}

/** Extracts a keyword anchor from user text */
export function extractAnchor(text: string): string {
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

/** Checks if user answer is long enough for mirroring */
export function isLongUserAnswer(text: string) {
  const compactLength = text.replace(/\s/g, "").length;
  const clauseCount = text.split(/[，。；;,.!?！？]/).filter((item) => item.trim().length > 0).length;
  return compactLength >= 70 || clauseCount >= 4;
}

/** Mirrors user answer + follow-up */
export function buildMirroredFollowUp(userText: string, followUp: string) {
  return `我先复述一下：${summarizeUserAnswerForMirror(userText)}。接下来我想追问：${trimFollowUp(followUp)}`;
}

/** Helper for above */
export function summarizeUserAnswerForMirror(userText: string) {
  if (userText.includes("团队执行慢") && (userText.includes("判断") || userText.includes("边界"))) {
    return "你不是只在说团队执行慢，而是在说风险出现时，判断边界又被交回到你这里";
  }
  if ((userText.includes("救火") || userText.includes("兜底")) && userText.includes("判断")) {
    return "你不是只在说要不要继续救火，而是在说判断责任为什么总会回到你这里";
  }
  if (userText.includes("失控") && userText.includes("授权")) {
    return "你不是只在说授权会不会失控，而是在说自己能不能承受放手后的短期代价";
  }

  const anchor = extractAnchor(userText);
  return `你不是只在说“${anchor}”，而是在说它背后的责任、边界和真实代价`;
}

/** Checks if follow-up is mirrored format */
export function isMirroredFollowUp(followUp: string) {
  return followUp.startsWith("我先复述一下：");
}

/** Trims "接下来我想追问：" prefix */
export function trimFollowUp(followUp: string) {
  return followUp.replace(/^我先复述一下：.+?。接下来我想追问：/, "").trim();
}

/** Shortens user quote for display */
export function shortUserQuote(text: string) {
  const normalized = text.replace(/[，。！？、,.!?]/g, " ").replace(/\s+/g, " ").trim();
  return normalized.length > 18 ? `${normalized.slice(0, 18)}...` : normalized || "这个新线索";
}

/** Finds index of last turn by role */
export function findLastTurnIndex(turns: InterviewTurn[], role: InterviewTurn["role"]) {
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    if (turns[index].role === role) {
      return index;
    }
  }
  return -1;
}

/** Finds pending control action in session */
export function findPendingControlAction(session: InterviewSession): InterviewControlAction | undefined {
  const lastUserTurnIndex = findLastTurnIndex(session.turns, "user");
  for (let index = session.turns.length - 1; index > lastUserTurnIndex; index -= 1) {
    const turn = session.turns[index];
    if (turn.role !== "assistant" || turn.intent !== "控制反馈") {
      continue;
    }
    if (turn.content.includes("先跳过")) {
      return "skip";
    }
    if (turn.content.includes("放慢一点")) {
      return "softer";
    }
    if (turn.content.includes("更直接")) {
      return "sharper";
    }
    if (turn.content.includes("换个角度")) {
      return "different-angle";
    }
    if (turn.content.includes("阶段总结")) {
      return "summary";
    }
    if (turn.content.includes("不保存")) {
      return "do-not-save";
    }
  }
  return undefined;
}

/** Applies control action to follow-up */
export function applyPendingControlToFollowUp(action: InterviewControlAction, userText: string, followUp: string) {
  const anchor = extractAnchor(userText);
  const mirrored = isMirroredFollowUp(followUp);
  switch (action) {
    case "softer":
      if (mirrored) {
        return `我先放慢一点，${followUp} 我们先把事实说清楚，再看它是不是机制问题。`;
      }
      return `我先放慢一点，先把事实说清楚：围绕“${anchor}”，刚才具体发生了什么？我们先不急着下判断，再看它是不是机制问题。`;
    case "sharper":
      if (mirrored) {
        return `我会更直接一点，但${followUp}`;
      }
      return `我会更直接一点，先挑战一个前提：${trimFollowUp(followUp)}`;
    case "different-angle":
      if (mirrored) {
        return `沿着刚才换的角度看，${followUp}`;
      }
      return `沿着刚才换的角度看，这更像一个机制问题：${trimFollowUp(followUp)}`;
    case "skip":
      if (mirrored) {
        return `不回到刚才跳过的问题。${followUp}`;
      }
      return `不回到刚才跳过的问题。你现在提到“${shortUserQuote(userText)}”，我们从这个新线索开始：它具体发生在哪个项目里？`;
    case "summary":
      return mirrored ? `我先接着做收束：${followUp}` : `我先接着做收束：${trimFollowUp(followUp)}`;
    case "do-not-save":
      return mirrored ? `本次仍按不保存处理。${followUp}` : `本次仍按不保存处理。${trimFollowUp(followUp)}`;
  }
}

export function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function daysBetween(startIso: string, endIso: string) {
  const start = Date.parse(startIso);
  const end = Date.parse(endIso);
  if (Number.isNaN(start) || Number.isNaN(end)) {
    return 0;
  }
  return Math.max(0, Math.floor((end - start) / 86_400_000));
}

export function getReferenceMaterialPublisher(sourceUrl: string) {
  try {
    return new URL(sourceUrl).hostname.replace(/^www\./, "") || "导入资料";
  } catch {
    return "导入资料";
  }
}

export function formatSearchTraceSourceLabel(source: import("./types").SourceHighlight) {
  return `${source.publisher}｜${source.title}`;
}

