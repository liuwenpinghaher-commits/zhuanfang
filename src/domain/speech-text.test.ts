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
  it("returns neutral prosody for a plain statement with no aside and no semantic cue", () => {
    expect(deriveSpeechProsody("我们继续聊聊这件事的另一面")).toEqual({ emotion: "neutral", rate: 1, pitch: 1, volume: 50 });
  });

  it("②文本语义派生:问句无 aside 也轻升调(不再单调 neutral)", () => {
    const p = deriveSpeechProsody("你刚才说的审批权，具体卡在哪了？");
    expect(p.pitch).toBeGreaterThan(1);
  });

  it("②文本语义派生:共情词放缓温和", () => {
    const p = deriveSpeechProsody("我理解那种不容易，你不用着急。");
    expect(p.rate).toBeLessThan(1);
  });

  it("②文本语义派生:感叹句更热情(略快略响)", () => {
    const p = deriveSpeechProsody("这个洞察太关键了！");
    expect(p.volume).toBeGreaterThan(50);
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

  it("③情绪枚举:笑/兴奋旁白 → happy(走官方 instruction 真情绪)", () => {
    expect(deriveSpeechProsody("（轻笑）那咱们换个角度。").emotion).toBe("happy");
  });

  it("③情绪枚举:悲伤/低落旁白 → sad", () => {
    expect(deriveSpeechProsody("（语气低落，遗憾）这真的很可惜。").emotion).toBe("sad");
  });

  it("③情绪枚举:好奇/惊讶旁白 → surprised", () => {
    expect(deriveSpeechProsody("（惊讶地）真的吗？").emotion).toBe("surprised");
  });

  it("③情绪枚举:感叹句(无 aside)文本派生 → happy", () => {
    expect(deriveSpeechProsody("这个洞察太关键了！").emotion).toBe("happy");
  });

  it("③情绪枚举:严肃质问 → neutral(访谈不真怒,改走数值 prosody)", () => {
    expect(deriveSpeechProsody("（神情严肃）我必须挑战这个前提。").emotion).toBe("neutral");
  });

  it("③情绪枚举:纯陈述无情绪 → neutral(不发 instruction)", () => {
    expect(deriveSpeechProsody("我们继续聊下一个话题。").emotion).toBe("neutral");
  });
});
