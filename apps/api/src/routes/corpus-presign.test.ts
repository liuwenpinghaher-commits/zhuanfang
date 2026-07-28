import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import { registerCorpusRoutes } from "./corpus";
import { createInMemoryProductStateRepository } from "../product-state-repository";

describe("corpus local presign", () => {
  const dir = mkdtempSync(join(tmpdir(), "corpus-presign-"));
  const app = Fastify();
  const repo = createInMemoryProductStateRepository();

  beforeAll(async () => {
    await registerCorpusRoutes(app, repo, {
      env: { DEPLOYMENT_PROFILE: "local" },
      corpusUploadDir: dir
    });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("presign then PUT writes bytes", async () => {
    const presign = await app.inject({
      method: "POST",
      url: "/api/corpus/audio-files/presign",
      payload: { fileName: "clip.wav", byteSize: 16 }
    });
    expect(presign.statusCode).toBe(200);
    const body = presign.json() as { provider?: string; uploadPath: string; storedFileName: string };
    expect(body.provider ?? "local").toBe("local");
    expect(body.uploadPath).toContain("/api/corpus/audio-files/");

    const put = await app.inject({
      method: "PUT",
      url: body.uploadPath,
      payload: { audioBase64: Buffer.from("RIFF....WAVEfmt ").toString("base64") }
    });
    expect(put.statusCode).toBe(200);
    expect(put.json().byteSize).toBeGreaterThan(0);
  });
});
