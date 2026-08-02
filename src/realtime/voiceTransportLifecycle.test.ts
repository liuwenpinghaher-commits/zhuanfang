import { describe, expect, it } from "vitest";
import {
  createVoiceTransportStateGuard,
  terminateVoicePipelineAfterExhaustion,
} from "./voiceTransportLifecycle";

describe("voice transport terminal state", () => {
  it("reconnecting 阻止 pipeline 迟到状态，直到同一 session 明确 ready", () => {
    const guard = createVoiceTransportStateGuard();
    const epoch = guard.beginSession();

    expect(guard.allowsPipelineState(epoch)).toBe(true);
    expect(guard.transition(epoch, "reconnecting")).toBe(true);
    expect(guard.allowsPipelineState(epoch)).toBe(false);
    expect(guard.transition(epoch, "ready")).toBe(true);
    expect(guard.allowsPipelineState(epoch)).toBe(true);
  });

  it("exhausted 不接受迟到 ready，且旧 epoch 不能影响新 session", () => {
    const guard = createVoiceTransportStateGuard();
    const oldEpoch = guard.beginSession();

    expect(guard.transition(oldEpoch, "exhausted")).toBe(true);
    expect(guard.transition(oldEpoch, "ready")).toBe(false);
    expect(guard.allowsPipelineState(oldEpoch)).toBe(false);

    const newEpoch = guard.beginSession();
    expect(guard.allowsPipelineState(newEpoch)).toBe(true);
    expect(guard.transition(oldEpoch, "reconnecting")).toBe(false);
    expect(guard.allowsPipelineState(oldEpoch)).toBe(false);
  });

  it("exhausted 先保留待确认文字并失效 epoch，再关闭旧 pipeline", () => {
    const guard = createVoiceTransportStateGuard();
    const epoch = guard.beginSession();
    let pipelineCloseCount = 0;
    let lateStatus = "exhausted";
    let input = "已有文字草稿";
    let reviewCleared = false;
    let recording = true;
    let status = "listening";
    const pipelineRef = {
      current: {
        close() {
          pipelineCloseCount += 1;
          if (guard.allowsPipelineState(epoch)) lateStatus = "speaking";
        },
      },
    };
    const ttsRef = { current: { close() {} } };

    const result = terminateVoicePipelineAfterExhaustion({
      epoch,
      guard,
      pipelineRef,
      ttsRef,
      pendingReview: { text: "连接中断前的尾段", source: "recovery" },
      updateInterviewInput: (merge) => { input = merge(input); },
      clearReview: () => { reviewCleared = true; },
      setRecording: (next) => { recording = next; },
      setVoiceStatus: (next) => { status = next; },
      clearLiveTranscript: () => undefined,
    });

    expect(result).toEqual({
      terminated: true,
      preservedReview: true,
      noticeDetail: "待确认转写已转入输入框，需用户检查后手动发送；尚未写入专访。",
    });
    expect(input).toBe("已有文字草稿\n连接中断前的尾段");
    expect(reviewCleared).toBe(true);
    expect(recording).toBe(false);
    expect(status).toBe("exhausted");
    expect(pipelineRef.current).toBeNull();
    expect(ttsRef.current).toBeNull();
    expect(pipelineCloseCount).toBe(1);
    expect(lateStatus).toBe("exhausted");
    expect(guard.allowsPipelineState(epoch)).toBe(false);
    expect(guard.allowsPipelineState(guard.beginSession())).toBe(true);
  });

  it("echo review 也只转入文字输入框，不依赖已关闭 pipeline", () => {
    const guard = createVoiceTransportStateGuard();
    const epoch = guard.beginSession();
    let input = "";
    const pipelineRef = { current: { close() {} } };
    const ttsRef = { current: { close() {} } };

    const result = terminateVoicePipelineAfterExhaustion({
      epoch,
      guard,
      pipelineRef,
      ttsRef,
      pendingReview: { text: "疑似回声但尚未确认", source: "echo" },
      updateInterviewInput: (merge) => { input = merge(input); },
      clearReview: () => undefined,
      setRecording: () => undefined,
      setVoiceStatus: () => undefined,
      clearLiveTranscript: () => undefined,
    });

    expect(result.preservedReview).toBe(true);
    expect(result.noticeDetail).toContain("需用户检查后手动发送");
    expect(input).toBe("疑似回声但尚未确认");
    expect(pipelineRef.current).toBeNull();
  });
});
