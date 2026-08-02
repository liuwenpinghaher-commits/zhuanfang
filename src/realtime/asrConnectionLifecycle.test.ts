import { describe, expect, it } from "vitest";
import {
  computeAsrReconnectDelayMs,
  isRecoverableAsrCloseCode,
  type AsrConnectionEvent,
} from "./asrConnectionLifecycle";

describe("ASR 会中重连策略", () => {
  it("500ms 基数形成 500/1000/2000/4000/8000ms", () => {
    expect([1, 2, 3, 4, 5].map((n) => computeAsrReconnectDelayMs(n, 500, () => 0)))
      .toEqual([500, 1000, 2000, 4000, 8000]);
  });

  it("抖动严格落在 0–20%", () => {
    expect(computeAsrReconnectDelayMs(3, 500, () => 1)).toBe(2400);
  });

  it("4001 不可恢复，1006 和临时上游关闭可恢复", () => {
    expect(isRecoverableAsrCloseCode(4001)).toBe(false);
    expect(isRecoverableAsrCloseCode(1000)).toBe(false);
    expect(isRecoverableAsrCloseCode(1006)).toBe(true);
    expect(isRecoverableAsrCloseCode(1011)).toBe(true);
  });

  it("事件类型保留 code/reason 与预算", () => {
    const event: AsrConnectionEvent = {
      state: "reconnecting", attempt: 2, maxAttempts: 5, code: 1006, reason: "network",
    };
    expect(event.state).toBe("reconnecting");
  });
});
