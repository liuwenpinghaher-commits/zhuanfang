import { describe, it, expect } from "vitest";
import { createInMemoryAudioRepository } from "./audio-repository";
import type { InterviewAudio } from "../../../src/domain/types";

const mk = (id: string, role: InterviewAudio["role"] = "interviewee"): InterviewAudio => ({
  sessionId: id, role, audio: new Uint8Array([1, 2, 3, 4]), mime: "audio/webm", byteSize: 4,
  durationMs: 1000, createdAt: "2026-06-21T00:00:00.000Z"
});

describe("in-memory AudioRepository", () => {
  it("put/get 往返字节完整, has, 不存在 undefined/false", () => {
    const r = createInMemoryAudioRepository();
    expect(r.get("s1")).toBeUndefined();
    expect(r.has("s1")).toBe(false);
    r.put(mk("s1"));
    expect(Array.from(r.get("s1")!.audio)).toEqual([1, 2, 3, 4]);
    expect(r.has("s1")).toBe(true);
  });
  it("delete / deleteAll", () => {
    const r = createInMemoryAudioRepository();
    r.put(mk("s1")); r.put(mk("s2"));
    r.delete("s1");
    expect(r.has("s1")).toBe(false); expect(r.has("s2")).toBe(true);
    r.deleteAll();
    expect(r.has("s2")).toBe(false);
  });

  it("两路 role: 同 sessionId 的 interviewee/interviewer 互不覆盖, 各自取回", () => {
    const r = createInMemoryAudioRepository();
    const interviewee: InterviewAudio = { ...mk("s1", "interviewee"), audio: new Uint8Array([1, 1]) };
    const interviewer: InterviewAudio = { ...mk("s1", "interviewer"), audio: new Uint8Array([2, 2, 2]) };
    r.put(interviewee);
    r.put(interviewer);
    expect(Array.from(r.get("s1", "interviewee")!.audio)).toEqual([1, 1]);
    expect(Array.from(r.get("s1", "interviewer")!.audio)).toEqual([2, 2, 2]);
    expect(r.get("s1", "interviewee")!.role).toBe("interviewee");
    expect(r.get("s1", "interviewer")!.role).toBe("interviewer");
  });

  it("get/has 缺省 role → interviewee", () => {
    const r = createInMemoryAudioRepository();
    r.put(mk("s1", "interviewee"));
    expect(r.get("s1")!.role).toBe("interviewee");
    expect(r.has("s1")).toBe(true);
    // 只有 interviewer 一路时, 默认(interviewee)查不到
    const r2 = createInMemoryAudioRepository();
    r2.put(mk("s2", "interviewer"));
    expect(r2.get("s2")).toBeUndefined();
    expect(r2.has("s2")).toBe(false);
    expect(r2.has("s2", "interviewer")).toBe(true);
  });

  it("delete(sessionId) 无 role → 删该 session 全部 role", () => {
    const r = createInMemoryAudioRepository();
    r.put(mk("s1", "interviewee"));
    r.put(mk("s1", "interviewer"));
    r.delete("s1");
    expect(r.has("s1", "interviewee")).toBe(false);
    expect(r.has("s1", "interviewer")).toBe(false);
  });

  it("delete(sessionId, role) 仅删该路, 另一路保留", () => {
    const r = createInMemoryAudioRepository();
    r.put(mk("s1", "interviewee"));
    r.put(mk("s1", "interviewer"));
    r.delete("s1", "interviewer");
    expect(r.has("s1", "interviewee")).toBe(true);
    expect(r.has("s1", "interviewer")).toBe(false);
  });

  it("listSessionIds 对同 session 两路去重为 1; listAll 每路一条", () => {
    const r = createInMemoryAudioRepository();
    r.put(mk("s1", "interviewee"));
    r.put(mk("s1", "interviewer"));
    r.put(mk("s2", "interviewee"));
    expect([...r.listSessionIds()].sort()).toEqual(["s1", "s2"]);
    expect(r.listAll().length).toBe(3);
  });
});
