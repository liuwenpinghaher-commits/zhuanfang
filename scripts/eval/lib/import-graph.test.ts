import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

describe("text driver import graph", () => {
  it("run.mjs does not statically import playwright or voice-cascade/reset helpers", () => {
    const src = readFileSync(join(root, "run.mjs"), "utf8");
    expect(src).not.toMatch(/from\s+["']@playwright\/test["']/);
    expect(src).not.toMatch(/from\s+["']playwright["']/);
    expect(src).not.toMatch(/voice-cascade\.spec/);
    expect(src).not.toMatch(/resetServerState/);
    expect(src).not.toMatch(/RESET_ALL_DATA/);
    expect(src).toMatch(/await import\("\.\/lib\/voice-adapter\.mjs"\)/);
  });

  it("voice-adapter source exists and does not import reset helpers", () => {
    const src = readFileSync(join(root, "lib/voice-adapter.mjs"), "utf8");
    expect(src).not.toMatch(/resetServerState/);
    expect(src).not.toMatch(/resetDemoState/);
    expect(src).not.toMatch(/RESET_ALL_DATA/);
    expect(src).not.toMatch(/voice-cascade\.spec/);
    expect(src).toMatch(/await import\("playwright"\)/);
    expect(src).toMatch(/zf_session/);
    expect(src).toMatch(/fake-mic/);
  });
});
