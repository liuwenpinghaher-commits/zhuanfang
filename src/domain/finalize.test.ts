import { describe, it, expect } from "vitest";
import { finalizeSession, createInterviewSession, addTurn, createInitialProductState } from "./engine";
import { clampMaturityByAppearances, upsertFinalizeThemes } from "./finalize";
import type { LongTermTheme } from "./types";

describe("theme maturity coherence (#1)", () => {
  it("caps a single-appearance theme at 萌芽 no matter what the LLM labeled it", () => {
    expect(clampMaturityByAppearances("成型", 1)).toBe("萌芽");
    expect(clampMaturityByAppearances("聚焦", 1)).toBe("萌芽");
    expect(clampMaturityByAppearances("变化", 1)).toBe("萌芽");
  });
  it("raises the ceiling only as the theme actually recurs", () => {
    expect(clampMaturityByAppearances("成型", 2)).toBe("重复");
    expect(clampMaturityByAppearances("成型", 3)).toBe("聚焦");
    expect(clampMaturityByAppearances("成型", 4)).toBe("成型");
  });
  it("never forces maturity UP — the LLM can keep a recurring theme nascent", () => {
    expect(clampMaturityByAppearances("萌芽", 5)).toBe("萌芽");
  });
});

describe("upsertFinalizeThemes tracking + maturity (#1/#2a)", () => {
  const theme = (over: Partial<LongTermTheme>): LongTermTheme => ({
    id: "t1", name: "控制感", summary: "s", maturity: "萌芽", representativeQuote: "q",
    appearances: 1, nextQuestion: "nq", createdAt: "2026-06-01T00:00:00.000Z", updatedAt: "2026-06-01T00:00:00.000Z", ...over
  });
  it("merges by normalized name (trailing space/punct), increments appearances, clamps maturity", () => {
    const result = upsertFinalizeThemes(
      [theme({})],
      [{ name: "控制感。", summary: "new", maturity: "成型", representativeQuote: "q2", nextQuestion: "nq2" }],
      "2026-06-21T00:00:00.000Z"
    );
    expect(result.length).toBe(1); // merged, NOT split into two theme lines
    expect(result[0].appearances).toBe(2);
    expect(result[0].maturity).toBe("重复"); // LLM said 成型 → clamped to ceiling for 2 appearances
  });
  it("a brand-new theme is born 萌芽 even if the LLM said 成型", () => {
    const result = upsertFinalizeThemes([], [{ name: "新主题", summary: "s", maturity: "成型", representativeQuote: "q", nextQuestion: "nq" }], "2026-06-21T00:00:00.000Z");
    expect(result.length).toBe(1);
    expect(result[0].appearances).toBe(1);
    expect(result[0].maturity).toBe("萌芽");
  });
});

describe("finalize memory extraction (M1a)", () => {
  // 真实性重构:剔除「无 providedCandidates → 从会话/keyQuote 启发式造模板候选」的兜底——
  // 记忆候选只来自 LLM 真实抽取(providedCandidates),确定性 finalize 不再伪造候选。
  // 原「derives candidate text from actual session content」「candidate text contains salient
  // user content」两个用例专测该兜底,改写为断言新的诚实行为:
  it("finalizeSession without providedCandidates does NOT fabricate a memory candidate", () => {
    const state = createInitialProductState();
    let s = createInterviewSession({ id: "s1", title: "关于放权的纠结" });
    s = addTurn(s, { role: "user", content: "我一直不敢把审批权交给团队，怕出错。" });
    s = addTurn(s, { role: "assistant", content: "你怕的是结果失控，还是判断力被质疑？" });
    s = addTurn(s, { role: "user", content: "其实是怕我自己不再被需要。" });
    const { nextState } = finalizeSession(state, s);
    expect(nextState.memoryCandidates).toHaveLength(state.memoryCandidates.length);
  });

  it("mergeFinalizedState accepts providedCandidates and uses them instead of building from session", async () => {
    const { mergeFinalizedState } = await import("./finalize");
    const { createInitialProductState: initState, createInterviewSession: cis, addTurn: at, buildInterviewQualityReport } = await import("./engine");
    const { nowIso } = await import("./utils");

    const state = initState();
    let s = cis({ id: "s3", title: "测试 providedCandidates" });
    s = at(s, { role: "user", content: "这是测试内容，应被忽略。" });

    const fakeCandidate = {
      id: "mc-fake-001",
      text: "来自外部 LLM 抽取的候选",
      status: "pending" as const,
      sourceType: "interview_session" as const,
      sourceId: "s3",
      evidenceQuote: "这是测试内容",
      reason: "LLM 抽取",
      sensitivity: "normal" as const,
      reviewScore: 0,
      reviewSignals: [],
      createdAt: nowIso()
    };

    const completedAt = nowIso();
    const note = {
      id: "note-test",
      sessionId: "s3",
      title: s.title,
      summary: "测试摘要",
      keyQuote: "这是测试内容，应被忽略。",
      saidTrack: ["这是测试内容，应被忽略。"],
      learnedTrack: [],
      nextQuestions: [],
      createdAt: completedAt
    };
    const content = { note, points: [], questions: [], decisions: [], debts: [], themes: [] };

    const { nextState } = mergeFinalizedState(state, s, content, completedAt, [fakeCandidate]);
    expect(nextState.memoryCandidates).toHaveLength(1);
    expect(nextState.memoryCandidates[0].text).toBe("来自外部 LLM 抽取的候选");
    expect(nextState.memoryCandidates[0].id).toBe("mc-fake-001");
  });

  it("mergeFinalizedState drops endCheckpoint on the completed session", async () => {
    const { mergeFinalizedState } = await import("./finalize");
    const { createInitialProductState: initState, createInterviewSession: cis } = await import("./engine");
    const { nowIso } = await import("./utils");
    const state = initState();
    const s = {
      ...cis({ id: "s-ckpt", title: "有 checkpoint 的场" }),
      endCheckpoint: {
        turnCount: 0,
        extractCandidates: [{
          id: "mc-ckpt",
          text: "抽过的记忆",
          status: "pending" as const,
          sourceType: "interview_session" as const,
          sourceId: "s-ckpt",
          evidenceQuote: "原话",
          reason: "抽取",
          sensitivity: "normal" as const,
          reviewScore: 0,
          reviewSignals: [],
          createdAt: nowIso()
        }],
        extractAt: nowIso()
      }
    };
    const completedAt = nowIso();
    const note = {
      id: "note-ckpt",
      sessionId: "s-ckpt",
      title: s.title,
      summary: "摘要",
      keyQuote: "原话",
      saidTrack: ["原话"],
      learnedTrack: [],
      nextQuestions: [],
      createdAt: completedAt
    };
    const { nextState } = mergeFinalizedState(state, s, { note, points: [], questions: [], decisions: [], debts: [], themes: [] }, completedAt, s.endCheckpoint.extractCandidates);
    const done = nextState.sessions.find((item) => item.id === "s-ckpt");
    expect(done?.status).toBe("completed");
    expect(done?.endCheckpoint).toBeUndefined();
  });

  it("mergeFinalizedState with empty/undefined providedCandidates adds NO memory candidate (诚实的空,不再启发式造候选)", async () => {
    const { mergeFinalizedState } = await import("./finalize");
    const { createInitialProductState: initState, createInterviewSession: cis, addTurn: at } = await import("./engine");
    const { nowIso } = await import("./utils");

    const state = initState();
    let s = cis({ id: "s4", title: "兜底测试" });
    s = at(s, { role: "user", content: "我担心团队无法独立判断复杂问题。" });

    const completedAt = nowIso();
    const note = {
      id: "note-fallback",
      sessionId: "s4",
      title: s.title,
      summary: "测试",
      keyQuote: "我担心团队无法独立判断复杂问题。",
      saidTrack: ["我担心团队无法独立判断复杂问题。"],
      learnedTrack: [],
      nextQuestions: [],
      createdAt: completedAt
    };
    const content = { note, points: [], questions: [], decisions: [], debts: [], themes: [] };

    // undefined 与空数组同义:LLM 没抽出值得沉淀的记忆 → 不新增候选,绝不从 keyQuote 造模板候选。
    const { nextState: viaUndefined } = mergeFinalizedState(state, s, content, completedAt, undefined);
    expect(viaUndefined.memoryCandidates).toHaveLength(state.memoryCandidates.length);
    const { nextState: viaEmpty } = mergeFinalizedState(state, s, content, completedAt, []);
    expect(viaEmpty.memoryCandidates).toHaveLength(state.memoryCandidates.length);
  });

  it("F: decisions/debts 带 evidence 时 mergeFinalizedState 补 evidenceAnchors(满足 A1 溯源)", async () => {
    const { mergeFinalizedState } = await import("./finalize");
    const { createInitialProductState: initState, createInterviewSession: cis, addTurn: at } = await import("./engine");
    const { nowIso } = await import("./utils");

    const state = initState();
    let s = cis({ id: "s5", title: "决策溯源测试" });
    s = at(s, { role: "user", content: "我决定把招聘权下放给团队负责人。" });

    const completedAt = nowIso();
    const note = {
      id: "note-f", sessionId: "s5", title: s.title, summary: "x",
      keyQuote: "我决定把招聘权下放给团队负责人。", saidTrack: [], learnedTrack: [], nextQuestions: [], createdAt: completedAt
    };
    const decision = {
      id: "de_f", title: "下放招聘权", decisionKind: "候选决策" as const, confirmationStatus: "待用户确认" as const,
      choice: "下放", tradeOff: "", riskHypothesis: "", reviewAt: "", status: "待复盘" as const,
      evidence: ["我决定把招聘权下放给团队负责人。"], updatedAt: completedAt
    };
    const debt = {
      id: "dt_f", concept: "授权边界", context: "", whyImportant: "", status: "待了解" as const,
      nextQuestion: "", evidence: ["我决定把招聘权下放给团队负责人。"], updatedAt: completedAt
    };
    const content = { note, points: [], questions: [], decisions: [decision], debts: [debt], themes: [] };

    const { nextState } = mergeFinalizedState(state, s, content, completedAt, undefined);
    const de = nextState.decisions.find((d) => d.id === "de_f")!;
    const dt = nextState.debts.find((d) => d.concept === "授权边界")!;
    expect(de.evidenceAnchors?.length).toBeGreaterThan(0);       // F:decision 有溯源 anchor
    expect(de.evidenceAnchors?.[0].turnId).toBeTruthy();
    expect(dt.evidenceAnchors?.length).toBeGreaterThan(0);       // F:debt 有溯源 anchor
  });
});

describe("finalize 证据锚点扩展 (Phase 1 收尾)", () => {
  // 共用的会话：两条 user 原话，能被各资产的逐字摘录回匹配到。
  const buildSession = async () => {
    const { createInterviewSession: cis, addTurn: at } = await import("./engine");
    let s = cis({ id: "anchor-s1", title: "关于放权的纠结" });
    s = at(s, { role: "user", content: "我一直不敢把审批权交给团队，怕出错。" });
    s = at(s, { role: "assistant", content: "你怕的是结果失控，还是判断力被质疑？" });
    s = at(s, { role: "user", content: "其实是怕我自己不再被需要。" });
    return s;
  };

  const userTurnId = (s: { turns: { id: string; role: string; content: string }[] }, content: string) =>
    s.turns.find((t) => t.role === "user" && t.content.includes(content))!.id;

  it("points 的首个非空 evidence 命中 user 轮 → 盖 evidenceAnchors", async () => {
    const { mergeFinalizedState } = await import("./finalize");
    const { createInitialProductState: initState } = await import("./engine");
    const { nowIso } = await import("./utils");

    const state = initState();
    const s = await buildSession();
    const completedAt = nowIso();
    const note = {
      id: "note-pt", sessionId: s.id, title: s.title, summary: "测试",
      keyQuote: "其实是怕我自己不再被需要。", saidTrack: [], learnedTrack: [], nextQuestions: [], createdAt: completedAt
    };
    const point = {
      id: "pt-1", title: "放权焦虑", content: "用户难以下放审批权",
      status: "临时想法" as const, confidence: "AI 推断" as const,
      evidence: ["", "我一直不敢把审批权交给团队，怕出错。"], relatedThemeIds: [],
      important: false, updatedAt: completedAt
    };
    const content = { note, points: [point], questions: [], decisions: [], debts: [], themes: [] };

    const { nextState } = mergeFinalizedState(state, s, content, completedAt, undefined);
    const stored = nextState.points.find((p) => p.id === "pt-1")!;
    expect(stored.evidenceAnchors).toEqual([{ sessionId: s.id, turnId: userTurnId(s, "审批权") }]);
  });

  it("points 的 evidence 匹配不到 → 不加 evidenceAnchors", async () => {
    const { mergeFinalizedState } = await import("./finalize");
    const { createInitialProductState: initState } = await import("./engine");
    const { nowIso } = await import("./utils");

    const state = initState();
    const s = await buildSession();
    const completedAt = nowIso();
    const note = {
      id: "note-pt2", sessionId: s.id, title: s.title, summary: "测试",
      keyQuote: "其实是怕我自己不再被需要。", saidTrack: [], learnedTrack: [], nextQuestions: [], createdAt: completedAt
    };
    const point = {
      id: "pt-2", title: "无来源", content: "x",
      status: "临时想法" as const, confidence: "AI 推断" as const,
      evidence: ["对话里根本不存在的一句话"], relatedThemeIds: [],
      important: false, updatedAt: completedAt
    };
    const content = { note, points: [point], questions: [], decisions: [], debts: [], themes: [] };

    const { nextState } = mergeFinalizedState(state, s, content, completedAt, undefined);
    const stored = nextState.points.find((p) => p.id === "pt-2")!;
    expect(stored.evidenceAnchors).toBeUndefined();
  });

  it("note.keyQuote 命中 user 轮 → 盖 keyQuoteAnchor（单 anchor）", async () => {
    const { mergeFinalizedState } = await import("./finalize");
    const { createInitialProductState: initState } = await import("./engine");
    const { nowIso } = await import("./utils");

    const state = initState();
    const s = await buildSession();
    const completedAt = nowIso();
    const note = {
      id: "note-kq", sessionId: s.id, title: s.title, summary: "测试",
      keyQuote: "其实是怕我自己不再被需要。", saidTrack: [], learnedTrack: [], nextQuestions: [], createdAt: completedAt
    };
    const content = { note, points: [], questions: [], decisions: [], debts: [], themes: [] };

    const { note: finalNote } = mergeFinalizedState(state, s, content, completedAt, undefined);
    expect(finalNote.keyQuoteAnchor).toEqual({ sessionId: s.id, turnId: userTurnId(s, "不再被需要") });
  });

  it("theme.representativeQuote 命中 user 轮 → 盖 representativeQuoteAnchor（单 anchor）", async () => {
    const { mergeFinalizedState } = await import("./finalize");
    const { createInitialProductState: initState } = await import("./engine");
    const { nowIso } = await import("./utils");

    const state = initState();
    const s = await buildSession();
    const completedAt = nowIso();
    const note = {
      id: "note-th", sessionId: s.id, title: s.title, summary: "测试",
      keyQuote: "其实是怕我自己不再被需要。", saidTrack: [], learnedTrack: [], nextQuestions: [], createdAt: completedAt
    };
    const theme = {
      name: "控制感", summary: "对放权的焦虑", representativeQuote: "我一直不敢把审批权交给团队，怕出错。",
      nextQuestion: "下次问什么", maturity: "萌芽" as const
    };
    const content = { note, points: [], questions: [], decisions: [], debts: [], themes: [theme] };

    const { nextState } = mergeFinalizedState(state, s, content, completedAt, undefined);
    const stored = nextState.themes.find((t) => t.name === "控制感")!;
    expect(stored.representativeQuoteAnchor).toEqual({ sessionId: s.id, turnId: userTurnId(s, "审批权") });
  });

  // 真实性重构:剔除「M3 确定性回退候选也带锚点」用例——确定性回退候选本身已被剔除
  // (无 providedCandidates → 不新增记忆候选),不存在需要盖锚点的回退候选。
  // providedCandidates 路径的锚点行为由上方「mergeFinalizedState accepts providedCandidates」覆盖。
});

describe("审计修复:知识债状态守卫 + 问题 upsert", () => {
  it("upsertFinalizeDebts:用户置「不相关」不被 LLM 的「待了解」覆盖,appearances 仍+1", async () => {
    const { upsertFinalizeDebts } = await import("./finalize");
    const existing = [{ id: "d1", concept: "向量数据库", context: "", whyImportant: "", nextQuestion: "", status: "不相关" as const, appearances: 1, updatedAt: "2026-06-27T00:00:00.000Z" }];
    const incoming = [{ id: "d2", concept: "向量数据库", context: "c", whyImportant: "w", nextQuestion: "n", status: "待了解" as const, appearances: 1, updatedAt: "2026-06-28T00:00:00.000Z" }];
    const out = upsertFinalizeDebts(existing, incoming, "se_x", "2026-06-28T00:00:00.000Z");
    expect(out).toHaveLength(1);
    expect(out[0].status).toBe("不相关");        // 用户状态保留
    expect(out[0].appearances).toBe(2);          // 计数仍自增
  });

  it("upsertFinalizeDebts:既有为「待了解」时接受 incoming status", async () => {
    const { upsertFinalizeDebts } = await import("./finalize");
    const existing = [{ id: "d1", concept: "RAG", context: "", whyImportant: "", nextQuestion: "", status: "待了解" as const, appearances: 1, updatedAt: "2026-06-27T00:00:00.000Z" }];
    const incoming = [{ id: "d2", concept: "RAG", context: "c", whyImportant: "w", nextQuestion: "n", status: "待了解" as const, appearances: 1, updatedAt: "2026-06-28T00:00:00.000Z" }];
    const out = upsertFinalizeDebts(existing, incoming, "se_x", "2026-06-28T00:00:00.000Z");
    expect(out[0].appearances).toBe(2);
  });

  it("upsertFinalizeQuestions:同问题两次 upsert → appearances=2 且「开放」升「反复出现」", async () => {
    const { upsertFinalizeQuestions } = await import("./finalize");
    const q = (id: string) => ({ id, question: "如何平衡放权与质量", whyImportant: "", status: "开放" as const, appearances: 1, relatedThemeIds: [], nextPrompt: "", important: false, updatedAt: "2026-06-27T00:00:00.000Z" });
    let out = upsertFinalizeQuestions([], [q("q1")], "se_1", "2026-06-27T00:00:00.000Z");
    out = upsertFinalizeQuestions(out, [q("q2")], "se_2", "2026-06-28T00:00:00.000Z");
    expect(out).toHaveLength(1);
    expect(out[0].appearances).toBe(2);
    expect(out[0].status).toBe("反复出现");       // 机器首次可达该状态
  });

  it("upsertFinalizeQuestions:用户置「正在聚焦」不被复现覆盖", async () => {
    const { upsertFinalizeQuestions } = await import("./finalize");
    const existing = [{ id: "q1", question: "核心问题", whyImportant: "", status: "正在聚焦" as const, appearances: 2, relatedThemeIds: [], nextPrompt: "", important: false, updatedAt: "2026-06-27T00:00:00.000Z" }];
    const incoming = [{ id: "q2", question: "核心问题", whyImportant: "", status: "开放" as const, appearances: 1, relatedThemeIds: [], nextPrompt: "", important: false, updatedAt: "2026-06-28T00:00:00.000Z" }];
    const out = upsertFinalizeQuestions(existing, incoming, "se_2", "2026-06-28T00:00:00.000Z");
    expect(out[0].status).toBe("正在聚焦");
    expect(out[0].appearances).toBe(3);
  });

  it("R5-4:relatedThemeIds 复现时合并去重(旧∪新),不丢历史主题链", async () => {
    const { upsertFinalizeQuestions } = await import("./finalize");
    const existing = [{ id: "q1", question: "你如何权衡?", whyImportant: "", status: "开放" as const, appearances: 1, relatedThemeIds: ["th_control", "th_shared"], nextPrompt: "", important: false, updatedAt: "2026-06-27T00:00:00.000Z" }];
    const incoming = [{ id: "q2", question: "你如何权衡?", whyImportant: "", status: "开放" as const, appearances: 1, relatedThemeIds: ["th_risk", "th_shared"], nextPrompt: "", important: false, updatedAt: "2026-06-28T00:00:00.000Z" }];
    const out = upsertFinalizeQuestions(existing, incoming, "se_2", "2026-06-28T00:00:00.000Z");
    // 旧[control,shared] ∪ 新[risk,shared] = [control,shared,risk]:历史 th_control 不被替换丢弃,th_shared 不重复
    expect(out[0].relatedThemeIds).toEqual(["th_control", "th_shared", "th_risk"]);
  });

  it("R5-4:incoming 无主题时保留既有主题链(不被空数组清空)", async () => {
    const { upsertFinalizeQuestions } = await import("./finalize");
    const existing = [{ id: "q1", question: "你如何权衡?", whyImportant: "", status: "开放" as const, appearances: 1, relatedThemeIds: ["th_keep"], nextPrompt: "", important: false, updatedAt: "2026-06-27T00:00:00.000Z" }];
    const incoming = [{ id: "q2", question: "你如何权衡?", whyImportant: "", status: "开放" as const, appearances: 1, relatedThemeIds: [], nextPrompt: "", important: false, updatedAt: "2026-06-28T00:00:00.000Z" }];
    const out = upsertFinalizeQuestions(existing, incoming, "se_2", "2026-06-28T00:00:00.000Z");
    expect(out[0].relatedThemeIds).toEqual(["th_keep"]);
  });

  it("upsertFinalizeDebts:复现时合并 relatedThemeIds", async () => {
    const { upsertFinalizeDebts } = await import("./finalize");
    const existing = [{ id: "d1", concept: "RAG", context: "", whyImportant: "", nextQuestion: "", status: "待了解" as const, appearances: 1, relatedThemeIds: ["th_old"], updatedAt: "2026-06-27T00:00:00.000Z" }];
    const incoming = [{ id: "d2", concept: "RAG", context: "c", whyImportant: "w", nextQuestion: "n", status: "待了解" as const, appearances: 1, relatedThemeIds: ["th_new"], updatedAt: "2026-06-28T00:00:00.000Z" }];
    const out = upsertFinalizeDebts(existing, incoming, "se_2", "2026-06-28T00:00:00.000Z");
    expect(out).toHaveLength(1);
    expect(out[0].relatedThemeIds).toEqual(["th_old", "th_new"]);
    expect(out[0].appearedInSessionIds).toEqual(["se_2"]);
  });

  it("upsertFinalizePoints:同标题合并，用户确认不被覆盖", async () => {
    const { upsertFinalizePoints } = await import("./finalize");
    const existing = [{
      id: "p1", title: "放权会变贵", content: "旧", status: "稳定观点" as const, confidence: "用户确认" as const,
      evidence: ["旧证"], relatedThemeIds: ["th_a"], important: false, updatedAt: "2026-06-27T00:00:00.000Z", sourceSessionId: "se_1"
    }];
    const incoming = [{
      id: "p2", title: "放权会变贵", content: "新", status: "临时想法" as const, confidence: "AI 推断" as const,
      evidence: ["新证"], relatedThemeIds: ["th_b"], important: false, updatedAt: "2026-06-28T00:00:00.000Z"
    }];
    const out = upsertFinalizePoints(existing, incoming, "se_2", "2026-06-28T00:00:00.000Z");
    expect(out).toHaveLength(1);
    expect(out[0].confidence).toBe("用户确认");
    expect(out[0].status).toBe("稳定观点");
    expect(out[0].sourceSessionId).toBe("se_1");
    expect(out[0].appearedInSessionIds).toContain("se_1");
    expect(out[0].appearedInSessionIds).toContain("se_2");
    expect(out[0].relatedThemeIds).toEqual(["th_a", "th_b"]);
  });

  it("upsertFinalizeDecisions:同标题合并，已确认不被打回待确认", async () => {
    const { upsertFinalizeDecisions } = await import("./finalize");
    const existing = [{
      id: "de1", title: "是否亲自救火", decisionKind: "候选决策" as const, confirmationStatus: "用户确认" as const,
      choice: "不救", tradeOff: "t", riskHypothesis: "r", reviewAt: "", status: "已复盘" as const,
      updatedAt: "2026-06-27T00:00:00.000Z", sourceSessionId: "se_1"
    }];
    const incoming = [{
      id: "de2", title: "是否亲自救火", decisionKind: "候选决策" as const, confirmationStatus: "待用户确认" as const,
      choice: "再想想", tradeOff: "t2", riskHypothesis: "r2", reviewAt: "", status: "待复盘" as const,
      updatedAt: "2026-06-28T00:00:00.000Z"
    }];
    const out = upsertFinalizeDecisions(existing, incoming, "se_2", "2026-06-28T00:00:00.000Z");
    expect(out).toHaveLength(1);
    expect(out[0].confirmationStatus).toBe("用户确认");
    expect(out[0].status).toBe("已复盘");
    expect(out[0].appearedInSessionIds).toEqual(["se_1", "se_2"]);
  });
});
