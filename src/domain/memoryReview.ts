import type {
  MemoryCandidate,
  MemoryCandidateStatus,
  MemorySensitivity,
  MemorySourceType
} from "./types";

type MemoryCandidateReviewInput = {
  text?: string;
  status?: MemoryCandidateStatus;
  sourceType?: MemorySourceType;
  evidenceQuote?: string;
  reason?: string;
  sensitivity?: MemorySensitivity;
  reviewScore?: number;
  reviewSignals?: string[];
};

type CorrectionAwareCandidate = {
  text: string;
  evidenceQuote?: string;
};

const externalSourceTypes: MemorySourceType[] = ["search_brief", "import_source", "corpus_import"];
const interviewSourceTypes: MemorySourceType[] = ["interview_session", "dual_track_note"];

export function scoreMemoryCandidate(candidate: MemoryCandidateReviewInput): Pick<MemoryCandidate, "reviewScore" | "reviewSignals"> {
  const signals: string[] = [];
  let score = 50;
  const evidenceQuote = candidate.evidenceQuote?.trim() ?? "";
  const reason = candidate.reason?.trim() ?? "";
  const text = candidate.text?.trim() ?? "";

  if (evidenceQuote.length >= 12) {
    score += 14;
    signals.push("有明确证据");
  }

  if (candidate.sourceType && interviewSourceTypes.includes(candidate.sourceType)) {
    score += 14;
    signals.push("来自专访原话");
  }

  if (candidate.status === "pending" || /确认|待审核|长期记忆/.test(reason)) {
    score += 8;
    signals.push("需用户确认");
  }

  if (candidate.sourceType && externalSourceTypes.includes(candidate.sourceType)) {
    score -= 12;
    signals.push("外部资料仅作候选");
  }

  if (candidate.sensitivity === "sensitive") {
    score -= 15;
    signals.push("敏感候选需谨慎");
  }

  if (/总是|一定|永远|所有|完全|必须|从不|绝不|根本|一律/.test(text)) {
    score -= 6;
    signals.push("含泛化表达");
  }

  // Durability / actionability — what actually makes something worth long-term memory:
  // a triggerable mechanism or falsifiable structure ("当X时会Y" / "因为A所以B" / "不是A而是B"),
  // and/or a quantified anchor. A flat assertion with neither is likely rhetoric or a vague
  // opinion that won't stay useful — nudge the reviewer away from it.
  const hasMechanism =
    /如果|一旦|因为|所以|导致|取决于|前提是|不是[^，。；]+而是|越[^，。；]+越|当[^，。；]{0,24}[时则]/.test(text);
  const hasQuantifiedAnchor = /\d/.test(text);
  if (hasMechanism) {
    score += 12;
    signals.push("含可操作机制/可证伪结构");
  }
  if (hasQuantifiedAnchor) {
    score += 6;
    signals.push("含量化锚点");
  }
  if (!hasMechanism && !hasQuantifiedAnchor) {
    score -= 10;
    signals.push("缺可操作/量化锚点（疑似泛泛断言或修辞）");
  }

  return {
    reviewScore: clampReviewScore(score),
    reviewSignals: uniqueReviewSignals(signals.length > 0 ? signals : ["需人工复核"])
  };
}

export function withMemoryCandidateReview<T extends MemoryCandidateReviewInput>(
  candidate: T,
  options: { legacyBackfill?: boolean; preserveExisting?: boolean } = {}
): T & Pick<MemoryCandidate, "reviewScore" | "reviewSignals"> {
  const computed = scoreMemoryCandidate(candidate);
  const preserveExisting = options.preserveExisting ?? true;
  const hasPersistedScore = preserveExisting && Number.isFinite(candidate.reviewScore);
  const persistedSignals = preserveExisting && Array.isArray(candidate.reviewSignals)
    ? candidate.reviewSignals.filter((signal): signal is string => typeof signal === "string" && signal.trim().length > 0)
    : [];
  const reviewSignals = uniqueReviewSignals([
    ...(options.legacyBackfill ? ["旧数据已补齐评分"] : []),
    ...(persistedSignals.length > 0 ? persistedSignals : computed.reviewSignals)
  ]);

  return {
    ...candidate,
    reviewScore: hasPersistedScore ? clampReviewScore(candidate.reviewScore ?? computed.reviewScore) : computed.reviewScore,
    reviewSignals
  };
}

export function conflictsWithExplicitCorrection(
  candidate: CorrectionAwareCandidate,
  corrections: string[]
) {
  const candidateText = normalizeForConflict(candidate.text);
  if (!candidateText) {
    return false;
  }
  return corrections.some((rawCorrection) => {
    const correction = normalizeForConflict(rawCorrection);
    if (!isExplicitCorrection(rawCorrection) || !correction) {
      return false;
    }
    // A candidate that faithfully preserves the complete corrected statement
    // is desirable; only stale/contradictory claims should be blocked.
    if (candidateText.includes(correction) || correction.includes(candidateText)) {
      return false;
    }

    // Candidate that itself negates the absolute/prerequisite claim is alignment, not conflict.
    const candidateNegatesClaim =
      /不是.{0,28}(?:结构性?前提|准入门槛|缺一不可)|而不是.{0,28}(?:结构性?前提|准入门槛|缺一不可)|并非.{0,20}(?:前提|门槛)/.test(
        candidate.text
      ) || isExplicitCorrection(candidate.text);

    const prerequisiteClaim = /结构性?前提|缺一不可|准入门槛|必须.{0,12}(?:满足|具备|准备好)/.test(candidate.text);
    const prerequisiteCorrection = /不是.{0,28}(?:前提|准入门槛)|不(?:需要|应当).{0,20}(?:满足|具备)|不是.{0,20}必须.{0,20}满足/.test(rawCorrection);
    if (
      prerequisiteClaim &&
      prerequisiteCorrection &&
      !candidateNegatesClaim &&
      sharedConceptCount(candidateText, correction) >= 2
    ) {
      return true;
    }

    const candidateIsAbsolute = /总是|永远|所有|完全|必须|从不|绝不|根本|一律|缺一不可/.test(candidate.text);
    if (candidateNegatesClaim) {
      return false;
    }
    return candidateIsAbsolute && sharedConceptCount(candidateText, correction) >= 3;
  });
}

/**
 * Collect human-authored correction strings that must block silent long-term confirm:
 * memoryCorrections + dual-track learnedTrack lines that read as explicit corrections.
 */
export function collectConflictCorrectionTexts(input: {
  memoryCorrections?: Array<{ text?: string } | string>;
  learnedTrack?: string[];
}): string[] {
  const fromCorrections = (input.memoryCorrections ?? []).map((item) =>
    typeof item === "string" ? item : item.text ?? ""
  );
  const fromLearned = (input.learnedTrack ?? []).filter((line) => isExplicitCorrection(line));
  return [...fromCorrections, ...fromLearned].map((t) => t.trim()).filter(Boolean);
}

const CONFLICT_REVIEW_SIGNALS = new Set(["与笔记/用户修正冲突", "不可静默确认"]);
const CONFLICT_REASON_SUFFIX = "与用户显式修正或笔记「我学到了什么」冲突，需拒绝或改写后再确认。";

/**
 * Annotate a pending candidate when it conflicts with note corrections / explicit corrections.
 * Does not auto-reject; surfaces suggestedUpdate="conflict" for HITL and approve gate.
 * When text no longer conflicts (e.g. after user edit), clears conflict flags so approve can proceed.
 */
export function annotateCandidateConflict<T extends CorrectionAwareCandidate & {
  suggestedUpdate?: string;
  reason?: string;
  reviewSignals?: string[];
}>(
  candidate: T,
  corrections: string[]
): T {
  if (!conflictsWithExplicitCorrection(candidate, corrections)) {
    if (candidate.suggestedUpdate !== "conflict") {
      return candidate;
    }
    // Edit path: conflict resolved — drop conflict markers so silent confirm is allowed again.
    const cleanedSignals = (candidate.reviewSignals ?? []).filter((s) => !CONFLICT_REVIEW_SIGNALS.has(s));
    const cleanedReason = (candidate.reason ?? "")
      .split(/(?<=[。．.])\s*/)
      .map((part) => part.trim())
      .filter((part) => part && !part.includes(CONFLICT_REASON_SUFFIX.slice(0, 12)))
      .join("");
    return {
      ...candidate,
      suggestedUpdate: "add",
      reason: cleanedReason || "已根据你的修改重新评分，可再次确认。",
      reviewSignals: cleanedSignals.length > 0 ? cleanedSignals : ["已改写·待确认"]
    };
  }
  const signals = Array.from(
    new Set([...(candidate.reviewSignals ?? []), "与笔记/用户修正冲突", "不可静默确认"])
  );
  const reasonParts = [candidate.reason, CONFLICT_REASON_SUFFIX].filter(Boolean);
  const reason = reasonParts.join(candidate.reason?.includes(CONFLICT_REASON_SUFFIX) ? "" : " ");
  return {
    ...candidate,
    suggestedUpdate: "conflict",
    reason,
    reviewSignals: signals
  };
}

/** True when approve must refuse without force (conflict surface or explicit correction clash). */
export function shouldBlockSilentMemoryConfirm(
  candidate: CorrectionAwareCandidate & { suggestedUpdate?: string; status?: string },
  corrections: string[]
): boolean {
  if (candidate.status && candidate.status !== "pending") return true;
  if (candidate.suggestedUpdate === "conflict") return true;
  return conflictsWithExplicitCorrection(candidate, corrections);
}

function isExplicitCorrection(text: string) {
  return /纠正|更正|不是|并非|不再|不能说|不应该|不应当|我不同意|我否定/.test(text);
}

function normalizeForConflict(text: string) {
  return text
    .toLowerCase()
    .replace(/ai\s*native/g, "ainative")
    .replace(/[\s，。！？、,.!?；;：:"“”'‘’（）()\[\]【】]/g, "");
}

function sharedConceptCount(left: string, right: string) {
  const leftConcepts = conceptBigrams(left);
  const rightConcepts = conceptBigrams(right);
  let count = 0;
  for (const concept of leftConcepts) {
    if (rightConcepts.has(concept)) {
      count += 1;
    }
  }
  return count;
}

function conceptBigrams(text: string) {
  const stop = new Set(["不是", "而是", "这个", "那个", "我们", "应当", "进行", "一个", "开始"]);
  const result = new Set<string>();
  for (let index = 0; index < text.length - 1; index += 1) {
    const token = text.slice(index, index + 2);
    if (!stop.has(token)) {
      result.add(token);
    }
  }
  return result;
}

function clampReviewScore(score: number) {
  return Math.max(0, Math.min(100, Math.round(score)));
}

function uniqueReviewSignals(signals: string[]) {
  return Array.from(new Set(signals.map((signal) => signal.trim()).filter(Boolean)));
}
