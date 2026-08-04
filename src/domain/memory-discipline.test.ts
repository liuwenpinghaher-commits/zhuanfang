import { describe, expect, it } from "vitest";
import { createInitialProductState } from "./engine";
import { buildInterviewContextPack, buildInterviewGuide } from "./context-pack";
import { mergeFinalizedState, type FinalizeContent } from "./finalize";
import { approveMemoryCandidate, updateMemoryCandidateText } from "./memory";
import {
  annotateCandidateConflict,
  collectConflictCorrectionTexts,
  conflictsWithExplicitCorrection,
  shouldBlockSilentMemoryConfirm
} from "./memoryReview";
import type { InterviewSession, MemoryCandidate, MemoryRecord } from "./types";

function confirmed(partial: Partial<MemoryRecord> & Pick<MemoryRecord, "id" | "text">): MemoryRecord {
  return {
    status: "confirmed",
    sourceType: "interview_session",
    sourceId: "s1",
    evidenceQuote: "证据足够长作为引用锚点",
    sensitivity: "normal",
    createdAt: "2026-06-01T00:00:00.000Z",
    updatedAt: "2026-06-01T00:00:00.000Z",
    importance: 8,
    ...partial
  };
}

function pending(id: string, text: string, extra: Partial<MemoryCandidate> = {}): MemoryCandidate {
  return {
    id,
    text,
    status: "pending",
    sourceType: "interview_session",
    sourceId: "s2",
    evidenceQuote: "原文片段足够长可作证据",
    reason: "需确认",
    sensitivity: "normal",
    createdAt: "2026-08-01T00:00:00.000Z",
    reviewScore: 80,
    reviewSignals: [],
    ...extra
  };
}

describe("memory discipline — confirmed-only packing", () => {
  it("excludes pending and deprecated records from context-pack confirmed pool", () => {
    const state = {
      ...createInitialProductState(),
      memoryRecords: [
        confirmed({ id: "ok", text: "我确认：放权先试点再扩大" }),
        {
          ...confirmed({ id: "pending-shaped", text: "不该出现" }),
          status: "deprecated" as const,
          deprecatedReason: "已被取代",
          supersededByRecordId: "ok"
        }
      ],
      memoryCandidates: [pending("c_pending", "待审候选：不该进跨会话召回")]
    };
    // Default policy: includePendingCandidatesInContext is typically false
    state.systemConfig = {
      ...state.systemConfig,
      memory: {
        ...state.systemConfig.memory,
        includePendingCandidatesInContext: false
      }
    };
    const pack = buildInterviewContextPack(state, { topicHint: "放权试点" });
    const texts = pack.memoryRecords.map((r) => r.text);
    const ids = pack.memoryRecords.map((r) => r.id);
    expect(texts.some((t) => t.includes("放权先试点"))).toBe(true);
    expect(ids).toContain("ok");
    expect(ids).not.toContain("pending-shaped");
    expect(texts.some((t) => t.includes("不该出现"))).toBe(false);
    expect(texts.some((t) => t.includes("待审候选"))).toBe(false);
    // Only confirmed status is eligible in the pack's memoryRecords list.
    expect(pack.memoryRecords.every((r) => r.status === "confirmed")).toBe(true);
  });
});

describe("memory discipline — conflict surface + no silent confirm", () => {
  it("detects candidate vs explicit correction conflict", () => {
    const candidate = {
      text: "组织效率提升的结构性前提缺一不可，必须满足全部准入门槛"
    };
    const corrections = ["纠正：效率瓶颈不是结构性前提，也不是必须全部满足的准入门槛"];
    expect(conflictsWithExplicitCorrection(candidate, corrections)).toBe(true);
    const annotated = annotateCandidateConflict(pending("c1", candidate.text), corrections);
    expect(annotated.suggestedUpdate).toBe("conflict");
    expect(shouldBlockSilentMemoryConfirm(annotated, corrections)).toBe(true);
  });

  it("approveMemoryCandidate does not confirm conflicting candidate without force", () => {
    const conflicting = pending(
      "c_bad",
      "组织效率提升的结构性前提缺一不可，必须满足全部准入门槛",
      { suggestedUpdate: "conflict" }
    );
    const state = {
      ...createInitialProductState(),
      memoryRecords: [] as MemoryRecord[],
      memoryCandidates: [conflicting],
      memoryCorrections: [
        {
          id: "corr1",
          text: "纠正：效率瓶颈不是结构性前提，也不是必须全部满足的准入门槛",
          createdAt: "2026-08-01T00:00:00.000Z"
        }
      ]
    };
    const blocked = approveMemoryCandidate(state, "c_bad");
    expect(blocked.memoryRecords.length).toBe(0);
    expect(blocked.memoryCandidates.find((c) => c.id === "c_bad")!.status).toBe("pending");
    expect(blocked.auditEvents.some((e) => e.type === "memory_candidate_approve_blocked")).toBe(true);

    const forced = approveMemoryCandidate(state, "c_bad", { force: true, mode: "add" });
    expect(forced.memoryRecords.some((r) => r.status === "confirmed" && r.text.includes("结构性前提"))).toBe(
      true
    );
  });

  it("edit path re-annotates: conflict clears after corrective rewrite", () => {
    const conflicting = pending(
      "c_edit",
      "组织效率提升的结构性前提缺一不可，必须满足全部准入门槛",
      { suggestedUpdate: "conflict" }
    );
    const state = {
      ...createInitialProductState(),
      memoryCandidates: [conflicting],
      memoryCorrections: [
        {
          id: "corr_edit",
          text: "纠正：效率瓶颈不是结构性前提，也不是必须全部满足的准入门槛",
          createdAt: "2026-08-01T00:00:00.000Z"
        }
      ]
    };
    const revised = updateMemoryCandidateText(
      state,
      "c_edit",
      "组织效率瓶颈在跨部门激励与决策权，而不是结构性前提缺一不可"
    );
    const cand = revised.memoryCandidates.find((c) => c.id === "c_edit")!;
    expect(cand.suggestedUpdate).not.toBe("conflict");
    expect(shouldBlockSilentMemoryConfirm(cand, [
      "纠正：效率瓶颈不是结构性前提，也不是必须全部满足的准入门槛"
    ])).toBe(false);
    const approved = approveMemoryCandidate(revised, "c_edit", { mode: "add" });
    expect(approved.memoryRecords.some((r) => r.status === "confirmed")).toBe(true);
  });

  it("finalize annotates extract candidates that conflict with learnedTrack", () => {
    const base = createInitialProductState();
    const draftSession: InterviewSession = {
      id: "se_conflict",
      mode: "daily",
      strength: "standard",
      status: "active",
      title: "冲突场",
      startedAt: "2026-08-01T00:00:00.000Z",
      turns: [
        {
          id: "u1",
          role: "user",
          content: "其实瓶颈不是结构性前提",
          intent: "用户表达",
          timestamp: "2026-08-01T00:00:00.000Z"
        }
      ],
      strategyTrace: [],
      card: {
        title: "冲突",
        whyNow: "",
        suggestedOpening: "开场",
        historyReferences: [],
        potentialTension: "",
        suggestedPerspectives: [],
        likelyOutputs: []
      },
      guide: buildInterviewGuide(base, { topicHint: "组织效率" })
    };

    const content: FinalizeContent = {
      note: {
        id: "note_1",
        sessionId: draftSession.id,
        title: "冲突场笔记",
        summary: "用户纠正了结构性前提说法",
        keyQuote: "其实瓶颈不是结构性前提",
        saidTrack: ["其实瓶颈不是结构性前提"],
        learnedTrack: ["纠正：效率瓶颈不是结构性前提，也不是必须全部满足的准入门槛"],
        nextQuestions: [],
        createdAt: "2026-08-01T01:00:00.000Z"
      },
      points: [],
      questions: [],
      decisions: [],
      debts: [],
      themes: []
    };
    const badCandidate = pending(
      "c_extract",
      "组织效率提升的结构性前提缺一不可，必须满足全部准入门槛"
    );
    const { nextState } = mergeFinalizedState(
      base,
      draftSession,
      content,
      "2026-08-01T01:00:00.000Z",
      [badCandidate]
    );
    const stored = nextState.memoryCandidates.find((c) => c.id === "c_extract");
    expect(stored).toBeTruthy();
    expect(stored!.suggestedUpdate).toBe("conflict");
    const corrections = collectConflictCorrectionTexts({
      learnedTrack: content.note.learnedTrack
    });
    expect(shouldBlockSilentMemoryConfirm(stored!, corrections)).toBe(true);
    const stillPending = approveMemoryCandidate(nextState, "c_extract");
    expect(stillPending.memoryRecords.filter((r) => r.sourceCandidateId === "c_extract")).toHaveLength(0);
  });
});
