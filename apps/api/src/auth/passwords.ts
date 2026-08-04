import { pbkdf2Sync, randomBytes, timingSafeEqual } from "node:crypto";

const SCHEME = "pbkdf2_sha256";
const ITERATIONS = 260_000;
const KEYLEN = 32;

export function hashPassword(password: string): string {
  if (!password) throw new Error("password required");
  const salt = randomBytes(16).toString("hex");
  const dk = pbkdf2Sync(password, salt, ITERATIONS, KEYLEN, "sha256").toString("hex");
  return `${SCHEME}$${salt}$${dk}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  if (!password || !stored) return false;
  const parts = stored.split("$");
  if (parts.length !== 3 || parts[0] !== SCHEME) return false;
  const [, salt, hexDk] = parts;
  if (!salt || !hexDk) return false;
  const dk = pbkdf2Sync(password, salt, ITERATIONS, KEYLEN, "sha256");
  const expected = Buffer.from(hexDk, "hex");
  if (expected.length !== dk.length) return false;
  return timingSafeEqual(dk, expected);
}
