import type {
  ProductState,
  InterviewSession,
  DualTrackNote,
  PointAsset,
  QuestionAsset,
  DecisionAsset,
  KnowledgeDebt
} from "./types";

export interface SessionArchiveEntry {
  session?: InterviewSession;
  note: DualTrackNote;
  points: PointAsset[];
  questions: QuestionAsset[];
  decisions: DecisionAsset[];
  debts: KnowledgeDebt[];
}

/**
 * 以 notes 为骨架，按 createdAt 倒序构建每次专访的资产归档。
 * 每条 note 关联其同 sessionId 的 session 与各类资产。
 * 合并过的资产仍挂在第一场 sourceSessionId，后场通过 appearedInSessionIds / 证据锚点归入档案。
 * 不含来源场次的资产（如 intel 路径产生的 debt）不会归入任何 entry。
 */
export function assetAppearedInSession(
  asset: {
    sourceSessionId?: string;
    appearedInSessionIds?: string[];
    evidenceAnchors?: Array<{ sessionId: string }>;
  },
  sessionId: string
): boolean {
  if (asset.sourceSessionId === sessionId) return true;
  if (asset.appearedInSessionIds?.includes(sessionId)) return true;
  if (asset.evidenceAnchors?.some((anchor) => anchor.sessionId === sessionId)) return true;
  return false;
}

export function buildSessionArchive(state: ProductState): SessionArchiveEntry[] {
  const sortedNotes = [...state.notes].sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
  );

  return sortedNotes.map((note) => {
    const session = state.sessions.find((s) => s.id === note.sessionId);
    const sid = note.sessionId;

    return {
      session,
      note,
      points: state.points.filter((a) => assetAppearedInSession(a, sid)),
      questions: state.questions.filter((a) => assetAppearedInSession(a, sid)),
      decisions: state.decisions.filter((a) => assetAppearedInSession(a, sid)),
      debts: state.debts.filter((a) => assetAppearedInSession(a, sid))
    };
  });
}
