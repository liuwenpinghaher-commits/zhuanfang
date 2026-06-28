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
import type { InterviewSession, LongTermTheme, ProductState } from "../../../../src/domain/types";
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

  // --- Controlled theme grounding (本体论欠账①: attributeThemeIds 下线, LLM 直出受控主题归属) ---
  // relatedThemeIds is now sourced from LLM-emitted themeRefs (controlled to this finalize's
  // themes[] ∪ existing state themes), not a fragile substring guess, and never falls back to themes[0].
  describe("controlled theme grounding via themeRefs", () => {
    it("themeRefs naming this finalize's NEW theme → relatedThemeIds resolves to that theme's id", async () => {
      // The point's title/content does NOT contain the theme name "放权信任", so the old substring
      // matcher would have missed it; the explicit themeRef is what grounds it.
      const json = JSON.stringify({
        summary: "这次对话谈了团队管理",
        keyQuote: "我必须学会信任下属",
        saidTrack: ["我说了管理的事"],
        learnedTrack: ["学到了要授权"],
        themes: [{ name: "放权信任", summary: "如何把事交出去", representativeQuote: "原话", nextQuestion: "下次追问", maturity: "萌芽" }],
        points: [{ title: "管理的核心是放手", content: "盯得越紧团队越被动", evidence: ["原话"], themeRefs: ["放权信任"] }]
      });
      const result = await finalizeSessionWithLlm(baseState, makeSession(), mockChat(json));
      const theme = result.nextState.themes.find((t) => t.name === "放权信任");
      const point = result.nextState.points.find((p) => p.title === "管理的核心是放手");
      expect(theme).toBeDefined();
      expect(point).toBeDefined();
      expect(point!.relatedThemeIds).toEqual([theme!.id]);
    });

    it("themeRefs naming a pre-existing state theme → relatedThemeIds resolves to the EXISTING theme's id (continuity)", async () => {
      // Seed an existing theme into the state; a themeRef using its exact name must resolve to its id
      // (the same merge-by-name continuity the themes[] path relies on), even if this finalize's
      // themes[] does not re-list it.
      const existingTheme: LongTermTheme = {
        id: "theme-existing-001",
        name: "增长焦虑",
        summary: "对增速放缓的担忧",
        representativeQuote: "增长是生命线",
        nextQuestion: "增长从哪来？",
        maturity: "重复",
        appearances: 3,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };
      const stateWithTheme: ProductState = { ...baseState, themes: [existingTheme] };

      const json = JSON.stringify({
        summary: "这次聊到增长压力",
        keyQuote: "我们必须找到新的增长曲线",
        saidTrack: ["我说了增长"],
        learnedTrack: ["学到了要找新曲线"],
        themes: [], // does not re-declare the existing theme
        questions: [{ question: "第二增长曲线在哪？", whyImportant: "决定存亡", nextPrompt: "你试过哪些方向？", themeRefs: ["增长焦虑"] }]
      });
      const result = await finalizeSessionWithLlm(stateWithTheme, makeSession(), mockChat(json));
      const question = result.nextState.questions.find((q) => q.question === "第二增长曲线在哪？");
      expect(question).toBeDefined();
      expect(question!.relatedThemeIds).toEqual(["theme-existing-001"]);
    });

    it("themeRefs naming a NON-existent theme → that ref is ignored (no hallucinated attribution / no new theme)", async () => {
      const json = JSON.stringify({
        summary: "这次对话谈了产品",
        keyQuote: "产品要聚焦",
        saidTrack: ["我说了产品"],
        learnedTrack: ["学到了聚焦"],
        themes: [{ name: "产品聚焦", summary: "做减法", representativeQuote: "原话", nextQuestion: "下次追问", maturity: "萌芽" }],
        // One real ref + one bogus ref: only the real one survives, the bogus one is dropped silently.
        debts: [{ concept: "PMF", context: "提到了", whyImportant: "值得补", nextQuestion: "怎么验证？", themeRefs: ["产品聚焦", "不存在的主题XYZ"] }]
      });
      const result = await finalizeSessionWithLlm(baseState, makeSession(), mockChat(json));
      const theme = result.nextState.themes.find((t) => t.name === "产品聚焦");
      const debt = result.nextState.debts.find((d) => d.concept === "PMF");
      expect(theme).toBeDefined();
      expect(debt).toBeDefined();
      // bogus ref dropped → only the real theme id remains
      expect(debt!.relatedThemeIds).toEqual([theme!.id]);
      // no extra theme was created from the bogus ref (themes only come from themes[])
      expect(result.nextState.themes.filter((t) => t.name === "不存在的主题XYZ")).toHaveLength(0);
    });

    it("no themeRefs on an asset → relatedThemeIds is empty (honest blank, NOT a themes[0] fallback)", async () => {
      // The decision omits themeRefs entirely. Even though the finalize emits a theme, the old
      // behavior would have linked the decision to themes[0]; the new behavior leaves it blank.
      const json = JSON.stringify({
        summary: "这次对话有个决策",
        keyQuote: "我决定先做 A",
        saidTrack: ["我说了决策"],
        learnedTrack: ["学到了取舍"],
        themes: [{ name: "战略取舍", summary: "资源有限", representativeQuote: "原话", nextQuestion: "下次追问", maturity: "萌芽" }],
        decisions: [{ title: "先做A", choice: "A", tradeOff: "放弃B", riskHypothesis: "B可能更大", reviewAt: "2025-06-01" /* no themeRefs */ }]
      });
      const result = await finalizeSessionWithLlm(baseState, makeSession(), mockChat(json));
      const decision = result.nextState.decisions.find((d) => d.title === "先做A");
      expect(decision).toBeDefined();
      // honest blank, not [themes[0].id]
      expect(decision!.relatedThemeIds).toEqual([]);
    });

    it("attributeThemeIds is gone: a substring co-occurrence with NO themeRef does NOT auto-attribute", async () => {
      // The point's content literally contains the theme name "复利" (≥3? no — but historically the
      // old matcher used >=3 chars). Use a ≥3-char theme name that appears verbatim in the point text
      // to prove the substring path is truly dead: without an explicit themeRef it must stay blank.
      const json = JSON.stringify({
        summary: "这次聊到长期主义",
        keyQuote: "时间的复利效应最被低估",
        saidTrack: ["我说了复利"],
        learnedTrack: ["学到了耐心"],
        themes: [{ name: "复利效应", summary: "长期才显现", representativeQuote: "原话", nextQuestion: "下次追问", maturity: "萌芽" }],
        // content contains "复利效应" verbatim but provides NO themeRefs → must NOT be linked anymore.
        points: [{ title: "耐心很重要", content: "复利效应需要时间才能显现", evidence: ["原话"] }]
      });
      const result = await finalizeSessionWithLlm(baseState, makeSession(), mockChat(json));
      const point = result.nextState.points.find((p) => p.title === "耐心很重要");
      expect(point).toBeDefined();
      expect(point!.relatedThemeIds).toEqual([]);
    });
  });
});
