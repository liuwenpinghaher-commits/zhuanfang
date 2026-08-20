/**
 * Eval-store fixtures: PUT body = GET stored + overlay. Overlay-only is an error
 * (missing arrays silently fall back to Mia seed in normalizeProductState).
 */
export const PUT_REQUIRED_KEYS = [
  "revision",
  "profile",
  "sessions",
  "notes",
  "debts",
  "decisions",
  "points",
  "playbookPatches",
  "systemConfig"
];

export function isFragmentPutBody(body) {
  if (!body || typeof body !== "object") return true;
  const keys = Object.keys(body);
  const missing = PUT_REQUIRED_KEYS.filter((k) => !(k in body));
  if (missing.length) return true;
  if (keys.length <= 3 && "revision" in body && "debts" in body) return true;
  return false;
}

export function assertFullPutBody(body, stored) {
  if (isFragmentPutBody(body)) {
    const missing = PUT_REQUIRED_KEYS.filter((k) => !(k in (body ?? {})));
    throw new Error(
      `overlay-only PUT rejected; missing ${missing.join(",") || "shape"}; seed fallback would reintroduce Mia`
    );
  }
  if (stored && body.revision !== stored.revision) {
    throw new Error("revision must copy stored.revision");
  }
  for (const k of ["sessions", "notes", "debts", "decisions", "points", "playbookPatches"]) {
    if (!Array.isArray(body[k])) {
      throw new Error(`PUT body.${k} must be an array (same shape as stored)`);
    }
  }
  if (!body.systemConfig || typeof body.systemConfig !== "object" || Array.isArray(body.systemConfig)) {
    throw new Error("PUT body.systemConfig must be an object");
  }
  if (!body.profile || typeof body.profile !== "object") {
    throw new Error("PUT body.profile must be an object");
  }
}

function deepMerge(base, overlay) {
  if (!overlay || typeof overlay !== "object" || Array.isArray(overlay)) return overlay;
  const out = { ...(base && typeof base === "object" && !Array.isArray(base) ? base : {}) };
  for (const [k, v] of Object.entries(overlay)) {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      out[k] = deepMerge(out[k], v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

/** Apply overlay onto a clone of stored. Never returns a fragment. */
export function applyOverlay(stored, overlay = {}) {
  if (!stored || typeof stored !== "object") {
    throw new Error("stored GET state is required");
  }
  if (overlay && isFragmentPutBody(overlay) && Object.keys(overlay).length > 0 && !("profile" in stored)) {
    // overlay is expected to be a fragment; stored must supply the rest
  }
  const body = structuredClone(stored);
  for (const [k, v] of Object.entries(overlay ?? {})) {
    if (k === "revision") continue;
    if (k === "systemConfig") {
      body.systemConfig = deepMerge(body.systemConfig ?? {}, v ?? {});
    } else if (k === "profile") {
      body.profile = deepMerge(body.profile ?? {}, v ?? {});
    } else {
      body[k] = v;
    }
  }
  body.revision = stored.revision;
  assertFullPutBody(body, stored);
  return body;
}

/** Reject sending overlay as if it were the PUT body. */
export function rejectOverlayOnlyPut(body) {
  assertFullPutBody(body, { revision: body?.revision });
  return body;
}

export function clockDebtOverlay(now = Date.now()) {
  return {
    debts: [
      {
        id: "debt-eval-1",
        concept: "成核点",
        context: "评测预置开放知识债",
        whyImportant: "策略时钟",
        status: "待了解",
        nextQuestion: "你现在能解释成核点吗？",
        updatedAt: new Date(now - 40 * 864e5).toISOString()
      }
    ],
    decisions: []
  };
}

export function clockDecisionOverlay(now = Date.now()) {
  return {
    decisions: [
      {
        id: "dec-eval-1",
        title: "是否放权",
        decisionKind: "候选决策",
        confirmationStatus: "用户确认",
        choice: "关键节点把控",
        tradeOff: "短控 vs 长期",
        riskHypothesis: "短期失控",
        reviewAt: new Date(now - 864e5).toISOString(),
        status: "待复盘",
        updatedAt: new Date(now - 40 * 864e5).toISOString()
      }
    ],
    debts: []
  };
}

export function clockContradictionOverlay(now = Date.now()) {
  const updatedAt = new Date(now).toISOString();
  return {
    points: [
      {
        id: "pt-a",
        title: "远程优于现场",
        content: "远程协作效率更高",
        status: "稳定观点",
        confidence: "用户确认",
        evidence: ["从前"],
        important: true,
        updatedAt,
        contradictsPointIds: ["pt-b"]
      },
      {
        id: "pt-b",
        title: "现场不可替代",
        content: "现场不可替代",
        status: "稳定观点",
        confidence: "用户确认",
        evidence: ["现在"],
        important: true,
        updatedAt,
        contradictsPointIds: ["pt-a"]
      }
    ]
  };
}

export function clockBlindspotOverlay() {
  return {
    systemConfig: { interview: { maxFollowUpDepth: 8 } },
    points: []
  };
}

export function concreteMomentOverlay(now = Date.now()) {
  const iso = new Date(now).toISOString();
  return {
    playbookPatches: [
      {
        id: "patch-eval-cm",
        title: "具体时刻",
        description: "eval",
        sourceInsightId: "insight-eval",
        status: "applied",
        rules: ["先让被访者落到一个真实场景"],
        ruleTypes: ["concrete-moment"],
        impact: "medium",
        createdAt: iso,
        appliedAt: iso
      }
    ],
    debts: [],
    decisions: []
  };
}

export function memoryConflictOverlay(now = Date.now()) {
  const iso = new Date(now).toISOString();
  return {
    memoryCandidates: [
      {
        id: "c_eval_conflict",
        text: "组织效率提升的结构性前提缺一不可，必须满足全部准入门槛",
        status: "pending",
        sourceType: "interview_session",
        sourceId: "s-conflict",
        evidenceQuote: "原文片段足够长可作证据",
        reason: "需确认",
        sensitivity: "normal",
        suggestedUpdate: "conflict",
        createdAt: iso,
        reviewScore: 70,
        reviewSignals: ["与笔记/用户修正冲突", "不可静默确认"]
      }
    ],
    memoryCorrections: [
      {
        id: "corr_eval",
        text: "纠正：效率瓶颈不是结构性前提，也不是必须全部满足的准入门槛",
        createdAt: iso
      }
    ]
  };
}
