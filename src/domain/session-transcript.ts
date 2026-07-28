import type { InterviewSession } from "./types";

/** Minimal ref shape so domain stays free of React types. */
export interface MutableNumberRef {
  current: number;
}

/**
 * Fold a `final` assistant transcript segment into the live session without
 * collapsing a multi-segment reply to its last segment (P1-12 / R-P1-03 support).
 */
export function appendAssistantTranscriptFinal(
  session: InterviewSession,
  text: string,
  turnRef: MutableNumberRef
): InterviewSession {
  const trimmed = text.trim();
  if (!trimmed) {
    return session;
  }
  const turns = [...session.turns];
  const lastIdx = turns.length - 1;
  if (lastIdx < 0 || turns[lastIdx].role !== "assistant") {
    return session;
  }

  const isNewTurn = turnRef.current !== lastIdx;
  const prevContent = turns[lastIdx].content;

  if (isNewTurn) {
    turns[lastIdx] = { ...turns[lastIdx], content: trimmed };
    turnRef.current = lastIdx;
    return { ...session, turns };
  }

  if (prevContent.includes(trimmed) || trimmed.includes(prevContent)) {
    if (trimmed.length > prevContent.length) {
      turns[lastIdx] = { ...turns[lastIdx], content: trimmed };
      return { ...session, turns };
    }
    return session;
  }

  const separator = prevContent && !prevContent.endsWith(" ") ? " " : "";
  turns[lastIdx] = { ...turns[lastIdx], content: `${prevContent}${separator}${trimmed}` };
  return { ...session, turns };
}
