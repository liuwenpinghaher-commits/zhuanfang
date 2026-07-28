/**
 * Stage-2 retrieval plane: channel quotas, low-confidence reject, boot context pack.
 * Pure functions — no I/O, no clocks except optional `now` for tests.
 */
import type {
  KnowledgeChunk,
  KnowledgeSourceType,
  MemoryRecord,
  ProductState,
  SystemConfig
} from "./types";
import { cosineSimilarity } from "./vector";

/** Lightweight tokenizer (leaf module — avoid importing context-pack and creating a cycle). */
function tokenizeMemoryGraphText(text: string): string[] {
  const stop = new Set(["用户","确认","这个","不是","而是","因为","每次","继续","问题","关键","应该","可以","如果","自己","他们","一个","需要","具体","真实","系统"]);
  const parts = text
    .toLowerCase()
    .split(/[\s,，。.!！？?、；;：:\-_/\\|()\[\]{}「」『』""''《》<>]+/g)
    .map((p) => p.trim())
    .filter((p) => p.length >= 2 && !stop.has(p));
  // also emit bigrams for CJK runs without spaces
  const extra: string[] = [];
  for (const part of parts) {
    if (/[\u4e00-\u9fff]{4,}/.test(part)) {
      for (let i = 0; i < part.length - 1; i += 1) {
        const bi = part.slice(i, i + 2);
        if (bi.length === 2) extra.push(bi);
      }
    }
  }
  return [...parts, ...extra];
}

/** Default floor: top hit below this is treated as "no reliable memory". */
export const DEFAULT_MIN_RECALL_SCORE = 0.12;

/** Boot pack approximate char budget (~4 chars ≈ 1 token for zh/en mix). */
export const DEFAULT_BOOT_CONTEXT_CHAR_BUDGET = 2400;

export type RetrievalChannel = "memory" | "material" | "transcript" | "asset";

export interface ChannelQuota {
  memory: number;
  material: number;
  transcript: number;
  asset: number;
}

export const DEFAULT_CHANNEL_QUOTA: ChannelQuota = {
  memory: 5,
  material: 3,
  transcript: 2,
  asset: 3
};

export interface ScoredHit<T> {
  item: T;
  score: number;
  channel: RetrievalChannel;
}

export interface RecallDecision {
  /** Hits that passed the floor (may be empty). */
  accepted: ScoredHit<unknown>[];
  /** True when we intentionally refuse to ground on low/empty recall. */
  rejected: boolean;
  reason?: "empty" | "below_threshold";
  topScore: number;
  threshold: number;
}

export function resolveMinRecallScore(memory?: SystemConfig["memory"]): number {
  const raw = (memory as { minRecallScore?: number } | undefined)?.minRecallScore;
  if (typeof raw === "number" && Number.isFinite(raw) && raw >= 0 && raw <= 1) {
    return raw;
  }
  return DEFAULT_MIN_RECALL_SCORE;
}

/** Apply low-confidence reject (MemX-style): empty or top1 < threshold → reject. */
export function decideRecallAcceptance(
  scored: Array<{ score: number }>,
  threshold: number = DEFAULT_MIN_RECALL_SCORE
): { rejected: boolean; reason?: "empty" | "below_threshold"; topScore: number; threshold: number } {
  if (!scored.length) {
    return { rejected: true, reason: "empty", topScore: 0, threshold };
  }
  const topScore = Math.max(...scored.map((s) => s.score));
  if (topScore < threshold) {
    return { rejected: true, reason: "below_threshold", topScore, threshold };
  }
  return { rejected: false, topScore, threshold };
}

export function channelForKnowledgeSource(sourceType: KnowledgeSourceType): RetrievalChannel {
  if (sourceType === "memory") return "memory";
  if (sourceType === "material") return "material";
  if (sourceType === "transcript") return "transcript";
  return "asset";
}

/**
 * Enforce per-channel caps while preserving global score order within each channel.
 * Prevents long import material from crowding out personal memories.
 */
export function applyChannelQuotas<T extends { sourceType: KnowledgeSourceType }>(
  ranked: Array<{ item: T; score: number }>,
  quota: ChannelQuota = DEFAULT_CHANNEL_QUOTA
): Array<{ item: T; score: number; channel: RetrievalChannel }> {
  const taken: Record<RetrievalChannel, number> = {
    memory: 0,
    material: 0,
    transcript: 0,
    asset: 0
  };
  const out: Array<{ item: T; score: number; channel: RetrievalChannel }> = [];
  for (const row of ranked) {
    const channel = channelForKnowledgeSource(row.item.sourceType);
    const limit = quota[channel];
    if (taken[channel] >= limit) continue;
    taken[channel] += 1;
    out.push({ ...row, channel });
  }
  return out;
}

/** Keyword overlap score 0..1 for free text. */
export function keywordOverlapScore(query: string, text: string): number {
  const q = [...tokenizeMemoryGraphText(query)];
  if (!q.length) return 0;
  const tokens = new Set(tokenizeMemoryGraphText(text));
  let hits = 0;
  for (const t of q) {
    if (tokens.has(t)) hits += 1;
  }
  return hits / q.length;
}

/** Hybrid score: max(cosine, keyword) when embedding present. */
export function hybridTextScore(
  query: string,
  text: string,
  queryEmbedding?: number[],
  docEmbedding?: number[]
): number {
  const kw = keywordOverlapScore(query, text);
  if (queryEmbedding?.length && docEmbedding?.length) {
    const cos = Math.max(0, cosineSimilarity(queryEmbedding, docEmbedding));
    return Math.max(cos, kw);
  }
  return kw;
}

export function scoreKnowledgeChunk(
  chunk: KnowledgeChunk,
  query: string,
  queryEmbedding?: number[]
): number {
  return hybridTextScore(query, `${chunk.title} ${chunk.text}`, queryEmbedding, chunk.embedding);
}

/**
 * Rank knowledge chunks with hybrid score, channel quotas, and reject decision.
 * Drop-in enrichment around rankKnowledgeChunks for chat / personal RAG.
 */
/** Stage-3 citation envelope — every accepted hit carries provenance for grounded answers. */
export interface CitationEnvelope {
  id: string;
  text: string;
  score: number;
  sourceType: KnowledgeSourceType | string;
  sourceId: string;
  title?: string;
  retrievedAt: string;
  channel?: RetrievalChannel;
}

export type GroundingMode = "grounded" | "partial" | "refused";

export function toCitationEnvelopes(
  chunks: KnowledgeChunk[],
  scores: number[],
  retrievedAt: string = new Date().toISOString()
): CitationEnvelope[] {
  return chunks.map((c, i) => ({
    id: c.id,
    text: c.text,
    score: scores[i] ?? 0,
    sourceType: c.sourceType,
    sourceId: c.sourceId,
    title: c.title,
    retrievedAt,
    channel: channelForKnowledgeSource(c.sourceType)
  }));
}

/** Decide answer grounding mode from recall + how many citations the model actually used. */
export function decideGroundingMode(opts: {
  rejected: boolean;
  retrievedCount: number;
  citationCount: number;
}): GroundingMode {
  if (opts.rejected || opts.retrievedCount === 0) return "refused";
  if (opts.citationCount <= 0) return "partial";
  return "grounded";
}

export function retrievePersonalKnowledge(
  chunks: KnowledgeChunk[],
  query: string,
  opts: {
    queryEmbedding?: number[];
    topK?: number;
    quota?: ChannelQuota;
    minScore?: number;
    retrievedAt?: string;
  } = {}
): {
  chunks: KnowledgeChunk[];
  scores: number[];
  citations: CitationEnvelope[];
  rejected: boolean;
  reason?: "empty" | "below_threshold";
  topScore: number;
  threshold: number;
} {
  const topK = opts.topK ?? 8;
  const threshold = opts.minScore ?? DEFAULT_MIN_RECALL_SCORE;
  const retrievedAt = opts.retrievedAt ?? new Date().toISOString();
  const scored = chunks
    .map((item) => ({ item, score: scoreKnowledgeChunk(item, query, opts.queryEmbedding) }))
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score);

  const decision = decideRecallAcceptance(scored, threshold);
  if (decision.rejected) {
    return {
      chunks: [],
      scores: [],
      citations: [],
      rejected: true,
      reason: decision.reason,
      topScore: decision.topScore,
      threshold
    };
  }

  const capped = applyChannelQuotas(scored, opts.quota ?? DEFAULT_CHANNEL_QUOTA).slice(0, topK);
  const outChunks = capped.map((c) => c.item);
  const outScores = capped.map((c) => c.score);
  return {
    chunks: outChunks,
    scores: outScores,
    citations: toCitationEnvelopes(outChunks, outScores, retrievedAt),
    rejected: false,
    topScore: decision.topScore,
    threshold
  };
}

export interface BootContextPack {
  profileSummary: string;
  recentSessionSummaries: string[];
  topSemanticFacts: string[];
  activeThemes: string[];
  memoryPolicyLine: string;
  /** Approximate character length of assembled pack. */
  charCount: number;
  /** True when content was truncated to fit budget. */
  truncated: boolean;
  /** Ready-to-inject block for system prompts. */
  text: string;
}

/**
 * Compact boot context for session open / voice instructions (token-budgeted).
 * Does not include raw transcripts or full memory dumps.
 */
export function buildBootContextPack(
  state: ProductState,
  opts: { charBudget?: number; maxSessions?: number; maxFacts?: number; maxThemes?: number } = {}
): BootContextPack {
  const charBudget = opts.charBudget ?? DEFAULT_BOOT_CONTEXT_CHAR_BUDGET;
  const maxSessions = opts.maxSessions ?? 3;
  const maxFacts = opts.maxFacts ?? 8;
  const maxThemes = opts.maxThemes ?? 4;

  const p = state.profile;
  const profileSummary = [p.name, p.role, p.industry, p.currentFocus && `关注：${p.currentFocus}`, p.longTermGoal && `长期：${p.longTermGoal}`]
    .filter(Boolean)
    .join(" · ");

  const includeSensitive = state.systemConfig.memory.includeSensitiveMemoriesInContext;
  const facts = state.memoryRecords
    .filter(
      (r) =>
        r.status === "confirmed" &&
        (includeSensitive || (r.sensitivity ?? "normal") !== "sensitive")
    )
    .sort((a, b) => (b.importance ?? 5) - (a.importance ?? 5) || b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, maxFacts)
    .map((r) => r.text.trim())
    .filter(Boolean);

  const sessions = [...state.sessions]
    .filter((s) => s.status === "completed" || s.status === "active")
    .sort((a, b) => (b.startedAt || "").localeCompare(a.startedAt || ""))
    .slice(0, maxSessions)
    .map((s) => {
      const note = state.notes.find((n) => n.sessionId === s.id);
      const line = note?.summary?.trim() || s.title || s.id;
      return line.length > 120 ? `${line.slice(0, 120)}…` : line;
    });

  const themes = state.themes
    .filter((t) => t.maturity !== "关闭")
    .slice(0, maxThemes)
    .map((t) => t.name);

  const mem = state.systemConfig.memory;
  const memoryPolicyLine = [
    mem.includeSensitiveMemoriesInContext ? "敏感记忆：可入上下文" : "敏感记忆：默认隔离",
    mem.includePendingCandidatesInContext ? "待审候选：可入上下文" : "待审候选：不入上下文",
    `外部素材策略：${mem.externalMaterialMemoryPolicy}`
  ].join("；");

  const sections: string[] = [
    `【用户画像】${profileSummary || "（未填写）"}`,
    themes.length ? `【活跃主题】${themes.join("、")}` : "",
    sessions.length ? `【近场专访】\n${sessions.map((s, i) => `${i + 1}. ${s}`).join("\n")}` : "",
    facts.length ? `【可引用事实】\n${facts.map((f, i) => `${i + 1}. ${f}`).join("\n")}` : "【可引用事实】（暂无已确认长期记忆）",
    `【记忆策略】${memoryPolicyLine}`
  ].filter(Boolean);

  let text = sections.join("\n");
  let truncated = false;
  if (text.length > charBudget) {
    text = `${text.slice(0, Math.max(0, charBudget - 1))}…`;
    truncated = true;
  }

  return {
    profileSummary,
    recentSessionSummaries: sessions,
    topSemanticFacts: facts,
    activeThemes: themes,
    memoryPolicyLine,
    charCount: text.length,
    truncated,
    text
  };
}

/** Honest system-line when recall was rejected. */
export function noReliableMemoryNotice(reason?: "empty" | "below_threshold"): string {
  if (reason === "below_threshold") {
    return "【检索说明】未找到足够相关的个人资料（相关度低于阈值）。请明确区分推断与用户已确认事实，不要编造用户记忆。";
  }
  return "【检索说明】当前没有可引用的个人资料命中。请明确区分推断与用户已确认事实，不要编造用户记忆。";
}

export function scoreMemoryTextsForReject(
  texts: string[],
  topicHint: string,
  records: MemoryRecord[],
  queryEmbedding?: number[]
): Array<{ text: string; score: number }> {
  const byText = new Map(records.map((r) => [r.text, r] as const));
  return texts.map((text) => {
    const record = byText.get(text);
    const score = hybridTextScore(topicHint, text, queryEmbedding, record?.embedding);
    return { text, score };
  });
}
