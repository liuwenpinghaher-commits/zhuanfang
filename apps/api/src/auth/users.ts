import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { hashPassword, verifyPassword } from "./passwords";

type UserRow = { username: string; password_hash: string; created_at: number };

export function resolveAuthDbPath(env: Record<string, string | undefined> = process.env, cwd = process.cwd()): string {
  const override = (env.PRODUCT_AUTH_DB ?? "").trim();
  if (override) return override;
  const state = (env.PRODUCT_STATE_DB_PATH ?? "").trim();
  if (state && state.toLowerCase() !== "memory" && !state.startsWith(":")) {
    return join(dirname(state), "auth-users.json");
  }
  return join(cwd, ".data", "auth-users.json");
}

function loadUsers(path: string): UserRow[] {
  if (!existsSync(path)) return [];
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as { users?: UserRow[] };
    return Array.isArray(raw.users) ? raw.users : [];
  } catch {
    return [];
  }
}

function saveUsers(path: string, users: UserRow[]): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ users }, null, 2), "utf8");
}

export function ensureBootstrapUsers(
  env: Record<string, string | undefined> = process.env,
  cwd = process.cwd()
): string[] {
  const raw = (env.PRODUCT_BOOTSTRAP_USERS ?? "").trim();
  if (!raw) return [];
  const path = resolveAuthDbPath(env, cwd);
  const existing = loadUsers(path);
  if (existing.length > 0) return [];
  const created: string[] = [];
  const now = Date.now() / 1000;
  const users: UserRow[] = [];
  for (const part of raw.split(",")) {
    const trimmed = part.trim();
    if (!trimmed || !trimmed.includes(":")) continue;
    const idx = trimmed.indexOf(":");
    const user = trimmed.slice(0, idx).trim();
    const pass = trimmed.slice(idx + 1);
    if (!user || !pass) continue;
    users.push({ username: user, password_hash: hashPassword(pass), created_at: now });
    created.push(user);
  }
  if (users.length) saveUsers(path, users);
  return created;
}

export function authenticateUser(
  username: string,
  password: string,
  env: Record<string, string | undefined> = process.env,
  cwd = process.cwd()
): boolean {
  const u = username.trim();
  if (!u || !password) return false;
  ensureBootstrapUsers(env, cwd);
  const users = loadUsers(resolveAuthDbPath(env, cwd));
  const row = users.find((x) => x.username === u);
  if (!row) {
    verifyPassword(password, hashPassword("dummy-timing"));
    return false;
  }
  return verifyPassword(password, row.password_hash);
}

export function createUser(
  username: string,
  password: string,
  env: Record<string, string | undefined> = process.env,
  cwd = process.cwd()
): void {
  const u = username.trim();
  if (!u || !password) throw new Error("username and password required");
  const path = resolveAuthDbPath(env, cwd);
  const users = loadUsers(path);
  if (users.some((x) => x.username === u)) throw new Error(`user exists: ${u}`);
  users.push({ username: u, password_hash: hashPassword(password), created_at: Date.now() / 1000 });
  saveUsers(path, users);
}

export function userExists(
  username: string,
  env: Record<string, string | undefined> = process.env,
  cwd = process.cwd()
): boolean {
  const u = username.trim();
  if (!u) return false;
  ensureBootstrapUsers(env, cwd);
  return loadUsers(resolveAuthDbPath(env, cwd)).some((x) => x.username === u);
}
