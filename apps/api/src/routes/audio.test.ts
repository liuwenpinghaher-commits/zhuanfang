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
      role: "interviewee",
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
      role: "interviewee",
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

  it("role=interviewer: POST + GET 各自取回, 与默认(interviewee)互不干扰", async () => {
    const audioRepository = createInMemoryAudioRepository();
    const server = buildApiServer({ env: {}, audioRepository });
    // interviewee (默认, 无 role)
    await server.inject({
      method: "POST",
      url: "/api/sessions/s1/audio",
      payload: { audioBase64: Buffer.from([1, 1]).toString("base64"), mime: "audio/webm" }
    });
    // interviewer (?role=interviewer)
    await server.inject({
      method: "POST",
      url: "/api/sessions/s1/audio?role=interviewer",
      payload: { audioBase64: Buffer.from([2, 2, 2]).toString("base64"), mime: "audio/webm" }
    });

    const erRes = await server.inject({ method: "GET", url: "/api/sessions/s1/audio?role=interviewer" });
    expect(erRes.statusCode).toBe(200);
    expect(Array.from(erRes.rawPayload)).toEqual([2, 2, 2]);

    // 默认(无 role)拿 interviewee, 不受 interviewer 影响
    const eeRes = await server.inject({ method: "GET", url: "/api/sessions/s1/audio" });
    expect(eeRes.statusCode).toBe(200);
    expect(Array.from(eeRes.rawPayload)).toEqual([1, 1]);

    // 两路在 repo 里各存一条
    expect(audioRepository.get("s1", "interviewee")!.role).toBe("interviewee");
    expect(audioRepository.get("s1", "interviewer")!.role).toBe("interviewer");
  });

  it("meta?role=interviewer 返回里带 role", async () => {
    const audioRepository = createInMemoryAudioRepository();
    const server = buildApiServer({ env: {}, audioRepository });
    await server.inject({
      method: "POST",
      url: "/api/sessions/s1/audio?role=interviewer",
      payload: { audioBase64: Buffer.from([2, 2, 2]).toString("base64"), mime: "audio/webm", durationMs: 800 }
    });
    const res = await server.inject({ method: "GET", url: "/api/sessions/s1/audio/meta?role=interviewer" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      exists: true,
      role: "interviewer",
      mime: "audio/webm",
      byteSize: 3,
      durationMs: 800,
      recordingStartedAt: null
    });
    // 默认 meta(无 role)→ interviewee 不存在
    const def = await server.inject({ method: "GET", url: "/api/sessions/s1/audio/meta" });
    expect(def.json()).toEqual({ exists: false });
  });

  it("非法 role → 回退 interviewee", async () => {
    const audioRepository = createInMemoryAudioRepository();
    const server = buildApiServer({ env: {}, audioRepository });
    await server.inject({
      method: "POST",
      url: "/api/sessions/s1/audio?role=bogus",
      payload: { audioBase64: Buffer.from([7]).toString("base64"), mime: "audio/webm" }
    });
    // 非法 role 落入 interviewee
    expect(audioRepository.get("s1", "interviewee")!.role).toBe("interviewee");
    const res = await server.inject({ method: "GET", url: "/api/sessions/s1/audio?role=bogus" });
    expect(res.statusCode).toBe(200);
    expect(Array.from(res.rawPayload)).toEqual([7]);
  });

  it("meta 默认存在时也带 role: interviewee", async () => {
    const audioRepository = createInMemoryAudioRepository();
    const server = buildApiServer({ env: {}, audioRepository });
    await server.inject({
      method: "POST",
      url: "/api/sessions/s1/audio",
      payload: { audioBase64: Buffer.from([1, 2, 3]).toString("base64"), mime: "audio/webm", durationMs: 500 }
    });
    const res = await server.inject({ method: "GET", url: "/api/sessions/s1/audio/meta" });
    expect(res.json()).toEqual({
      exists: true,
      role: "interviewee",
      mime: "audio/webm",
      byteSize: 3,
      durationMs: 500,
      recordingStartedAt: null
    });
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
