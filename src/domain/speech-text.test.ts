import { describe, it, expect } from "vitest";
import { stripSpokenAsides, deriveSpeechProsody } from "./speech-text";

describe("stripSpokenAsides", () => {
  it("removes full-width parenthetical stage directions but keeps the spoken words", () => {
    const input = "你认同这个顺序吗？（温和但明确地观察对方反应）能说说你的理由吗？";
    expect(stripSpokenAsides(input)).toBe("你认同这个顺序吗？能说说你的理由吗？");
  });

  it("removes a leading aside without leaving stray whitespace", () => {
    expect(stripSpokenAsides("（轻笑，循循善诱）那咱们倒过来想。")).toBe("那咱们倒过来想。");
  });

  it("removes half-width parenthetical asides too", () => {
    expect(stripSpokenAsides("Right (leans in, curious) tell me more.")).toBe("Right tell me more.");
  });

  it("leaves text without asides unchanged", () => {
    const clean = "你刚才说的审批权，具体是哪个项目卡住了？";
    expect(stripSpokenAsides(clean)).toBe(clean);
  });

  it("returns empty string when the reply is only an aside", () => {
    expect(stripSpokenAsides("（轻笑）")).toBe("");
  });

  it("handles multiple asides in one reply", () => {
    expect(stripSpokenAsides("（点头）我明白了。（停顿）那你呢？")).toBe("我明白了。那你呢？");
  });
});

describe("deriveSpeechProsody", () => {
  it("returns neutral prosody when there is no aside", () => {
    expect(deriveSpeechProsody("你刚才说的审批权，具体卡在哪了？")).toEqual({ rate: 1, pitch: 1, volume: 50 });
  });

  it("maps a gentle/calm aside to slower rate and slightly lower pitch", () => {
    const p = deriveSpeechProsody("你认同吗？（温和但明确地观察对方反应）");
    expect(p.rate).toBeLessThan(1);
    expect(p.pitch).toBeLessThanOrEqual(1);
  });

  it("maps a lively/amused aside to faster rate and higher pitch", () => {
    const p = deriveSpeechProsody("（轻笑，循循善诱）那咱们倒过来想。");
    expect(p.rate).toBeGreaterThan(1);
    expect(p.pitch).toBeGreaterThan(1);
  });

  it("maps a serious/firm aside to lower pitch", () => {
    const p = deriveSpeechProsody("（神情严肃）我必须挑战这个前提。");
    expect(p.pitch).toBeLessThan(1);
  });

  it("keeps every value within a natural interview range", () => {
    for (const text of ["（极度兴奋狂喜）", "（沉思良久，缓缓地）", "（温柔安慰）", "（急促紧张）"]) {
      const p = deriveSpeechProsody(text);
      expect(p.rate).toBeGreaterThanOrEqual(0.8);
      expect(p.rate).toBeLessThanOrEqual(1.3);
      expect(p.pitch).toBeGreaterThanOrEqual(0.85);
      expect(p.pitch).toBeLessThanOrEqual(1.2);
      expect(p.volume).toBeGreaterThanOrEqual(20);
      expect(p.volume).toBeLessThanOrEqual(80);
    }
  });
});
