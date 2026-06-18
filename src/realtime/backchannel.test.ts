import { describe, it, expect } from "vitest";
import { createBackchannelPicker } from "./backchannel";

describe("createBackchannelPicker", () => {
  it("circling 有 depthGuidance 时优先用它", () => {
    const pick = createBackchannelPicker();
    expect(pick("circling", "我们好像在团队授权这点上绕")).toBe("我们好像在团队授权这点上绕");
  });

  it("emotional 从共情池选，且轮换不重复", () => {
    const pick = createBackchannelPicker();
    const a = pick("emotional");
    const b = pick("emotional");
    expect(a).not.toBe(b); // 轮换
    expect(typeof a).toBe("string");
    expect(a.length).toBeGreaterThan(0);
  });

  it("无专属池的状态用默认池", () => {
    const pick = createBackchannelPicker();
    const out = pick("fluent");
    expect(out.length).toBeGreaterThan(0);
  });

  it("circling 无 guidance 时用 circling 池", () => {
    const pick = createBackchannelPicker();
    const out = pick("circling");
    expect(out.length).toBeGreaterThan(0);
    expect(out).not.toBe(""); // 来自池
  });
});
