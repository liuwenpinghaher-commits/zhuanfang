import type { InterviewTurn, KnowledgeChunk, ProductState } from "./types";
import { makeId, nowIso } from "./utils";
import { tokenizeMemoryGraphText } from "./context-pack";

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
