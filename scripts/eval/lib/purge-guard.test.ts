import { describe, expect, it } from "vitest";
import {
  assertEvalProcessSafe,
  assertPurgeAllowed,
  DEFAULT_EVAL_API_BASE,
  defaultEvalApiBase,
  isQingBlueHost,
  tokenRefusalReason
} from "./purge-guard.mjs";

describe("purge-guard (shipped)", () => {
  it("default API base is local, not qing.blue", () => {
    expect(DEFAULT_EVAL_API_BASE).toBe("http://127.0.0.1:3210");
    expect(isQingBlueHost(DEFAULT_EVAL_API_BASE)).toBe(false);
    expect(defaultEvalApiBase({})).toBe("http://127.0.0.1:3210");
    expect(isQingBlueHost("https://zhuanfang.qing.blue")).toBe(true);
  });

  it("token set → refuse", () => {
    expect(tokenRefusalReason({ PRODUCT_API_TOKEN: "x" })).toBe("PRODUCT_API_TOKEN_present");
    expect(() => assertEvalProcessSafe({ PRODUCT_API_TOKEN: "x" })).toThrow(/PRODUCT_API_TOKEN_present/);
    try {
      assertEvalProcessSafe({ PRODUCT_API_TOKEN: "secret" });
      throw new Error("should have thrown");
    } catch (err: unknown) {
      expect((err as { exitCode?: number }).exitCode).toBe(2);
    }
  });

  it("does not refuse when token is empty", () => {
    expect(() => assertEvalProcessSafe({ PRODUCT_API_TOKEN: "", EVAL_API_BASE: "http://127.0.0.1:3210" })).not.toThrow();
  });

  it("purge without eval login is refused", () => {
    const env = { PRODUCT_API_TOKEN: "", EVAL_ALLOW_PURGE: "1", EVAL_USERNAME: "eval_sim" };
    expect(() => assertPurgeAllowed({ env, wrappingProven: true })).toThrow(/eval_session_login_required/);
    expect(() =>
      assertPurgeAllowed({ env: { ...env, EVAL_ALLOW_PURGE: "0" }, meUsername: "eval_sim", wrappingProven: true })
    ).toThrow(/EVAL_ALLOW_PURGE_not_set/);
    expect(() =>
      assertPurgeAllowed({ env, meUsername: "eval_sim", wrappingProven: false })
    ).toThrow(/wrapping_probe_failed/);
    expect(() =>
      assertPurgeAllowed({ env, meUsername: "eval_sim", wrappingProven: true })
    ).not.toThrow();
  });
});
