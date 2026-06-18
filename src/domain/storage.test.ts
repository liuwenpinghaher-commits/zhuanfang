import { describe, expect, it } from "vitest";
import { createInitialProductState } from "./engine";
import { normalizeProductState } from "./storage";

describe("product state storage", () => {
  it("normalizes legacy local state with new capability fields", () => {
    const legacy = createInitialProductState();
    const legacyLike = {
      profile: legacy.profile,
      sessions: legacy.sessions,
      notes: legacy.notes,
      points: legacy.points,
      questions: legacy.questions,
      decisions: legacy.decisions,
      debts: legacy.debts,
      themes: legacy.themes,
      memoryCorrections: legacy.memoryCorrections
    };

    const normalized = normalizeProductState(legacyLike);

    expect(normalized.notes).toHaveLength(legacy.notes.length);
    expect(normalized.searchBriefs).toEqual([]);
    expect(normalized.podcastEpisodes).toEqual([]);
    expect(normalized.corpusImports).toEqual([]);
    expect(normalized.systemConfig.search.activeProvider).toBe("bailian");
    expect(normalized.systemConfig.interview.launchMode).toBe("immersive");
  });

  it("merges default provider definitions into previously persisted system config", () => {
    const legacy = createInitialProductState();
    const normalized = normalizeProductState({
      ...legacy,
      systemConfig: {
        ...legacy.systemConfig,
        providers: [
          {
            id: "local-demo-search",
            kind: "search",
            label: "Local Demo Search",
            status: "ready",
            active: true,
            description: "旧本地搜索配置",
            lastCheckedAt: "2026-06-09T00:00:00.000Z"
          }
        ],
        search: {
          ...legacy.systemConfig.search,
          activeProvider: "local-demo"
        },
        voice: {
          ...legacy.systemConfig.voice,
          ttsProvider: "local-demo"
        },
        models: {
          planningModel: "local-planner",
          interviewModel: "local-rules-interviewer",
          synthesisModel: "local-synthesizer"
        }
      }
    });

    expect(normalized.systemConfig.providers.map((provider) => provider.id)).toContain("bailian-responses");
    expect(normalized.systemConfig.providers.find((provider) => provider.id === "bailian-qwen-tts")).toMatchObject({
      active: true,
      label: "百炼 CosyVoice"
    });
    expect(normalized.systemConfig.providers.find((provider) => provider.id === "bailian-responses")).toMatchObject({
      active: true
    });
    expect(normalized.systemConfig.providers.find((provider) => provider.id === "local-demo-search")).toMatchObject({
      active: false,
      description: "旧本地搜索配置"
    });
    expect(normalized.systemConfig.search.activeProvider).toBe("bailian");
    expect(normalized.systemConfig.voice.ttsProvider).toBe("bailian");
    expect(normalized.systemConfig.models).toMatchObject({
      planningModel: "qwen3.7-plus",
      interviewModel: "qwen-plus-character",
      synthesisModel: "qwen3.7-plus"
    });
  });

  it("normalizes legacy search briefs with structured material fields", () => {
    const state = createInitialProductState();
    const normalized = normalizeProductState({
      ...state,
      searchBriefs: [
        {
          id: "legacy-brief",
          topic: "AI 产品商业化热点",
          provider: "anysearch",
          status: "needs-review",
          summary: "旧简报摘要",
          discussionTopics: ["旧讨论主题"],
          sourceAngles: ["旧来源角度"],
          sources: [],
          appliedToSessionIds: [],
          createdAt: "2026-06-10T00:00:00.000Z"
        }
      ]
    });

    expect(normalized.searchBriefs[0]).toMatchObject({
      facts: ["旧简报摘要"],
      controversies: ["旧来源角度"],
      opposingViews: ["需要补充反方观点，避免把外部素材直接当结论。"],
      interviewAngles: ["旧讨论主题"]
    });
  });

  it("migrates legacy s2s realtimeMode to bailian (s2s pipeline removed in Phase 3)", () => {
    const state = createInitialProductState();
    const normalized = normalizeProductState({
      ...state,
      systemConfig: {
        ...state.systemConfig,
        voice: {
          ...state.systemConfig.voice,
          realtimeMode: "s2s",
        },
      },
    });

    expect(normalized.systemConfig.voice.realtimeMode).toBe("bailian");
  });

  it("preserves an existing bailian realtimeMode", () => {
    const state = createInitialProductState();
    const normalized = normalizeProductState({
      ...state,
      systemConfig: {
        ...state.systemConfig,
        voice: {
          ...state.systemConfig.voice,
          realtimeMode: "bailian",
        },
      },
    });

    expect(normalized.systemConfig.voice.realtimeMode).toBe("bailian");
  });

  it("preserves an existing livekit realtimeMode", () => {
    const state = createInitialProductState();
    const normalized = normalizeProductState({
      ...state,
      systemConfig: {
        ...state.systemConfig,
        voice: {
          ...state.systemConfig.voice,
          realtimeMode: "livekit",
        },
      },
    });

    expect(normalized.systemConfig.voice.realtimeMode).toBe("livekit");
  });

  it("defaults revision to 0 when missing and preserves a numeric revision", () => {
    expect(normalizeProductState({}).revision).toBe(0);
    expect(normalizeProductState({ revision: 7 }).revision).toBe(7);
  });

  it("migrates v1 themes to v2 Track fields and sets schemaVersion", () => {
    const v1 = createInitialProductState();
    // 模拟 v1 数据：剥掉 v2 新增字段
    const v1Themes = v1.themes.map(({ kind, pinned, createdAt, lastActiveAt, ...rest }) => rest);
    const normalized = normalizeProductState({ ...v1, themes: v1Themes, schemaVersion: undefined });

    expect(normalized.schemaVersion).toBe(2);
    expect(normalized.themes[0].kind).toBe("theme");
    expect(normalized.themes[0].pinned).toBe(false);
    expect(normalized.themes[0].createdAt).toBe(normalized.themes[0].updatedAt);
    expect(normalized.themes[0].lastActiveAt).toBe(normalized.themes[0].updatedAt);
  });

  it("migrateWorkflowRuns: maps legacy mastra-runtime providerId to local-workflow-runtime", () => {
    const state = createInitialProductState();
    const legacyRun = {
      id: "run-legacy-001",
      workflow: "interview_preparation" as const,
      status: "succeeded" as const,
      providerId: "mastra-runtime",
      entityType: "interview_session" as const,
      entityId: "session-abc",
      inputSummary: "legacy input",
      outputSummary: "legacy output",
      startedAt: "2026-01-01T00:00:00.000Z",
      completedAt: "2026-01-01T00:01:00.000Z",
      traceId: "trace-001"
    };
    const alreadyValidRun = {
      id: "run-valid-002",
      workflow: "context_pack_build" as const,
      status: "succeeded" as const,
      providerId: "local-workflow-runtime" as const,
      entityType: "interview_session" as const,
      entityId: "session-def",
      inputSummary: "valid input",
      outputSummary: "valid output",
      startedAt: "2026-02-01T00:00:00.000Z",
      traceId: "trace-002"
    };

    const normalized = normalizeProductState({
      ...state,
      workflowRuns: [legacyRun, alreadyValidRun]
    });

    // legacy entry is migrated
    expect(normalized.workflowRuns[0].providerId).toBe("local-workflow-runtime");
    // other fields on the migrated run are preserved
    expect(normalized.workflowRuns[0].id).toBe("run-legacy-001");
    expect(normalized.workflowRuns[0].workflow).toBe("interview_preparation");
    expect(normalized.workflowRuns[0].status).toBe("succeeded");
    expect(normalized.workflowRuns[0].traceId).toBe("trace-001");
    expect(normalized.workflowRuns[0].entityId).toBe("session-abc");

    // already-valid entry is unchanged
    expect(normalized.workflowRuns[1].providerId).toBe("local-workflow-runtime");
    expect(normalized.workflowRuns[1].id).toBe("run-valid-002");

    // empty workflowRuns does not crash
    expect(normalizeProductState({ ...state, workflowRuns: [] }).workflowRuns).toEqual([]);

    // missing workflowRuns falls back to default (empty array)
    const { workflowRuns: _omitted, ...stateWithoutRuns } = state;
    expect(normalizeProductState(stateWithoutRuns).workflowRuns).toEqual([]);
  });
});
