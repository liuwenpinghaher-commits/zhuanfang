import { describe, it, expect } from "vitest";
import { formatProviderErrorMessage } from "./provider-error";

describe("provider-error", () => {
  it("redacts API keys from error messages", () => {
    const error = new Error("Failed with key sk-abc123xyz");
    const formatted = formatProviderErrorMessage(error);
    expect(formatted).not.toContain("sk-abc123xyz");
  });

  it("truncates long messages", () => {
    const error = new Error("x".repeat(500));
    const formatted = formatProviderErrorMessage(error);
    expect(formatted.length).toBeLessThanOrEqual(200);
  });
});
