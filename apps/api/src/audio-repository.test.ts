import { describe, it, expect } from "vitest";
import { createInMemoryAudioRepository } from "./audio-repository";
import type { InterviewAudio } from "../../../src/domain/types";

const mk = (id: string, role: InterviewAudio["role"] = "interviewee"): InterviewAudio => ({
  sessionId: id, role, audio: new Uint8Array([1, 2, 3, 4]), mime: "audio/webm", byteSize: 4,
  durationMs: 1000, createdAt: "2026-06-21T00:00:00.000Z"
});

// R2a:仓库接口已异步化,全部调用 await。
describe("in-memory AudioRepository", () => {
  it("put/get 往返字节完整, has, 不存在 undefined/false", async () => {
    const r = createInMemoryAudioRepository();
    expect(await r.get("s1")).toBeUndefined();
    expect(await r.has("s1")).toBe(false);
    await r.put(mk("s1"));
    expect(Array.from((await r.get("s1"))!.audio)).toEqual([1, 2, 3, 4]);
    expect(await r.has("s1")).toBe(true);
  });
  it("delete / deleteAll", async () => {
    const r = createInMemoryAudioRepository();
    await r.put(mk("s1")); await r.put(mk("s2"));
    await r.delete("s1");
    expect(await r.has("s1")).toBe(false); expect(await r.has("s2")).toBe(true);
    await r.deleteAll();
    expect(await r.has("s2")).toBe(false);
  });

  it("两路 role: 同 sessionId 的 interviewee/interviewer 互不覆盖, 各自取回", async () => {
    const r = createInMemoryAudioRepository();
    const interviewee: InterviewAudio = { ...mk("s1", "interviewee"), audio: new Uint8Array([1, 1]) };
    const interviewer: InterviewAudio = { ...mk("s1", "interviewer"), audio: new Uint8Array([2, 2, 2]) };
    await r.put(interviewee);
    await r.put(interviewer);
    expect(Array.from((await r.get("s1", "interviewee"))!.audio)).toEqual([1, 1]);
    expect(Array.from((await r.get("s1", "interviewer"))!.audio)).toEqual([2, 2, 2]);
    expect((await r.get("s1", "interviewee"))!.role).toBe("interviewee");
    expect((await r.get("s1", "interviewer"))!.role).toBe("interviewer");
  });

  it("get/has 缺省 role → interviewee", async () => {
    const r = createInMemoryAudioRepository();
    await r.put(mk("s1", "interviewee"));
    expect((await r.get("s1"))!.role).toBe("interviewee");
    expect(await r.has("s1")).toBe(true);
    // 只有 interviewer 一路时, 默认(interviewee)查不到
    const r2 = createInMemoryAudioRepository();
    await r2.put(mk("s2", "interviewer"));
    expect(await r2.get("s2")).toBeUndefined();
    expect(await r2.has("s2")).toBe(false);
    expect(await r2.has("s2", "interviewer")).toBe(true);
  });

  it("delete(sessionId) 无 role → 删该 session 全部 role", async () => {
    const r = createInMemoryAudioRepository();
    await r.put(mk("s1", "interviewee"));
    await r.put(mk("s1", "interviewer"));
    await r.delete("s1");
    expect(await r.has("s1", "interviewee")).toBe(false);
    expect(await r.has("s1", "interviewer")).toBe(false);
  });

  it("delete(sessionId, role) 仅删该路, 另一路保留", async () => {
    const r = createInMemoryAudioRepository();
    await r.put(mk("s1", "interviewee"));
    await r.put(mk("s1", "interviewer"));
    await r.delete("s1", "interviewer");
    expect(await r.has("s1", "interviewee")).toBe(true);
    expect(await r.has("s1", "interviewer")).toBe(false);
  });

  it("listSessionIds 对同 session 两路去重为 1; listAll 每路一条", async () => {
    const r = createInMemoryAudioRepository();
    await r.put(mk("s1", "interviewee"));
    await r.put(mk("s1", "interviewer"));
    await r.put(mk("s2", "interviewee"));
    expect([...(await r.listSessionIds())].sort()).toEqual(["s1", "s2"]);
    expect((await r.listAll()).length).toBe(3);
  });
});
