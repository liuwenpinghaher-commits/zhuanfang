/**
 * theme-tagging.ts — 资料↔主题线软标签纯函数
 *
 * 两段信号:
 *  1. 强信号:资料文本直接含主题名 → 归属。
 *  2. 语义信号:资料与主题语料(名称 + 摘要 + 代表原话)的加权词重叠达阈值 → 归属。
 *     复用 context-pack 的中文 n-gram 分词器,捕获"谈到主题相关词但没写主题名"的资料。
 *
 * ponytail: 关键词重叠启发式,单用户(几百~几千条)规模够用且零异步/零 API。
 * 需要更强语义召回时,换 phase 3 已有的 embedding cosine。
 */
import { tokenizeMemoryGraphText } from "./context-pack";

export interface ThemeTagCandidate {
  id: string;
  name: string;
  summary?: string;
  representativeQuote?: string;
}

/** 语义信号阈值:加权重叠分(长度≥3 的词计 2 分,长度≥2 的计 1 分)达到此值即归属。 */
export const SEMANTIC_TAG_THRESHOLD = 5;

/**
 * 给一段文本(资料标题 + 内容)按主题打软标签,返回命中的主题 id 列表。
 *
 * @param text    资料标题 + 内容拼接文本
 * @param themes  候选主题(需 id/name;有 summary/representativeQuote 时参与语义匹配)
 */
export function tagSourceThemes(text: string, themes: ThemeTagCandidate[]): string[] {
  const sourceTokens = tokenizeMemoryGraphText(text);
  return themes
    .filter((theme) => {
      if (!theme.name) return false;
      // 1. 强信号:直接含主题名。
      if (text.includes(theme.name)) return true;
      // 2. 语义信号:与主题语料的加权词重叠。
      const themeTokens = tokenizeMemoryGraphText(
        `${theme.name} ${theme.summary ?? ""} ${theme.representativeQuote ?? ""}`
      );
      let score = 0;
      for (const token of themeTokens) {
        if (token.length >= 2 && sourceTokens.has(token)) {
          score += token.length >= 3 ? 2 : 1;
          if (score >= SEMANTIC_TAG_THRESHOLD) return true;
        }
      }
      return false;
    })
    .map((theme) => theme.id);
}
