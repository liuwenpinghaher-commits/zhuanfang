import { AsyncLocalStorage } from "node:async_hooks";

export type AuthPrincipal =
  | { kind: "user"; username: string }
  | { kind: "machine"; username: string };

const storage = new AsyncLocalStorage<AuthPrincipal | null>();

export function runWithPrincipal<T>(principal: AuthPrincipal | null, fn: () => T): T {
  return storage.run(principal, fn);
}

/** Prefer enterWith in Fastify onRequest so the rest of the request inherits the principal. */
export function enterPrincipal(principal: AuthPrincipal | null): void {
  storage.enterWith(principal);
}

export function currentPrincipal(): AuthPrincipal | null {
  return storage.getStore() ?? null;
}

export function currentUsername(): string | null {
  const p = currentPrincipal();
  return p?.username ?? null;
}

export function legacyOwner(env: Record<string, string | undefined> = process.env): string {
  return (env.PRODUCT_LEGACY_OWNER ?? env.PRODUCT_DEFAULT_USER ?? "admin").trim() || "admin";
}

export function machineUsername(env: Record<string, string | undefined> = process.env): string {
  return (env.PRODUCT_MACHINE_USER ?? "__machine__").trim() || "__machine__";
}

/** Sanitize username for filesystem / surreal path segments. */
export function sanitizeUserKey(username: string): string {
  const s = username.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "_");
  return s.slice(0, 64) || "user";
}
