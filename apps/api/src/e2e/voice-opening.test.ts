// @vitest-environment node
/**
 * Full-chain regression: voice agent-context carries opening discipline +
 * suggestedOpening + tracking-points.
 *
 * Flow under test:
 *   POST /api/interview-sessions
 *     → buildInterviewCard (card.suggestedOpening set from demo guide)
 *   GET  /api/realtime-voice/agent-context/:id
 *     → buildInterviewAgentContext(session)
 *     → buildRealtimeVoiceInstructions(session)
 *     → buildVoiceOpeningDiscipline(card) + INTERVIEWER_CRAFT_RULES + guide fields
 *
 * Deterministic: buildApiServer({ env: {} }) uses demo initial state;
 * no live LLM keys required.
 */

import { describe, it, expect } from "vitest";
import { buildApiServer } from "../server";

describe("voice agent-context — full-chain opening discipline + tracking-points", () => {
  it("agent-context carries opening discipline, suggestedOpening and tracking-points", async () => {
    const server = buildApiServer({ env: {} });

    // Step 1: create a session via the real route (uses demo state → real card/guide)
    const createRes = await server.inject({
      method: "POST",
      url: "/api/interview-sessions",
      payload: { mode: "decision", strength: "standard" }
    });
    expect(createRes.statusCode).toBe(200);
    const created = createRes.json();
    const sessionId: string = created.session.id;
    const suggestedOpening: string = created.session.card.suggestedOpening;

    // The demo state has a theme + question → suggestedOpening must be non-empty
    expect(suggestedOpening).toBeTruthy();

    // Step 2: fetch the voice agent-context
    const ctxRes = await server.inject({
      method: "GET",
      url: `/api/realtime-voice/agent-context/${sessionId}`
    });
    expect(ctxRes.statusCode).toBe(200);
    const ctx = ctxRes.json();

    // The response field is `instructions` (top-level, not nested)
    const instr: string = ctx.instructions;
    expect(typeof instr).toBe("string");
    expect(instr.length).toBeGreaterThan(0);

    // Opening discipline reached the voice prompt
    expect(instr).toContain("【开场铁律");

    // Small-talk bans are present in the opening discipline
    expect(instr).toMatch(/你好吗|最近怎么样|刚来/);

    // The card's suggestedOpening is embedded in the opening discipline
    expect(instr).toContain(suggestedOpening);

    // Persona is present (from INTERVIEWER_CRAFT_RULES)
    expect(instr).toContain("专访主持人");

    // Tracking-points are present (demo state has debts → 知识债/盲区,
    // points → 立场, historyReferences → 历史, recommendedPerspectives → 视角)
    expect(instr).toMatch(/历史|立场|知识债|盲区|视角/);

    await server.close();
  });
});
