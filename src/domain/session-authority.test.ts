import { describe, expect, it } from "vitest";
import { createInitialProductState, createSessionDraft, finalizeSession, mergeFinalizedState } from "./engine";
import type { FinalizeContent } from "./finalize";
import { buildInterviewEndPresentation } from "./session-end-presentation";
import { createTurnAssembler } from "../realtime/turnAssembler";
import type { InterviewSession } from "./types";

describe("session authority — unconfirmed partials", () => {
  it("turnAssembler treats non-final partial as non-authoritative (wait, no commit)", () => {
    const assembler = createTurnAssembler({ stabilityWindowMs: 450 });
    const partial = assembler.ingest({
      text: "我其实还没说完",
      isFinal: false,
      atMs: 1_000,
      hasUserEnergyEvidence: true
    });
    expect(partial.action).toBe("wait");
    expect(partial.reason).toMatch(/partial transcript is not authoritative/i);

    const stillWait = assembler.decide({ atMs: 1_100, allowCommit: true });
    expect(stillWait.action).toBe("wait");
    expect(stillWait.action).not.toBe("commit");
  });

  it("only stable final segments can commit as authoritative transcript", () => {
    const assembler = createTurnAssembler({ stabilityWindowMs: 100 });
    assembler.ingest({
      text: "完整一句。",
      isFinal: true,
      atMs: 2_000,
      hasUserEnergyEvidence: true
    });
    const early = assembler.decide({ atMs: 2_050, allowCommit: true });
    expect(early.action).toBe("wait");
    const committed = assembler.decide({ atMs: 2_200, allowCommit: true });
    expect(committed.action).toBe("commit");
    expect(committed.transcript).toContain("完整一句");
  });
});

describe("session honesty — doNotSave end presentation", () => {
  it("doNotSave presentation never claims archive/assets generated", () => {
    const p = buildInterviewEndPresentation({
      doNotSave: true,
      pendingMemoryCandidateCount: 3,
      longTermRecallRequiresApproval: true,
      noteTitle: "不该出现的标题"
    });
    expect(p.claimsArchiveGenerated).toBe(false);
    expect(p.noticeTitle).not.toMatch(/档案已生成/);
    expect(p.noticeBody).toMatch(/未写入长期资产/);
    expect(p.lastSummary.doNotSave).toBe(true);
    expect(p.lastSummary.pendingMemory).toBe(0);
  });

  it("normal end with pending HITL claims archive but routes to memory review", () => {
    const p = buildInterviewEndPresentation({
      doNotSave: false,
      pendingMemoryCandidateCount: 2,
      noteTitle: "本场笔记"
    });
    expect(p.claimsArchiveGenerated).toBe(true);
    expect(p.noticeTitle).toMatch(/档案已生成/);
    expect(p.lastSummary.destination).toBe("memory");
    expect(p.lastSummary.pendingMemory).toBe(2);
  });
});

describe("session honesty — finalize doNotSave domain path", () => {
  it("finalizeSession with doNotSave does not write note/session/memory candidates", () => {
    const base = createInitialProductState();
    const beforeNotes = base.notes.length;
    const beforeSessions = base.sessions.length;
    const beforeCandidates = base.memoryCandidates.length;

    const session = createSessionDraft(base, "daily", "standard", { topicHint: "隐私场" });
    session.doNotSave = true;
    session.turns = [
      {
        id: "u1",
        role: "user",
        content: "这是不该落库的内容",
        intent: "用户表达",
        timestamp: "2026-08-01T00:00:00.000Z"
      }
    ];

    const { nextState } = finalizeSession(base, session);
    expect(nextState.notes.length).toBe(beforeNotes);
    expect(nextState.sessions.length).toBe(beforeSessions);
    expect(nextState.memoryCandidates.length).toBe(beforeCandidates);
    // No new long-term assets from this session id
    expect(nextState.points.every((p) => p.sourceSessionId !== session.id)).toBe(true);
  });

  it("mergeFinalizedState doNotSave ignores provided candidates (no silent memory)", () => {
    const base = createInitialProductState();
    const session = createSessionDraft(base, "daily", "standard", {});
    session.doNotSave = true;
    const content: FinalizeContent = {
      note: {
        id: "n1",
        sessionId: session.id,
        title: "不该写",
        summary: "x",
        keyQuote: "y",
        saidTrack: ["y"],
        learnedTrack: ["z"],
        nextQuestions: [],
        createdAt: "2026-08-01T00:00:00.000Z"
      },
      points: [],
      questions: [],
      decisions: [],
      debts: [],
      themes: []
    };
    const { nextState } = mergeFinalizedState(
      base,
      session as InterviewSession,
      content,
      "2026-08-01T00:00:00.000Z",
      [
        {
          id: "c_should_not",
          text: "幽灵候选",
          status: "pending",
          sourceType: "interview_session",
          sourceId: session.id,
          evidenceQuote: "证据足够长作为引用锚点",
          reason: "不应写入",
          sensitivity: "normal",
          reviewScore: 0.5,
          reviewSignals: [],
          createdAt: "2026-08-01T00:00:00.000Z"
        }
      ]
    );
    expect(nextState.memoryCandidates.some((c) => c.id === "c_should_not")).toBe(false);
    expect(nextState.notes.some((n) => n.id === "n1")).toBe(false);
  });
});
