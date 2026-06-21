import { describe, it, expect } from "vitest";
import { buildApiServer } from "../server";
import { createInMemoryAudioRepository } from "../audio-repository";

describe("audio routes", () => {
  it("POST /api/sessions/:id/audio 上传 → 200 + ok + byteSize,落入注入的 repo", async () => {
    const audioRepository = createInMemoryAudioRepository();
    const server = buildApiServer({ env: {}, audioRepository });
    const res = await server.inject({
      method: "POST",
      url: "/api/sessions/s1/audio",
      payload: {
        audioBase64: Buffer.from([1, 2, 3]).toString("base64"),
        mime: "audio/webm",
        durationMs: 500
      }
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.byteSize).toBe(3);

    const stored = audioRepository.get("s1");
    expect(stored).toBeDefined();
    expect(Array.from(stored!.audio)).toEqual([1, 2, 3]);
    expect(stored!.mime).toBe("audio/webm");
    expect(stored!.byteSize).toBe(3);
    expect(stored!.durationMs).toBe(500);
  });

  it("GET /api/sessions/:id/audio 回放 → 200 + 二进制往返 + content-type", async () => {
    const audioRepository = createInMemoryAudioRepository();
    const server = buildApiServer({ env: {}, audioRepository });
    await server.inject({
      method: "POST",
      url: "/api/sessions/s1/audio",
      payload: {
        audioBase64: Buffer.from([1, 2, 3]).toString("base64"),
        mime: "audio/webm",
        durationMs: 500
      }
    });
    const res = await server.inject({ method: "GET", url: "/api/sessions/s1/audio" });
    expect(res.statusCode).toBe(200);
    expect(Array.from(res.rawPayload)).toEqual([1, 2, 3]);
    expect(res.headers["content-type"]).toContain("audio/webm");
  });

  it("GET /api/sessions/missing/audio → 404", async () => {
    const audioRepository = createInMemoryAudioRepository();
    const server = buildApiServer({ env: {}, audioRepository });
    const res = await server.inject({ method: "GET", url: "/api/sessions/missing/audio" });
    expect(res.statusCode).toBe(404);
  });

  it("GET /api/sessions/:id/audio/meta 存在 → exists:true + 元数据", async () => {
    const audioRepository = createInMemoryAudioRepository();
    const server = buildApiServer({ env: {}, audioRepository });
    await server.inject({
      method: "POST",
      url: "/api/sessions/s1/audio",
      payload: {
        audioBase64: Buffer.from([1, 2, 3]).toString("base64"),
        mime: "audio/webm",
        durationMs: 500
      }
    });
    const res = await server.inject({ method: "GET", url: "/api/sessions/s1/audio/meta" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      exists: true,
      mime: "audio/webm",
      byteSize: 3,
      durationMs: 500,
      recordingStartedAt: null
    });
  });

  it("POST 带 recordingStartedAt → meta 返回该值", async () => {
    const audioRepository = createInMemoryAudioRepository();
    const server = buildApiServer({ env: {}, audioRepository });
    await server.inject({
      method: "POST",
      url: "/api/sessions/s1/audio",
      payload: {
        audioBase64: Buffer.from([1, 2, 3]).toString("base64"),
        mime: "audio/webm",
        durationMs: 500,
        recordingStartedAt: "2026-06-21T10:00:00.000Z"
      }
    });
    const stored = audioRepository.get("s1");
    expect(stored!.recordingStartedAt).toBe("2026-06-21T10:00:00.000Z");

    const res = await server.inject({ method: "GET", url: "/api/sessions/s1/audio/meta" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      exists: true,
      mime: "audio/webm",
      byteSize: 3,
      durationMs: 500,
      recordingStartedAt: "2026-06-21T10:00:00.000Z"
    });
  });

  it("GET /api/sessions/missing/audio/meta → exists:false", async () => {
    const audioRepository = createInMemoryAudioRepository();
    const server = buildApiServer({ env: {}, audioRepository });
    const res = await server.inject({ method: "GET", url: "/api/sessions/missing/audio/meta" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ exists: false });
  });

  it("POST 缺 audioBase64 → 422", async () => {
    const audioRepository = createInMemoryAudioRepository();
    const server = buildApiServer({ env: {}, audioRepository });
    const res = await server.inject({
      method: "POST",
      url: "/api/sessions/s1/audio",
      payload: { mime: "audio/webm" }
    });
    expect(res.statusCode).toBe(422);
  });

  it("POST 缺 mime → 422", async () => {
    const audioRepository = createInMemoryAudioRepository();
    const server = buildApiServer({ env: {}, audioRepository });
    const res = await server.inject({
      method: "POST",
      url: "/api/sessions/s1/audio",
      payload: { audioBase64: Buffer.from([1, 2, 3]).toString("base64") }
    });
    expect(res.statusCode).toBe(422);
  });
});
