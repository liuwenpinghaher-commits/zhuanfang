import { createHmac, timingSafeEqual } from "node:crypto";

export const SESSION_COOKIE = "zf_session";
const DEFAULT_TTL_HOURS = 168;

export interface SessionData {
  username: string;
  exp: number;
}

function ttlSeconds(env: Record<string, string | undefined> = process.env): number {
  const hours = Number(env.PRODUCT_SESSION_TTL_HOURS ?? DEFAULT_TTL_HOURS);
  const h = Number.isFinite(hours) && hours > 0 ? hours : DEFAULT_TTL_HOURS;
  return Math.max(300, Math.floor(h * 3600));
}

export function sessionSecret(env: Record<string, string | undefined> = process.env): string {
  const s = (env.PRODUCT_SESSION_SECRET ?? "").trim();
  if (!s) throw new Error("PRODUCT_SESSION_SECRET is required when session auth is enabled");
  return s;
}

export function issueSessionToken(
  username: string,
  opts?: { now?: number; secret?: string; env?: Record<string, string | undefined> }
): string {
  const u = username.trim();
  if (!u) throw new Error("username required");
  const env = opts?.env ?? process.env;
  const secret = opts?.secret ?? sessionSecret(env);
  const now = opts?.now ?? Math.floor(Date.now() / 1000);
  const exp = now + ttlSeconds(env);
  const body = Buffer.from(JSON.stringify({ u, exp }), "utf8").toString("base64url");
  const sig = createHmac("sha256", secret).update(body).digest("hex");
  return `${body}.${sig}`;
}

export function parseSessionToken(
  token: string | undefined | null,
  opts?: { now?: number; secret?: string; env?: Record<string, string | undefined> }
): SessionData | null {
  if (!token || !token.includes(".")) return null;
  const env = opts?.env ?? process.env;
  let secret: string;
  try {
    secret = opts?.secret ?? sessionSecret(env);
  } catch {
    return null;
  }
  const i = token.lastIndexOf(".");
  if (i <= 0) return null;
  const body = token.slice(0, i);
  const sig = token.slice(i + 1);
  if (!body || !sig) return null;
  const expect = createHmac("sha256", secret).update(body).digest("hex");
  try {
    const a = Buffer.from(expect, "utf8");
    const b = Buffer.from(sig, "utf8");
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  } catch {
    return null;
  }
  try {
    const pad = "=".repeat((4 - (body.length % 4)) % 4);
    const json = Buffer.from(body.replace(/-/g, "+").replace(/_/g, "/") + pad, "base64").toString("utf8");
    const payload = JSON.parse(json) as { u?: string; exp?: number };
    const username = String(payload.u ?? "").trim();
    const exp = Number(payload.exp);
    if (!username || !Number.isFinite(exp)) return null;
    const now = opts?.now ?? Math.floor(Date.now() / 1000);
    if (exp < now) return null;
    return { username, exp };
  } catch {
    return null;
  }
}

export function sessionCookieHeader(
  token: string,
  opts: { secure?: boolean; maxAgeSec?: number; clear?: boolean } = {}
): string {
  if (opts.clear) {
    return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${opts.secure ? "; Secure" : ""}`;
  }
  const maxAge = opts.maxAgeSec ?? DEFAULT_TTL_HOURS * 3600;
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${
    opts.secure ? "; Secure" : ""
  }`;
}
