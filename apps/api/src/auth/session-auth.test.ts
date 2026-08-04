import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hashPassword, verifyPassword } from "./passwords";
import { issueSessionToken, parseSessionToken, SESSION_COOKIE } from "./session";
import { authenticateUser, ensureBootstrapUsers } from "./users";
import { enterPrincipal, runWithPrincipal } from "./user-context";
import {
  createInMemoryUserRepoFactory,
  createUserScopedProductStateRepository
} from "./user-scoped-repository";
import { buildApiServer } from "../server";
import { createInMemoryProductStateRepository } from "../product-state-repository";

const SECRET = "test-session-secret-for-zhuanfang-l1-32b!!";

describe("passwords + session", () => {
  it("hash/verify roundtrip", () => {
    const h = hashPassword("s3cret!");
    expect(h.startsWith("pbkdf2_sha256$")).toBe(true);
    expect(verifyPassword("s3cret!", h)).toBe(true);
    expect(verifyPassword("wrong", h)).toBe(false);
  });

  it("session issue/parse and rejects tamper", () => {
    const tok = issueSessionToken("alice", { secret: SECRET, env: { PRODUCT_SESSION_SECRET: SECRET } });
    const data = parseSessionToken(tok, { secret: SECRET, env: { PRODUCT_SESSION_SECRET: SECRET } });
    expect(data?.username).toBe("alice");
    expect(parseSessionToken(tok + "x", { secret: SECRET, env: { PRODUCT_SESSION_SECRET: SECRET } })).toBeNull();
  });
});

describe("bootstrap users + HTTP session gate", () => {
  let dir: string;
  afterEach(() => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* */
    }
  });

  function envBase() {
    dir = mkdtempSync(join(tmpdir(), "zf-auth-"));
    return {
      PRODUCT_AUTH_ENABLED: "1",
      PRODUCT_SESSION_SECRET: SECRET,
      PRODUCT_BOOTSTRAP_USERS: "alice:alice-pass,bob:bob-pass",
      PRODUCT_LEGACY_OWNER: "alice",
      PRODUCT_AUTH_DB: join(dir, "auth-users.json"),
      RATE_LIMIT_DISABLED: "1"
    } as Record<string, string>;
  }

  it("login fail/success, protected /api/state requires session", async () => {
    const env = envBase();
    ensureBootstrapUsers(env, dir);
    expect(authenticateUser("alice", "alice-pass", env, dir)).toBe(true);
    expect(authenticateUser("alice", "nope", env, dir)).toBe(false);

    const factory = createInMemoryUserRepoFactory();
    const scoped = createUserScopedProductStateRepository({
      env,
      fallbackUsername: "alice",
      getOrCreate: (u) => factory.getOrCreate(u)
    });
    const server = buildApiServer({
      env,
      productStateRepository: scoped,
      disableUserScopedState: true
    });
    await server.ready();

    const unauth = await server.inject({ method: "GET", url: "/api/state" });
    expect(unauth.statusCode).toBe(401);

    const bad = await server.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username: "alice", password: "wrong" }
    });
    expect(bad.statusCode).toBe(401);

    const ok = await server.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username: "alice", password: "alice-pass" }
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().username).toBe("alice");
    const setCookie = ok.headers["set-cookie"];
    const cookieLine = Array.isArray(setCookie) ? setCookie.join(";") : String(setCookie ?? "");
    expect(cookieLine).toContain(SESSION_COOKIE);

    // extract cookie value
    const m = cookieLine.match(new RegExp(`${SESSION_COOKIE}=([^;]+)`));
    expect(m).toBeTruthy();
    const cookie = `${SESSION_COOKIE}=${m![1]}`;

    const state = await server.inject({
      method: "GET",
      url: "/api/state",
      headers: { cookie }
    });
    expect(state.statusCode).toBe(200);
    expect(state.json()).toHaveProperty("revision");

    const bootstrap = await server.inject({
      method: "GET",
      url: "/api/runtime-bootstrap",
      headers: { cookie }
    });
    expect(bootstrap.statusCode).toBe(200);
    const bb = bootstrap.json() as { authRequired?: boolean; authenticated?: boolean; cookieSet?: boolean };
    expect(bb.authRequired).toBe(true);
    expect(bb.authenticated).toBe(true);
    // Must not leak machine token
    expect(JSON.stringify(bb)).not.toMatch(/alice-pass|PRODUCT_API_TOKEN|secret/);

    await server.close();
  });

  it("A/B isolation on product state", async () => {
    const env = envBase();
    ensureBootstrapUsers(env, dir);
    const factory = createInMemoryUserRepoFactory();
    const scoped = createUserScopedProductStateRepository({
      env,
      fallbackUsername: "alice",
      getOrCreate: (u) => factory.getOrCreate(u)
    });
    const server = buildApiServer({
      env,
      productStateRepository: scoped,
      disableUserScopedState: true
    });
    await server.ready();

    const login = async (user: string, pass: string) => {
      const res = await server.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: { username: user, password: pass }
      });
      expect(res.statusCode).toBe(200);
      const setCookie = res.headers["set-cookie"];
      const cookieLine = Array.isArray(setCookie) ? setCookie.join(";") : String(setCookie ?? "");
      const m = cookieLine.match(new RegExp(`${SESSION_COOKIE}=([^;]+)`));
      return `${SESSION_COOKIE}=${m![1]}`;
    };

    const aliceCookie = await login("alice", "alice-pass");
    // Alice writes a distinctive theme via replace path: PUT /api/state if exists, else mutate via reset+replace
    const aliceState = await server.inject({ method: "GET", url: "/api/state", headers: { cookie: aliceCookie } });
    expect(aliceState.statusCode).toBe(200);
    const as = aliceState.json() as { revision: number; themes: unknown[] };
    const next = {
      ...as,
      themes: [
        ...(as.themes ?? []),
        {
          id: "th_alice_secret",
          name: "ALICE_ONLY_THEME",
          summary: "private",
          maturity: "聚焦",
          representativeQuote: "",
          appearances: 1,
          nextQuestion: "",
          updatedAt: new Date().toISOString()
        }
      ]
    };
    const put = await server.inject({
      method: "PUT",
      url: "/api/state",
      headers: { cookie: aliceCookie, "content-type": "application/json" },
      payload: next
    });
    // PUT may be 200 or 405 depending on routes — use replace via export-safe path
    if (put.statusCode >= 400) {
      // Fall back to direct repo under ALS
      runWithPrincipal({ kind: "user", username: "alice" }, () => {
        scoped.replaceState(next as never);
      });
    }

    const aliceRead = await server.inject({
      method: "GET",
      url: "/api/state",
      headers: { cookie: aliceCookie }
    });
    expect(JSON.stringify(aliceRead.json())).toContain("ALICE_ONLY_THEME");

    const bobCookie = await login("bob", "bob-pass");
    const bobRead = await server.inject({
      method: "GET",
      url: "/api/state",
      headers: { cookie: bobCookie }
    });
    expect(bobRead.statusCode).toBe(200);
    expect(JSON.stringify(bobRead.json())).not.toContain("ALICE_ONLY_THEME");

    await server.close();
  });

  it("machine Bearer without session cookie reaches protected API", async () => {
    const env = {
      ...envBase(),
      DEPLOYMENT_PROFILE: "production",
      PRODUCT_API_TOKEN: "machine-token-xyz"
    };
    ensureBootstrapUsers(env, dir);
    const server = buildApiServer({
      env,
      productStateRepository: createInMemoryProductStateRepository(),
      disableUserScopedState: true
    });
    await server.ready();

    const denied = await server.inject({ method: "GET", url: "/api/state" });
    expect(denied.statusCode).toBe(401);

    const ok = await server.inject({
      method: "GET",
      url: "/api/state",
      headers: { authorization: "Bearer machine-token-xyz" }
    });
    expect(ok.statusCode).toBe(200);

    // bootstrap must not dump machine token in body, nor set product_api_token cookie under session mode
    const boot = await server.inject({ method: "GET", url: "/api/runtime-bootstrap" });
    expect(JSON.stringify(boot.json())).not.toContain("machine-token-xyz");
    const setCookie = boot.headers["set-cookie"];
    const cookieLine = Array.isArray(setCookie) ? setCookie.join(";") : String(setCookie ?? "");
    expect(cookieLine).not.toMatch(/product_api_token=/);

    const logout = await server.inject({ method: "POST", url: "/api/auth/logout" });
    expect(logout.statusCode).toBe(200);
    expect(String(logout.headers["set-cookie"] ?? "")).toMatch(/Max-Age=0/i);

    await server.close();
  });
});
