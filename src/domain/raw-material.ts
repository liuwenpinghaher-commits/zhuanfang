import type { EvidenceAnchor, InterviewAnnotation, InterviewTurn, ProductState } from "./types";
import { cloneState, makeId, nowIso, withAuditEvent } from "./utils";

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
  // Minimum length for a turn to win via REVERSE matching (quote contains the
  // turn). Without this, trivial fillers like "嗯。"/"对。" — which sort before
  // the real source turn — get misanchored whenever they happen to be a
  // substring of a long quote.
  const MIN_REVERSE = 6;

  // 1) Exact equality wins outright — never let a substring steal an exact match.
  const exactEq = userTurns.find((t) => t.content.trim() === q);
  if (exactEq) {
    return [{ sessionId, turnId: exactEq.id }];
  }
  // 2) Forward substring: the quote is a substring of a turn (the normal case —
  //    LLM lifted a fragment of what the user said).
  const forward = userTurns.find((t) => t.content.includes(q));
  if (forward) {
    return [{ sessionId, turnId: forward.id }];
  }
  // 3) Reverse substring: the quote is longer than the turn (rare), guarded by a
  //    minimum turn length so fillers can't latch onto a long quote.
  const reverse = userTurns.find((t) => {
    const c = t.content.trim();
    return c.length >= MIN_REVERSE && q.includes(c);
  });
  if (reverse) {
    return [{ sessionId, turnId: reverse.id }];
  }

  // 4) Normalized (whitespace/punctuation-stripped) degraded matching.
  const norm = (s: string) => s.replace(/[\s。，、；：！？·.,;:!?"'「」（）()]/g, "");
  const nq = norm(q);
  if (!nq) {
    return [];
  }
  const fuzzy = userTurns.find((t) => {
    const nt = norm(t.content);
    // Forward (turn contains quote) is unguarded; reverse keeps the same
    // minimum-length guard so a normalized filler can't win either.
    return nt.includes(nq) || (nt.length >= MIN_REVERSE && nq.includes(nt));
  });
  return fuzzy ? [{ sessionId, turnId: fuzzy.id }] : [];
}

/** 在 finalize 时给一批带 evidenceQuote 的对象(记忆候选等)盖上证据锚点。
 *  已有锚点的不动；匹配不到来源的保持原样(不加 evidenceAnchors)——绝不伪造来源。 */
export function stampFinalizeAnchors<T extends { evidenceQuote?: string; evidenceAnchors?: EvidenceAnchor[] }>(
  items: T[],
  sessionId: string,
  turns: InterviewTurn[]
): T[] {
  return items.map((item) => {
    if (item.evidenceAnchors && item.evidenceAnchors.length > 0) {
      return item;
    }
    const anchors = resolveEvidenceAnchors(item.evidenceQuote ?? "", sessionId, turns);
    return anchors.length > 0 ? { ...item, evidenceAnchors: anchors } : item;
  });
}

/** 给存量 state 回填证据锚点:用各会话仍在热层的 turns,给已有的 memoryRecords / memoryCandidates
 *  补上 evidenceAnchors。已有锚点的或没有来源会话的不动;匹配不到来源的保持原样——绝不伪造来源。
 *  幂等:再次运行不会改动已盖好锚点的条目。注意须在降冷(turns 被剥离)之前跑。 */
export function backfillEvidenceAnchors(state: ProductState): ProductState {
  const turnsBySession = new Map<string, InterviewTurn[]>();
  for (const s of state.sessions) {
    turnsBySession.set(s.id, s.turns ?? []);
  }
  const stamp = <T extends { evidenceQuote?: string; evidenceAnchors?: EvidenceAnchor[]; sourceId?: string }>(
    items: T[]
  ): T[] =>
    items.map((item) => {
      if (item.evidenceAnchors?.length || !item.sourceId) {
        return item;
      }
      const turns = turnsBySession.get(item.sourceId) ?? [];
      const anchors = resolveEvidenceAnchors(item.evidenceQuote ?? "", item.sourceId, turns);
      return anchors.length ? { ...item, evidenceAnchors: anchors } : item;
    });
  return {
    ...cloneState(state),
    memoryRecords: stamp(state.memoryRecords),
    memoryCandidates: stamp(state.memoryCandidates)
  };
}

export function addAnnotation(
  state: ProductState,
  sessionId: string,
  turnId: string,
  text: string
): ProductState {
  const body = text.trim();
  if (!body) {
    return state;
  }
  const createdAt = nowIso();
  const annotation: InterviewAnnotation = { id: makeId("annotation"), sessionId, turnId, text: body, createdAt };
  const next = cloneState(state);
  next.interviewAnnotations = [annotation, ...next.interviewAnnotations];
  return withAuditEvent(next, {
    type: "annotation_created",
    label: "新增专访旁注",
    detail: body,
    severity: "info",
    entityType: "interview_session",
    entityId: sessionId,
    createdAt
  });
}

export function removeAnnotation(state: ProductState, annotationId: string): ProductState {
  const target = state.interviewAnnotations.find((a) => a.id === annotationId);
  if (!target) {
    return state;
  }
  const createdAt = nowIso();
  const next = cloneState(state);
  next.interviewAnnotations = next.interviewAnnotations.filter((a) => a.id !== annotationId);
  return withAuditEvent(next, {
    type: "annotation_removed",
    label: "删除专访旁注",
    detail: target.text,
    severity: "info",
    entityType: "interview_session",
    entityId: target.sessionId,
    createdAt
  });
}
