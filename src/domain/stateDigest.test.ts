import { describe, it, expect } from "vitest";
import { buildStableDigest } from "./stateDigest";

describe("stateDigest", () => {
  it("produces consistent hash for same input", () => {
    const a = { x: 1, y: 2 };
    const b = { y: 2, x: 1 };
    expect(buildStableDigest(a)).toBe(buildStableDigest(b));
  });

  it("produces different hash for different input", () => {
    expect(buildStableDigest({ x: 1 })).not.toBe(buildStableDigest({ x: 2 }));
  });

  it("produces fnv1a format hash", () => {
    const digest = buildStableDigest({ hello: "world" });
    expect(digest).toMatch(/^fnv1a-[a-f0-9]{8}$/);
  });

  it("handles nested objects consistently", () => {
    const a = { outer: { inner: 1, deep: { value: "x" } } };
    const b = { outer: { deep: { value: "x" }, inner: 1 } };
    expect(buildStableDigest(a)).toBe(buildStableDigest(b));
  });
});
