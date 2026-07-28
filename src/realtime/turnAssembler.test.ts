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

  it("有用户能量和问答语境时保留极短但完整的回答", () => {
    const assembler = createTurnAssembler({ stabilityWindowMs: 100 });
    assembler.ingest({ text: "不是", isFinal: true, atMs: 0, hasUserEnergyEvidence: true });
    expect(assembler.decide({ atMs: 150, allowCommit: true, questionContext: true })).toMatchObject({
      action: "commit",
      transcript: "不是"
    });
  });
});
