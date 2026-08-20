import { describe, expect, it } from "vitest";
import { createEmptyProductState, createInitialProductState } from "./engine";
import { isPristineDemoState, normalizeProductState } from "./storage";

describe("P3-11: isPristineDemoState 灾备指纹", () => {
  it("首次运行的 demo 种子判为 pristine(revision 不影响判定)", () => {
    expect(isPristineDemoState(createInitialProductState())).toBe(true);
    // 空库重启返回的 demo 可能带任意 revision——内容签名忽略 revision,仍须命中。
    expect(isPristineDemoState({ ...createInitialProductState(), revision: 42 })).toBe(true);
  });

  it("清空后的空态、以及有真实改动的态都不判为 pristine", () => {
    expect(isPristineDemoState(createEmptyProductState())).toBe(false);
    const edited = createInitialProductState();
    edited.profile.name = "真实用户";
    expect(isPristineDemoState(edited)).toBe(false);
  });
});

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
      label: "Qwen-Audio TTS"
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
      planningModel: "qwen3.6-flash",
      interviewModel: "qwen3.7-plus",
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
    // 模拟 v1 数据：剥掉 v2 新增字段（kind/pinned/lastActiveAt 已删；只剩 createdAt）
    const v1Themes = v1.themes.map(({ createdAt, ...rest }) => rest);
    const normalized = normalizeProductState({ ...v1, themes: v1Themes, schemaVersion: undefined });

    expect(normalized.schemaVersion).toBe(2);
    expect(normalized.themes[0].createdAt).toBe(normalized.themes[0].updatedAt);
  });

  it("v1->v2 migration preserves all existing theme content (no data loss)", () => {
    const v1 = createInitialProductState();
    const v1Themes = v1.themes.map(({ createdAt, ...rest }) => rest);
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
    expect(twice.themes[0].createdAt).toBe(once.themes[0].createdAt);
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
    const VALID_VOICES = ["longanlingxin", "longanqian", "longanyang", "longanhuan"];

    it("createInitialProductState returns a valid defaultVoice", () => {
      const state = createInitialProductState();
      expect(VALID_VOICES).toContain(state.systemConfig.voice.defaultVoice);
    });

    it("normalizeProductState falls back illegal defaultVoice to longanlingxin", () => {
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
      expect(normalized.systemConfig.voice.defaultVoice).toBe("longanlingxin");
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

  describe("R3 外部调研合并", () => {
    it("丢弃历史 intel 数据(intelTasks/intelItems 不再是字段)", () => {
      const state = createInitialProductState();
      const legacy = {
        ...state,
        intelTasks: [{ id: "t1", name: "监控", keywords: ["AI"] }],
        intelItems: [{ id: "i1", taskId: "t1", relevance: 50 }]
      } as unknown as Parameters<typeof normalizeProductState>[0];
      const normalized = normalizeProductState(legacy) as unknown as Record<string, unknown>;
      expect(normalized.intelTasks).toBeUndefined();
      expect(normalized.intelItems).toBeUndefined();
      expect(normalized.themes).toBeDefined();
      expect(normalized.searchBriefs).toBeDefined();
    });

    it("searchBrief 的 tracked 标志往返保留", () => {
      const state = createInitialProductState();
      const brief = { ...(state.searchBriefs[0] ?? {}), id: "brief-tracked", topic: "AI agent", tracked: true };
      const normalized = normalizeProductState({ ...state, searchBriefs: [brief as never] });
      expect(normalized.searchBriefs[0].tracked).toBe(true);
    });
  });

  describe("R4 记忆简化", () => {
    it("themes: 清除历史死字段 kind/pinned/lastActiveAt(不随 spread 透传)", () => {
      const state = createInitialProductState();
      const legacyTheme = {
        ...state.themes[0],
        kind: "subject",
        pinned: true,
        lastActiveAt: "2026-01-01T00:00:00.000Z"
      };
      const normalized = normalizeProductState({ ...state, themes: [legacyTheme as never] });
      const migrated = normalized.themes[0] as unknown as Record<string, unknown>;
      expect(migrated.kind).toBeUndefined();
      expect(migrated.pinned).toBeUndefined();
      expect(migrated.lastActiveAt).toBeUndefined();
      // 真实字段无损
      expect(normalized.themes[0].name).toBe(state.themes[0].name);
    });

    // M1 数据迁移:历史 state.memoryEdges → record.relatedThemeIds(无损折入,memoryEdges 字段消失)。
    function memRec(id: string): import("./types").MemoryRecord {
      return { id, text: "记忆", status: "confirmed", sourceType: "profile", sourceId: "p", evidenceQuote: "", sensitivity: "normal", createdAt: "2026-06-01T00:00:00.000Z", updatedAt: "2026-06-01T00:00:00.000Z" };
    }

    it("M1 迁移:历史 rich edge 指向主题的归属折入 record.relatedThemeIds,非主题边丢弃,memoryEdges 字段消失", () => {
      const state = createInitialProductState();
      const themeId = state.themes[0]?.id ?? "theme-control";
      const legacyEdges = [
        { id: "e1", fromMemoryRecordId: "r1", targetType: "long_term_theme", targetId: themeId, relation: "supports", weight: 3 },
        { id: "e2", fromMemoryRecordId: "r1", targetType: "point", targetId: "p1", relation: "contradicts", weight: 1 }
      ];
      const normalized = normalizeProductState({ ...state, memoryRecords: [memRec("r1")], memoryEdges: legacyEdges as never });
      expect(normalized.memoryRecords.find((r) => r.id === "r1")?.relatedThemeIds).toEqual([themeId]);
      // memoryEdges 字段从持久化状态彻底消失
      expect((normalized as unknown as Record<string, unknown>).memoryEdges).toBeUndefined();
    });

    it("M1 迁移:简化形边折入 record.relatedThemeIds(指向真实主题),幂等无损", () => {
      const state = createInitialProductState();
      const themeId = state.themes[0]?.id ?? "theme-control";
      const simplified = [{ id: "e1", fromMemoryRecordId: "r1", themeId, createdAt: "2026-06-01T00:00:00.000Z" }];
      const once = normalizeProductState({ ...state, memoryRecords: [memRec("r1")], memoryEdges: simplified as never });
      expect(once.memoryRecords.find((r) => r.id === "r1")?.relatedThemeIds).toEqual([themeId]);
      // 幂等:把一轮迁移后的结果(record 已带 relatedThemeIds、无 memoryEdges)再 normalize 一次,归属不变、不重复
      const twice = normalizeProductState(once as never);
      expect(twice.memoryRecords.find((r) => r.id === "r1")?.relatedThemeIds).toEqual([themeId]);
    });

    it("M1 迁移:record 已有 relatedThemeIds 时与历史边取并集(去重无损)", () => {
      const state = createInitialProductState();
      const themeA = state.themes[0]?.id ?? "theme-a";
      const recWithExisting = { ...memRec("r1"), relatedThemeIds: [themeA] };
      // 历史边同时含已存在的 themeA(去重)与悬空 ghost(后续 prune 裁掉)
      const legacyEdges = [
        { fromMemoryRecordId: "r1", themeId: themeA },
        { fromMemoryRecordId: "r1", themeId: "theme-ghost" }
      ];
      const normalized = normalizeProductState({ ...state, memoryRecords: [recWithExisting], memoryEdges: legacyEdges as never });
      // themeA 不重复;ghost 被 pruneDanglingThemeRefs 裁掉
      expect(normalized.memoryRecords.find((r) => r.id === "r1")?.relatedThemeIds).toEqual([themeA]);
    });
  });

  describe("R4: memoryCandidates 有界裁剪", () => {
    function makeCandidate(id: string, status: "pending" | "approved" | "rejected", dayOffset: number) {
      return {
        id,
        text: `candidate ${id}`,
        status,
        sourceType: "interview_session" as const,
        sourceId: "session-1",
        evidenceQuote: "quote",
        reason: "reason",
        sensitivity: "normal" as const,
        reviewScore: 80,
        reviewSignals: ["signal"],
        createdAt: new Date(Date.UTC(2026, 0, dayOffset + 1)).toISOString()
      };
    }

    it("超过 200 条 approved 候选时只保留最近 200 条", () => {
      const state = createInitialProductState();
      const approved = Array.from({ length: 210 }, (_, i) =>
        makeCandidate(`approved-${i + 1}`, "approved", i)
      );
      const normalized = normalizeProductState({ ...state, memoryCandidates: approved as never });
      const approvedResult = normalized.memoryCandidates.filter((c) => c.status === "approved");
      expect(approvedResult.length).toBeLessThanOrEqual(200);
    });

    it("所有 pending 候选无论数量全部保留", () => {
      const state = createInitialProductState();
      const pending = Array.from({ length: 50 }, (_, i) =>
        makeCandidate(`pending-${i + 1}`, "pending", i)
      );
      const approved = Array.from({ length: 210 }, (_, i) =>
        makeCandidate(`approved-${i + 1}`, "approved", i + 50)
      );
      const normalized = normalizeProductState({
        ...state,
        memoryCandidates: [...pending, ...approved] as never
      });
      const pendingResult = normalized.memoryCandidates.filter((c) => c.status === "pending");
      const approvedResult = normalized.memoryCandidates.filter((c) => c.status !== "pending");
      expect(pendingResult.length).toBe(50);
      expect(approvedResult.length).toBeLessThanOrEqual(200);
    });

    it("保留的是最近的 200 条已审候选（createdAt 最大）", () => {
      const state = createInitialProductState();
      // 210 条 approved，day 0..209；最近 200 条应为 day 10..209
      const approved = Array.from({ length: 210 }, (_, i) =>
        makeCandidate(`approved-${i + 1}`, "approved", i)
      );
      const normalized = normalizeProductState({ ...state, memoryCandidates: approved as never });
      const ids = normalized.memoryCandidates.map((c) => c.id);
      // 最旧 10 条(approved-1..approved-10)应被裁掉，最新的应保留
      expect(ids).toContain("approved-210");
      expect(ids).toContain("approved-11");
      expect(ids).not.toContain("approved-1");
      expect(ids).not.toContain("approved-10");
    });

    it("候选不足 200 条时全部保留（幂等）", () => {
      const state = createInitialProductState();
      const candidates = [
        makeCandidate("p1", "pending", 0),
        makeCandidate("a1", "approved", 1),
        makeCandidate("r1", "rejected", 2)
      ];
      const normalized = normalizeProductState({ ...state, memoryCandidates: candidates as never });
      expect(normalized.memoryCandidates.length).toBe(3);
    });

    it("部分候选缺少 createdAt（历史脏数据）时 normalize 不崩、approved ≤ 200、pending 全留", () => {
      const state = createInitialProductState();
      // 50 pending（有 createdAt）+ 180 approved（部分缺 createdAt）
      const pending = Array.from({ length: 50 }, (_, i) => ({
        id: `pd-${i}`,
        text: `pending ${i}`,
        status: "pending" as const,
        sourceType: "interview_session" as const,
        sourceId: "s1",
        evidenceQuote: "quote",
        reason: "reason",
        sensitivity: "normal" as const,
        reviewScore: 60,
        reviewSignals: [],
        createdAt: new Date(Date.UTC(2026, 0, i + 1)).toISOString()
      }));
      const approvedWithMissingCreatedAt = Array.from({ length: 180 }, (_, i) => ({
        id: `ap-${i}`,
        text: `approved ${i}`,
        status: i % 3 === 0 ? ("approved" as const) : ("rejected" as const),
        sourceType: "interview_session" as const,
        sourceId: "s1",
        evidenceQuote: "quote",
        reason: "reason",
        sensitivity: "normal" as const,
        reviewScore: 75,
        reviewSignals: [],
        // 每隔 3 个故意缺 createdAt（历史脏数据）
        ...(i % 3 !== 0 ? { createdAt: new Date(Date.UTC(2026, 1, i + 1)).toISOString() } : {})
      }));

      const normalized = normalizeProductState({
        ...state,
        memoryCandidates: [...pending, ...approvedWithMissingCreatedAt] as never
      });

      const pendingResult = normalized.memoryCandidates.filter((c) => c.status === "pending");
      const reviewedResult = normalized.memoryCandidates.filter((c) => c.status !== "pending");
      // pending 全部保留
      expect(pendingResult.length).toBe(50);
      // 已审 ≤ 200（总量 180 < 200 故全留，重点验证不崩）
      expect(reviewedResult.length).toBeLessThanOrEqual(200);
      // 不崩即通过（无异常抛出）
    });
  });

  describe("M1 迁移:非主题历史边丢弃(无归属折入)", () => {
    function memRec(id: string): import("./types").MemoryRecord {
      return { id, text: "记忆", status: "confirmed", sourceType: "profile", sourceId: "p", evidenceQuote: "", sensitivity: "normal", createdAt: "2026-06-01T00:00:00.000Z", updatedAt: "2026-06-01T00:00:00.000Z" };
    }

    it("全部为非主题边时无任何主题归属折入 record", () => {
      const state = createInitialProductState();
      const nonThemeEdges = [
        { id: "e1", fromMemoryRecordId: "r1", targetType: "point", targetId: "p1" },
        { id: "e2", fromMemoryRecordId: "r2", targetType: "question", targetId: "q1" }
      ];
      const normalized = normalizeProductState({ ...state, memoryRecords: [memRec("r1"), memRec("r2")], memoryEdges: nonThemeEdges as never });
      expect(normalized.memoryRecords.find((r) => r.id === "r1")?.relatedThemeIds ?? []).toEqual([]);
      expect(normalized.memoryRecords.find((r) => r.id === "r2")?.relatedThemeIds ?? []).toEqual([]);
    });

    it("混合边时只把 long_term_theme 边折入对应 record,非主题边被丢弃", () => {
      const state = createInitialProductState();
      const themeId = state.themes[0]?.id ?? "theme-x";
      const mixed = [
        { id: "e1", fromMemoryRecordId: "r1", targetType: "long_term_theme", targetId: themeId },
        { id: "e2", fromMemoryRecordId: "r2", targetType: "point", targetId: "p-xyz" }
      ];
      const normalized = normalizeProductState({ ...state, memoryRecords: [memRec("r1"), memRec("r2")], memoryEdges: mixed as never });
      expect(normalized.memoryRecords.find((r) => r.id === "r1")?.relatedThemeIds).toEqual([themeId]);
      expect(normalized.memoryRecords.find((r) => r.id === "r2")?.relatedThemeIds ?? []).toEqual([]);
    });
  });

  describe("legacy.readings 清除", () => {
    it("历史 readings 字段经 spread 透传后被显式删除", () => {
      const state = createInitialProductState();
      const legacy = {
        ...state,
        readings: [{ id: "r1", title: "旧阅读记录", url: "https://example.com" }]
      } as unknown as Parameters<typeof normalizeProductState>[0];
      const normalized = normalizeProductState(legacy) as unknown as Record<string, unknown>;
      expect(normalized.readings).toBeUndefined();
    });
  });

  describe("R1-F2:DEFAULT '' string 列 + array<string> 列畸形值钳制(P0-3 wedge 防御)", () => {
    it("note 的 keyQuote(null)/saidTrack(非数组)/learnedTrack(含非string)被钳成 SurrealDB 可持久值", () => {
      const state = createInitialProductState();
      // 这些列 SCHEMAFULL 为 TYPE string / array<string> 且 DEFAULT '';畸形值(null/数字/非数组)
      // 此前 clampPersistableEnums 的 str() 只兜"无 DEFAULT 必填 string",漏了它们 → 直落权威库 coerce
      // 失败 → persist wedge(基线冻结,所有后续写永不落库)。R1-F2 扩展 str/strArr 兜底覆盖。
      const dirty = {
        ...state,
        notes: [{
          id: "n1", sessionId: "se_x", title: "标题", summary: "概要",
          keyQuote: null,
          saidTrack: "不是数组",
          learnedTrack: [1, 2, "真话"],
          nextQuestions: [],
          createdAt: "2026-06-27T00:00:00.000Z"
        }]
      };
      const n = normalizeProductState(dirty as never).notes.find((x) => x.id === "n1");
      expect(n).toBeDefined();
      expect(n?.keyQuote).toBe("");           // null → '' (TYPE string 可持久)
      expect(n?.saidTrack).toEqual([]);       // 非数组 → []
      expect(n?.learnedTrack).toEqual(["真话"]);  // 过滤非 string 元素
    });

    it("theme 的 summary(数字)/representativeQuote(null)被钳成 '' (DEFAULT '' string 列)", () => {
      const state = createInitialProductState();
      const themes = state.themes.map((t, i) => (i === 0 ? { ...t, summary: 123, representativeQuote: null } : t));
      const t0 = normalizeProductState({ ...state, themes: themes as never }).themes[0];
      expect(t0.summary).toBe("");
      expect(t0.representativeQuote).toBe("");
    });
  });

  describe("N-01:数值/布尔 typed core 列坏值钳制(P0-3/R1-F2 家族的 int/option<int>/bool 变体)", () => {
    // 背景:SurrealDB SCHEMAFULL `TYPE int/option<int>/bool` core 列被非法值 coerce 失败 → persist
    // 确定性 wedge 权威库(mem:// 真库 spike 实证 '3'/3.7/null/NONE/'yes' 各自报错)。clampPersistableEnums
    // 此前只兜 string/array<string>/枚举,漏了数值/bool。以下逐列覆盖六种坏形态(字符串数字/null/缺字段/
    // 负数/小数/非法类型)+ 合法值不破坏。
    const TS = "2026-06-27T00:00:00.000Z";

    it("question.appearances(TYPE int)六种坏形态 → 合法非负整数;合法值不破坏", () => {
      const state = createInitialProductState();
      const norm = (appearances: unknown) =>
        normalizeProductState({
          ...state,
          questions: [{ id: "qx", question: "q", whyImportant: "", status: "开放", appearances, relatedThemeIds: [], nextPrompt: "", important: false, updatedAt: TS }] as never
        }).questions.find((q) => q.id === "qx")!.appearances;
      expect(norm("3")).toBe(0);        // 字符串数字 → 0(fail-closed:不 parseFloat 救活)
      expect(norm(null)).toBe(0);       // null → 0
      expect(norm(undefined)).toBe(0);  // 缺字段 → 0(专治 UPSERT 覆盖 "found NONE")
      expect(norm(-2)).toBe(0);         // 负数 → 0(出现计数语义无负)
      expect(norm(3.7)).toBe(3);        // 小数 → Math.floor 3
      expect(norm(true)).toBe(0);       // 非法类型(bool)→ 0
      expect(norm(5)).toBe(5);          // 合法值原样保留
    });

    it("theme.appearances(TYPE int)六种坏形态 → 合法非负整数;合法值不破坏", () => {
      const state = createInitialProductState();
      const norm = (appearances: unknown) =>
        normalizeProductState({
          ...state,
          themes: [{ id: "thx", name: "t", summary: "", maturity: "萌芽", representativeQuote: "", appearances, nextQuestion: "", updatedAt: TS }] as never
        }).themes.find((t) => t.id === "thx")!.appearances;
      expect(norm("5")).toBe(0);
      expect(norm(null)).toBe(0);
      expect(norm(undefined)).toBe(0);
      expect(norm(-9)).toBe(0);
      expect(norm(2.9)).toBe(2);
      expect(norm(false)).toBe(0);
      expect(norm(7)).toBe(7);
    });

    it("memory.importance(TYPE option<int>)坏形态 → 整数保留、其余 undefined(toRecord 跳过 → NONE 合法)", () => {
      const state = createInitialProductState();
      const norm = (importance: unknown) =>
        normalizeProductState({
          ...state,
          memoryRecords: [{ id: "mx", text: "x", status: "confirmed", sourceType: "profile", sourceId: "s", evidenceQuote: "", sensitivity: "normal", importance, createdAt: TS, updatedAt: TS }] as never
        }).memoryRecords.find((m) => m.id === "mx")!.importance;
      expect(norm("5")).toBeUndefined();     // 字符串数字 → undefined(fail-closed 不落库)
      expect(norm(null)).toBeUndefined();    // null → undefined(spike:null 会 wedge option<int>)
      expect(norm(undefined)).toBeUndefined(); // 缺字段 → undefined(本就 NONE)
      expect(norm(7.9)).toBe(7);             // 小数 → Math.floor 7
      expect(norm(-3)).toBe(-3);             // 负整数保留(option<int> 无 ASSERT/下界,不 wedge;照任务口径不钳负)
      expect(norm(true)).toBeUndefined();    // 非法类型 → undefined
      expect(norm(8)).toBe(8);               // 合法值原样保留
    });

    it("point.important(TYPE bool)非严格 true 一律 false(=== true,镜像 config_version.active)", () => {
      const state = createInitialProductState();
      const norm = (important: unknown) =>
        normalizeProductState({
          ...state,
          points: [{ id: "px", title: "t", content: "c", status: "临时想法", confidence: "待验证", evidence: [], relatedThemeIds: [], important, updatedAt: TS }] as never
        }).points.find((p) => p.id === "px")!.important;
      expect(norm("yes")).toBe(false);       // 字符串 → false(spike:'yes' 会 wedge bool 列)
      expect(norm(1)).toBe(false);           // 数字 → false
      expect(norm(null)).toBe(false);        // null → false
      expect(norm(undefined)).toBe(false);   // 缺字段 → false
      expect(norm("true")).toBe(false);      // 字符串 "true" → false(只认真 boolean)
      expect(norm(true)).toBe(true);         // 合法 true 原样保留
    });

    it("backfillPointDefaults 与 important clamp 协调不打架:缺省/坏值最终恒合法 bool,evidence/relatedThemeIds 仍兜底", () => {
      const state = createInitialProductState();
      const p = normalizeProductState({
        ...state,
        // important 坏值 + evidence/relatedThemeIds 缺失:验证 backfill(补数组)与 clamp(定 bool)各司其职。
        points: [{ id: "pz", title: "t", content: "c", status: "临时想法", confidence: "待验证", important: "yes", updatedAt: TS }] as never
      }).points.find((x) => x.id === "pz")!;
      expect(p.important).toBe(false);          // clamp(=== true)最终权威,坏值 → false
      expect(p.evidence).toEqual([]);           // backfillPointDefaults 仍补齐(未被 clamp 影响)
      expect(p.relatedThemeIds).toEqual([]);    // 同上
    });
  });

  describe("N-01-embedding:array<float> 向量列坏值/维度钳制(memory.embedding / rag_chunk.embedding)", () => {
    // 背景:embedding 是 `TYPE option<array<float>>` + HNSW DIMENSION 1024 的 core 列。mem:// 真库 spike 实证
    // null/非数组/含非数值元素 → 类型 coerce 失败 wedge;任意非 1024 维有限数组 → HNSW "Incorrect vector
    // dimension" wedge。optFloatArray fail-closed:仅「1024 维 ∧ 全有限数值」保留,否则 → undefined(NONE)。
    const TS = "2026-06-27T00:00:00.000Z";
    const valid1024 = Array.from({ length: 1024 }, (_, i) => (i % 7) * 0.001);

    const normMemEmb = (embedding: unknown) =>
      normalizeProductState({
        ...createInitialProductState(),
        memoryRecords: [{ id: "mx", text: "x", status: "confirmed", sourceType: "profile", sourceId: "s", evidenceQuote: "", sensitivity: "normal", createdAt: TS, updatedAt: TS, embedding }] as never
      }).memoryRecords.find((m) => m.id === "mx")!.embedding;

    const normRagEmb = (embedding: unknown) => {
      const state = createInitialProductState();
      const norm = normalizeProductState({
        ...state,
        // rag_chunk 的 sourceId 须指向存在的来源,否则 pruneDanglingContainmentRefs 会先把它裁掉(测不到 embedding)。
        importSources: [...state.importSources, { id: "src-x", title: "t", content: "c", sourceType: "text", status: "chunked", sensitivity: "normal", createdAt: TS }] as never,
        ragChunks: [{ id: "rx", sourceId: "src-x", title: "", text: "t", keywords: [], usage: "interview-context", tokenEstimate: 1, createdAt: TS, embedding }] as never
      });
      return norm.ragChunks.find((c) => c.id === "rx")?.embedding;
    };

    it("memory.embedding 坏形态 → undefined(NONE);合法 1024 维原样保留", () => {
      expect(normMemEmb(null)).toBeUndefined();                 // null(spike:Expected none|array<float> but found NULL)
      expect(normMemEmb("notarray")).toBeUndefined();           // 非数组
      expect(normMemEmb(["a", "b"])).toBeUndefined();           // 含非数值元素(coerce 失败)
      expect(normMemEmb([0.1, "0.2", 0.3])).toBeUndefined();    // 含字符串数字(不 coerce 救活)
      expect(normMemEmb([0.1, NaN, 0.3])).toBeUndefined();      // 含 NaN(Number.isFinite 排除)
      expect(normMemEmb([0.1, Infinity])).toBeUndefined();      // 含 Infinity
      expect(normMemEmb([0.1, 0.2, 0.3])).toBeUndefined();      // 3 维 ≠ 1024(spike:Incorrect vector dimension)
      expect(normMemEmb(Array.from({ length: 512 }, () => 0.01))).toBeUndefined(); // 512 维
      expect(normMemEmb([])).toBeUndefined();                   // 空数组(0 维)
      expect(normMemEmb(undefined)).toBeUndefined();            // 缺省(本就 NONE)
      const kept = normMemEmb(valid1024);                       // 合法 1024 维
      expect(kept).toEqual(valid1024);
      expect(kept).toHaveLength(1024);
    });

    it("rag_chunk.embedding 坏形态 → undefined(NONE);合法 1024 维原样保留", () => {
      expect(normRagEmb(null)).toBeUndefined();
      expect(normRagEmb("notarray")).toBeUndefined();
      expect(normRagEmb(["a", "b"])).toBeUndefined();
      expect(normRagEmb([1, 2, 3])).toBeUndefined();            // 3 维
      expect(normRagEmb([0.1, NaN])).toBeUndefined();           // NaN + 错维度
      expect(normRagEmb(valid1024)).toEqual(valid1024);         // 合法保留
    });

    it("1024 维但含一个非有限元素 → 整个 undefined(维度对但元素级 fail-closed)", () => {
      const almost = Array.from({ length: 1024 }, () => 0.01);
      almost[500] = NaN;                                        // 维度正确、单元素 NaN
      expect(normMemEmb(almost)).toBeUndefined();               // 仍 fail-closed(NaN 污染 COSINE 语义)
    });
  });

  describe("MemoryRecord migration (M3 data)", () => {
    it("normalizes legacy MemoryRecord without new fields, no crash", () => {
      const legacy = {
        ...createInitialProductState(),
        memoryRecords: [
          {
            id: "m1",
            text: "x",
            status: "confirmed",
            sourceType: "interview_session",
            sourceId: "s",
            evidenceQuote: "",
            createdAt: "2026-01-01T00:00:00Z",
            updatedAt: "2026-01-01T00:00:00Z"
          }
        ]
      };
      const norm = normalizeProductState(legacy as Parameters<typeof normalizeProductState>[0]);
      const r = norm.memoryRecords[0];
      expect(r.embedding).toBeUndefined();        // 可选,缺省不报错
      expect(r.importance ?? 5).toBe(5);          // 缺省视为中性 5
      expect(r.text).toBe("x");                   // 其余字段不变
    });

    it("MemoryRecord with embedding and importance is preserved after normalize (round-trip)", () => {
      const state = createInitialProductState();
      // N-01-embedding:embedding 必须是合法 1024 维(EMBEDDING_DIMENSION)才被 optFloatArray 原样保留——
      // 非 1024 维会确定性 wedge HNSW,故 clamp fail-closed 裁成 undefined。此前该 fixture 用 3 维
      // [0.1,0.2,0.3] 断言保留,但该值真落库会炸 HNSW;改用合法 1024 维,保留"合法向量往返无损"的原意。
      const validEmbedding = Array.from({ length: 1024 }, (_, i) => (i % 10) * 0.01);
      const norm = normalizeProductState({
        ...state,
        memoryRecords: [
          {
            id: "m2",
            text: "y",
            status: "confirmed" as const,
            sourceType: "interview_session" as const,
            sourceId: "s",
            evidenceQuote: "quote",
            createdAt: "2026-01-01T00:00:00Z",
            updatedAt: "2026-01-01T00:00:00Z",
            embedding: validEmbedding,
            importance: 8,
            lastAccessedAt: "2026-06-01T00:00:00Z"
          }
        ]
      });
      const r = norm.memoryRecords[0];
      expect(r.embedding).toEqual(validEmbedding);   // 合法 1024 维原样保留
      expect(r.importance).toBe(8);
      expect(r.lastAccessedAt).toBe("2026-06-01T00:00:00Z");
      expect(r.text).toBe("y");
    });

    it("MemoryCandidate with dedup hint fields is preserved after normalize (round-trip)", () => {
      const state = createInitialProductState();
      const norm = normalizeProductState({
        ...state,
        memoryCandidates: [
          {
            id: "mc-dedup",
            text: "候选去重测试",
            status: "pending" as const,
            sourceType: "interview_session" as const,
            sourceId: "s1",
            evidenceQuote: "很长的原话引用超过十二字符",
            reason: "reason",
            sensitivity: "normal" as const,
            reviewScore: 70,
            reviewSignals: ["signal-a"],
            createdAt: "2026-06-01T00:00:00Z",
            similarToRecordId: "m1",
            suggestedUpdate: "update" as const
          }
        ]
      });
      const c = norm.memoryCandidates[0];
      expect(c.similarToRecordId).toBe("m1");
      expect(c.suggestedUpdate).toBe("update");
    });

    it("MemoryCandidate without dedup hint fields is not crashed, fields are undefined", () => {
      const state = createInitialProductState();
      const norm = normalizeProductState({
        ...state,
        memoryCandidates: [
          {
            id: "mc-old",
            text: "候选记忆文本",
            status: "pending" as const,
            sourceType: "interview_session" as const,
            sourceId: "s1",
            evidenceQuote: "很长的原话引用超过十二字符",
            reason: "reason",
            sensitivity: "normal" as const,
            reviewScore: 70,
            reviewSignals: ["signal-a"],
            createdAt: "2026-06-01T00:00:00Z"
          }
        ]
      });
      const c = norm.memoryCandidates[0];
      expect(c.similarToRecordId).toBeUndefined();
      expect(c.suggestedUpdate).toBeUndefined();
    });
  });

  // N-01-datetime:normalize 的 isoDate/optIsoDate 坏日期钳制(纯函数层)。持久层 fillUpsertDefaults 会把
  // datetime typed 列从 rest 提升(new Date(rest[col])),坏日期串会在提升时 coerce 成 Invalid Date → wedge
  // (真库回归见 packages/db/src/surreal/n01-numeric-wedge.test.ts)。这里在 normalize 出口断言钳制结果。
  describe("N-01-datetime: 坏日期钳制 (normalizeProductState 纯函数层)", () => {
    const SENTINEL = "1970-01-01T00:00:00.000Z"; // 与 storage.ts DATE_SENTINEL 同值(固定哨兵,非真实时刻)
    const mem = (over: Record<string, unknown>) => ({
      id: "m1", text: "t", status: "confirmed", sourceType: "profile", sourceId: "s",
      evidenceQuote: "", sensitivity: "normal", createdAt: "2026-06-27T00:00:00.000Z",
      updatedAt: "2026-06-27T00:00:00.000Z", ...over
    });
    const normMem = (over: Record<string, unknown>) =>
      normalizeProductState({ ...createInitialProductState(), memoryRecords: [mem(over)] }).memoryRecords[0];

    it("必填 datetime 坏串/空串/NaN/null/缺失 → 固定哨兵;合法日期原样保留", () => {
      expect(normMem({ createdAt: "not-a-date" }).createdAt, "坏串→哨兵").toBe(SENTINEL);
      expect(normMem({ createdAt: "" }).createdAt, "空串→哨兵").toBe(SENTINEL);
      expect(normMem({ createdAt: "2026-13-99T99:99:99Z" }).createdAt, "越界坏 ISO→哨兵").toBe(SENTINEL);
      expect(normMem({ createdAt: NaN }).createdAt, "NaN→哨兵").toBe(SENTINEL);
      expect(normMem({ createdAt: 12345 }).createdAt, "数字(非串)→哨兵(fail-closed 不救活)").toBe(SENTINEL);
      expect(normMem({ createdAt: null }).createdAt, "null→哨兵").toBe(SENTINEL);
      // 缺字段(undefined)→ 哨兵(确定性,不注入 now;Option A)。
      const { createdAt: _omit, ...noCreatedAt } = mem({});
      const normalized = normalizeProductState({ ...createInitialProductState(), memoryRecords: [noCreatedAt] }).memoryRecords[0];
      expect(normalized.createdAt, "缺字段→哨兵").toBe(SENTINEL);
      // 合法 ISO 原样保留(不重写、不篡改真实时刻,绝不误伤)。
      expect(normMem({ createdAt: "2026-06-27T12:34:56.789Z" }).createdAt, "合法日期不误伤").toBe("2026-06-27T12:34:56.789Z");
    });

    it("option<datetime>(session.completedAt)坏值→undefined、合法保留、缺失仍缺失(不注入哨兵)", () => {
      const base = createInitialProductState();
      const mkSession = (over: Record<string, unknown>) => ({
        id: "se1", title: "t", mode: "daily", strength: "standard", status: "completed",
        card: {}, guide: {}, turns: [], startedAt: "2026-06-27T00:00:00.000Z", ...over
      });
      const normSess = (over: Record<string, unknown>) =>
        normalizeProductState({ ...base, sessions: [mkSession(over)] }).sessions[0];
      // 坏 completedAt → undefined(toRecord 会跳过 → 列 NONE)。
      expect(normSess({ completedAt: "not-a-date" }).completedAt, "坏值→undefined").toBeUndefined();
      // 合法 completedAt → 保留。
      expect(normSess({ completedAt: "2026-06-27T01:00:00.000Z" }).completedAt, "合法保留").toBe("2026-06-27T01:00:00.000Z");
      // 缺失 completedAt(active 会话常态)→ 仍 undefined,绝不注入哨兵(可选列不该凭空多一个假时刻)。
      expect(normSess({ status: "active" }).completedAt, "缺失仍缺失").toBeUndefined();
      // 必填 startedAt 坏串 → 哨兵(与 option 变体区分)。
      expect(normSess({ startedAt: "garbage" }).startedAt, "必填坏串→哨兵").toBe(SENTINEL);
    });

    it("turn.timestamp 与流水 tsField(workflowRuns.startedAt)坏串 → 哨兵", () => {
      const base = createInitialProductState();
      const norm = normalizeProductState({
        ...base,
        sessions: [{ id: "se1", title: "t", mode: "daily", strength: "standard", status: "active", card: {}, guide: {},
          startedAt: "2026-06-27T00:00:00.000Z",
          turns: [{ id: "tn1", sessionId: "se1", role: "user", content: "hi", timestamp: "bad-ts" }] }],
        workflowRuns: [{ id: "wr1", workflow: "context_pack_build", status: "succeeded", providerId: "local-workflow-runtime",
          entityType: "interview_session", entityId: "s", inputSummary: "", outputSummary: "", traceId: "t", startedAt: "nope" }],
      });
      expect(norm.sessions[0].turns[0].timestamp, "turn.timestamp 坏串→哨兵").toBe(SENTINEL);
      expect(norm.workflowRuns[0].startedAt, "流水 tsField 坏串→哨兵").toBe(SENTINEL);
    });

    it("幂等:坏日期钳制后再 normalize 一次结果稳定(哨兵/合法都不漂移)", () => {
      const once = normalizeProductState({ ...createInitialProductState(),
        memoryRecords: [mem({ createdAt: "not-a-date", updatedAt: "2026-06-27T00:00:00.000Z" })] });
      const twice = normalizeProductState(once);
      expect(twice.memoryRecords[0].createdAt).toBe(SENTINEL);
      expect(twice.memoryRecords[0].createdAt).toBe(once.memoryRecords[0].createdAt);
      expect(twice.memoryRecords[0].updatedAt).toBe("2026-06-27T00:00:00.000Z");
    });
  });
});
