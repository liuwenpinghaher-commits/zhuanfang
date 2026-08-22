/**
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
 * Ask whether the side track is putting a matter on the floor (or telling
 * the host to stop and listen), vs greeting / backchannel / tone.
 * Peeling decorations is not a greeting wordlist; leftover still has to be a matter.
 */
export function isGrabbingMatter(transcript: string): boolean {
  let s = transcript.replace(
    /[\s，。！？、,.!?；;：:"“”'‘’（）()\u3000]/g,
    ""
  );
  if (s.length <= 2) return false;
  s = s.replace(/[啊呀呢吧吗嘛哈咯啦哦噢呃]+$/u, "");
  s = collapseRepeatedStem(s);
  if (s.length <= 2) return false;
  if (/[你您]$/u.test(s) && s.slice(0, -1).length <= 2) s = s.slice(0, -1);
  if (s.length <= 2) return false;
  // Isolated short token is not yet a matter or a listen bid.
  if (s.length <= 3) return false;
  return true;
}

function collapseRepeatedStem(s: string): string {
  for (let n = 1; n <= Math.floor(s.length / 2); n += 1) {
    if (s.length % n !== 0) continue;
    const unit = s.slice(0, n);
    if (unit.repeat(s.length / n) === s) return unit;
  }
  return s;
}
