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

  return {
    ingest(input: TranscriptInput): AssemblyDecision {
      const text = input.text.trim();
      if (!text) return wait("empty transcript");
      hasUserEnergyEvidence ||= input.hasUserEnergyEvidence;
      if (
        input.isFinal
        && recentTts
        && input.atMs >= recentTts.startedAtMs
        && input.atMs <= recentTts.endedAtMs + echoWindowMs
        && !input.hasUserEnergyEvidence
        && textSimilarity(text, recentTts.text) >= similarityThreshold
      ) {
        quarantined = {
          action: "quarantine",
          transcript: text,
          reason: "transcript is highly similar to recent TTS without independent user energy"
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
    noteTtsPlayback(input: { text: string; startedAtMs: number; endedAtMs: number }): void {
      recentTts = { ...input, text: input.text.trim() };
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
