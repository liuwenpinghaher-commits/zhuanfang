export interface VoiceReviewRef<T> {
  current: T | null;
}

interface RunVoiceReviewActionOptions<T> {
  ref: VoiceReviewRef<T>;
  clearRendered: () => void;
  action: (item: T) => void;
}

/**
 * Clears the consumed review before invoking the pipeline. If that action
 * synchronously publishes the next queued review, the replacement remains the
 * final ref/rendered state instead of being erased after the action returns.
 */
export function runVoiceReviewAction<T>(
  options: RunVoiceReviewActionOptions<T>
): boolean {
  const item = options.ref.current;
  if (!item) return false;
  options.ref.current = null;
  options.clearRendered();
  options.action(item);
  return true;
}
