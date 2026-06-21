import { describe, it, expect } from "vitest";
import { offloadCompletedSession } from "./raw-material";
import { createInitialProductState } from "../../../../src/domain/engine";

describe("offloadCompletedSession", () => {
  it("把指定会话的 turns/strategyTrace 抽成冷层载荷,热 state 剥离并打标", () => {
    const base = createInitialProductState();
    const state = { ...base, sessions: [{
      id: "s1", title: "t", mode: "daily", strength: "standard", status: "completed",
      startedAt: "2026-06-21T00:00:00.000Z", turns: [
        { id: "t1", role: "user", content: "原话", intent: "", timestamp: "2026-06-21T00:00:00.000Z" }
      ], strategyTrace: [], card: {} as any, guide: {} as any
    } as any] };
    const { hotState, material } = offloadCompletedSession(state, "s1");
    expect(material?.turns).toHaveLength(1);
    const s = hotState.sessions.find((x) => x.id === "s1")!;
    expect(s.turns).toHaveLength(0);
    expect(s.rawMaterialOffloaded).toBe(true);
  });
  it("会话不存在 → material undefined,hotState 原样", () => {
    const state = createInitialProductState();
    const { hotState, material } = offloadCompletedSession(state, "nope");
    expect(material).toBeUndefined();
    expect(hotState).toBe(state);
  });
});
