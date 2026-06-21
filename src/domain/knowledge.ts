import type { InterviewTurn, KnowledgeChunk, KnowledgeSourceType, ProductState } from "./types";
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
