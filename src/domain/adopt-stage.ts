/**
 * Shared adopt pre-stage decision (App.tsx adoptServerState).
 * Keep pure so unit tests drive the shipped predicate without mounting React.
 */
export function shouldStageLocalBeforeAdopt(input: {
  localSignature: string;
  remoteSignature: string;
  lastSavedSignature: string;
}): boolean {
  if (input.localSignature === input.remoteSignature) return false;
  const localDiffersFromLastSaved =
    !input.lastSavedSignature || input.localSignature !== input.lastSavedSignature;
  return localDiffersFromLastSaved;
}
