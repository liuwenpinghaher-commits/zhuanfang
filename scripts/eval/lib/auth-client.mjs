/** Cookie name is the only identity the eval driver may use. */
export const SESSION_COOKIE_NAME = "zf_session";
export const FORBIDDEN_COOKIE_NAMES = ["product_api_token", "PRODUCT_API_TOKEN"];

export function assertCookieAllowed(name) {
  if (FORBIDDEN_COOKIE_NAMES.includes(name)) {
    throw new Error(`eval must not read/write cookie ${name}`);
  }
  if (name !== SESSION_COOKIE_NAME) {
    throw new Error(`eval cookie must be ${SESSION_COOKIE_NAME}, got ${name}`);
  }
}

export function cookieHeader(value) {
  assertCookieAllowed(SESSION_COOKIE_NAME);
  return `${SESSION_COOKIE_NAME}=${value}`;
}
