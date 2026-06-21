import type { ChatCitation, ChatMessage, ChatSession, InterviewTurn, KnowledgeChunk, KnowledgeSourceType, ProductState } from "./types";
import { cloneState, makeId, nowIso, withAuditEvent } from "./utils";
import { tokenizeMemoryGraphText } from "./context-pack";
import { cosineSimilarity } from "./vector";

/** chat 会话总数上限：每个 ProductState 最多保留的会话数，超出按 updatedAt 升序淘汰最旧。 */
const MAX_CHAT_SESSIONS = 50;
/** 单会话消息上限：单个会话最多保留的消息条数，超出截断最旧。 */
const MAX_CHAT_MESSAGES = 200;

/** 标题截断的字符上限：足以辨识来源，又不至于把整段正文塞进标题。 */
const TITLE_LIMIT = 60;
/** material 正文截断上限：参考资料体量大，v1 每 importSource 一块，取合理上限。 */
const MATERIAL_TEXT_LIMIT = 2000;

function truncate(text: string, limit: number): string {
  const trimmed = text.trim();
  return trimmed.length > limit ? `${trimmed.slice(0, limit)}…` : trimmed;
}

function makeChunk(
  sourceType: KnowledgeChunk["sourceType"],
  sourceId: string,
  title: string,
  text: string,
  createdAt: string,
): KnowledgeChunk {
  const cleanText = text.trim();
  return {
    id: makeId("kc"),
    sourceType,
    sourceId,
    title: title.trim(),
    text: cleanText,
    keywords: [...tokenizeMemoryGraphText(cleanText)],
    createdAt,
    // 离线切块阶段不挂 embedding——嵌入在后续异步阶段补齐。
  };
}

/**
 * 跨源切块：把蒸馏资产 + 参考资料 + 冷层逐字 transcript 切成统一的 KnowledgeChunk。
 *
 * 纯函数、不可变、不嵌入。transcript 的逐字稿不在 ProductState 里（属冷层），
 * 由调用方经 rawTurnsBySession 传入；缺该会话的逐字稿则跳过 transcript 切块。
 */
export function buildKnowledgeChunks(
  state: ProductState,
  rawTurnsBySession: Map<string, InterviewTurn[]>,
): KnowledgeChunk[] {
  const createdAt = nowIso();
  const chunks: KnowledgeChunk[] = [];

  // memory → record.text
  for (const record of state.memoryRecords) {
    const text = record.text;
    chunks.push(makeChunk("memory", record.id, truncate(text, TITLE_LIMIT), text, createdAt));
  }

  // theme → name + summary + representativeQuote
  for (const theme of state.themes) {
    const text = `${theme.name} ${theme.summary} ${theme.representativeQuote}`.trim();
    chunks.push(makeChunk("theme", theme.id, theme.name, text, createdAt));
  }

  // point → title + content
  for (const point of state.points) {
    const text = `${point.title} ${point.content}`.trim();
    chunks.push(makeChunk("point", point.id, point.title, text, createdAt));
  }

  // decision → title + choice
  for (const decision of state.decisions) {
    const text = `${decision.title} ${decision.choice}`.trim();
    chunks.push(makeChunk("decision", decision.id, decision.title, text, createdAt));
  }

  // debt → concept + context
  for (const debt of state.debts) {
    const text = `${debt.concept} ${debt.context}`.trim();
    chunks.push(makeChunk("debt", debt.id, debt.concept, text, createdAt));
  }

  // note → summary + keyQuote
  for (const note of state.notes) {
    const text = `${note.summary} ${note.keyQuote}`.trim();
    const title = note.title?.trim() || truncate(note.summary, TITLE_LIMIT);
    chunks.push(makeChunk("note", note.id, title, text, createdAt));
  }

  // material → 每个 importSource 一块，正文截断
  for (const source of state.importSources) {
    const text = truncate(source.content, MATERIAL_TEXT_LIMIT);
    chunks.push(makeChunk("material", source.id, source.title, text, createdAt));
  }

  // transcript → 逐字稿冷层，按 user 轮一块
  for (const session of state.sessions) {
    const turns = rawTurnsBySession.get(session.id);
    if (!turns) continue;
    for (const turn of turns) {
      if (turn.role !== "user") continue;
      chunks.push(
        makeChunk("transcript", `${session.id}#${turn.id}`, session.title ?? session.id, turn.content, createdAt),
      );
    }
  }

  return chunks;
}

/** 单个可索引来源的引用：类型 + 该来源的稳定 id。 */
export interface SourceRef {
  sourceType: KnowledgeSourceType;
  sourceId: string;
}

/** 两个 ProductState 之间可索引来源的增量：内容变化的（新增/修改）与被删除的。 */
export interface IndexDiff {
  changed: SourceRef[];
  removed: SourceRef[];
}

/** 一个可索引数组在 diff 时的描述：sourceType + 取 id + 该来源数组的取值器。 */
interface DiffableArray {
  sourceType: KnowledgeSourceType;
  pick: (state: ProductState) => ReadonlyArray<{ id: string }>;
}

// material / transcript 不在此 diff 内：material 由 import 端点补、transcript 由 /end 降冷后补，
// 它们的内容不完全（或根本不）落在 ProductState 的对应数组里。
const DIFFABLE_ARRAYS: DiffableArray[] = [
  { sourceType: "note", pick: (s) => s.notes },
  { sourceType: "memory", pick: (s) => s.memoryRecords },
  { sourceType: "theme", pick: (s) => s.themes },
  { sourceType: "point", pick: (s) => s.points },
  { sourceType: "decision", pick: (s) => s.decisions },
  { sourceType: "debt", pick: (s) => s.debts }
];

/**
 * 持久化边界增量：比对 prev / next 的可索引资产数组（note/memory/theme/point/decision/debt），
 * 逐条按 id 配对：
 *  - next 有、prev 无 → changed（新增）
 *  - next 有、prev 有但内容变（JSON.stringify 逐条比对）→ changed（修改）
 *  - prev 有、next 无 → removed（删除）
 * 纯函数，不可变、不嵌入；material/transcript 由各自端点单独补点，不在此 diff。
 */
export function diffIndexableSources(prev: ProductState, next: ProductState): IndexDiff {
  const changed: SourceRef[] = [];
  const removed: SourceRef[] = [];

  for (const { sourceType, pick } of DIFFABLE_ARRAYS) {
    const prevItems = pick(prev);
    const nextItems = pick(next);
    const prevById = new Map(prevItems.map((it) => [it.id, it] as const));
    const nextIds = new Set(nextItems.map((it) => it.id));

    for (const item of nextItems) {
      const before = prevById.get(item.id);
      if (before === undefined) {
        changed.push({ sourceType, sourceId: item.id }); // 新增
      } else if (JSON.stringify(before) !== JSON.stringify(item)) {
        changed.push({ sourceType, sourceId: item.id }); // 修改
      }
    }

    for (const item of prevItems) {
      if (!nextIds.has(item.id)) {
        removed.push({ sourceType, sourceId: item.id }); // 删除
      }
    }
  }

  return { changed, removed };
}

/**
 * 新建一个空 chat 会话，unshift 进 chatSessions（最新在前）并记审计。
 * 超 MAX_CHAT_SESSIONS 时按 updatedAt 升序淘汰最旧，保留最新 50 个。
 * 纯函数、不可变；返回 { state, sessionId }。
 */
export function createChatSession(state: ProductState, title?: string): { state: ProductState; sessionId: string } {
  const now = nowIso();
  const sessionId = makeId("chat");
  const session: ChatSession = {
    id: sessionId,
    title: title?.trim() || "新对话",
    messages: [],
    createdAt: now,
    updatedAt: now
  };

  const next = cloneState(state);
  next.chatSessions = [session, ...next.chatSessions];
  if (next.chatSessions.length > MAX_CHAT_SESSIONS) {
    // 按 updatedAt 升序排出最旧的，保留最新 MAX_CHAT_SESSIONS 个（保持原相对顺序）。
    const evictIds = new Set(
      [...next.chatSessions]
        .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt))
        .slice(0, next.chatSessions.length - MAX_CHAT_SESSIONS)
        .map((item) => item.id)
    );
    next.chatSessions = next.chatSessions.filter((item) => !evictIds.has(item.id));
  }

  return {
    state: withAuditEvent(next, {
      type: "chat_session_created",
      label: "对话会话已创建",
      detail: session.title,
      severity: "info",
      entityType: "chat_session",
      entityId: sessionId,
      createdAt: now
    }),
    sessionId
  };
}

/**
 * 给指定会话追加一条消息（user / assistant），更新 updatedAt。
 * content 去首尾空白；单会话消息超 MAX_CHAT_MESSAGES 截断最旧（保留最新 200）。
 * 会话不存在则原样返回（引用相等）。纯函数、不可变。
 */
export function appendChatMessage(
  state: ProductState,
  sessionId: string,
  role: "user" | "assistant",
  content: string,
  citations?: ChatCitation[]
): ProductState {
  if (!state.chatSessions.some((item) => item.id === sessionId)) {
    return state;
  }

  const now = nowIso();
  const message: ChatMessage = {
    id: makeId("msg"),
    role,
    content: content.trim(),
    ...(citations && citations.length ? { citations } : {}),
    createdAt: now
  };

  const next = cloneState(state);
  next.chatSessions = next.chatSessions.map((item) => {
    if (item.id !== sessionId) return item;
    const messages = [...item.messages, message];
    return {
      ...item,
      messages: messages.length > MAX_CHAT_MESSAGES ? messages.slice(-MAX_CHAT_MESSAGES) : messages,
      updatedAt: now
    };
  });

  return next;
}

/** 改会话标题（去首尾空白）。会话不存在则该项不变。纯函数、不可变。 */
export function renameChatSession(state: ProductState, sessionId: string, title: string): ProductState {
  const next = cloneState(state);
  next.chatSessions = next.chatSessions.map((item) =>
    item.id === sessionId ? { ...item, title: title.trim(), updatedAt: nowIso() } : item
  );
  return next;
}

/** 删除指定会话。纯函数、不可变。 */
export function deleteChatSession(state: ProductState, sessionId: string): ProductState {
  const next = cloneState(state);
  next.chatSessions = next.chatSessions.filter((item) => item.id !== sessionId);
  return next;
}

/** chat prompt 里 history 拼接的最近条数上限。 */
const CHAT_HISTORY_LIMIT = 6;
/** 资料列表中每块正文截断的字符上限。 */
const CHAT_CHUNK_TEXT_LIMIT = 400;

/**
 * 召回排序：从全量 chunks 里选出与 query 最相关的前 topK。
 *  - 有 queryEmbedding 且块有 embedding → 余弦相似度排序（复用 cosineSimilarity）。
 *  - 否则关键词重叠：query 的 token 与 chunk.keywords ∪ chunk.text 的 token 交集计数。
 * 纯函数、不可变；返回前 topK 个。
 */
export function rankKnowledgeChunks(
  chunks: KnowledgeChunk[],
  queryText: string,
  queryEmbedding: number[] | undefined,
  topK: number
): KnowledgeChunk[] {
  if (queryEmbedding && queryEmbedding.length > 0) {
    const scored = chunks
      .filter((c) => Array.isArray(c.embedding) && c.embedding.length > 0)
      .map((c) => ({ chunk: c, score: cosineSimilarity(queryEmbedding, c.embedding as number[]) }))
      .sort((a, b) => b.score - a.score);
    if (scored.length > 0) {
      return scored.slice(0, topK).map((s) => s.chunk);
    }
    // 没有任何块带 embedding → 退化到关键词重叠（下方逻辑）。
  }

  const queryTokens = new Set(tokenizeMemoryGraphText(queryText));
  const scored = chunks
    .map((c) => {
      const chunkTokens = new Set([...c.keywords, ...tokenizeMemoryGraphText(c.text)]);
      let overlap = 0;
      for (const t of queryTokens) {
        if (chunkTokens.has(t)) overlap += 1;
      }
      return { chunk: c, score: overlap };
    })
    .sort((a, b) => b.score - a.score);
  return scored.slice(0, topK).map((s) => s.chunk);
}

/**
 * 构建通用 AI 助手对话 prompt。
 *  - system：私人认知助手人设 + 接地指令（优先依据用户资料并标来源编号；不足时可推断，但明确区分
 *    '你的资料显示' 与 '我的推断'，不把推断伪装成用户资料）+ 编号资料列表。
 *  - user：近 history（最多 CHAT_HISTORY_LIMIT 条）拼接 + 当前 message。
 * 纯函数、不可变。
 */
export function buildChatPrompt(
  retrieved: KnowledgeChunk[],
  history: ChatMessage[],
  message: string
): { system: string; user: string } {
  const materials = retrieved.length
    ? retrieved
        .map((c, i) => `[${i + 1}] (${c.sourceType}) ${c.title}: ${truncate(c.text, CHAT_CHUNK_TEXT_LIMIT)}`)
        .join("\n")
    : "（暂未检索到相关资料）";

  const system =
    "你是用户的私人认知助手。下面是检索到的用户自己的资料(带编号)。" +
    "优先依据这些资料回答并在用到处标注来源编号(如[1]);" +
    "资料不足时可基于常识和推理补充,但要明确区分'你的资料显示'与'我的推断'," +
    "不要把推断伪装成用户资料。\n\n" +
    `检索到的资料:\n${materials}`;

  const recent = history.slice(-CHAT_HISTORY_LIMIT);
  const historyText = recent
    .map((m) => `${m.role === "user" ? "用户" : "助手"}: ${m.content}`)
    .join("\n");

  const user = historyText
    ? `对话历史:\n${historyText}\n\n当前问题: ${message}`
    : `当前问题: ${message}`;

  return { system, user };
}
