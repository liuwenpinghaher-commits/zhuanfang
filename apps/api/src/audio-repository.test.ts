import { describe, it, expect } from "vitest";
import { createInMemoryAudioRepository } from "./audio-repository";
import type { InterviewAudio } from "../../../src/domain/types";

const mk = (id: string): InterviewAudio => ({
  sessionId: id, audio: new Uint8Array([1, 2, 3, 4]), mime: "audio/webm", byteSize: 4,
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
});
