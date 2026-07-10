import { describe, it, expect } from "vitest";
import { createSqliteAudioRepository } from "./sqlite-audio-repository";
import type { InterviewAudio } from "../../../src/domain/types";

const mk = (id: string, role: InterviewAudio["role"] = "interviewee"): InterviewAudio => ({
  sessionId: id,
  role,
  audio: new Uint8Array([9, 8, 7, 0, 255]),
  mime: "audio/webm",
  byteSize: 5,
  durationMs: 2000,
  createdAt: "2026-06-21T00:00:00.000Z"
});

// R2a:仓库接口已异步化,全部调用 await。
describe("sqlite AudioRepository", () => {
  it("BLOB 往返字节完整, has, delete/deleteAll", async () => {
    const r = createSqliteAudioRepository({ dbPath: ":memory:" });
    await r.put(mk("s1"));
    expect(Array.from((await r.get("s1"))!.audio)).toEqual([9, 8, 7, 0, 255]);
    expect((await r.get("s1"))!.mime).toBe("audio/webm");
    expect(await r.has("s1")).toBe(true);
    expect(await r.get("missing")).toBeUndefined();
    await r.delete("s1");
    expect(await r.has("s1")).toBe(false);
    await r.put(mk("s2"));
    await r.deleteAll();
    expect(await r.has("s2")).toBe(false);
  });

  it("recordingStartedAt: put 带录音起始墙钟 → get 一致", async () => {
    const r = createSqliteAudioRepository({ dbPath: ":memory:" });
    await r.put({ ...mk("s1"), recordingStartedAt: "2026-06-21T10:00:00.000Z" });
    expect((await r.get("s1"))!.recordingStartedAt).toBe("2026-06-21T10:00:00.000Z");
  });

  it("recordingStartedAt: 不带时 get 无该字段(保持可选)", async () => {
    const r = createSqliteAudioRepository({ dbPath: ":memory:" });
    await r.put(mk("s1"));
    expect("recordingStartedAt" in (await r.get("s1"))!).toBe(false);
  });

  it("recordingStartedAt: upsert 覆盖时更新该列", async () => {
    const r = createSqliteAudioRepository({ dbPath: ":memory:" });
    await r.put({ ...mk("s1"), recordingStartedAt: "2026-06-21T10:00:00.000Z" });
    await r.put({ ...mk("s1"), recordingStartedAt: "2026-06-21T11:11:11.000Z" });
    expect((await r.get("s1"))!.recordingStartedAt).toBe("2026-06-21T11:11:11.000Z");
  });

  it("role: 两路 BLOB 各自往返, role 带上, 互不覆盖", async () => {
    const r = createSqliteAudioRepository({ dbPath: ":memory:" });
    await r.put({ ...mk("s1", "interviewee"), audio: new Uint8Array([1, 1]), byteSize: 2 });
    await r.put({ ...mk("s1", "interviewer"), audio: new Uint8Array([2, 2, 2]), byteSize: 3 });
    expect(Array.from((await r.get("s1", "interviewee"))!.audio)).toEqual([1, 1]);
    expect(Array.from((await r.get("s1", "interviewer"))!.audio)).toEqual([2, 2, 2]);
    expect((await r.get("s1", "interviewee"))!.role).toBe("interviewee");
    expect((await r.get("s1", "interviewer"))!.role).toBe("interviewer");
    expect((await r.get("s1"))!.role).toBe("interviewee"); // 默认 interviewee
  });

  it("role: delete(sessionId) 无 role → 删两路; listSessionIds 去重", async () => {
    const r = createSqliteAudioRepository({ dbPath: ":memory:" });
    await r.put(mk("s1", "interviewee"));
    await r.put(mk("s1", "interviewer"));
    expect(await r.listSessionIds()).toEqual(["s1"]);
    expect((await r.listAll()).length).toBe(2);
    await r.delete("s1");
    expect(await r.has("s1", "interviewee")).toBe(false);
    expect(await r.has("s1", "interviewer")).toBe(false);
  });

  it("role: delete(sessionId, role) 仅删该路", async () => {
    const r = createSqliteAudioRepository({ dbPath: ":memory:" });
    await r.put(mk("s1", "interviewee"));
    await r.put(mk("s1", "interviewer"));
    await r.delete("s1", "interviewer");
    expect(await r.has("s1", "interviewee")).toBe(true);
    expect(await r.has("s1", "interviewer")).toBe(false);
  });
});
