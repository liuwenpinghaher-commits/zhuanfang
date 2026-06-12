import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadLocalEnvFile } from "./env";

describe("local env loader", () => {
  const tempDirs: string[] = [];
  const touchedKeys = ["DASHSCOPE_API_KEY", "BAILIAN_MODEL", "BAILIAN_TTS_MODEL"];

  afterEach(() => {
    for (const key of touchedKeys) {
      delete process.env[key];
    }
    while (tempDirs.length > 0) {
      rmSync(tempDirs.pop()!, { recursive: true, force: true });
    }
  });

  it("loads .env.local values without overriding existing environment variables", () => {
    const dir = mkdtempSync(join(tmpdir(), "interview-env-"));
    tempDirs.push(dir);
    writeFileSync(
      join(dir, ".env.local"),
      [
        "DASHSCOPE_API_KEY=local-secret",
        "BAILIAN_MODEL=qwen3.7-plus",
        'BAILIAN_TTS_MODEL="cosyvoice-v3-plus"',
        "# ignored comment"
      ].join("\n")
    );
    process.env.DASHSCOPE_API_KEY = "already-present";

    loadLocalEnvFile(dir);

    expect(process.env.DASHSCOPE_API_KEY).toBe("already-present");
    expect(process.env.BAILIAN_MODEL).toBe("qwen3.7-plus");
    expect(process.env.BAILIAN_TTS_MODEL).toBe("cosyvoice-v3-plus");
  });
});
