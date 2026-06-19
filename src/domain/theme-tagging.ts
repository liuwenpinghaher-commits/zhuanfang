/**
 * theme-tagging.ts — 资料↔主题线软标签纯函数
 *
 * 朴素子串匹配：资料文本含主题名即归属。
 * ponytail: 当前用子串匹配；需要语义匹配时升级到 embedding 相似度。
 */

/**
 * 给一段文本按主题名做子串匹配，返回命中的主题 id 列表。
 *
 * @param text    资料标题 + 内容拼接文本
 * @param themes  候选主题列表（需有 id 和 name）
 */
export function tagSourceThemes(
  text: string,
  themes: { id: string; name: string }[]
): string[] {
  return themes
    .filter((t) => t.name && text.includes(t.name))
    .map((t) => t.id);
}
