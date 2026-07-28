import { useCallback, useRef } from "react";
import {
  buildInterruptedStash,
  formatInterruptedStashForPrompt,
  type InterruptedUtteranceStash
} from "../domain/voice-interrupt-stash";

/**
 * Stage-3: keep last barge-in partial for the next LLM turn, then clear.
 * Keeps App free of stash plumbing details.
 */
export function useInterruptedUtteranceStash() {
  const stashRef = useRef<InterruptedUtteranceStash | null>(null);

  const recordInterrupt = useCallback((spokenTextSoFar: string, sessionId?: string) => {
    stashRef.current = buildInterruptedStash(spokenTextSoFar, { sessionId: sessionId ?? undefined });
    return stashRef.current;
  }, []);

  const peekPromptFragment = useCallback(() => formatInterruptedStashForPrompt(stashRef.current), []);

  const consumeForPrompt = useCallback(() => {
    const fragment = formatInterruptedStashForPrompt(stashRef.current);
    stashRef.current = null;
    return fragment;
  }, []);

  const clear = useCallback(() => {
    stashRef.current = null;
  }, []);

  return { recordInterrupt, peekPromptFragment, consumeForPrompt, clear, stashRef };
}
