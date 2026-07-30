import { describe, expect, it } from "vitest";
import { assertPublicHttpUrl, assertSafeAudioSourceUrl, UnsafeUrlError } from "./safe-url";

describe("assertPublicHttpUrl", () => {
  it("allows public https URLs", () => {
    expect(assertPublicHttpUrl("https://cdn.example.com/a.wav")).toContain("cdn.example.com");
  });

  it("rejects loopback and private IPs", () => {
    for (const u of [
      "http://127.0.0.1/x",
      "http://10.0.0.5/x",
      "http://192.168.1.1/x",
      "http://172.16.0.1/x",
      "http://169.254.169.254/latest/meta-data/",
      "http://localhost/x"
    ]) {
      expect(() => assertPublicHttpUrl(u)).toThrow(UnsafeUrlError);
    }
  });

  it("allows allowlisted private hosts", () => {
    const prev = process.env.CORPUS_AUDIO_URL_ALLOWLIST;
    process.env.CORPUS_AUDIO_URL_ALLOWLIST = "minio.local,10.0.0.5";
    try {
      expect(assertPublicHttpUrl("http://10.0.0.5/bucket/a.wav")).toContain("10.0.0.5");
    } finally {
      if (prev === undefined) delete process.env.CORPUS_AUDIO_URL_ALLOWLIST;
      else process.env.CORPUS_AUDIO_URL_ALLOWLIST = prev;
    }
  });

  it("assertSafeAudioSourceUrl allows oss:// without fetch", () => {
    expect(assertSafeAudioSourceUrl("oss://bucket/key")).toBe("oss://bucket/key");
  });
});
