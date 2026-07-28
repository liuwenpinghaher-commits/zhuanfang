/**
 * Stage-3 barge-in context stash: next LLM turn can see what was cut off.
 */
export interface InterruptedUtteranceStash {
  text: string;
  at: string;
  sessionId?: string;
}

export function buildInterruptedStash(
  spokenTextSoFar: string | undefined | null,
  opts: { sessionId?: string; at?: string } = {}
): InterruptedUtteranceStash | null {
  const text = (spokenTextSoFar ?? "").trim();
  if (!text) return null;
  return {
    text,
    at: opts.at ?? new Date().toISOString(),
    ...(opts.sessionId ? { sessionId: opts.sessionId } : {})
  };
}

/** Inject stash into voice/interview system prompt fragment. */
export function formatInterruptedStashForPrompt(stash: InterruptedUtteranceStash | null | undefined): string {
  if (!stash?.text) return "";
  return (
    `【打断上下文】上一轮助手话术在用户打断时未说完，已播出片段：\n` +
    `「${stash.text}」\n` +
    `请根据用户新输入决定继续、改述或换题，不要假装完整说完了被打断的句子。`
  );
}

export function consumeStashAfterUse(
  stash: InterruptedUtteranceStash | null
): null {
  void stash;
  return null;
}
