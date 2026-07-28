import { describe, expect, it } from "vitest";
import { mergeInterviewSessionRefresh } from "./session-merge";
import type { InterviewCard, InterviewGuide, InterviewSession, InterviewTurn } from "./types";

function makeTurn(id: string, role: "user" | "assistant", content: string): InterviewTurn {
  return {
    id,
    sessionId: "sess-1",
    role,
    content,
    intent: role === "user" ? "user_reply" : "follow_up",
    timestamp: "2026-07-23T00:00:00.000Z",
    createdAt: "2026-07-23T00:00:00.000Z"
  } as InterviewTurn;
}

function makeSession(turns: InterviewTurn[]): InterviewSession {
  return {
    id: "sess-1",
    mode: "daily",
    strength: "standard",
    status: "active",
    title: "t",
    startedAt: "2026-07-23T00:00:00.000Z",
    turns,
    guide: { topicHint: "old" } as InterviewGuide,
    card: { suggestedOpening: "old-open" } as InterviewCard,
    strategyTrace: []
  } as InterviewSession;
}

describe("mergeInterviewSessionRefresh (IV-P0-01/02)", () => {
  it("keeps latest turns and strategyTrace while refreshing guide/card", () => {
    const latest = makeSession([
      makeTurn("t1", "user", "hello"),
      makeTurn("t2", "assistant", "follow-up?")
    ]);
    latest.strategyTrace = [
      {
        strategy: "mechanism_probe",
        label: "机制追问",
        reason: "test",
        depth: "mechanism",
        turnIndex: 1
      }
    ];
    const patchGuide = { topicHint: "new-topic", relevantMemories: ["m1"] } as InterviewGuide;
    const patchCard = { suggestedOpening: "new-open", searchBriefId: "b1" } as InterviewCard;

    const merged = mergeInterviewSessionRefresh(latest, {
      guide: patchGuide,
      card: patchCard
    });

    expect(merged.turns).toEqual(latest.turns);
    expect(merged.strategyTrace).toEqual(latest.strategyTrace);
    expect(merged.guide).toEqual(patchGuide);
    expect(merged.card).toEqual(patchCard);
    expect(merged.id).toBe("sess-1");
  });

  it("does not drop turns recorded after a stale base snapshot", () => {
    const staleBase = makeSession([makeTurn("t1", "user", "only-one")]);
    const latestWithRace = makeSession([
      makeTurn("t1", "user", "only-one"),
      makeTurn("t2", "user", "recorded-during-refresh"),
      makeTurn("t3", "assistant", "voice answer")
    ]);
    // Stale path would have written staleBase+newGuide; merge uses latest instead.
    const merged = mergeInterviewSessionRefresh(latestWithRace, {
      guide: { ...staleBase.guide, topicHint: "refreshed" } as InterviewGuide,
      card: staleBase.card
    });
    expect(merged.turns).toHaveLength(3);
    expect(merged.turns.map((t) => t.id)).toEqual(["t1", "t2", "t3"]);
    expect(merged.guide.topicHint).toBe("refreshed");
  });
});
