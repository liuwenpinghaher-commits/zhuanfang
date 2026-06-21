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
