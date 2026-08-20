/** Mia seed fingerprints from src/domain/seed.ts — not the owner's book. */
const MIA_NOTE_ID = /^note-seed-/;
const MIA_SESSION_ID = /^session-seed-/;
const EMPTY_NAMES = new Set(["", "Mia", "未设置"]);

function ids(list, key = "id") {
  return (Array.isArray(list) ? list : []).map((row) => String(row?.[key] ?? ""));
}

function allSeedOrEmpty(values, re) {
  return values.every((id) => !id || re.test(id));
}

export function isMiaSeedFingerprint(state) {
  if (!state || typeof state !== "object") return false;
  const name = String(state.profile?.name ?? "");
  if (name !== "Mia") return false;
  const sessionIds = ids(state.sessions);
  const noteIds = ids(state.notes);
  const noteSessionIds = ids(state.notes, "sessionId");
  if (!allSeedOrEmpty(sessionIds, MIA_SESSION_ID)) return false;
  if (!allSeedOrEmpty(noteIds, MIA_NOTE_ID)) return false;
  if (!allSeedOrEmpty(noteSessionIds, MIA_SESSION_ID)) return false;
  if (Array.isArray(state.memoryRecords) && state.memoryRecords.length > 0) return false;
  return true;
}

export function isPurgedEmptyBook(state) {
  const name = String(state?.profile?.name ?? "");
  const sessions = Array.isArray(state?.sessions) ? state.sessions : [];
  const notes = Array.isArray(state?.notes) ? state.notes : [];
  const memories = Array.isArray(state?.memoryRecords) ? state.memoryRecords : [];
  if (sessions.length || notes.length || memories.length) return false;
  return EMPTY_NAMES.has(name) || name.startsWith("eval-marker-");
}

/**
 * True when GET /api/state looks like the owner's live store.
 * Mia seed (note-seed-* / session-seed-*) and eval markers are NOT owner.
 */
export function looksLikeOwnerBook(state) {
  if (!state || typeof state !== "object") return false;
  const name = String(state.profile?.name ?? "");
  if (name.startsWith("eval-marker-")) return false;
  if (isMiaSeedFingerprint(state)) return false;
  if (isPurgedEmptyBook(state)) return false;
  // Isolate purge zeros profile.name; later eval sessions are not the owner's book.
  if (name === "") return false;

  const sessionIds = ids(state.sessions);
  const noteIds = ids(state.notes);
  if (sessionIds.some((id) => id && !MIA_SESSION_ID.test(id))) return true;
  if (noteIds.some((id) => id && !MIA_NOTE_ID.test(id))) return true;
  if (Array.isArray(state.memoryRecords) && state.memoryRecords.length > 0) return true;
  if (name && !EMPTY_NAMES.has(name) && !name.startsWith("eval-marker-")) return true;
  return false;
}

export function sessionIdSet(state) {
  return new Set(ids(state?.sessions).filter(Boolean));
}

export function sameSessionIdSet(a, b) {
  const left = [...sessionIdSet(a)].sort();
  const right = [...sessionIdSet(b)].sort();
  if (left.length !== right.length) return false;
  return left.every((id, i) => id === right[i]);
}

/** Shared hot state: same revision + same session ids AND either side is owner-like. */
export function witnessSharesOwnerBook(simState, witnessState) {
  if (!simState || !witnessState) return false;
  if (simState.revision !== witnessState.revision) return false;
  if (!sameSessionIdSet(simState, witnessState)) return false;
  return looksLikeOwnerBook(simState) || looksLikeOwnerBook(witnessState);
}
