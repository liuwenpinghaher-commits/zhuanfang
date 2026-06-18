import { describe, it, expect } from "vitest";
import { assessTurnCompleteness } from "./turnCompleteness";

describe("assessTurnCompleteness", () => {
  it("空串 → incomplete", () => {
    expect(assessTurnCompleteness("")).toBe("incomplete");
    expect(assessTurnCompleteness("   ")).toBe("incomplete");
  });

  it("悬挂连词收尾 → incomplete", () => {
    expect(assessTurnCompleteness("我觉得这个方案不错，因为")).toBe("incomplete");
    expect(assessTurnCompleteness("我本来想去，但是")).toBe("incomplete");
    expect(assessTurnCompleteness("然后")).toBe("incomplete");
  });

  it("填充词收尾 → incomplete", () => {
    expect(assessTurnCompleteness("我想说的是那个")).toBe("incomplete");
    expect(assessTurnCompleteness("就是")).toBe("incomplete");
  });

  it("强需宾语的连词收尾 → incomplete", () => {
    expect(assessTurnCompleteness("我把")).toBe("incomplete");
    expect(assessTurnCompleteness("苹果和")).toBe("incomplete");
  });

  it("常见词末字（对/在 等）不再误判为 incomplete → ambiguous", () => {
    expect(assessTurnCompleteness("我现在")).toBe("ambiguous");
    expect(assessTurnCompleteness("你说得对")).toBe("ambiguous");
  });

  it("终止标点 → complete", () => {
    expect(assessTurnCompleteness("我说完了。")).toBe("complete");
    expect(assessTurnCompleteness("你说的是什么？")).toBe("complete");
    expect(assessTurnCompleteness("太好了！")).toBe("complete");
  });

  it("句末语气词收尾 → complete", () => {
    expect(assessTurnCompleteness("你觉得呢")).toBe("complete");
    expect(assessTurnCompleteness("我们今天聊控制感吧")).toBe("complete");
    expect(assessTurnCompleteness("是这样吗")).toBe("complete");
  });

  it("无明显信号的裸句 → ambiguous", () => {
    expect(assessTurnCompleteness("我昨天去了公司")).toBe("ambiguous");
    expect(assessTurnCompleteness("这件事挺复杂")).toBe("ambiguous");
  });

  it("尾随软逗号/空格不影响判定", () => {
    expect(assessTurnCompleteness("因为，")).toBe("incomplete");
    expect(assessTurnCompleteness("我说完了。 ")).toBe("complete");
  });
});
