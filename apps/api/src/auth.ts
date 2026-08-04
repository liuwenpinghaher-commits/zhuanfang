import { createHash, timingSafeEqual } from "node:crypto";
import { parseSessionToken, SESSION_COOKIE } from "./auth/session";
import { enterPrincipal, legacyOwner, machineUsername, type AuthPrincipal } from "./auth/user-context";

type Env = Record<string, string | undefined>;

/** Human session auth (username/password + zf_session). */
export function isSessionAuthEnabled(env: Env): boolean {
  const v = (env.PRODUCT_AUTH_ENABLED ?? "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

/** Production machine bearer is active when profile is production AND token is set. */
export function isMachineAuthConfigured(env: Env): boolean {
  const isProduction = (env.DEPLOYMENT_PROFILE ?? "").trim().toLowerCase() === "production";
  return isProduction && Boolean(env.PRODUCT_API_TOKEN);
}

/**
 * Guard active when either human session auth is enabled OR legacy production token guard is on.
 * Local/dev with neither → open (tests remain friction-free unless env enables auth).
 */
export function isAuthGuardActive(env: Env): boolean {
  return isSessionAuthEnabled(env) || isMachineAuthConfigured(env);
}

function bearerMatches(actual: string, apiToken: string): boolean {
  const expected = `Bearer ${apiToken}`;
  const expectedDigest = createHash("sha256").update(expected).digest();
  const actualDigest = createHash("sha256").update(actual).digest();
  return timingSafeEqual(expectedDigest, actualDigest);
}

export function readCookieValue(
  cookieHeader: string | undefined,
  name: string
): string | undefined {
  if (!cookieHeader) return undefined;
  for (const part of cookieHeader.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === name) {
      const v = rest.join("=").trim();
      return v ? decodeURIComponent(v) : undefined;
    }
  }
  return undefined;
}

/** @deprecated name kept for callers; reads product_api_token cookie (legacy). */
export function readCookieToken(
  cookieHeader: string | undefined,
  name = "product_api_token"
): string | undefined {
  return readCookieValue(cookieHeader, name);
}

export function resolvePrincipal(
  env: Env,
  presented: { authHeader?: string; tokenQuery?: string; cookieHeader?: string }
): AuthPrincipal | null {
  // 1) Human session cookie
  const sessionRaw = readCookieValue(presented.cookieHeader, SESSION_COOKIE);
  if (sessionRaw) {
    const data = parseSessionToken(sessionRaw, { env });
    if (data) return { kind: "user", username: data.username };
  }

  // 2) Machine bearer / query / legacy cookie
  const apiToken = (env.PRODUCT_API_TOKEN ?? "").trim();
  if (apiToken) {
    if (presented.authHeader && bearerMatches(presented.authHeader, apiToken)) {
      return { kind: "machine", username: machineUsername(env) };
    }
    if (presented.tokenQuery && bearerMatches(`Bearer ${presented.tokenQuery}`, apiToken)) {
      return { kind: "machine", username: machineUsername(env) };
    }
    const legacyCookie = readCookieValue(presented.cookieHeader, "product_api_token");
    if (legacyCookie && bearerMatches(`Bearer ${legacyCookie}`, apiToken)) {
      // Treat legacy shared-token cookie as machine principal on legacy owner for data access
      return { kind: "machine", username: legacyOwner(env) };
    }
  }

  return null;
}

/**
 * True when auth is inactive OR a presented credential resolves a principal.
 */
export function isAuthorized(
  env: Env,
  presented: { authHeader?: string; tokenQuery?: string; cookieToken?: string; cookieHeader?: string }
): boolean {
  if (!isAuthGuardActive(env)) {
    return true;
  }
  // Back-compat: cookieToken alone (tests) maps to legacy product_api_token header shape
  const cookieHeader =
    presented.cookieHeader ??
    (presented.cookieToken ? `product_api_token=${encodeURIComponent(presented.cookieToken)}` : undefined);
  return resolvePrincipal(env, {
    authHeader: presented.authHeader,
    tokenQuery: presented.tokenQuery,
    cookieHeader
  }) !== null;
}

/** Attach principal to ALS for the rest of the request (call from onRequest). */
export function bindRequestPrincipal(
  env: Env,
  presented: { authHeader?: string; tokenQuery?: string; cookieHeader?: string }
): AuthPrincipal | null {
  if (!isAuthGuardActive(env)) {
    enterPrincipal(null);
    return null;
  }
  const p = resolvePrincipal(env, presented);
  enterPrincipal(p);
  return p;
}

export { SESSION_COOKIE } from "./auth/session";
