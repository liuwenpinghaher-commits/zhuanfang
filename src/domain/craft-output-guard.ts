/**
 * Craft output guard — optional post-LLM heuristic for interview assistant turns.
 *
 * Flag: VOICE_CRAFT_OUTPUT_GUARD (default OFF / false). When enabled, multi-question
 * assistant text can be truncated to the first question; other craft violations are
 * logged as retry-worthy without inventing a second LLM call in this module.
 *
 * Pure domain: no I/O. Brain/routes call apply* and decide whether to log/persist.
 * craft-golden (strategy/retrieval) is independent and must stay green either way.
 */

/** Env flag name (documented in .env.example). Default absent/false = passthrough. */
export const VOICE_CRAFT_OUTPUT_GUARD_ENV = "VOICE_CRAFT_OUTPUT_GUARD";

/** Soft length cap for a single interview probe (characters). */
export const CRAFT_OUTPUT_MAX_CHARS = 160;

/** Counselor-style anti-patterns from INTERVIEWER_CRAFT_RULES (hard anti-patterns). */
const COUNSELOR_PATTERN_RES: RegExp[] = [
  /你提到了[\s\S]{0,40}这听起来/,
  /在这个过程中有没有遇到过什么挑战/,
  /效果怎么样呢/,
  /是怎么处理的呢/,
  /那在这个过程中/,
  /听起来(你|好像|似乎)/
];

export type CraftOutputGuardAssessment = {
  singleQuestionHeuristicOk: boolean;
  multiQuestion: boolean;
  tooLong: boolean;
  counselorPattern: boolean;
  questionMarkCount: number;
  reasons: string[];
};

export type CraftOutputGuardAction = "passthrough" | "truncated" | "retry_logged";

export type CraftOutputGuardResult = {
  text: string;
  originalText: string;
  enabled: boolean;
  /** True when the guard changed text and/or recorded a retry-worthy violation. */
  outputGuardTriggered: boolean;
  singleQuestionHeuristicOk: boolean;
  action: CraftOutputGuardAction;
  reasons: string[];
  assessment: CraftOutputGuardAssessment;
};

/**
 * Rubric hook dimensions (0–2 each) — mirrors docs/interview-rubric.md / eval rubric.
 * Used by human-gate samples; not auto-scored in CI.
 */
export const INTERVIEW_RUBRIC_DIMENSIONS = [
  "concrete_moment",
  "single_question",
  "no_advice_list",
  "no_fabricated_memory",
  "strategy_alignment"
] as const;

export type InterviewRubricDimension = (typeof INTERVIEW_RUBRIC_DIMENSIONS)[number];

export type InterviewRubricScores = Record<InterviewRubricDimension, 0 | 1 | 2>;

/** Turn-15 human gate: whether tracking / craft was assessed at mid-session (manual). */
export type Turn15TrackingHook = {
  /** 1-based user-facing turn index (design: turn 15). */
  turnIndex: 15;
  /** Human: does the probe still track the session theme / open debts? */
  trackingOk: boolean | null;
  /** Sum of five rubric dims (0–10) when scored. */
  rubricTotal: number | null;
  notes: string;
};

export function emptyTurn15TrackingHook(notes = ""): Turn15TrackingHook {
  return {
    turnIndex: 15,
    trackingOk: null,
    rubricTotal: null,
    notes
  };
}

export function sumInterviewRubricScores(scores: InterviewRubricScores): number {
  return INTERVIEW_RUBRIC_DIMENSIONS.reduce((acc, dim) => acc + scores[dim], 0);
}

/**
 * VOICE_CRAFT_OUTPUT_GUARD default false.
 * True only for explicit 1/true/yes/on (case-insensitive).
 */
export function isCraftOutputGuardEnabled(
  env: Record<string, string | undefined> = typeof process !== "undefined" ? process.env : {}
): boolean {
  const raw = env[VOICE_CRAFT_OUTPUT_GUARD_ENV];
  if (raw === undefined || raw === null) return false;
  const v = String(raw).trim();
  if (!v) return false;
  return /^(1|true|yes|on)$/i.test(v);
}

export function countQuestionMarks(text: string): number {
  const m = text.match(/[？?]/g);
  return m ? m.length : 0;
}

/**
 * Heuristic: more than one question mark, or two+ interrogative clauses separated
 * by punctuation (e.g. "……？……？" / "……? 还有……？").
 */
export function looksLikeMultiQuestion(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  if (countQuestionMarks(trimmed) >= 2) return true;
  // Two sentence-like chunks that both look like questions without relying only on marks.
  const clauses = trimmed
    .split(/[。！!；;\n]+/)
    .map((c) => c.trim())
    .filter(Boolean);
  if (clauses.length < 2) return false;
  const questiony = clauses.filter(
    (c) => /[？?]/.test(c) || /^(那|怎么|为什么|为何|是否|有没有|能不能|可以|哪)/.test(c)
  );
  return questiony.length >= 2;
}

export function looksLikeCounselorPattern(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  return COUNSELOR_PATTERN_RES.some((re) => re.test(t));
}

export function assessAssistantCraftOutput(text: string): CraftOutputGuardAssessment {
  const trimmed = (text ?? "").trim();
  const multiQuestion = looksLikeMultiQuestion(trimmed);
  const tooLong = trimmed.length > CRAFT_OUTPUT_MAX_CHARS;
  const counselorPattern = looksLikeCounselorPattern(trimmed);
  const questionMarkCount = countQuestionMarks(trimmed);
  const reasons: string[] = [];
  if (multiQuestion) reasons.push("multi_question");
  if (tooLong) reasons.push("too_long");
  if (counselorPattern) reasons.push("counselor_pattern");
  const singleQuestionHeuristicOk = !multiQuestion && !counselorPattern;
  return {
    singleQuestionHeuristicOk,
    multiQuestion,
    tooLong,
    counselorPattern,
    questionMarkCount,
    reasons
  };
}

/**
 * Keep content through the first question mark (inclusive). If none, keep first sentence.
 * Never returns empty when original was non-empty (falls back to original).
 */
export function truncateToFirstQuestion(text: string): string {
  const original = text ?? "";
  const trimmed = original.trim();
  if (!trimmed) return original;

  const markMatch = /[？?]/.exec(trimmed);
  if (markMatch && markMatch.index !== undefined) {
    const cut = trimmed.slice(0, markMatch.index + 1).trim();
    return cut || original;
  }

  const sentenceMatch = /[。！!]/.exec(trimmed);
  if (sentenceMatch && sentenceMatch.index !== undefined) {
    const cut = trimmed.slice(0, sentenceMatch.index + 1).trim();
    return cut || original;
  }

  if (trimmed.length > CRAFT_OUTPUT_MAX_CHARS) {
    return trimmed.slice(0, CRAFT_OUTPUT_MAX_CHARS).trim() || original;
  }
  return original;
}

export type ApplyCraftOutputGuardOptions = {
  /** Override env flag; when omitted, reads VOICE_CRAFT_OUTPUT_GUARD (default false). */
  enabled?: boolean;
  env?: Record<string, string | undefined>;
};

/**
 * Apply craft output guard.
 * - enabled=false (default): passthrough; assessment still computed for hooks/metrics.
 * - enabled=true + multi_question: truncate to first question.
 * - enabled=true + other violations only: log-retry path (text unchanged).
 */
export function applyCraftOutputGuard(
  text: string,
  options: ApplyCraftOutputGuardOptions = {}
): CraftOutputGuardResult {
  const enabled =
    options.enabled !== undefined
      ? options.enabled
      : isCraftOutputGuardEnabled(options.env);
  const originalText = text ?? "";
  const assessment = assessAssistantCraftOutput(originalText);

  if (!enabled || assessment.reasons.length === 0) {
    return {
      text: originalText,
      originalText,
      enabled,
      outputGuardTriggered: false,
      singleQuestionHeuristicOk: assessment.singleQuestionHeuristicOk,
      action: "passthrough",
      reasons: assessment.reasons,
      assessment
    };
  }

  if (assessment.multiQuestion) {
    const truncated = truncateToFirstQuestion(originalText);
    const changed = truncated.trim() !== originalText.trim();
    return {
      text: changed ? truncated : originalText,
      originalText,
      enabled,
      outputGuardTriggered: true,
      singleQuestionHeuristicOk: false,
      action: changed ? "truncated" : "retry_logged",
      reasons: assessment.reasons,
      assessment
    };
  }

  // too_long / counselor_pattern: do not invent rewrites beyond multi-q truncate;
  // surface retry_logged so brain can log and operators can sample.
  return {
    text: originalText,
    originalText,
    enabled,
    outputGuardTriggered: true,
    singleQuestionHeuristicOk: assessment.singleQuestionHeuristicOk,
    action: "retry_logged",
    reasons: assessment.reasons,
    assessment
  };
}

/**
 * Craft meta snapshot for brain/observability hooks (no I/O).
 */
export function buildCraftMetaFromGuardResult(result: CraftOutputGuardResult): {
  outputGuardTriggered: boolean;
  singleQuestionHeuristicOk: boolean;
  action: CraftOutputGuardAction;
  reasons: string[];
} {
  return {
    outputGuardTriggered: result.outputGuardTriggered,
    singleQuestionHeuristicOk: result.singleQuestionHeuristicOk,
    action: result.action,
    reasons: result.reasons
  };
}
