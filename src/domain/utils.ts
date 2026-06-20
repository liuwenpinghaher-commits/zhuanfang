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

// 句首/句尾常见的虚词与连接词，从锚点片段两端剥离，让锚点更接近"用户在谈的那个东西"，
// 而不带场景偏向（不再用职场/管理词表硬挑关键词）。
const ANCHOR_EDGE_FILLERS = [
  "我觉得", "我认为", "我想", "我其实", "我", "你", "他", "她", "它", "我们", "他们",
  "然后", "因为", "所以", "但是", "可是", "不过", "而且", "就是", "其实", "感觉", "可能",
  "现在", "当时", "后来", "一直", "总是", "真的", "确实", "就", "都", "也", "还", "很", "太",
  "这个", "那个", "这", "那", "的", "了", "吧", "啊", "呢", "嘛", "吗"
];

function stripAnchorEdges(segment: string): string {
  let result = segment.trim();
  let changed = true;
  while (changed) {
    changed = false;
    for (const filler of ANCHOR_EDGE_FILLERS) {
      if (result.length > filler.length && result.startsWith(filler)) {
        result = result.slice(filler.length).trim();
        changed = true;
      }
      if (result.length > filler.length && result.endsWith(filler)) {
        result = result.slice(0, result.length - filler.length).trim();
        changed = true;
      }
    }
  }
  return result;
}

/**
 * Extracts a scenario-agnostic anchor phrase from user text — the longest
 * meaningful clause, with edge filler words stripped. Deterministic, no domain
 * keyword list (a real semantic anchor needs LLM extraction; this is the offline
 * fallback). Returns "这个问题" only when nothing usable remains.
 */
export function extractAnchor(text: string): string {
  const segments = text
    .split(/[，。！？、,.!?；;：:\n]+/)
    .map((segment) => stripAnchorEdges(segment))
    .filter((segment) => segment.length > 0);
  const longest = segments.sort((a, b) => b.length - a.length)[0];
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

/**
 * Builds a scenario-agnostic one-line mirror of the user's answer. Deterministic
 * offline fallback (a faithful mirror really needs LLM summarization) — anchors on
 * the user's own longest clause without presuming a workplace/responsibility frame,
 * and gently points past the surface to "what's underneath it" so the follow-up has
 * something to land on.
 */
export function summarizeUserAnswerForMirror(userText: string) {
  const anchor = extractAnchor(userText);
  return `你说的重点不只是“${anchor}”这件事本身，更像是它背后让你在意的那层东西`;
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

