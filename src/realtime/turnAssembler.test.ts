// @vitest-environment node
import { describe, expect, it } from "vitest";
import { createTurnAssembler } from "./turnAssembler";

describe("turnAssembler", () => {
  it("partial 永不提交；多个 final 在稳定窗口后合并且只提交一次", () => {
    const assembler = createTurnAssembler({ stabilityWindowMs: 300 });
    assembler.ingest({ text: "个人提效很快", isFinal: false, atMs: 0, hasUserEnergyEvidence: true });
    expect(assembler.decide({ atMs: 100, allowCommit: true }).action).toBe("wait");

    assembler.ingest({ text: "个人提效很快，", isFinal: true, atMs: 200, hasUserEnergyEvidence: true });
    assembler.ingest({ text: "但组织价值流没有缩短。", isFinal: true, atMs: 350, hasUserEnergyEvidence: true });
    expect(assembler.decide({ atMs: 500, allowCommit: true }).action).toBe("wait");

    const committed = assembler.decide({ atMs: 700, allowCommit: true });
    expect(committed).toMatchObject({ action: "commit", transcript: "个人提效很快，但组织价值流没有缩短。" });
    assembler.markCommitted();
    expect(assembler.decide({ atMs: 900, allowCommit: true }).action).toBe("wait");
  });

  it("悬挂尾句即使稳定也继续等待后续 final", () => {
    const assembler = createTurnAssembler({ stabilityWindowMs: 200 });
    assembler.ingest({ text: "我觉得组织没有提效，是因为", isFinal: true, atMs: 0, hasUserEnergyEvidence: true });
    const decision = assembler.decide({ atMs: 500, allowCommit: false });
    expect(decision.action).toBe("wait");
    expect(decision.transcript).toContain("是因为");
  });

  it("TTS 播放窗口内的高相似转写且无独立用户能量时进入 quarantine", () => {
    const assembler = createTurnAssembler({ stabilityWindowMs: 100, echoWindowMs: 800, similarityThreshold: 0.72 });
    assembler.noteTtsPlayback({ text: "你能讲一个最近发生的具体例子吗？", startedAtMs: 0, endedAtMs: 1000 });
    const result = assembler.ingest({
      text: "你能讲一个最近发生的具体例子吗",
      isFinal: true,
      atMs: 1200,
      hasUserEnergyEvidence: false
    });
    expect(result.action).toBe("quarantine");
    expect(assembler.decide({ atMs: 1500, allowCommit: true }).action).toBe("quarantine");
  });

  // Echo-guard golden edges (Phase 1 regression locks) — keep quarantine strict
  // only for high-sim + no user energy *inside* the TTS echo window.
  it("echo-guard golden: 回声窗外的高相似转写不再 quarantine，可稳定后 commit", () => {
    const assembler = createTurnAssembler({
      stabilityWindowMs: 100,
      echoWindowMs: 500,
      similarityThreshold: 0.72
    });
    assembler.noteTtsPlayback({
      text: "你能讲一个最近发生的具体例子吗？",
      startedAtMs: 0,
      endedAtMs: 1000
    });
    // atMs well past endedAtMs + echoWindowMs → not echo, treat as real user speech.
    const result = assembler.ingest({
      text: "你能讲一个最近发生的具体例子吗？",
      isFinal: true,
      atMs: 1000 + 500 + 50,
      hasUserEnergyEvidence: false
    });
    expect(result.action).toBe("wait");
    expect(assembler.decide({ atMs: 1000 + 500 + 200, allowCommit: true }).action).toBe("commit");
  });

  it("echo-guard golden: 窗内像漏音的转写即使有能量也 quarantine", () => {
    const assembler = createTurnAssembler({
      stabilityWindowMs: 100,
      echoWindowMs: 800,
      similarityThreshold: 0.72
    });
    assembler.noteTtsPlayback({
      text: "你能讲一个最近发生的具体例子吗？",
      startedAtMs: 0,
      endedAtMs: 1000
    });
    const result = assembler.ingest({
      text: "你能讲一个最近发生的具体例子吗",
      isFinal: true,
      atMs: 1200,
      hasUserEnergyEvidence: true
    });
    expect(result.action).toBe("quarantine");
    expect(assembler.decide({ atMs: 1400, allowCommit: true }).action).toBe("quarantine");
  });

  it("beginLiveTts 在 speak 开始时就能判相似，不必等 endedAt", () => {
    const assembler = createTurnAssembler({ similarityThreshold: 0.8 });
    assembler.beginLiveTts("你好，今天我们聊聊你的工作。", 0);
    expect(assembler.isSimilarToLiveTts("你好，今天我们聊聊你的工作。")).toBe(true);
    expect(assembler.isSimilarToLiveTts("等一下你听我说那次救火")).toBe(false);
  });

  it("半句漏音是当前句的前缀，也算相似", () => {
    const assembler = createTurnAssembler({ similarityThreshold: 0.8, echoWindowMs: 1200 });
    assembler.beginLiveTts("你能讲一个最近发生的具体例子吗？", 0);
    expect(assembler.isSimilarToLiveTts("你能讲一个最近发生的具体例子", 100)).toBe(true);
  });

  it("上一句还在回声窗里时，下一句播放中的上一句漏音仍算相似", () => {
    const assembler = createTurnAssembler({ similarityThreshold: 0.8, echoWindowMs: 1200 });
    assembler.beginLiveTts("我理解。", 0);
    assembler.noteTtsPlayback({ text: "我理解。", startedAtMs: 0, endedAtMs: 400 });
    assembler.beginLiveTts("你继续说。", 400);
    expect(assembler.isSimilarToLiveTts("我理解。", 500)).toBe(true);
    expect(assembler.isSimilarToLiveTts("你继续说", 500)).toBe(true);
  });

  it("口播含「不是」时，短答「不是」不是回声", () => {
    const assembler = createTurnAssembler({
      stabilityWindowMs: 100,
      echoWindowMs: 800,
      similarityThreshold: 0.8
    });
    assembler.noteTtsPlayback({
      text: "你是不是还想讲那次救火？",
      startedAtMs: 0,
      endedAtMs: 1000
    });
    expect(assembler.isSimilarToLiveTts("不是", 1200)).toBe(false);
    const result = assembler.ingest({
      text: "不是",
      isFinal: true,
      atMs: 1200,
      hasUserEnergyEvidence: true
    });
    expect(result.action).not.toBe("quarantine");
    expect(assembler.decide({ atMs: 1400, allowCommit: true, questionContext: true }).action).toBe("commit");
  });

  it("有用户能量和问答语境时保留极短但完整的回答", () => {
    const assembler = createTurnAssembler({ stabilityWindowMs: 100 });
    assembler.ingest({ text: "不是", isFinal: true, atMs: 0, hasUserEnergyEvidence: true });
    expect(assembler.decide({ atMs: 150, allowCommit: true, questionContext: true })).toMatchObject({
      action: "commit",
      transcript: "不是"
    });
  });
});
