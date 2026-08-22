/**
 * Take-floor: guest is grabbing a matter onto the floor, not greeting/echo/tone.
 * Completeness is a different question — do not call assessTurnCompleteness here.
 */

export interface TakeFloorInput {
  transcript: string;
  hasUserEnergy: boolean;
  similarToLiveTts: boolean; // live text written at speak START, not after await
  takingTheFloor: boolean;   // is the guest grabbing a matter, NOT completeness
}

export function isTakeFloor(input: TakeFloorInput): boolean {
  if (input.similarToLiveTts) return false;
  if (!input.hasUserEnergy) return false;
  return input.takingTheFloor;
}

/**
 * Veto tokens that don't look like a submit (same ≤2 stripped-char bar as
 * turnAssembler). Not a min-length product rule and not a greeting wordlist.
 */
export function isGrabbingMatter(transcript: string): boolean {
  const stripped = transcript.replace(
    /[\s，。！？、,.!?；;：:"“”'‘’（）()\u3000]/g,
    ""
  );
  if (stripped.length <= 2) return false;
  return true;
}
