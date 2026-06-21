import type { EvidenceAnchor, InterviewTurn } from "./types";

/** 把 LLM 逐字摘录的用户原话匹配回它来自的 user 轮。精确子串优先；归一化(去空白/标点)子串退化匹配；
 *  匹配不到返回空数组——绝不伪造来源。只在 user 轮里找。 */
export function resolveEvidenceAnchors(
  quote: string,
  sessionId: string,
  turns: InterviewTurn[]
): EvidenceAnchor[] {
  const q = quote.trim();
  if (!q) {
    return [];
  }
  const userTurns = turns.filter((t) => t.role === "user");
  const exact = userTurns.find((t) => t.content.includes(q) || q.includes(t.content.trim()));
  if (exact) {
    return [{ sessionId, turnId: exact.id }];
  }
  const norm = (s: string) => s.replace(/[\s。，、；：！？·.,;:!?"'「」（）()]/g, "");
  const nq = norm(q);
  if (!nq) {
    return [];
  }
  const fuzzy = userTurns.find((t) => {
    const nt = norm(t.content);
    return nt.includes(nq) || nq.includes(nt);
  });
  return fuzzy ? [{ sessionId, turnId: fuzzy.id }] : [];
}
