/**
 * Pure end-of-interview presentation rules (journey honesty).
 * doNotSave never claims "档案已生成".
 * Pending / HITL memory also must not claim "档案已生成".
 */

export type InterviewEndDestination = "notes" | "memory" | "home";

export type InterviewEndPresentation = {
  noticeKind: "info" | "success";
  noticeTitle: string;
  noticeBody: string;
  /** True only when we may tell the user the archive is complete (never for doNotSave or pending HITL). */
  claimsArchiveGenerated: boolean;
  destination: InterviewEndDestination;
  lastSummary: {
    noteTitle: string;
    pendingMemory: number;
    destination: "notes" | "memory";
    doNotSave: boolean;
  };
};

export function buildInterviewEndPresentation(input: {
  doNotSave: boolean;
  pendingMemoryCandidateCount: number;
  longTermRecallRequiresApproval?: boolean;
  noteTitle?: string;
}): InterviewEndPresentation {
  const pending = Math.max(0, Number(input.pendingMemoryCandidateCount) || 0);
  const needsHitl = input.longTermRecallRequiresApproval === true || pending > 0;
  const noteTitle = (input.noteTitle ?? "").trim() || "本场笔记";

  if (input.doNotSave) {
    return {
      noticeKind: "info",
      noticeTitle: "专访已结束（本场不保存）",
      noticeBody: "按你的选择，本场未写入长期资产与录音；对话仅作当次体验。",
      claimsArchiveGenerated: false,
      destination: "home",
      lastSummary: {
        noteTitle: "本场不保存",
        pendingMemory: 0,
        destination: "notes",
        doNotSave: true
      }
    };
  }

  if (needsHitl) {
    return {
      noticeKind: "info",
      noticeTitle: "本场已结束，记忆待你确认",
      noticeBody:
        pending > 0
          ? `双轨笔记已写下。另有 ${pending} 条记忆待确认后才会进入跨会话召回——请在「记忆」审核。现在还不能说档案已生成。`
          : "双轨笔记已写下。长期记忆需你确认后才会进入跨会话召回。现在还不能说档案已生成。",
      claimsArchiveGenerated: false,
      destination: "home",
      lastSummary: {
        noteTitle,
        pendingMemory: pending,
        destination: "memory",
        doNotSave: false
      }
    };
  }

  return {
    noticeKind: "success",
    noticeTitle: "专访档案已生成",
    noticeBody: `「${noteTitle}」已写入双轨笔记；可在下方「上场摘要」或笔记/资产中继续。`,
    claimsArchiveGenerated: true,
    destination: "home",
    lastSummary: {
      noteTitle,
      pendingMemory: 0,
      destination: "notes",
      doNotSave: false
    }
  };
}
