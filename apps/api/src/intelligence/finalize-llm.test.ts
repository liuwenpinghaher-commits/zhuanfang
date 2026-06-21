/**
 * Parser robustness tests for finalize-llm.
 *
 * finalizeSessionWithLlm is an async function that wraps parseFinalizeJson
 * (private) + mapToFinalizeContent. We test via the public export, injecting
 * a mock BailianChatClient to control the raw string the parser sees.
 *
 * Key robustness points (from parseFinalizeJson):
 *  - Missing required fields (summary/saidTrack/learnedTrack) → throws
 *  - Invalid maturity → clampMaturity defaults to "萌芽"
 *  - malformed reviewAt → normalizeReviewAt adds 30 days from completedAt
 *  - Missing optional arrays → empty arrays in output (no crash)
 */
import { describe, expect, it } from "vitest";
import { createInitialProductState } from "../../../../src/domain/engine";
import { createSessionDraft } from "../../../../src/domain/context-pack";
import type { InterviewSession } from "../../../../src/domain/types";
import type { BailianChatClient } from "../providers/bailian";
import { finalizeSessionWithLlm } from "./finalize-llm";

const DEFAULT_TURN = {
  id: "turn-1",
  role: "user" as const,
  content: "这是一条用户发言，用于 keyQuote 回退",
  intent: "normal",
  timestamp: new Date().toISOString()
};

// Create a proper session using createSessionDraft (ensures card/guide are populated)
function makeSession(turnOverrides?: { turns: InterviewSession["turns"] }): InterviewSession {
  const state = createInitialProductState();
  const draft = createSessionDraft(state, "daily", "standard");
  const turns = turnOverrides?.turns ?? [DEFAULT_TURN];
  return { ...draft, turns };
}

const baseState = createInitialProductState();

const mockChat = (json: string): BailianChatClient => ({
  async complete() {
    return json;
  }
});

// Minimal well-formed JSON that parseFinalizeJson accepts
const VALID_JSON = JSON.stringify({
  summary: "这次对话很有收获",
  keyQuote: "团队执行慢是信号",
  saidTrack: ["我说了很多关于团队的事"],
  learnedTrack: ["学到了要更直接反馈"],
  nextQuestions: ["下次如何追问？"],
  points: [{ title: "核心观点", content: "执行慢是信号", evidence: ["原话"] }],
  questions: [{ question: "为什么执行慢？", whyImportant: "关键问题", nextPrompt: "你能举个例子吗" }],
  decisions: [{ title: "决策A", choice: "A", tradeOff: "取舍", riskHypothesis: "风险", reviewAt: "2025-01-01" }],
  debts: [{ concept: "知识债概念", context: "出现了", whyImportant: "值得补", nextQuestion: "怎么补？" }],
  themes: [{ name: "长期主题", summary: "主题概述", representativeQuote: "原话", nextQuestion: "下次追问", maturity: "聚焦" }]
});

// FinalizeResult = { note: DualTrackNote; nextState: ProductState }
// Assets (points/decisions/themes/debts) are stored in nextState, not at top level.

describe("finalizeSessionWithLlm", () => {
  it("happy path: well-formed JSON → note fields come from LLM output", async () => {
    const session = makeSession();
    const result = await finalizeSessionWithLlm(baseState, session, mockChat(VALID_JSON));

    expect(result.note.summary).toBe("这次对话很有收获");
    expect(result.note.keyQuote).toBe("团队执行慢是信号");
    expect(result.note.saidTrack).toContain("我说了很多关于团队的事");
    expect(result.note.learnedTrack).toContain("学到了要更直接反馈");
    expect(result.nextState).toBeDefined();
    // Assets land in nextState
    expect(Array.isArray(result.nextState.points)).toBe(true);
    expect(Array.isArray(result.nextState.debts)).toBe(true);
    expect(Array.isArray(result.nextState.themes)).toBe(true);
  });

  it("missing required fields (summary/saidTrack/learnedTrack) → throws", async () => {
    const badJson = JSON.stringify({ keyQuote: "有原话但没摘要" });
    await expect(
      finalizeSessionWithLlm(baseState, makeSession(), mockChat(badJson))
    ).rejects.toThrow();
  });

  it("invalid maturity value → clamped to '萌芽' (default) in nextState.themes", async () => {
    const json = JSON.stringify({
      ...JSON.parse(VALID_JSON),
      themes: [
        {
          name: "某主题",
          summary: "概述",
          representativeQuote: "原话",
          nextQuestion: "问题",
          maturity: "INVALID_VALUE" // not in THEME_MATURITIES
        }
      ]
    });
    const result = await finalizeSessionWithLlm(baseState, makeSession(), mockChat(json));
    const theme = result.nextState.themes.find((t) => t.name === "某主题");
    expect(theme).toBeDefined();
    expect(theme!.maturity).toBe("萌芽"); // clampMaturity default → 萌芽 (bias toward under-, not over-stating)
  });

  it("a brand-new theme is clamped to 萌芽 regardless of the maturity the LLM labeled it", async () => {
    // Maturity must track REAL recurrence: a first-appearance theme is 萌芽 no matter how developed
    // the single conversation felt. The LLM's over-eager 成型/聚焦 label is clamped down by appearances.
    const validMaturities = ["萌芽", "重复", "聚焦", "成型", "变化", "关闭"] as const;
    for (const maturity of validMaturities) {
      const json = JSON.stringify({
        ...JSON.parse(VALID_JSON),
        themes: [{ name: "主题", summary: "概述", representativeQuote: "原话", nextQuestion: "追问", maturity }]
      });
      const result = await finalizeSessionWithLlm(baseState, makeSession(), mockChat(json));
      const theme = result.nextState.themes.find((t) => t.name === "主题");
      expect(theme!.maturity).toBe("萌芽");
    }
  });

  it("malformed reviewAt → normalizeReviewAt fallback (adds 30 days) in nextState.decisions", async () => {
    const json = JSON.stringify({
      ...JSON.parse(VALID_JSON),
      decisions: [{ title: "决策B", choice: "B", tradeOff: "取舍", riskHypothesis: "风险", reviewAt: "not-a-date" }]
    });
    const result = await finalizeSessionWithLlm(baseState, makeSession(), mockChat(json));
    const decision = result.nextState.decisions.find((d) => d.title === "决策B");
    expect(decision).toBeDefined();
    // normalizeReviewAt should produce a YYYY-MM-DD string (30 days out)
    expect(decision!.reviewAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("empty reviewAt string → normalizeReviewAt fallback (adds 30 days)", async () => {
    const json = JSON.stringify({
      ...JSON.parse(VALID_JSON),
      decisions: [{ title: "决策C", choice: "C", tradeOff: "取舍", riskHypothesis: "风险", reviewAt: "" }]
    });
    const result = await finalizeSessionWithLlm(baseState, makeSession(), mockChat(json));
    const decision = result.nextState.decisions.find((d) => d.title === "决策C");
    expect(decision!.reviewAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("missing optional arrays → no new assets added to nextState (no crash)", async () => {
    const json = JSON.stringify({
      summary: "简单总结",
      keyQuote: "关键原话",
      saidTrack: ["说了一些话"],
      learnedTrack: ["学到了一些东西"]
      // points, questions, decisions, debts, themes all missing → [] each
    });
    const beforePoints = baseState.points.length;
    const beforeDebts = baseState.debts.length;
    const result = await finalizeSessionWithLlm(baseState, makeSession(), mockChat(json));
    // No new assets added when arrays are missing
    expect(result.nextState.points.length).toBe(beforePoints);
    expect(result.nextState.debts.length).toBe(beforeDebts);
  });

  it("malformed JSON → throws so the route can fall back", async () => {
    await expect(
      finalizeSessionWithLlm(baseState, makeSession(), mockChat("not valid json at all"))
    ).rejects.toThrow();
  });

  it("keyQuote missing from LLM but session has user turns → uses longest user turn as fallback", async () => {
    const json = JSON.stringify({
      summary: "总结",
      saidTrack: ["说了"],
      learnedTrack: ["学了"],
      keyQuote: "" // empty → asNonEmptyString returns "" → pickLongestUserTurn fallback
    });
    const session = makeSession({
      turns: [
        { id: "t1", role: "user", content: "这是最长的用户发言内容用于回退", intent: "normal", timestamp: new Date().toISOString() },
        { id: "t2", role: "assistant", content: "助手回复", intent: "normal", timestamp: new Date().toISOString() }
      ]
    });
    const result = await finalizeSessionWithLlm(baseState, session, mockChat(json));
    expect(result.note.keyQuote).toBe("这是最长的用户发言内容用于回退");
  });
});
