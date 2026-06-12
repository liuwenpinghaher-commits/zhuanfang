import { describe, it, expect } from "vitest";
import { resolveRequestTimeoutMs } from "./request-timeout";

describe("request-timeout", () => {
  it("resolves default timeout from empty env", () => {
    expect(resolveRequestTimeoutMs({}, "PROVIDER_REQUEST_TIMEOUT_MS")).toBe(30000);
  });

  it("resolves custom timeout from env", () => {
    expect(resolveRequestTimeoutMs({ PROVIDER_REQUEST_TIMEOUT_MS: "15000" }, "PROVIDER_REQUEST_TIMEOUT_MS")).toBe(15000);
  });
});
