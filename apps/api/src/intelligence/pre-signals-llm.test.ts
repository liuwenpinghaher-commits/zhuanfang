/**
 * Parser robustness tests for pre-signals-llm.
 *
 * generatePreSignals calls extractPreSignals (from providers/bailian.ts) which
 * parses the <pre_signals>...</pre_signals> block format.
 * Robustness points:
 *  - No <pre_signals> block → throws "Failed to parse pre_signals"
 *  - Well-formed block → returns valid InteractionPreSignals
 *  - Missing depth_direction.concept → depthDirection is null
 *  - Invalid sensitivity → defaults to "medium"
 *  - Empty backchannel/interrupt → defaults returned
 */
import { describe, expect, it } from "vitest";
import type { InterviewSession } from "../../../../src/domain/types";
import type { BailianChatClient } from "../providers/bailian";
import { generatePreSignals } from "./pre-signals-llm";

function makeSession(overrides: Partial<InterviewSession> = {}): InterviewSession {
  return {
    id: "sess-voice",
    title: "产品决策专访",
    mode: "decision",
    strength: "standard",
    status: "active",
    turns: [],
    createdAt: new Date().toISOString(),
    ...overrides
  } as InterviewSession;
}

const mockChat = (response: string): BailianChatClient => ({
  async complete() {
    return response;
  }
});

// Well-formed pre_signals block
const VALID_PRE_SIGNALS = `<pre_signals>
depth_direction:
  concept: 用户的取舍逻辑
  reason: 多次提到取舍但未展开
  guidance: 你当时最难取舍的是什么？
backchannel: 嗯,对,明白
interrupt: 不对,等等,打断一下
sensitivity: low
</pre_signals>`;

describe("generatePreSignals", () => {
  it("happy path: well-formed block → returns valid InteractionPreSignals", async () => {
    const result = await generatePreSignals(makeSession(), mockChat(VALID_PRE_SIGNALS));

    expect(result.depthDirection).not.toBeNull();
    expect(result.depthDirection!.concept).toBe("用户的取舍逻辑");
    expect(result.depthDirection!.reason).toBeTruthy();
    expect(result.depthDirection!.guidance).toBeTruthy();
    expect(Array.isArray(result.backchannelWhitelist)).toBe(true);
    expect(Array.isArray(result.interruptTriggers)).toBe(true);
    expect(result.interruptSensitivity).toBe("low");
  });

  it("no <pre_signals> block in response → throws", async () => {
    await expect(
      generatePreSignals(makeSession(), mockChat("这里没有 pre_signals 块，只有普通文本。"))
    ).rejects.toThrow("Failed to parse pre_signals");
  });

  it("missing depth_direction.concept → depthDirection is null", async () => {
    const block = `<pre_signals>
depth_direction:
  reason: 某原因
  guidance: 某引导
backchannel: 嗯,对
interrupt: 不对
sensitivity: medium
</pre_signals>`;
    const result = await generatePreSignals(makeSession(), mockChat(block));
    expect(result.depthDirection).toBeNull();
  });

  it("invalid sensitivity → defaults to 'medium'", async () => {
    const block = `<pre_signals>
depth_direction:
  concept: 某方向
  reason: 原因
  guidance: 引导
backchannel: 嗯,好
interrupt: 不是
sensitivity: INVALID_VALUE
</pre_signals>`;
    const result = await generatePreSignals(makeSession(), mockChat(block));
    expect(result.interruptSensitivity).toBe("medium");
  });

  it("all valid sensitivity values pass through", async () => {
    for (const sensitivity of ["low", "medium", "high"]) {
      const block = `<pre_signals>
depth_direction:
  concept: 方向
  reason: 原因
  guidance: 引导
backchannel: 嗯
interrupt: 不对
sensitivity: ${sensitivity}
</pre_signals>`;
      const result = await generatePreSignals(makeSession(), mockChat(block));
      expect(result.interruptSensitivity).toBe(sensitivity);
    }
  });

  it("backchannel/interrupt missing → default lists returned", async () => {
    const block = `<pre_signals>
depth_direction:
  concept: 方向
  reason: 原因
  guidance: 引导
sensitivity: high
</pre_signals>`;
    const result = await generatePreSignals(makeSession(), mockChat(block));
    // extractPreSignals uses default lists when not provided
    expect(result.backchannelWhitelist.length).toBeGreaterThan(0);
    expect(result.interruptTriggers.length).toBeGreaterThan(0);
  });

  it("session with no turns still returns valid result (uses empty transcript fallback)", async () => {
    const result = await generatePreSignals(makeSession({ turns: [] }), mockChat(VALID_PRE_SIGNALS));
    expect(result.depthDirection).not.toBeNull();
  });

  it("LLM throws → propagates the error (caller handles it as 502)", async () => {
    const throwingChat: BailianChatClient = {
      async complete() {
        throw new Error("Network error");
      }
    };
    await expect(
      generatePreSignals(makeSession(), throwingChat)
    ).rejects.toThrow("Network error");
  });
});
