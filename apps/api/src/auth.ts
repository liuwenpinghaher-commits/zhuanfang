import { createHash, timingSafeEqual } from "node:crypto";

type Env = Record<string, string | undefined>;

/** Production bearer auth is active only when the profile is production AND a token is set. */
export function isAuthGuardActive(env: Env): boolean {
  const isProduction = (env.DEPLOYMENT_PROFILE ?? "").trim().toLowerCase() === "production";
  return isProduction && Boolean(env.PRODUCT_API_TOKEN);
}

function bearerMatches(actual: string, apiToken: string): boolean {
  // Hash both sides to a fixed 32-byte SHA-256 digest BEFORE comparing. This makes the
  // timingSafeEqual run on equal-length buffers in constant time regardless of the input,
  // eliminating the length-equality short-circuit (`actual.length === expected.length &&`)
  // that previously leaked a length oracle.
  const expected = `Bearer ${apiToken}`;
  const expectedDigest = createHash("sha256").update(expected).digest();
  const actualDigest = createHash("sha256").update(actual).digest();
  return timingSafeEqual(expectedDigest, actualDigest);
}

/**
 * True when auth is inactive (local/dev) OR a presented credential matches the token.
 * Accepts the `Authorization` header (normal HTTP) AND a `?token=` query value, because
 * browser WebSocket clients cannot set request headers — without the query path the WS
 * upgrade would be unauthenticated, bypassing the HTTP guard entirely.
 */
export function isAuthorized(env: Env, presented: { authHeader?: string; tokenQuery?: string }): boolean {
  const apiToken = env.PRODUCT_API_TOKEN;
  if (!isAuthGuardActive(env) || !apiToken) {
    return true;
  }
  if (presented.authHeader && bearerMatches(presented.authHeader, apiToken)) {
    return true;
  }
  if (presented.tokenQuery && bearerMatches(`Bearer ${presented.tokenQuery}`, apiToken)) {
    return true;
  }
  return false;
}
