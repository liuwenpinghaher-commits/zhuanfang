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
});
