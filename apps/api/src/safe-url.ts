/**
 * Outbound URL guard (Wave A · A1.3 SSRF).
 * Blocks loopback / private / link-local / metadata targets unless allowlisted.
 */
import { isIP } from "node:net";

const DEFAULT_BLOCKED_HOSTS = new Set([
  "localhost",
  "metadata.google.internal",
  "metadata",
  "host.docker.internal"
]);

export class UnsafeUrlError extends Error {
  readonly code = "unsafe_url";
  constructor(message: string) {
    super(message);
    this.name = "UnsafeUrlError";
  }
}

function parseAllowlist(raw: string | undefined): Set<string> {
  if (!raw?.trim()) return new Set();
  return new Set(
    raw
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean)
  );
}

function isPrivateOrSpecialIp(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) {
    const parts = ip.split(".").map((p) => Number(p));
    if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) return true;
    const [a, b] = parts;
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    if (a >= 224) return true; // multicast / reserved
    return false;
  }
  if (v === 6) {
    const lower = ip.toLowerCase();
    if (lower === "::" || lower === "::1") return true;
    if (lower.startsWith("fc") || lower.startsWith("fd")) return true; // ULA
    if (lower.startsWith("fe80")) return true; // link-local
    if (lower.startsWith("ff")) return true; // multicast
    // IPv4-mapped
    const mapped = lower.match(/^:ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped?.[1]) return isPrivateOrSpecialIp(mapped[1]);
    return false;
  }
  return true;
}

/**
 * Validate a user-supplied URL before the server fetches it (SenseVoice, etc.).
 * @returns normalized href
 */
export function assertPublicHttpUrl(
  raw: string,
  opts: { allowlistEnv?: string; allowProtocols?: string[] } = {}
): string {
  const text = typeof raw === "string" ? raw.trim() : "";
  if (!text) throw new UnsafeUrlError("URL 不能为空。");

  let u: URL;
  try {
    u = new URL(text);
  } catch {
    throw new UnsafeUrlError("URL 无法解析。");
  }

  const allowProtocols = opts.allowProtocols ?? ["http:", "https:"];
  if (!allowProtocols.includes(u.protocol)) {
    // oss:// is a DashScope-side reference, not fetched by our Node process — allow explicitly when requested.
    throw new UnsafeUrlError(`不允许的 URL 协议：${u.protocol.replace(":", "")}`);
  }

  const host = (u.hostname || "").toLowerCase().replace(/^\[|\]$/g, "");
  if (!host) throw new UnsafeUrlError("URL 缺少主机名。");

  const allowlist = parseAllowlist(opts.allowlistEnv ?? process.env.CORPUS_AUDIO_URL_ALLOWLIST);
  if (allowlist.has(host) || allowlist.has(u.host.toLowerCase())) {
    return u.href;
  }

  if (DEFAULT_BLOCKED_HOSTS.has(host)) {
    throw new UnsafeUrlError(`禁止访问主机：${host}`);
  }

  // Literal IP host
  if (isIP(host)) {
    if (isPrivateOrSpecialIp(host)) {
      throw new UnsafeUrlError(`禁止访问内网/特殊地址：${host}`);
    }
    return u.href;
  }

  // Hostname ending in .local / .internal
  if (host.endsWith(".local") || host.endsWith(".internal") || host.endsWith(".localhost")) {
    throw new UnsafeUrlError(`禁止访问内网主机名：${host}`);
  }

  return u.href;
}

/** Soft check used by routes that also accept oss:// (not fetched locally). */
export function assertSafeAudioSourceUrl(raw: string): string {
  const text = raw.trim();
  if (/^oss:\/\//i.test(text)) return text;
  return assertPublicHttpUrl(text, {
    allowProtocols: ["http:", "https:"],
    allowlistEnv: process.env.CORPUS_AUDIO_URL_ALLOWLIST
  });
}
