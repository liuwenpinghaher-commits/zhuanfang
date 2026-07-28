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
 * Accepts Authorization bearer, `?token=` query (WS/media), and cookie session token
 * (same-origin SPA bootstrap — avoids baking the secret into static JS as the only model).
 */
export function isAuthorized(
  env: Env,
  presented: { authHeader?: string; tokenQuery?: string; cookieToken?: string }
): boolean {
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
  if (presented.cookieToken && bearerMatches(`Bearer ${presented.cookieToken}`, apiToken)) {
    return true;
  }
  return false;
}

/** Parse a simple Cookie header for a named value (no dependency on @fastify/cookie). */
export function readCookieToken(cookieHeader: string | undefined, name = "product_api_token"): string | undefined {
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
