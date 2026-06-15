// Pure, testable extraction of real speech features for the expression-state
// engine. Replaces the hardcoded constants (speechRate=3, pitchTrend="flat",
// pausePosition="mid_clause", samePointCount=0) that prevented `fluent` and
// `circling` from ever being detected.

/** Chars/sec from transcript growth between two partial-transcript samples.
 *  Returns null when there's no forward progress (e.g. a new turn reset). */
export function computeSpeechRate(
  prevTranscript: string,
  prevAt: number,
  currTranscript: string,
  currAt: number
): number | null {
  const dtSec = (currAt - prevAt) / 1000;
  if (dtSec <= 0) {
    return null;
  }
  const deltaChars = currTranscript.length - prevTranscript.length;
  if (deltaChars <= 0) {
    return null;
  }
  return deltaChars / dtSec;
}

/** Where the speaker paused: at a punctuation boundary, mid-clause, or start. */
export function detectPausePosition(transcript: string): "grammar_boundary" | "mid_clause" | "sentence_start" {
  const trimmed = transcript.trim();
  if (!trimmed) {
    return "sentence_start";
  }
  return /[。！？!?,，、；;：:…]$/.test(trimmed) ? "grammar_boundary" : "mid_clause";
}

/** How many times the most-repeated clause appears beyond the first (0 = none). */
export function countSamePoint(transcript: string): number {
  const clauses = transcript
    .split(/[。！？!?,，、；;\n]+/)
    .map((clause) => clause.replace(/\s+/g, "").trim())
    .filter((clause) => clause.length >= 4);
  const counts = new Map<string, number>();
  let max = 0;
  for (const clause of clauses) {
    const next = (counts.get(clause) ?? 0) + 1;
    counts.set(clause, next);
    if (next > max) {
      max = next;
    }
  }
  return Math.max(0, max - 1);
}

/** Spectral centroid (Hz) of an FFT magnitude frame — a cheap pitch/brightness proxy. */
export function spectralCentroid(magnitudes: ArrayLike<number>, sampleRate: number): number {
  let weighted = 0;
  let total = 0;
  for (let i = 0; i < magnitudes.length; i++) {
    weighted += i * magnitudes[i];
    total += magnitudes[i];
  }
  if (total === 0) {
    return 0;
  }
  const binHz = sampleRate / 2 / magnitudes.length;
  return (weighted / total) * binHz;
}

/** Trend of a centroid series: rising / falling / flat (needs >=4 usable points). */
export function pitchTrendFromSeries(values: number[]): "rising" | "falling" | "flat" {
  const usable = values.filter((value) => value > 0);
  if (usable.length < 4) {
    return "flat";
  }
  const recent = usable.slice(-6);
  const mid = Math.floor(recent.length / 2);
  const avg = (arr: number[]) => arr.reduce((sum, value) => sum + value, 0) / arr.length;
  const first = avg(recent.slice(0, mid));
  const second = avg(recent.slice(mid));
  const threshold = avg(recent) * 0.08;
  if (second - first > threshold) {
    return "rising";
  }
  if (first - second > threshold) {
    return "falling";
  }
  return "flat";
}

export interface SpeechFeatures {
  speechRate: number;
  baselineSpeechRate: number;
  pitchTrend: "rising" | "falling" | "flat";
  pausePosition: "grammar_boundary" | "mid_clause" | "sentence_start";
  samePointCount: number;
  timeSinceLastGuidance: number;
}

export interface SpeechFeatureTracker {
  onTranscript(transcript: string, at: number): void;
  onCentroid(centroid: number): void;
  markGuidance(at: number): void;
  features(now: number, transcript: string): SpeechFeatures;
}

/** Accumulates transcript/pitch samples and produces real expression features. */
export function createSpeechFeatureTracker(): SpeechFeatureTracker {
  let lastTranscript = "";
  let lastAt = 0;
  let speechRate = 0;
  const rateSamples: number[] = [];
  const centroids: number[] = [];
  let lastGuidanceAt = 0;

  return {
    onTranscript(transcript, at) {
      // Skip the very first sample (no prior timestamp to diff against).
      if (lastAt !== 0) {
        const rate = computeSpeechRate(lastTranscript, lastAt, transcript, at);
        if (rate !== null) {
          speechRate = rate;
          rateSamples.push(rate);
          if (rateSamples.length > 20) {
            rateSamples.shift();
          }
        }
      }
      lastTranscript = transcript;
      lastAt = at;
    },
    onCentroid(centroid) {
      centroids.push(centroid);
      if (centroids.length > 12) {
        centroids.shift();
      }
    },
    markGuidance(at) {
      lastGuidanceAt = at;
    },
    features(now, transcript) {
      const baseline = rateSamples.length
        ? rateSamples.reduce((sum, value) => sum + value, 0) / rateSamples.length
        : speechRate || 3;
      return {
        speechRate: speechRate || baseline || 3,
        baselineSpeechRate: baseline || 3,
        pitchTrend: pitchTrendFromSeries(centroids),
        pausePosition: detectPausePosition(transcript),
        samePointCount: countSamePoint(transcript),
        timeSinceLastGuidance: lastGuidanceAt ? now - lastGuidanceAt : 99999
      };
    }
  };
}
