/**
 * Eval process safety: refuse machine tokens, refuse unauthenticated purge,
 * never default the API base at a public remote host.
 */
export const DEFAULT_EVAL_API_BASE = "http://127.0.0.1:3210";
export const FORBIDDEN_EVAL_USERNAMES = new Set(["admin", "smoke_a", "smoke_b"]);

export function defaultEvalApiBase(env = process.env) {
  const raw = String(env.EVAL_API_BASE ?? env.PRODUCT_API_BASE ?? DEFAULT_EVAL_API_BASE).trim();
  return raw || DEFAULT_EVAL_API_BASE;
}

export function isQingBlueHost(apiBase) {
  const s = String(apiBase ?? "").trim();
  if (!s) return false;
  return /^https:\/\//i.test(s) && !/^https?:\/\/(127\.0\.0\.1|localhost)(:|\/|$)/i.test(s);
}

export function tokenRefusalReason(env = process.env) {
  const token = String(env.PRODUCT_API_TOKEN ?? "").trim();
  if (token) return "PRODUCT_API_TOKEN_present";
  return null;
}

/** Hard refuse: eval process must not even exist with a machine token. */
export function assertEvalProcessSafe(env = process.env) {
  const reason = tokenRefusalReason(env);
  if (reason) {
    const msg = JSON.stringify({ event: "eval_token_refused", reason });
    throw Object.assign(new Error(msg), { exitCode: 2, evalRefuse: true, reason });
  }
  const base = defaultEvalApiBase(env);
  if (!String(env.EVAL_API_BASE ?? "").trim() && isQingBlueHost(base)) {
    throw Object.assign(
      new Error(JSON.stringify({ event: "eval_purge_blocked", reason: "default_api_is_qing_blue" })),
      { exitCode: 2, evalRefuse: true, reason: "default_api_is_qing_blue" }
    );
  }
}

export function isEvalUsernameAllowed(username, env = process.env) {
  const u = String(username ?? "").trim();
  if (!u) return false;
  if (FORBIDDEN_EVAL_USERNAMES.has(u)) return false;
  const legacy = String(env.PRODUCT_LEGACY_OWNER ?? "admin").trim() || "admin";
  if (u === legacy) return false;
  return true;
}

/**
 * Purge is allowed only after a successful eval session login AND EVAL_ALLOW_PURGE=1.
 * Cookie identity is zf_session (caller-provided username from GET /api/auth/me).
 */
export function assertPurgeAllowed({ env = process.env, meUsername, wrappingProven } = {}) {
  assertEvalProcessSafe(env);
  if (String(env.EVAL_ALLOW_PURGE ?? "0") !== "1") {
    throw Object.assign(
      new Error(JSON.stringify({ event: "eval_purge_blocked", reason: "EVAL_ALLOW_PURGE_not_set" })),
      { exitCode: 2, evalRefuse: true, reason: "EVAL_ALLOW_PURGE_not_set" }
    );
  }
  if (!wrappingProven) {
    throw Object.assign(
      new Error(JSON.stringify({ event: "eval_purge_blocked", reason: "wrapping_probe_failed" })),
      { exitCode: 2, evalRefuse: true, reason: "wrapping_probe_failed" }
    );
  }
  const expected = String(env.EVAL_USERNAME ?? "eval_sim").trim();
  if (!meUsername || meUsername !== expected || !isEvalUsernameAllowed(meUsername, env)) {
    throw Object.assign(
      new Error(JSON.stringify({ event: "eval_purge_blocked", reason: "eval_session_login_required" })),
      { exitCode: 2, evalRefuse: true, reason: "eval_session_login_required" }
    );
  }
}

export function printRefuseAndExit(err, log = console.error) {
  const code = err?.exitCode === 2 ? 2 : 2;
  log(err?.message ?? String(err));
  process.exit(code);
}
