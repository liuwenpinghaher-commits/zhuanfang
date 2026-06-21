import { describe, it, expect } from "vitest";
import { createSqliteAudioRepository } from "./sqlite-audio-repository";
import type { InterviewAudio } from "../../../src/domain/types";

const mk = (id: string): InterviewAudio => ({
  sessionId: id,
  audio: new Uint8Array([9, 8, 7, 0, 255]),
  mime: "audio/webm",
  byteSize: 5,
  durationMs: 2000,
  createdAt: "2026-06-21T00:00:00.000Z"
});

describe("sqlite AudioRepository", () => {
  it("BLOB 往返字节完整, has, delete/deleteAll", () => {
    const r = createSqliteAudioRepository({ dbPath: ":memory:" });
    r.put(mk("s1"));
    expect(Array.from(r.get("s1")!.audio)).toEqual([9, 8, 7, 0, 255]);
    expect(r.get("s1")!.mime).toBe("audio/webm");
    expect(r.has("s1")).toBe(true);
    expect(r.get("missing")).toBeUndefined();
    r.delete("s1");
    expect(r.has("s1")).toBe(false);
    r.put(mk("s2"));
    r.deleteAll();
    expect(r.has("s2")).toBe(false);
  });

  it("recordingStartedAt: put 带录音起始墙钟 → get 一致", () => {
    const r = createSqliteAudioRepository({ dbPath: ":memory:" });
    r.put({ ...mk("s1"), recordingStartedAt: "2026-06-21T10:00:00.000Z" });
    expect(r.get("s1")!.recordingStartedAt).toBe("2026-06-21T10:00:00.000Z");
  });

  it("recordingStartedAt: 不带时 get 无该字段(保持可选)", () => {
    const r = createSqliteAudioRepository({ dbPath: ":memory:" });
    r.put(mk("s1"));
    expect("recordingStartedAt" in r.get("s1")!).toBe(false);
  });

  it("recordingStartedAt: upsert 覆盖时更新该列", () => {
    const r = createSqliteAudioRepository({ dbPath: ":memory:" });
    r.put({ ...mk("s1"), recordingStartedAt: "2026-06-21T10:00:00.000Z" });
    r.put({ ...mk("s1"), recordingStartedAt: "2026-06-21T11:11:11.000Z" });
    expect(r.get("s1")!.recordingStartedAt).toBe("2026-06-21T11:11:11.000Z");
  });
});
