// @vitest-environment node
import { describe, expect, it } from "vitest";
import { isGrabbingMatter, isTakeFloor } from "./takeFloor";
import { assessTurnCompleteness } from "./turnCompleteness";

describe("isGrabbingMatter", () => {
  it("招呼/语气/应答不够成一件事", () => {
    expect(isGrabbingMatter("你好")).toBe(false);
    expect(isGrabbingMatter("嗯")).toBe(false);
    expect(isGrabbingMatter("好的")).toBe(false);
    expect(isGrabbingMatter("啊")).toBe(false);
    expect(isGrabbingMatter("你好啊")).toBe(false);
    expect(isGrabbingMatter("喂喂喂")).toBe(false);
    expect(isGrabbingMatter("谢谢你")).toBe(false);
    expect(isGrabbingMatter("等一下")).toBe(false);
  });

  it("侧轨已经在把一件事拿到场上，或要主持人停下来听", () => {
    expect(isGrabbingMatter("等一下你听我说那次救火")).toBe(true);
    expect(isGrabbingMatter("你听我说那次救火")).toBe(true);
  });
});

describe("isTakeFloor", () => {
  it("非回声、有能量：你好不抢话", () => {
    expect(isTakeFloor({
      transcript: "你好",
      hasUserEnergy: true,
      similarToLiveTts: false,
      takingTheFloor: isGrabbingMatter("你好"),
    })).toBe(false);
  });

  it("非回声、有能量：你好啊也不抢话", () => {
    expect(isTakeFloor({
      transcript: "你好啊",
      hasUserEnergy: true,
      similarToLiveTts: false,
      takingTheFloor: isGrabbingMatter("你好啊"),
    })).toBe(false);
  });

  it("非回声、有能量：正事抢话", () => {
    expect(isTakeFloor({
      transcript: "等一下你听我说那次救火",
      hasUserEnergy: true,
      similarToLiveTts: false,
      takingTheFloor: isGrabbingMatter("等一下你听我说那次救火"),
    })).toBe(true);
  });

  it("回声即使有能量也不抢话", () => {
    expect(isTakeFloor({
      transcript: "你好，今天我们聊聊你的工作。",
      hasUserEnergy: true,
      similarToLiveTts: true,
      takingTheFloor: true,
    })).toBe(false);
  });

  it("没有独立能量不抢话", () => {
    expect(isTakeFloor({
      transcript: "等一下你听我说那次救火",
      hasUserEnergy: false,
      similarToLiveTts: false,
      takingTheFloor: true,
    })).toBe(false);
  });

  it("completeness 不能当抢话主闸", () => {
    expect(assessTurnCompleteness("你好")).toBe("ambiguous");
    expect(assessTurnCompleteness("等一下你听我说那次救火")).toBe("ambiguous");
    expect(assessTurnCompleteness("你好啊")).toBe("complete");
  });
});
