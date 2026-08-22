export interface TurnAssemblerOptions {
  stabilityWindowMs?: number;
  echoWindowMs?: number;
  similarityThreshold?: number;
}

export interface TranscriptInput {
  text: string;
  isFinal: boolean;
  atMs: number;
  hasUserEnergyEvidence: boolean;
}

export interface AssemblyDecision {
  action: "wait" | "commit" | "quarantine";
  transcript: string;
  reason: string;
  waitMs?: number;
}

export function createTurnAssembler(_options: TurnAssemblerOptions = {}) {
  const stabilityWindowMs = Math.max(0, _options.stabilityWindowMs ?? 450);
  const echoWindowMs = Math.max(0, _options.echoWindowMs ?? 1_200);
  const similarityThreshold = Math.min(1, Math.max(0, _options.similarityThreshold ?? 0.8));
  let committedFinals = "";
  let partial = "";
  let lastFinalAtMs: number | null = null;
  let hasUserEnergyEvidence = false;
  let quarantined: AssemblyDecision | null = null;
  let recentTts: { text: string; startedAtMs: number; endedAtMs: number } | null = null;
  // Speak-start text plus recently ended clauses; leak is often a half-sentence of an earlier clause.
  let spokenClauses: Array<{ text: string; startedAtMs: number; endedAtMs: number | null }> = [];

  const transcript = () => `${committedFinals}${partial}`.trim();
  const wait = (reason: string, waitMs?: number): AssemblyDecision => ({
    action: "wait",
    transcript: transcript(),
    reason,
    ...(waitMs !== undefined ? { waitMs } : {})
  });

  function reset() {
    committedFinals = "";
    partial = "";
    lastFinalAtMs = null;
    hasUserEnergyEvidence = false;
    quarantined = null;
  }

  function pruneSpokenClauses(atMs: number) {
    spokenClauses = spokenClauses.filter((clause) =>
      clause.endedAtMs === null || atMs <= clause.endedAtMs + echoWindowMs
    );
  }

  function isSimilarToLiveTts(heard: string, atMs = Date.now()): boolean {
    const text = heard.trim();
    if (!text) return false;
    pruneSpokenClauses(atMs);
    for (const clause of spokenClauses) {
      if (atMs < clause.startedAtMs) continue;
      if (isEchoLikeness(text, clause.text, similarityThreshold)) return true;
    }
    return false;
  }

  return {
    ingest(input: TranscriptInput): AssemblyDecision {
      const text = input.text.trim();
      if (!text) return wait("empty transcript");
      hasUserEnergyEvidence ||= input.hasUserEnergyEvidence;
      // Speaker leak often has energy; likeness to live/recent TTS is enough to hold it back.
      if (isSimilarToLiveTts(text, input.atMs)) {
        quarantined = {
          action: "quarantine",
          transcript: text,
          reason: "transcript matches live or recent TTS"
        };
        return quarantined;
      }

      if (!input.isFinal) {
        partial = text;
        return wait("partial transcript is not authoritative");
      }

      if (!committedFinals) {
        committedFinals = text;
      } else if (text.startsWith(committedFinals)) {
        committedFinals = text;
      } else if (!committedFinals.endsWith(text)) {
        committedFinals += text;
      }
      partial = "";
      lastFinalAtMs = input.atMs;
      return wait("final segment is waiting for stability", stabilityWindowMs);
    },
    decide(input: { atMs: number; allowCommit: boolean; questionContext?: boolean }): AssemblyDecision {
      if (quarantined) return quarantined;
      const text = transcript();
      if (!text) return wait("no transcript");
      if (lastFinalAtMs === null) return wait("partial transcript has no final segment");
      const remaining = stabilityWindowMs - (input.atMs - lastFinalAtMs);
      if (remaining > 0) return wait("waiting for final stability window", remaining);
      if (!input.allowCommit) return wait("turn completeness gate requested more speech");
      if (text.replace(/\s/g, "").length <= 2 && (!input.questionContext || !hasUserEnergyEvidence)) {
        return wait("very short answer lacks question context or user energy evidence");
      }
      return { action: "commit", transcript: text, reason: "stable authoritative final transcript" };
    },
    beginLiveTts(text: string, startedAtMs: number): void {
      const trimmed = text.trim();
      pruneSpokenClauses(startedAtMs);
      for (const clause of spokenClauses) {
        if (clause.endedAtMs === null) clause.endedAtMs = startedAtMs;
      }
      if (!trimmed) return;
      spokenClauses.push({ text: trimmed, startedAtMs, endedAtMs: null });
      recentTts = { text: trimmed, startedAtMs, endedAtMs: startedAtMs };
    },
    isSimilarToLiveTts,
    noteTtsPlayback(input: { text: string; startedAtMs: number; endedAtMs: number }): void {
      const trimmed = input.text.trim();
      recentTts = { ...input, text: trimmed };
      pruneSpokenClauses(input.endedAtMs);
      const open = [...spokenClauses].reverse().find((clause) => clause.endedAtMs === null);
      if (open) {
        open.endedAtMs = input.endedAtMs;
        return;
      }
      if (trimmed) {
        spokenClauses.push({
          text: trimmed,
          startedAtMs: input.startedAtMs,
          endedAtMs: input.endedAtMs
        });
      }
    },
    confirmQuarantined(text: string, atMs: number): void {
      reset();
      committedFinals = text.trim();
      lastFinalAtMs = atMs - stabilityWindowMs;
      hasUserEnergyEvidence = true;
    },
    markCommitted(): void { reset(); },
    reset
  };
}

function isEchoLikeness(heard: string, spoken: string, similarityThreshold: number) {
  const a = normalize(heard);
  const b = normalize(spoken);
  if (!a || !b) return false;
  if (a === b) return true;
  if (textSimilarity(heard, spoken) >= similarityThreshold) return true;
  // Half-sentence leak is a prefix/infix of the spoken clause, not the other way around.
  return a.length >= 2 && b.includes(a);
}

function textSimilarity(left: string, right: string) {
  const a = normalizedBigrams(left);
  const b = normalizedBigrams(right);
  if (a.size === 0 || b.size === 0) return normalize(left) === normalize(right) ? 1 : 0;
  let intersection = 0;
  for (const token of a) if (b.has(token)) intersection += 1;
  return (2 * intersection) / (a.size + b.size);
}

function normalizedBigrams(text: string) {
  const normalized = normalize(text);
  const result = new Set<string>();
  for (let index = 0; index < normalized.length - 1; index += 1) {
    result.add(normalized.slice(index, index + 2));
  }
  return result;
}

function normalize(text: string) {
  return text.toLowerCase().replace(/[\s，。！？、,.!?；;：:"“”'‘’（）()]/g, "");
}
