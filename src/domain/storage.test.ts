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

  it("v1->v2 migration preserves all existing theme content (no data loss)", () => {
    const v1 = createInitialProductState();
    const v1Themes = v1.themes.map(({ kind, pinned, createdAt, lastActiveAt, ...rest }) => rest);
    const normalized = normalizeProductState({ ...v1, themes: v1Themes });

    // 现有字段必须逐一无损
    expect(normalized.themes.map((t) => t.name)).toEqual(v1.themes.map((t) => t.name));
    expect(normalized.themes.map((t) => t.summary)).toEqual(v1.themes.map((t) => t.summary));
    expect(normalized.themes.map((t) => t.maturity)).toEqual(v1.themes.map((t) => t.maturity));
    expect(normalized.themes.map((t) => t.appearances)).toEqual(v1.themes.map((t) => t.appearances));
    // 其它资产数组不受影响
    expect(normalized.notes).toHaveLength(v1.notes.length);
    expect(normalized.points[0].relatedThemeIds).toEqual(v1.points[0].relatedThemeIds);
  });

  it("re-normalizing an already-v2 state is idempotent", () => {
    const once = normalizeProductState(createInitialProductState());
    const twice = normalizeProductState(once);
    expect(twice.schemaVersion).toBe(2);
    expect(twice.themes[0].kind).toBe(once.themes[0].kind);
    expect(twice.themes[0].pinned).toBe(once.themes[0].pinned);
  });

  it("P1-24: prunes dangling relatedThemeIds across all asset types, preserves valid refs", () => {
    const state = createInitialProductState();
    const validThemeId = state.themes[0]?.id ?? "theme-real";
    const ghostId = "theme-ghost-does-not-exist";

    const normalized = normalizeProductState({
      ...state,
      themes: state.themes,
      points: [
        {
          id: "pt-1",
          title: "test point",
          content: "content",
          status: "active" as const,
          confidence: "AI 推断" as const,
          evidence: [],
          relatedThemeIds: [validThemeId, ghostId],
          important: false,
          updatedAt: "2026-06-19T00:00:00.000Z"
        }
      ],
      questions: [
        {
          id: "q-1",
          question: "test question",
          whyImportant: "why",
          status: "active" as const,
          appearances: 1,
          relatedThemeIds: [ghostId],
          nextPrompt: "",
          important: false,
          updatedAt: "2026-06-19T00:00:00.000Z"
        }
      ],
    });

    // 合法 id 保留，悬空 id 被剔除
    expect(normalized.points[0].relatedThemeIds).toEqual([validThemeId]);
    // 全部悬空时结果为空数组
    expect(normalized.questions[0].relatedThemeIds).toEqual([]);
  });

  it("P2-18: backfills missing reviewScore/reviewSignals on memoryCandidates via withMemoryCandidateReview", () => {
    const state = createInitialProductState();
    // 构造一个旧格式候选：缺少 reviewScore / reviewSignals
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const legacyCandidate: any = {
      id: "mc-old",
      text: "候选记忆文本",
      status: "pending",
      sourceType: "interview_session",
      sourceId: "session-001",
      evidenceQuote: "原话引用很长超过十二字符",
      reason: "待用户确认",
      sensitivity: "normal",
      createdAt: "2026-06-19T00:00:00.000Z"
      // 故意不提供 reviewScore / reviewSignals
    };
    const normalized = normalizeProductState({
      ...state,
      memoryCandidates: [legacyCandidate]
    });

    const candidate = normalized.memoryCandidates[0];
    expect(typeof candidate.reviewScore).toBe("number");
    expect(candidate.reviewScore).toBeGreaterThanOrEqual(0);
    expect(candidate.reviewScore).toBeLessThanOrEqual(100);
    expect(Array.isArray(candidate.reviewSignals)).toBe(true);
    expect(candidate.reviewSignals.length).toBeGreaterThan(0);
  });

  it("P2-19: normalizeImportSource — empty searchBriefId is normalized to undefined; non-empty value is preserved", () => {
    const state = createInitialProductState();
    const baseImportSource = {
      id: "src-001",
      title: "测试资料",
      sourceType: "pdf" as const,
      content: "内容",
      status: "chunked" as const,
      sensitivity: "normal" as const,
      chunkIds: ["chunk-1"],
      createdAt: "2026-06-19T00:00:00.000Z",
      updatedAt: "2026-06-19T00:00:00.000Z"
    };

    // 旧数据：searchBriefId 为空串 → normalize 后应归一为 undefined（字段缺失）
    const withEmptyId = { ...baseImportSource, searchBriefId: "" };
    const normalized1 = normalizeProductState({ ...state, importSources: [withEmptyId] });
    expect(normalized1.importSources[0].searchBriefId).toBeUndefined();

    // 非空值保留
    const withRealId = { ...baseImportSource, id: "src-002", searchBriefId: "brief-abc" };
    const normalized2 = normalizeProductState({ ...state, importSources: [withRealId] });
    expect(normalized2.importSources[0].searchBriefId).toBe("brief-abc");

    // 字段缺失时同样归一为 undefined
    const withoutId = { ...baseImportSource, id: "src-003" };
    const normalized3 = normalizeProductState({ ...state, importSources: [withoutId] });
    expect(normalized3.importSources[0].searchBriefId).toBeUndefined();
  });

  describe("P2-11: defaultVoice validation", () => {
    const VALID_VOICES = ["longanyang", "longanhuan"];

    it("createInitialProductState returns a valid defaultVoice (longanyang or longanhuan)", () => {
      const state = createInitialProductState();
      expect(VALID_VOICES).toContain(state.systemConfig.voice.defaultVoice);
    });

    it("normalizeProductState falls back illegal defaultVoice to longanyang", () => {
      const state = createInitialProductState();
      const normalized = normalizeProductState({
        ...state,
        systemConfig: {
          ...state.systemConfig,
          voice: {
            ...state.systemConfig.voice,
            defaultVoice: "warm-interviewer" as string
          }
        }
      });
      expect(VALID_VOICES).toContain(normalized.systemConfig.voice.defaultVoice);
      expect(normalized.systemConfig.voice.defaultVoice).toBe("longanyang");
    });

    it("normalizeProductState preserves a valid defaultVoice", () => {
      const state = createInitialProductState();
      const normalized = normalizeProductState({
        ...state,
        systemConfig: {
          ...state.systemConfig,
          voice: {
            ...state.systemConfig.voice,
            defaultVoice: "longanhuan"
          }
        }
      });
      expect(normalized.systemConfig.voice.defaultVoice).toBe("longanhuan");
    });

    // 修复点：custom 克隆声音必须原样保留，不被白名单清掉
    it("normalizeProductState preserves custom enrolled voice ID (custom-voice-abc123)", () => {
      const state = createInitialProductState();
      const normalized = normalizeProductState({
        ...state,
        systemConfig: {
          ...state.systemConfig,
          voice: {
            ...state.systemConfig.voice,
            defaultVoice: "custom-voice-abc123" as string
          }
        }
      });
      expect(normalized.systemConfig.voice.defaultVoice).toBe("custom-voice-abc123");
    });

    it("normalizeProductState preserves cosyvoice-clone style custom voice ID", () => {
      const state = createInitialProductState();
      const normalized = normalizeProductState({
        ...state,
        systemConfig: {
          ...state.systemConfig,
          voice: {
            ...state.systemConfig.voice,
            defaultVoice: "cosyvoice-clone-xyz789" as string
          }
        }
      });
      expect(normalized.systemConfig.voice.defaultVoice).toBe("cosyvoice-clone-xyz789");
    });

    it("normalizeProductState: podcastVoice calm-host (legacy invalid) is corrected to longanhuan", () => {
      const state = createInitialProductState();
      const normalized = normalizeProductState({
        ...state,
        systemConfig: {
          ...state.systemConfig,
          voice: {
            ...state.systemConfig.voice,
            podcastVoice: "calm-host" as string
          }
        }
      });
      expect(normalized.systemConfig.voice.podcastVoice).toBe("longanhuan");
    });

    it("normalizeProductState: podcastVoice custom clone is preserved", () => {
      const state = createInitialProductState();
      const normalized = normalizeProductState({
        ...state,
        systemConfig: {
          ...state.systemConfig,
          voice: {
            ...state.systemConfig.voice,
            podcastVoice: "custom-voice-podcast-001" as string
          }
        }
      });
      expect(normalized.systemConfig.voice.podcastVoice).toBe("custom-voice-podcast-001");
    });

    it("custom voice ID is idempotent across multiple normalizations", () => {
      const state = createInitialProductState();
      const withCustom = {
        ...state,
        systemConfig: {
          ...state.systemConfig,
          voice: {
            ...state.systemConfig.voice,
            defaultVoice: "custom-voice-abc123" as string
          }
        }
      };
      const once = normalizeProductState(withCustom);
      const twice = normalizeProductState(once);
      expect(once.systemConfig.voice.defaultVoice).toBe("custom-voice-abc123");
      expect(twice.systemConfig.voice.defaultVoice).toBe("custom-voice-abc123");
    });
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

  // P2-23: draft → active migration
  describe("InterviewSession draft→active migration", () => {
    it("migrates sessions with status='draft' to 'active' on normalize", () => {
      const state = createInitialProductState();
      const stateWithDraftSession = {
        ...state,
        sessions: [
          {
            id: "sess-001",
            mode: "daily",
            strength: "standard",
            status: "draft" as string,
            title: "旧 draft 会话",
            card: { title: "卡片", whyNow: "", suggestedOpening: "", historyReferences: [], potentialTension: "", suggestedPerspectives: [], likelyOutputs: [] },
            guide: {
              topicHint: "", dailyBrief: { suggestedTopic: "", openingQuestion: "", contextNote: "" },
              perspectiveCoverage: {}, missingPerspectives: [], recommendedPerspectives: [],
              perspectiveRationale: "", relevantMemories: [], graphReferences: [],
              opinionEvolution: [], statedPositions: [], openDebts: [], blindspotCandidates: [],
              knowledgeFragments: [], suggestedOpening: "", strategyChecklist: []
            },
            turns: [],
            startedAt: "2025-01-01T00:00:00.000Z"
          }
        ]
      };

      const normalized = normalizeProductState(stateWithDraftSession);
      expect(normalized.sessions[0].status).toBe("active");
    });

    it("does not alter sessions that are already 'active' or 'completed'", () => {
      const state = createInitialProductState();
      const guide = {
        topicHint: "", dailyBrief: { suggestedTopic: "", openingQuestion: "", contextNote: "" },
        perspectiveCoverage: {}, missingPerspectives: [], recommendedPerspectives: [],
        perspectiveRationale: "", relevantMemories: [], graphReferences: [],
        opinionEvolution: [], statedPositions: [], openDebts: [], blindspotCandidates: [],
        knowledgeFragments: [], suggestedOpening: "", strategyChecklist: []
      };
      const card = { title: "卡片", whyNow: "", suggestedOpening: "", historyReferences: [], potentialTension: "", suggestedPerspectives: [], likelyOutputs: [] };

      const stateWithSessions = {
        ...state,
        sessions: [
          { id: "sess-active", mode: "daily", strength: "standard", status: "active", title: "进行中", card, guide, turns: [], startedAt: "2025-01-01T00:00:00.000Z" },
          { id: "sess-completed", mode: "daily", strength: "standard", status: "completed", title: "已结束", card, guide, turns: [], startedAt: "2025-01-01T00:00:00.000Z", completedAt: "2025-01-01T01:00:00.000Z" }
        ]
      };

      const normalized = normalizeProductState(stateWithSessions);
      expect(normalized.sessions[0].status).toBe("active");
      expect(normalized.sessions[1].status).toBe("completed");
    });

    it("is idempotent: normalizing twice does not corrupt session status", () => {
      const state = createInitialProductState();
      const guide = {
        topicHint: "", dailyBrief: { suggestedTopic: "", openingQuestion: "", contextNote: "" },
        perspectiveCoverage: {}, missingPerspectives: [], recommendedPerspectives: [],
        perspectiveRationale: "", relevantMemories: [], graphReferences: [],
        opinionEvolution: [], statedPositions: [], openDebts: [], blindspotCandidates: [],
        knowledgeFragments: [], suggestedOpening: "", strategyChecklist: []
      };
      const card = { title: "卡片", whyNow: "", suggestedOpening: "", historyReferences: [], potentialTension: "", suggestedPerspectives: [], likelyOutputs: [] };

      const stateWithDraftSession = {
        ...state,
        sessions: [
          { id: "sess-001", mode: "daily", strength: "standard", status: "draft" as string, title: "旧 draft", card, guide, turns: [], startedAt: "2025-01-01T00:00:00.000Z" }
        ]
      };

      const once = normalizeProductState(stateWithDraftSession);
      const twice = normalizeProductState(once);
      expect(twice.sessions[0].status).toBe("active");
    });
  });

  describe("v2 软标签 — importSources.relatedThemeIds normalize + prune", () => {
    const baseSource = {
      id: "src-label-1",
      title: "资料",
      sourceType: "text" as const,
      content: "内容",
      status: "chunked" as const,
      sensitivity: "normal" as const,
      chunkIds: [],
      createdAt: "2026-06-06T00:00:00.000Z",
      updatedAt: "2026-06-06T00:00:00.000Z"
    };

    it("旧数据无 relatedThemeIds 字段 → normalize 后为 []", () => {
      const state = createInitialProductState();
      const normalized = normalizeProductState({
        ...state,
        importSources: [baseSource] // 没有 relatedThemeIds
      });
      expect(normalized.importSources[0].relatedThemeIds).toEqual([]);
    });

    it("含悬空 themeId 的 source → prune 后被剔除", () => {
      const state = createInitialProductState();
      const validId = state.themes[0]?.id ?? "theme-control";
      const ghostId = "theme-ghost-xyz";
      const normalized = normalizeProductState({
        ...state,
        importSources: [
          { ...baseSource, relatedThemeIds: [validId, ghostId] }
        ]
      });
      expect(normalized.importSources[0].relatedThemeIds).toEqual([validId]);
    });

    it("全部悬空时 relatedThemeIds 为 []", () => {
      const state = createInitialProductState();
      const normalized = normalizeProductState({
        ...state,
        importSources: [
          { ...baseSource, id: "src-label-2", relatedThemeIds: ["theme-ghost-a", "theme-ghost-b"] }
        ]
      });
      expect(normalized.importSources[0].relatedThemeIds).toEqual([]);
    });
  });
});
