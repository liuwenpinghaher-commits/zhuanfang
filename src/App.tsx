import {
  Archive,
  BookOpen,
  Brain,
  Compass,
  Headphones,
  Mic,
  Play,
  Search,
  Settings,
  ShieldCheck,
  SlidersHorizontal,
  Upload,
  Volume2
} from "lucide-react";
import { FormEvent, MutableRefObject, useEffect, useMemo, useRef, useState } from "react";
import {
  analyzeImportedInterview,
  approvePlaybookPatch,
  buildCognitiveRadar,
  buildInterviewCard,
  buildInterviewResumeCard,
  buildMonthlyReview,
  buildRealtimeTurnState,
  buildSearchBrief,
  createSearchBriefFromInput,
  buildSystemStatus,
  buildYearlyReview,
  createQuestionFromNote,
  createKnowledgeDebtFromSearchBrief,
  createPointFromSearchBrief,
  createQuestionFromSearchBrief,
  createSessionDraft,
  finalizeSession,
  generatePodcastEpisode,
  generatePodcastEpisodeFromKnowledgeDebt,
  generatePodcastEpisodeFromSearchBrief,
  generatePodcastEpisodeFromTheme,
  markMemoryCorrection,
  receiveUserTurn,
  searchProductAssets,
  toggleAssetImportance,
  buildRealtimeVoiceInstructions,
  updateDecisionStatus,
  updateInterviewControl,
  updateKnowledgeDebtStatus,
  updatePointStatus,
  updateQuestionStatus
} from "./domain/engine";
import { executeSearchProvider } from "./capabilities/search";
import { createIdleCapabilityTask, failCapabilityTask, startCapabilityTask } from "./capabilities/task";
import { productApiClient, getProductApiBaseUrl, isNetworkError, type ReviewsResponse } from "./api/productApi";
import type { RealtimeVoiceSessionResponse, SystemCapabilitiesResponse, SystemConfigResponse, SystemConfigUpdateRequest, VoiceInfo } from "./api/productApi";
// WebRTC omni client is incomplete (no callbacks/turn recording); the connect path is
// downlined to WebSocket in startVoiceSession. Type kept for the connection union only.
import type { BailianRealtimeWebrtcConnection } from "./realtime/realtimeTypes";
import {
  connectBailianRealtimeWebsocket,
  type BailianRealtimeWebsocketConnection
} from "./realtime/bailianWebsocket";
import { createLivekitVoiceSession, type LivekitVoiceSession } from "./realtime/livekitVoice";
import { connectCascadedPipeline, type CascadedPipeline } from "./realtime/cascadedPipeline";
import { createBrowserAsrSource } from "./realtime/cascadedAsrSource";
import { createBrowserTtsSink } from "./realtime/cascadedTtsSink";
import {
  dedupeGeneratedArtifacts,
  deleteCorpusInsightBundle,
  deletePodcastEpisode,
  deleteSearchBrief
} from "./domain/lifecycle";
import { loadProductState, productStateContentSignature, resetProductState, saveProductState } from "./domain/storage";
import type {
  AssetStatus,
  CorpusImportInput,
  InterviewControlAction,
  InterviewMode,
  InterviewSession,
  PodcastSourceType,
  ProductState,
  SearchBriefInput,
  SearchProviderId,
  SystemConfig
} from "./domain/types";
import { MyAssetsView } from "./features/my-assets/MyAssetsView";
import { ConfigView } from "./features/config/ConfigView";
import { CorpusLearningView } from "./features/corpus/CorpusLearningView";
import { HomeView } from "./features/home/HomeView";
import { InterviewView } from "./features/interview/InterviewView";
import { NotesView } from "./features/notes/NotesView";
import { PodcastStudioView } from "./features/podcast/PodcastStudioView";
import { ProfileView } from "./features/profile/ProfileView";
import { SearchIntelligenceView } from "./features/search/SearchIntelligenceView";
import { ThemesView } from "./features/themes/ThemesView";
import { TrackWorkspaceView } from "./features/track/TrackWorkspaceView";
import { MemoryGovernanceView } from "./features/memory/MemoryGovernanceView";
import { buildTrackWorkspace } from "./domain/timeline";
import {
  buildNotice,
  groupedNavigation,
  interviewControlGroups,
  type AssetFilter,
  type ConfigSection,
  type UiNotice,
  type View
} from "./ui";

const navIconByView: Record<View, typeof Compass> = {
  home: Compass,
  interview: Mic,
  search: Search,
  corpus: Upload,
  podcast: Headphones,
  notes: BookOpen,
  "my-assets": Archive,
  themes: Brain,
  memory: Brain,
  config: SlidersHorizontal,
  profile: Settings,
  track: Brain
};

export default function App() {
  const [productState, setProductState] = useState<ProductState>(() => loadProductState());
  const [apiPersistenceEnabled, setApiPersistenceEnabled] = useState(false);
  const [systemCapabilities, setSystemCapabilities] = useState<SystemCapabilitiesResponse | null>(null);
  const [serverReviews, setServerReviews] = useState<ReviewsResponse | null>(null);
  const [importing, setImporting] = useState(false);
  const [runtimeConfig, setRuntimeConfig] = useState<SystemConfigResponse | null>(null);
  const [runtimeConfigSaving, setRuntimeConfigSaving] = useState(false);
  const [view, setView] = useState<View>("home");
  const [session, setSession] = useState<InterviewSession | null>(null);
  const [pendingMode, setPendingMode] = useState<InterviewMode>("decision");
  const [notice, setNotice] = useState<UiNotice | null>(null);
  const [interviewInput, setInterviewInput] = useState("");
  const [submittingTurn, setSubmittingTurn] = useState(false);
  const [startingInterview, setStartingInterview] = useState(false);
  const [correctionText, setCorrectionText] = useState("");
  const [assetQuery, setAssetQuery] = useState("");
  const [assetFilter, setAssetFilter] = useState<AssetFilter>("all");
  const [selectedAssetKey, setSelectedAssetKey] = useState<string | undefined>(undefined);
  const [confirmingDecisionId, setConfirmingDecisionId] = useState<string | undefined>(undefined);
  const [configSection, setConfigSection] = useState<ConfigSection>("status");
  const [selectedTrackId, setSelectedTrackId] = useState<string | null>(null);
  const [recording, setRecording] = useState(false);
  const [realtimeVoiceSession, setRealtimeVoiceSession] = useState<RealtimeVoiceSessionResponse | null>(null);
  const [realtimeVoiceConnection, setRealtimeVoiceConnection] = useState<BailianRealtimeWebrtcConnection | BailianRealtimeWebsocketConnection | LivekitVoiceSession | null>(null);
  const [livekitVoiceSession, setLivekitVoiceSession] = useState<LivekitVoiceSession | null>(null);
  // Cascade pipeline instance — held in a ref so closing it doesn't trigger re-render.
  const cascadePipelineRef = useRef<CascadedPipeline | null>(null);
  // P1-12: which assistant turn index has already absorbed a `final` transcript
  // segment. A realtime turn can emit MULTIPLE finals (omni: audio_transcript.done
  // + text.done; livekit: one TranscriptionSegment per sentence) — the first final
  // for a given turn REPLACES the turn content, later finals APPEND, so a multi-part
  // reply isn't collapsed to its last segment. Reset implicitly: when the assistant
  // turn index advances (a new user+assistant pair was appended) the first final
  // again replaces. A ref (not state) so accumulation never triggers a re-render race.
  const assistantTranscriptTurnRef = useRef<number>(-1);
  const [audioLevel, setAudioLevel] = useState(0);
  const [voiceStatus, setVoiceStatus] = useState<"idle" | "connecting" | "listening" | "speaking" | "interrupted">("idle");
  const [liveUserTranscript, setLiveUserTranscript] = useState("");
  const [guidanceState, setGuidanceState] = useState<{
    active: boolean;
    kind: string | null;
    text: string | null;
    countThisTurn: number;
    lastTimestamp: string | null;
  }>({ active: false, kind: null, text: null, countThisTurn: 0, lastTimestamp: null });
  const [voices, setVoices] = useState<VoiceInfo[]>([]);
  const [voicesLoading, setVoicesLoading] = useState(false);
  const [searchTopic, setSearchTopic] = useState("AI 产品商业化热点");
  const [activeSearchBriefId, setActiveSearchBriefId] = useState<string | undefined>(undefined);
  const [searchTask, setSearchTask] = useState(() => createIdleCapabilityTask<SearchBriefInput>("联网搜索"));
  const [refreshingBriefId, setRefreshingBriefId] = useState<string | null>(null);
  const [trackingBriefId, setTrackingBriefId] = useState<string | null>(null);
  const [podcastNoteId, setPodcastNoteId] = useState(() => productState.notes[0]?.id ?? "");
  const [podcastVoice, setPodcastVoice] = useState(productState.systemConfig.voice.podcastVoice);
  const [podcastSourceType, setPodcastSourceType] = useState<PodcastSourceType>("note");
  const [podcastSourceId, setPodcastSourceId] = useState("");
  const [podcastEditingScript, setPodcastEditingScript] = useState("");
  const [corpusMediaType, setCorpusMediaType] = useState<CorpusImportInput["mediaType"]>("text");
  const [corpusTitle, setCorpusTitle] = useState("优秀专访样本");
  const [corpusSourceUrl, setCorpusSourceUrl] = useState("");
  // 本地上传音频文件的 base64 + 文件名。两种音频来源（公网 URL / 本地文件）任选其一。
  const [corpusAudioBase64, setCorpusAudioBase64] = useState("");
  const [corpusAudioFileName, setCorpusAudioFileName] = useState("");
  const [corpusTranscribing, setCorpusTranscribing] = useState(false);
  const [corpusAnalyzing, setCorpusAnalyzing] = useState(false);
  const [corpusContent, setCorpusContent] = useState(
    "主持人：你刚才说增长很难，能不能讲一个具体时刻？\n被访者：真正困难是团队不敢暴露坏消息。\n主持人：如果反过来看，是不是机制奖励了报喜不报忧？"
  );
  const [corpusFocus, setCorpusFocus] = useState("");

  useEffect(() => {
    saveProductState(productState);
  }, [productState]);

  const lastSavedContentRef = useRef<string>("");
  useEffect(() => {
    if (!apiPersistenceEnabled) {
      return;
    }
    const signature = productStateContentSignature(productState);
    // Only the revision changed (or nothing did) — nothing new to persist; skip to avoid the save->bump->adopt loop.
    if (signature === lastSavedContentRef.current) {
      return;
    }
    const timer = setTimeout(() => {
      productApiClient
        .saveState(productState)
        .then(({ state: server, conflicted }) => {
          if (conflicted) {
            // Another writer advanced the server — adopt its newer content wholesale,
            // and tell the user so a silently-dropped local edit isn't mistaken for saved.
            lastSavedContentRef.current = productStateContentSignature(server);
            setProductState(server);
            setNotice(buildNotice("warning", "改动已被其他更新覆盖", "已加载最新版本，刚才的修改如仍需要请重新操作。"));
          } else {
            // Our write landed. Record what we saved, and sync only the revision so the
            // next PUT isn't stale. A revision-only change won't re-trigger a save (the
            // content signature is unchanged), so there is no loop.
            lastSavedContentRef.current = signature;
            setProductState((prev) => (prev.revision === server.revision ? prev : { ...prev, revision: server.revision }));
          }
        })
        .catch(() => {
          // Transient error: skip this cycle; the next content change retries. Do NOT
          // permanently disable persistence on a network blip.
        });
    }, 300);
    return () => clearTimeout(timer);
  }, [apiPersistenceEnabled, productState]);

  // 打开即更新：首次进入外部调研视图时自动跑一次盯梢(每会话一次,静默,失败不打扰)。
  // 即时手动刷新走视图内的「自动盯梢」按钮;后台周期刷新走配置里的定时调度。
  const researchAutoOpenedRef = useRef(false);
  useEffect(() => {
    if (view !== "search" || researchAutoOpenedRef.current || !apiPersistenceEnabled) {
      return;
    }
    researchAutoOpenedRef.current = true;
    autoRunResearch().catch(() => {});
  }, [view, apiPersistenceEnabled]);

  useEffect(() => {
    if (view !== "config") {
      return;
    }

    let cancelled = false;
    productApiClient
      .getSystemCapabilities()
      .then((capabilities) => {
        if (!cancelled) {
          setSystemCapabilities(capabilities);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setSystemCapabilities(null);
        }
      });
    productApiClient
      .getSystemConfig()
      .then((config) => {
        if (!cancelled) {
          setRuntimeConfig(config);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setRuntimeConfig(null);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [view]);

  useEffect(() => {
    let cancelled = false;

    productApiClient
      .getState()
      .then((remoteState) => {
        if (!cancelled) {
          // Record what we just loaded as "already saved" so the debounce effect doesn't
          // immediately PUT the freshly-fetched state straight back to the server on load.
          lastSavedContentRef.current = productStateContentSignature(remoteState);
          setProductState(remoteState);
          setApiPersistenceEnabled(true);
        }
      })
      .catch(() => {
        // The demo remains usable when the optional local API is not running.
        if (!cancelled) {
          setApiPersistenceEnabled(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const card = useMemo(() => buildInterviewCard(productState, activeSearchBriefId), [activeSearchBriefId, productState]);
  // Resume: surface the most-recent unfinished (active) session so it isn't stranded.
  const resumeCard = useMemo(() => buildInterviewResumeCard(productState), [productState]);
  const localMonthlyReview = useMemo(() => buildMonthlyReview(productState), [productState]);
  const localYearlyReview = useMemo(() => buildYearlyReview(productState), [productState]);
  const localRadar = useMemo(() => buildCognitiveRadar(productState), [productState]);
  // Prefer LLM-synthesized reviews when available; the deterministic memos above
  // render instantly and act as the offline / no-key fallback.
  const monthlyReview = serverReviews?.monthly ?? localMonthlyReview;
  const yearlyReview = serverReviews?.yearly ?? localYearlyReview;
  const radar = serverReviews?.radar ?? localRadar;

  // Re-fetch LLM reviews only when the asset set actually changes (not on every
  // turn), so an interview in progress doesn't trigger repeated review calls.
  const reviewSignatureRef = useRef<string>("");
  useEffect(() => {
    const signature = [
      productState.notes.length,
      productState.points.length,
      productState.questions.length,
      productState.decisions.length,
      productState.debts.length,
      productState.themes.length
    ].join(":");
    if (signature === reviewSignatureRef.current) {
      return;
    }
    reviewSignatureRef.current = signature;
    setServerReviews(null);
    let cancelled = false;
    productApiClient
      .getReviews()
      .then((reviews) => {
        if (!cancelled) {
          setServerReviews(reviews);
        }
      })
      .catch(() => {
        // Offline / no API key: keep the deterministic fallback.
      });
    return () => {
      cancelled = true;
    };
  }, [productState]);

  // Adopt an authoritative state returned by a fine-grained route. Records it as
  // "already saved" so the debounce effect doesn't echo the whole state back in a
  // redundant full-state PUT (the route already persisted it server-side).
  function adoptServerState(next: ProductState) {
    lastSavedContentRef.current = productStateContentSignature(next);
    setProductState(next);
  }

  async function importMemoryDocument(title: string, content: string) {
    setImporting(true);
    try {
      const result = await productApiClient.importDocument({ title, content, sourceType: "text" });
      adoptServerState(result.state);
      setApiPersistenceEnabled(true);
      setNotice(buildNotice("success", "导入完成", `抽取了 ${result.candidateCount} 条候选记忆，请在下方审核。`));
    } catch {
      setNotice(buildNotice("warning", "导入失败", "需要后端在线且配置 DASHSCOPE_API_KEY 才能抽取候选记忆。"));
    } finally {
      setImporting(false);
    }
  }

  function withMemoryAction(run: () => Promise<ProductState>) {
    run()
      .then((next) => adoptServerState(next))
      .catch(() => setNotice(buildNotice("warning", "操作失败", "记忆治理需要后端在线。")));
  }
  function confirmDecision(id: string) {
    setConfirmingDecisionId(id);
    productApiClient
      .confirmDecision(id)
      .then((next) => adoptServerState(next))
      .catch(() => setNotice(buildNotice("warning", "操作失败", "确认决策需要后端在线。")))
      .finally(() => setConfirmingDecisionId(undefined));
  }

  const approveCandidate = (id: string) => withMemoryAction(() => productApiClient.approveMemoryCandidate(id));
  const rejectCandidate = (id: string) => withMemoryAction(() => productApiClient.rejectMemoryCandidate(id));
  const editCandidate = (id: string, text: string) => withMemoryAction(() => productApiClient.updateMemoryCandidate(id, text));
  const deprecateRecord = (id: string) => withMemoryAction(() => productApiClient.deprecateMemoryRecord(id));
  const deleteRecord = (id: string) => withMemoryAction(() => productApiClient.deleteMemoryRecord(id));
  const consolidateMemory = () =>
    productApiClient
      .consolidateMemory()
      .then((res) => {
        adoptServerState(res.state);
        setNotice(
          buildNotice(
            "success",
            "记忆已整理",
            res.deprecated > 0 ? `合并了 ${res.deprecated} 条近重复记忆。` : "没有发现可合并的近重复记忆。"
          )
        );
      })
      .catch(() => setNotice(buildNotice("warning", "操作失败", "整理记忆需要后端在线。")));

  const assetResults = useMemo(() => searchProductAssets(productState, assetQuery), [productState, assetQuery]);
  const systemStatus = useMemo(() => buildSystemStatus(productState), [productState]);
  const realtimeState = useMemo(
    () =>
      session
        ? buildRealtimeTurnState(session, {
            inputLevel: recording ? audioLevel : 0.02,
            silenceMs: recording ? 0 : 900,
            isUserSpeaking: recording,
            isAssistantSpeaking: voiceStatus === "speaking"
          })
        : null,
    [recording, session, audioLevel, voiceStatus, liveUserTranscript]
  );

  // 引导指示器自动消失:由语音管线的 onGuidance 信号点亮(见 connect* 的 onGuidance),
  // active 后 2.5s 自动收起。(此前这里读 realtimeState.guidance —— 那个字段从不被
  // 填充,指示器永不触发;现改为消费真实的 onGuidance 信号。)
  useEffect(() => {
    if (!guidanceState.active) {
      return;
    }
    const timer = setTimeout(() => setGuidanceState(prev => ({ ...prev, active: false })), 2500);
    return () => clearTimeout(timer);
  }, [guidanceState.active, guidanceState.lastTimestamp]);

  // 用户开始新轮时重置引导计数
  useEffect(() => {
    if (voiceStatus === "listening" && !realtimeState?.shouldInterrupt) {
      setGuidanceState(prev => ({ ...prev, countThisTurn: 0, active: false }));
    }
  }, [voiceStatus, realtimeState?.shouldInterrupt]);

  function closeRealtimeVoiceSession() {
    if (livekitVoiceSession) {
      livekitVoiceSession.close();
      setLivekitVoiceSession(null);
    }
    realtimeVoiceConnection?.close();
    setRealtimeVoiceConnection(null);
    setRealtimeVoiceSession(null);
    if (cascadePipelineRef.current) {
      cascadePipelineRef.current.close();
      cascadePipelineRef.current = null;
    }
    setRecording(false);
    setAudioLevel(0);
    setVoiceStatus("idle");
  }

  useEffect(() => {
    if (view !== "config") return;
    let cancelled = false;
    setVoicesLoading(true);
    productApiClient.listVoices().then((result) => {
      if (!cancelled) {
        setVoices([...result.preset, ...result.custom]);
        setVoicesLoading(false);
      }
    }).catch(() => {
      if (!cancelled) setVoicesLoading(false);
    });
    return () => { cancelled = true; };
  }, [view]);

  async function uploadVoice(audioBase64: string, preferredName: string) {
    const voice = await productApiClient.createVoice({ audioBase64, preferredName });
    setVoices((prev) => [...prev, voice]);
    setNotice(buildNotice("success", "音色创建成功", `音色 "${voice.name}" 已创建，可在音色列表中选择。`));
  }

  async function deleteVoice(voiceId: string) {
    await productApiClient.deleteVoice(voiceId);
    setVoices((prev) => prev.filter((v) => v.voice !== voiceId));
    setNotice(buildNotice("warning", "音色已删除", `音色 "${voiceId}" 已移除。`));
  }

  async function interruptAssistant() {
    setGuidanceState(prev => ({ ...prev, countThisTurn: 0, active: false }));
    // Hit whichever transport is live. cascade (pipeline.interrupt) and omni
    // (connection.interruptAssistant) have real barge-in; livekit's interrupt is a
    // best-effort no-op (SDK-limited) but harmless. Previously only livekit was wired,
    // so the manual 打断 button did nothing in the default cascade / omni modes.
    let interrupted = false;
    // Capture how much of the reply was actually spoken aloud so the server can truncate the
    // persisted assistant turn to what the guest really heard (P0-2). Without this the session
    // record keeps the full reply the AI never finished saying, and downstream memory/extraction
    // treats unspoken text as spoken.
    let spokenTextSoFar = "";
    if (cascadePipelineRef.current) {
      const info = cascadePipelineRef.current.interrupt();
      spokenTextSoFar = info?.spokenTextSoFar ?? "";
      interrupted = true;
    }
    const conn = realtimeVoiceConnection as
      | { interruptAssistant?: () => Promise<{ spokenTextSoFar?: string } | null> | void }
      | null;
    if (conn?.interruptAssistant) {
      const result = await conn.interruptAssistant();
      if (result && typeof result.spokenTextSoFar === "string") {
        spokenTextSoFar = result.spokenTextSoFar;
      }
      interrupted = true;
    }
    if (livekitVoiceSession) {
      livekitVoiceSession.interrupt();
      interrupted = true;
    }
    if (interrupted) {
      // Persist the interruption server-side so the assistant turn is truncated to the spoken
      // portion. Best-effort: a failure here must not break the local barge-in UX.
      const realtimeSessionId = realtimeVoiceSession?.sessionId;
      if (realtimeSessionId) {
        try {
          await productApiClient.interruptRealtimeVoiceSession(realtimeSessionId, {
            spokenTextSoFar,
            reason: "user_interrupt"
          });
        } catch (error) {
          console.warn(JSON.stringify({ event: "interrupt_persist_failed", error: error instanceof Error ? error.message : String(error) }));
        }
      }
      setVoiceStatus("interrupted");
      setTimeout(() => setVoiceStatus("listening"), 1500);
    }
  }

  /** 打开单条主题线工作区。 */
  function openTrack(id: string) {
    setSelectedTrackId(id);
    setView("track");
  }

  /** 继续一个未完成的 active 会话:把它装回 session 并切到工作台。 */
  function continueInterview(sessionId: string) {
    const target = productState.sessions.find((item) => item.id === sessionId && item.status === "active");
    if (!target) {
      setNotice(buildNotice("warning", "无法继续", "这条未完成的专访已不存在或已结束。"));
      return;
    }
    setSession(target);
    setView("interview");
  }

  /** 一键开始：直接传参给 startInterview，不依赖 setState 后的值。 */
  async function launchInterview(mode: InterviewMode = "decision", searchBriefId = activeSearchBriefId) {
    setPendingMode(mode);
    setActiveSearchBriefId(searchBriefId);
    setSession(null);
    await startInterview(mode, searchBriefId);
  }

  async function startInterview(mode: InterviewMode = pendingMode, searchBriefId = activeSearchBriefId) {
    setStartingInterview(true);
    try {
      const apiRun = await productApiClient.createInterviewSession({
        mode,
        strength: productState.profile.preferredStrength,
        ...(searchBriefId ? { searchBriefId } : {})
      });
      setSession(apiRun.session);
      setProductState(apiRun.state);
      closeRealtimeVoiceSession();
      setApiPersistenceEnabled(true);
      setView("interview");
      return;
    } catch (err) {
      if (!isNetworkError(err)) {
        // Server is up but rejected the request — don't fork to a phantom offline session.
        setNotice(buildNotice("warning", "无法开始专访", "服务返回错误，请稍后重试。"));
        return;
      }
      setApiPersistenceEnabled(false);
      setNotice(buildNotice("info", "已进入离线模式", "后端不可用，本次专访在本地进行，稍后可同步。"));
    } finally {
      setStartingInterview(false);
    }

    setSession(createSessionDraft(productState, mode, productState.profile.preferredStrength, { searchBriefId }));
    closeRealtimeVoiceSession();
    setView("interview");
  }

  async function createSearchMaterial(provider: SearchProviderId = productState.systemConfig.search.activeProvider) {
    const runningTask = startCapabilityTask(searchTask, provider);
    setSearchTask(runningTask);
    setView("search");

    const searchRequest = {
      topic: searchTopic,
      providerId: provider,
      maxSources: productState.systemConfig.search.maxSources,
      recencyDays: productState.systemConfig.search.recencyDays
    };

    try {
      const apiRun = await productApiClient.createSearchBrief(searchRequest);
      setSearchTask(apiRun.task);
      setProductState(apiRun.state);
      setApiPersistenceEnabled(true);
      setActiveSearchBriefId(apiRun.brief.id);
      setSearchTopic(apiRun.brief.topic);
      setNotice(
        apiRun.task.status === "degraded"
          ? buildNotice("warning", "搜索已降级完成", apiRun.task.degradedReason)
          : buildNotice("success", "搜索简报已生成", `已选中「${apiRun.brief.topic}」，可以带入下一次专访。`)
      );
      return;
    } catch (err) {
      if (!isNetworkError(err)) {
        // Server is up but rejected the request — don't fork to a local demo brief.
        setSearchTask(failCapabilityTask(runningTask, "服务返回错误，请稍后重试。"));
        setNotice(buildNotice("warning", "搜索失败", "服务返回错误，请稍后重试。"));
        return;
      }
      setApiPersistenceEnabled(false);
    }

    const run = await executeSearchProvider(searchRequest);
    setSearchTask(run.task);

    if (run.task.status === "failed") {
      setNotice(buildNotice("danger", "搜索 provider 调用失败", run.task.error ?? "请检查配置后重试。"));
      return;
    }

    const { brief, nextState } = createSearchBriefFromInput(productState, run.result);
    setProductState(nextState);
    setActiveSearchBriefId(brief.id);
    setSearchTopic(brief.topic);
    setNotice(
      run.task.status === "degraded"
        ? buildNotice("warning", "搜索已降级完成", run.task.degradedReason)
        : buildNotice("success", "搜索简报已生成", `已选中「${brief.topic}」，可以带入下一次专访。`)
    );
  }

  function retrySearchMaterial() {
    return createSearchMaterial((searchTask.providerId as SearchProviderId | undefined) ?? productState.systemConfig.search.activeProvider);
  }

  function startFromBrief(briefId: string) {
    launchInterview("learning", briefId);
  }

  function briefToDebt(briefId: string) {
    const result = createKnowledgeDebtFromSearchBrief(productState, briefId);
    if (!result) {
      setNotice(buildNotice("warning", "转换失败", "未找到该搜索简报。"));
      return;
    }
    setProductState(result.nextState);
    setNotice(buildNotice("success", "已转为知识债", "已加入资产库，可在下一次专访中校验。"));
  }

  function briefToPoint(briefId: string) {
    const result = createPointFromSearchBrief(productState, briefId);
    if (!result) {
      setNotice(buildNotice("warning", "转换失败", "未找到该搜索简报。"));
      return;
    }
    setProductState(result.nextState);
    setNotice(buildNotice("success", "已转为观点", "已从简报生成观点草稿，可在资产库继续打磨。"));
  }

  function briefToQuestion(briefId: string) {
    const result = createQuestionFromSearchBrief(productState, briefId);
    if (!result) {
      setNotice(buildNotice("warning", "转换失败", "未找到该搜索简报。"));
      return;
    }
    setProductState(result.nextState);
    setNotice(buildNotice("success", "已转为专访问题", "已加入问题资产，可带入下一次专访。"));
  }

  function removeSearchBrief(briefId: string) {
    if (typeof window !== "undefined" && !window.confirm("确定要删除这份搜索简报吗？已生成的访谈和资产不会被删除。")) {
      return;
    }
    setProductState(deleteSearchBrief(productState, briefId));
    setActiveSearchBriefId((current) => (current === briefId ? undefined : current));
    setNotice(buildNotice("warning", "搜索简报已删除", "历史访谈和资产保持不变。"));
  }

  function setDefaultSearchProvider(provider: SearchProviderId) {
    const nextConfig = {
      ...productState.systemConfig,
      search: { ...productState.systemConfig.search, activeProvider: provider }
    };
    const nextState = {
      ...productState,
      systemConfig: nextConfig
    };
    setProductState(nextState);
    setNotice(buildNotice("success", "默认搜索 Provider 已更新", `当前默认 provider：${provider}`));
  }

  async function autoBrief(themeId?: string, debtId?: string) {
    setView("search");

    try {
      const response = await productApiClient.createAutoBrief({ themeId, debtId });
      setProductState(response.state);
      setApiPersistenceEnabled(true);
      setActiveSearchBriefId(response.brief.id);
      setNotice(buildNotice("success", "自动简报已生成", `已选中「${response.brief.topic}」，可以带入下一次专访。`));
      return;
    } catch (err) {
      if (!isNetworkError(err)) {
        // Server is up but rejected — don't pass off a local placeholder brief as success.
        setNotice(buildNotice("warning", "自动简报失败", "服务返回错误，请稍后重试。"));
        return;
      }
      setApiPersistenceEnabled(false);
    }

    // Local fallback: derive the topic from the requested theme/debt so "从主题 X"
    // doesn't silently produce an unrelated fixed brief; flag it as an offline placeholder.
    const fallbackTopic = themeId
      ? productState.themes.find((theme) => theme.id === themeId)?.name
      : debtId
        ? productState.debts.find((debt) => debt.id === debtId)?.concept
        : undefined;
    const { brief, nextState } = buildSearchBrief(
      productState,
      fallbackTopic ?? "本周值得讨论的 AI 产品变化",
      productState.systemConfig.search.activeProvider
    );
    setProductState(nextState);
    setActiveSearchBriefId(brief.id);
    setNotice(buildNotice("warning", "自动简报已生成（本地占位）", `后端不可用，已用本地占位简报「${brief.topic}」，联网后可刷新获取真实资料。`));
  }

  async function refreshBrief(briefId: string) {
    setRefreshingBriefId(briefId);
    try {
      const response = await productApiClient.refreshSearchBrief(briefId);
      setProductState(response.state);
      setApiPersistenceEnabled(true);
      setNotice(buildNotice("success", "外部调研已刷新", `「${response.brief.topic}」的研究内容已更新。`));
    } catch {
      setApiPersistenceEnabled(false);
      setNotice(buildNotice("warning", "刷新失败", "无法连接到后端，刷新未完成。"));
    } finally {
      setRefreshingBriefId(null);
    }
  }

  async function trackBrief(briefId: string, tracked: boolean) {
    setTrackingBriefId(briefId);
    try {
      const response = await productApiClient.trackSearchBrief(briefId, tracked);
      setProductState(response.state);
      setApiPersistenceEnabled(true);
      setNotice(buildNotice("success", tracked ? "已标记为持续追踪" : "已取消持续追踪", tracked ? "该主题将持续追踪，可随时刷新获取最新研究。" : "已取消持续追踪标记。"));
    } catch {
      // Optimistic local update when API unavailable
      setApiPersistenceEnabled(false);
      setProductState((current) => ({
        ...current,
        searchBriefs: current.searchBriefs.map((b) => (b.id === briefId ? { ...b, tracked } : b))
      }));
      setNotice(buildNotice("success", tracked ? "已标记为持续追踪（本地）" : "已取消持续追踪（本地）", "后端不可用，已在本地更新状态。"));
    } finally {
      setTrackingBriefId(null);
    }
  }

  async function autoRunResearch() {
    try {
      const response = await productApiClient.autoRunResearch();
      setProductState(response.state);
      setApiPersistenceEnabled(true);
      setNotice(buildNotice("success", "自动盯梢完成", `新增 ${response.summary.generated} 条，刷新 ${response.summary.refreshed} 条。`));
      return response.summary;
    } catch {
      setApiPersistenceEnabled(false);
      throw new Error("自动盯梢失败，请检查网络连接后重试");
    }
  }

  async function generatePodcastScript() {
    const effectiveSourceId =
      podcastSourceType === "note"
        ? podcastNoteId || productState.notes[0]?.id
        : podcastSourceId || "";
    if (!effectiveSourceId) {
      return;
    }

    try {
      const apiRun = await productApiClient.generatePodcastEpisode({
        noteId: podcastSourceType === "note" ? effectiveSourceId : undefined,
        sourceType: podcastSourceType,
        sourceId: effectiveSourceId,
        format: "solo",
        voice: podcastVoice
      } as any);
      setProductState(apiRun.state);
      setApiPersistenceEnabled(true);
      setPodcastNoteId(effectiveSourceId);
      setPodcastEditingScript(apiRun.episode.script);
      setNotice(buildNotice("success", "播客脚本已生成", `使用声音配置：${apiRun.episode.voice}`));
      setView("podcast");
      return;
    } catch (err) {
      if (!isNetworkError(err)) {
        // Server is up but rejected — don't pass off a locally-generated script as success.
        setNotice(buildNotice("warning", "播客脚本生成失败", "服务返回错误，请稍后重试。"));
        return;
      }
      setApiPersistenceEnabled(false);
    }

    let result: { episode: any; nextState: ProductState };
    if (podcastSourceType === "search-brief") {
      result = generatePodcastEpisodeFromSearchBrief(productState, effectiveSourceId, {
        format: "solo",
        voice: podcastVoice
      });
    } else if (podcastSourceType === "theme") {
      result = generatePodcastEpisodeFromTheme(productState, effectiveSourceId, {
        format: "solo",
        voice: podcastVoice
      });
    } else if (podcastSourceType === "knowledge-debt") {
      result = generatePodcastEpisodeFromKnowledgeDebt(productState, effectiveSourceId, {
        format: "solo",
        voice: podcastVoice
      });
    } else {
      result = generatePodcastEpisode(productState, effectiveSourceId, {
        format: "solo",
        voice: podcastVoice
      });
    }
    setProductState(result.nextState);
    setPodcastNoteId(effectiveSourceId);
    setPodcastEditingScript(result.episode.script);
    setNotice(buildNotice("success", "播客脚本已生成", `使用声音配置：${podcastVoice}`));
    setView("podcast");
  }

  async function synthesizePodcastSpeech(episodeId: string) {
    const episode = productState.podcastEpisodes.find((ep) => ep.id === episodeId);
    if (!episode) {
      return;
    }

    // Capture the script the user is currently editing. We pass it directly to the
    // synthesize endpoint so TTS always uses the current version — this eliminates the
    // race where a prior saveState failure left the server holding a stale script.
    const scriptToSynthesize = podcastEditingScript || episode.script;

    // Best-effort: also update local state optimistically so the UI reflects the new script
    // even before the server round-trip completes.
    const applyScriptToState = (base: typeof productState) => ({
      ...base,
      podcastEpisodes: base.podcastEpisodes.map((ep) =>
        ep.id === episodeId
          ? { ...ep, script: scriptToSynthesize, scriptReviewStatus: "用户确认" as const }
          : ep
      )
    });
    setProductState(applyScriptToState(productState));

    // Best-effort persistence (non-blocking). If this fails, the synthesize call below
    // still carries the correct script, so failure here does NOT abort synthesis.
    productApiClient.saveState(applyScriptToState(productState)).then(
      ({ state: persisted, conflicted }) => {
        setProductState(conflicted ? applyScriptToState(persisted) : persisted);
        setApiPersistenceEnabled(true);
      },
      () => { setApiPersistenceEnabled(false); }
    );

    // Call the synthesize endpoint with the current script attached. The server will
    // use this script for TTS rendering AND persist it, so the result is always
    // consistent with what the user confirmed — regardless of whether saveState above
    // succeeded.
    try {
      const { state: synthState, episode: synthEpisode } = await productApiClient.synthesizePodcastEpisode(episodeId, scriptToSynthesize);
      setProductState(synthState);
      setPodcastEditingScript("");
      const isRendered = synthEpisode.audioRenderStatus === "rendered";
      setNotice(
        isRendered
          ? buildNotice("success", "语音合成完成", `播客 "${episode.title}" 音频已渲染。`)
          : buildNotice("warning", "语音合成降级", `播客 "${episode.title}" 脚本已确认，但 TTS 渲染失败，可稍后重试。`)
      );
    } catch {
      setNotice(buildNotice("danger", "语音合成失败", `播客 "${episode.title}" TTS 请求失败，脚本已保留。`));
    }
  }

  function removePodcastEpisode(episodeId: string) {
    if (typeof window !== "undefined" && !window.confirm("确定要删除这条播客生成结果吗？来源笔记不会被删除。")) {
      return;
    }
    setProductState(deletePodcastEpisode(productState, episodeId));
    setNotice(buildNotice("warning", "播客生成结果已删除", "来源笔记和认知资产保持不变。"));
  }

  async function analyzeCorpus() {
    if (!corpusContent.trim()) {
      return;
    }
    const input = {
      title: corpusTitle.trim() || "未命名专访样本",
      mediaType: corpusMediaType,
      content: corpusContent.trim(),
      ...(corpusSourceUrl.trim() ? { sourceUrl: corpusSourceUrl.trim() } : {})
    };

    setCorpusAnalyzing(true);
    try {
      const apiRun = await productApiClient.analyzeCorpusImport(input, corpusFocus.trim() || undefined);
      setProductState(apiRun.state);
      setApiPersistenceEnabled(true);
      setNotice(buildNotice("success", "语料分析已完成", "已生成可确认的访谈策略补丁。"));
      setView("corpus");
      return;
    } catch (err) {
      if (!isNetworkError(err)) {
        // Server is up but rejected — don't pass off a local offline analysis as success.
        setNotice(buildNotice("warning", "语料分析失败", "服务返回错误，请稍后重试。"));
        return;
      }
      setApiPersistenceEnabled(false);
    } finally {
      setCorpusAnalyzing(false);
    }

    const { nextState } = analyzeImportedInterview(productState, {
      title: input.title,
      mediaType: input.mediaType,
      content: input.content,
      sourceUrl: input.sourceUrl
    });
    setProductState(nextState);
    setNotice(buildNotice("success", "语料分析已完成", "已生成可确认的访谈策略补丁。"));
    setView("corpus");
  }

  async function transcribeCorpusAudio() {
    const sourceUrl = corpusSourceUrl.trim();
    const hasLocalFile = !!corpusAudioBase64 && !!corpusAudioFileName;
    if (!sourceUrl && !hasLocalFile) {
      setNotice(buildNotice("warning", "需要音频来源", "请填写公网音频 URL，或从本地选择一个音频文件。"));
      return;
    }

    const title = corpusTitle.trim() || "未命名音频专访样本";
    setCorpusMediaType("audio");
    setCorpusTranscribing(true);

    // 公网 URL 走真转写（SenseVoice）；本地文件没有可行的内联转写路径，后端会诚实降级。
    const request = sourceUrl
      ? { title, sourceUrl, languageHint: "zh" }
      : { title, sourceUrl: "", languageHint: "zh", audioBase64: corpusAudioBase64, fileName: corpusAudioFileName };

    try {
      const apiRun = await productApiClient.transcribeCorpusAudio(request);
      setCorpusContent(apiRun.transcription.text);
      setNotice(
        apiRun.transcription.status === "ready"
          ? buildNotice("success", "音频转写已完成", `已生成 ${apiRun.transcription.model} 转写稿，可继续分析。`)
          : buildNotice("warning", "音频转写已降级", apiRun.transcription.degradedReason)
      );
      return;
    } catch {
      setApiPersistenceEnabled(false);
      setCorpusContent(buildLocalAudioTranscriptionDraft(sourceUrl || `本地文件「${corpusAudioFileName}」`));
      setNotice(buildNotice("warning", "音频转写暂不可用", "Product API 未连接，已生成可编辑的手工转写模板。"));
    } finally {
      setCorpusTranscribing(false);
    }
  }

  function selectCorpusAudioFile(audioBase64: string, fileName: string) {
    setCorpusAudioBase64(audioBase64);
    setCorpusAudioFileName(fileName);
    setCorpusMediaType("audio");
    // 选了本地文件就清掉 URL，确保两种来源互斥、来源单一可预测。
    setCorpusSourceUrl("");
  }

  function clearCorpusAudioFile() {
    setCorpusAudioBase64("");
    setCorpusAudioFileName("");
  }

  function removeCorpusInsight(insightId: string) {
    if (typeof window !== "undefined" && !window.confirm("确定要删除这次语料分析吗？已应用的 PlaybookPatch 会保留为历史记录。")) {
      return;
    }
    setProductState(deleteCorpusInsightBundle(productState, insightId));
    setNotice(buildNotice("warning", "语料分析已删除", "已应用的引擎补丁仍会保留。"));
  }

  function applyPlaybookPatch(patchId: string, overrideRules?: string[]) {
    setProductState(approvePlaybookPatch(productState, patchId, overrideRules));
    setNotice(buildNotice("success", "PlaybookPatch 已应用", "系统配置已记录新的访谈策略版本。"));
    setView("config");
  }

  function cleanupGeneratedArtifacts() {
    const result = dedupeGeneratedArtifacts(productState);
    const removedTotal = result.removed.searchBriefs + result.removed.podcastEpisodes + result.removed.corpusInsights;
    setProductState(result.nextState);
    setNotice(
      removedTotal > 0
        ? buildNotice(
            "warning",
            "重复生成物已清理",
            `删除 ${result.removed.searchBriefs} 份搜索简报、${result.removed.podcastEpisodes} 条播客、${result.removed.corpusInsights} 次语料分析。`
          )
        : buildNotice("info", "没有发现重复生成物", "搜索简报、播客和语料分析都已保持唯一。")
    );
  }

  async function saveRuntimeConfig(updates: SystemConfigUpdateRequest) {
    setRuntimeConfigSaving(true);
    try {
      const result = await productApiClient.updateSystemConfig(updates);
      const capabilities = await productApiClient.getSystemCapabilities();
      setRuntimeConfig(result.config);
      setSystemCapabilities(capabilities);
      setNotice(buildNotice("success", "运行配置已保存", `已更新 ${result.settingsUpdated.length} 项服务端配置。`));
    } catch {
      setNotice(buildNotice("danger", "运行配置保存失败", "请确认 Product API 正在运行，且本地 env 文件可写。"));
    } finally {
      setRuntimeConfigSaving(false);
    }
  }

  function saveProductConfig(nextConfig: SystemConfig) {
    const nextState = {
      ...productState,
      systemConfig: nextConfig
    };
    setProductState(nextState);
    setPodcastVoice(nextConfig.voice.podcastVoice);
    setNotice(buildNotice("success", "产品策略已保存", "搜索、语音和访谈策略会影响后续生成流程。"));
  }

  function saveDefaultPodcastVoice() {
    const nextConfig = {
      ...productState.systemConfig,
      voice: { ...productState.systemConfig.voice, podcastVoice }
    };
    const nextState = {
      ...productState,
      systemConfig: nextConfig
    };
    setProductState(nextState);
    setNotice(buildNotice("success", "播客默认声音已更新", `默认声音已设为：${podcastVoice}`));
  }

  async function submitTurn(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!session || !interviewInput.trim()) {
      return;
    }
    const content = interviewInput;
    setInterviewInput("");
    setSubmittingTurn(true);

    try {
      const apiRun = await productApiClient.sendInterviewTurn(session.id, { content });
      // Use the server's authoritative session — it already carries the new
      // user+assistant turns AND its own interactionPreSignals. (The old code
      // spread the STALE closure `session` here, which dropped the new turns
      // whenever the reply included pre_signals, i.e. always with the real LLM.)
      setSession(apiRun.session);
      setProductState(apiRun.state);
      setApiPersistenceEnabled(true);
      return;
    } catch {
      if (apiPersistenceEnabled) {
        // Online but API call failed transiently — do NOT fork client session;
        // restore input so the user can retry.
        setNotice(buildNotice("warning", "未送达", "本轮未送到服务端，请重试。"));
        setInterviewInput(content);
        return;
      }
      setApiPersistenceEnabled(false);
    } finally {
      setSubmittingTurn(false);
    }

    // Genuinely offline fallback — only reached when !apiPersistenceEnabled.
    setSession(receiveUserTurn(session, content));
  }

  async function finishInterview() {
    if (!session) {
      return;
    }
    // Align with the server's rule: at least one USER turn (control feedback turns
    // don't count). Pre-checking avoids a 422 that the catch would misread as offline.
    const userTurnCount = session.turns.filter((turn) => turn.role === "user").length;
    if (userTurnCount === 0) {
      setNotice(buildNotice("warning", "还不能结束", "先回答至少一轮，再结束并生成档案。"));
      return;
    }

    try {
      const apiRun = await productApiClient.endInterviewSession(session.id);
      setProductState(apiRun.state);
      setApiPersistenceEnabled(true);
      setSession(null);
      closeRealtimeVoiceSession();
      setNotice(buildNotice("success", "专访档案已生成", "双轨笔记和认知资产已更新。"));
      setView("notes");
      return;
    } catch (err) {
      if (!isNetworkError(err)) {
        setNotice(buildNotice("warning", "结束失败", "服务返回错误，请稍后重试。本次未生成档案。"));
        return;
      }
      setApiPersistenceEnabled(false);
    }

    // Offline path (network error only): the deterministic finalize produces a
    // lightweight note with NO extracted assets — say so honestly, not "资产已更新".
    const result = finalizeSession(productState, session);
    setProductState(result.nextState);
    setSession(null);
    closeRealtimeVoiceSession();
    setNotice(buildNotice("warning", "已保存轻量档案", "后端不可用，仅保留双轨笔记，未做 AI 资产抽取。"));
    setView("notes");
  }

  async function applyInterviewControl(action: InterviewControlAction) {
    if (!session) {
      return;
    }
    const controlLabel =
      interviewControlGroups.flatMap((group) => group.actions).find((option) => option.id === action)?.label ?? "访谈控制";

    try {
      const apiRun = await productApiClient.applyInterviewControl(session.id, { action });
      setSession(apiRun.session);
      setProductState(apiRun.state);
      setApiPersistenceEnabled(true);
      setNotice(buildNotice("info", "访谈控制已应用", `下一轮会按「${controlLabel}」调整。`));
      return;
    } catch (err) {
      if (!isNetworkError(err)) {
        setNotice(buildNotice("warning", "控制未生效", "服务返回错误，请稍后重试。"));
        return;
      }
      setApiPersistenceEnabled(false);
    }

    setSession(updateInterviewControl(session, action));
    setNotice(buildNotice("info", "访谈控制已应用", `下一轮会按「${controlLabel}」调整。`));
  }

  function saveNoteQuestion(noteId: string, index: number) {
    const next = createQuestionFromNote(productState, noteId, index);
    if (next === productState) {
      // createQuestionFromNote returns the original state untouched when the note
      // or the回访 question can't be found — don't claim a false success.
      setNotice(buildNotice("warning", "未能保存问题", "该回访问题不存在或已失效，请刷新后重试。"));
      return;
    }
    setProductState(next);
    setNotice(buildNotice("success", "问题已保存到资产库", "在「我的资产 → 资产库」中可继续标记状态。"));
    setView("my-assets");
  }

  function addCorrection() {
    if (!correctionText.trim()) {
      return;
    }
    setProductState(markMemoryCorrection(productState, correctionText.trim()));
    setNotice(buildNotice("success", "记忆修正已保存", "后续访谈会参考这条边界。"));
    setCorrectionText("");
  }

  async function exportData() {
    return productApiClient.exportState();
  }

  async function importData(payload: unknown) {
    const nextState = await productApiClient.importState(payload);
    setApiPersistenceEnabled(true);
    saveProductState(nextState);
    setSession(null);
    closeRealtimeVoiceSession();
    setNotice(buildNotice("success", "数据已从备份恢复", "已用导入的备份覆盖当前全部数据。"));
    return nextState;
  }

  async function showPrivacyReport() {
    return productApiClient.getPrivacyReport();
  }

  async function purgeData() {
    const nextState = await productApiClient.purgeState();
    setApiPersistenceEnabled(true);
    saveProductState(nextState);
    setSession(null);
    closeRealtimeVoiceSession();
    setNotice(buildNotice("warning", "个人数据已彻底清空", "所有专访、记忆与资产已删除，Provider 配置已保留。"));
    return nextState;
  }

  async function resetData() {
    if (typeof window !== "undefined" && !window.confirm("确定清空示例数据，开始你自己的真实记录吗？这会移除内置示例的访谈、资产和记忆，且无法撤销。")) {
      return;
    }
    let nextState: ProductState;
    try {
      nextState = await productApiClient.resetState();
      setApiPersistenceEnabled(true);
      saveProductState(nextState);
    } catch {
      setApiPersistenceEnabled(false);
      // Preserve the current revision so the post-reset auto-save isn't rejected by
      // optimistic-concurrency and doesn't re-adopt the server's demo state.
      nextState = { ...resetProductState(), revision: productState.revision };
    }
    setProductState(nextState);
    setSession(null);
    closeRealtimeVoiceSession();
    setPendingMode("decision");
    setInterviewInput("");
    setActiveSearchBriefId(undefined);
    setPodcastNoteId("");
    setPodcastSourceType("note");
    setPodcastSourceId("");
    setPodcastEditingScript("");
    setCorpusMediaType("text");
    setCorpusSourceUrl("");
    setCorpusAudioBase64("");
    setCorpusAudioFileName("");
    setNotice(buildNotice("warning", "示例数据已清空", "可以开始记录你自己的真实访谈了。"));
    setView("home");
  }

  async function toggleRealtimeRecording() {
    if (recording) {
      closeRealtimeVoiceSession();
      return;
    }

    try {
      const voiceSession = await productApiClient.createRealtimeVoiceSession({
        ...(session ? { interviewSessionId: session.id } : {}),
        instructions: buildRealtimeVoiceInstructions(session, card, productState.memoryCorrections ?? []),
        voice: productState.systemConfig.voice.defaultVoice
      });
      setRealtimeVoiceSession(voiceSession);
      setApiPersistenceEnabled(true);

      if (voiceSession.status === "ready") {
        const voiceMode = productState.systemConfig.voice.realtimeMode ?? "cascade";

        if (voiceMode === "cascade") {
          // Cascade pipeline: real ASR (text-only omni WS) → LLM HTTP → CosyVoice TTS WS
          try {
            setVoiceStatus("connecting");
            const baseWsUrl = `ws://${location.hostname}:3210`;
            const asrWsUrl = `${baseWsUrl}/api/realtime-voice/ws/${voiceSession.sessionId}`;
            const ttsWsUrl = `${baseWsUrl}/api/realtime-voice/ws/tts/${voiceSession.sessionId}`;
            const interviewId = session?.id ?? "";

            const asr = createBrowserAsrSource({
              asrWsUrl,
              instructions: voiceSession.sessionUpdate.session.instructions
            });
            const tts = createBrowserTtsSink(ttsWsUrl, productState.systemConfig.voice.defaultVoice);

            // sendUserTurn: POST to /api/interview-sessions/:id/turns, return assistantText
            const sendUserTurn = async (text: string, signal: AbortSignal) => {
              if (!interviewId) {
                return { assistantText: "" };
              }
              // P0-D: forward the pipeline's barge-in signal so an interrupted turn
              // aborts the server LLM call rather than running to completion (which
              // would overwrite the user's newly-started turn and waste budget).
              const r = await productApiClient.sendInterviewTurn(interviewId, { content: text }, signal);
              setSession(r.session);
              setProductState(r.state);
              setApiPersistenceEnabled(true);
              if (r.preSignals) cascadePipelineRef.current?.updatePreSignals(r.preSignals);
              const lastTurn = r.session.turns.at(-1);
              // The server already stripped （…）asides from content and distilled the manner into
              // turn.prosody — forward it so the voice keeps its emotion.
              return { assistantText: lastTurn?.content ?? "", prosody: lastTurn?.prosody };
            };

            const preSignals = session?.interactionPreSignals ?? null;

            const pipeline = connectCascadedPipeline({
              asr,
              tts,
              sendUserTurn,
              preSignals,
              callbacks: {
                onStateChange: (s) => {
                  if (s === "listening" || s === "transcribing") setVoiceStatus("listening");
                  else if (s === "thinking") setVoiceStatus("connecting");
                  else if (s === "speaking") setVoiceStatus("speaking");
                  else if (s === "interrupted") setVoiceStatus("interrupted");
                  else if (s === "idle") setVoiceStatus("idle");
                },
                onUserTranscript: (text, isFinal) => {
                  // Live transcript chip only. The final user turn is persisted
                  // authoritatively by sendUserTurn → sendInterviewTurn (which adds
                  // BOTH the user turn and the assistant reply). Recording it again
                  // here was double-logging every turn (语音用户输入 + 用户表达).
                  setLiveUserTranscript(isFinal ? "" : text);
                },
                onAssistantText: () => {
                  // No-op: sendUserTurn already called setSession(r.session) with the
                  // assistant turn. Recording it again here double-logged the reply
                  // (百炼角色扮演追问 + 语音助手回应).
                },
                onError: (err) => {
                  setNotice(buildNotice("warning", "级联语音错误", err.message));
                }
              },
              classifyEndpoint: interviewId
                ? (text: string, signal: AbortSignal) => productApiClient.classifyTurnComplete(interviewId, text, signal)
                : undefined,
              onDecision: (trace) => {
                console.debug("[cascade decision]", trace);
                if (interviewId) void productApiClient.logCascadeDecision(interviewId, trace);
              },
            });

            cascadePipelineRef.current = pipeline;

            // Render the recording UI IMMEDIATELY. The opening playback + mic open
            // run in the BACKGROUND (not awaited): awaiting startListening here froze
            // the page for the whole ~9s opening before setRecording ran, and the
            // opening played while the UI was still stuck on "connecting".
            // voiceStatus is driven by the pipeline's onStateChange (speaking → listening).
            setRecording(true);
            setNotice(buildNotice("success", "实时语音会话已就绪", "级联模式 (ASR→分析→TTS) 已连接"));
            void pipeline.startListening(card.suggestedOpening || undefined).catch((err) => {
              setNotice(buildNotice("warning", "级联语音连接失败", err instanceof Error ? err.message : "请确认后端在线且 API key 已配置"));
            });
            return;
          } catch (err) {
            setNotice(buildNotice("warning", "级联语音连接失败", err instanceof Error ? err.message : "请确认后端在线且 API key 已配置"));
            return;
          }
        }

        if (voiceMode === "livekit") {
          // LiveKit cascaded pipeline (browser → LiveKit server → Python agent → DashScope)
          try {
            setVoiceStatus("connecting");
            const sessionId = voiceSession.sessionId;
            const interviewId = session?.id ?? "";
            const tokenResp = await fetch(
              `${getProductApiBaseUrl()}/api/realtime-voice/livekit-token?sessionId=${sessionId}&interviewSessionId=${interviewId}`
            );
            if (!tokenResp.ok) {
              throw new Error(`Token endpoint returned ${tokenResp.status}`);
            }
            const { token, serverUrl } = await tokenResp.json();

            const livekitSession = await createLivekitVoiceSession({
              serverUrl: serverUrl ?? "ws://127.0.0.1:7880",
              token,
              interviewSessionId: interviewId,
              callbacks: {
                onStateChange: (state) => {
                  if (state === "connected") setVoiceStatus("listening");
                  if (state === "disconnected") { setRecording(false); setVoiceStatus("idle"); }
                },
                onUserTranscript: (text, isFinal) => {
                  setLiveUserTranscript(text);
                  if (!isFinal || !text.trim()) return;
                  // Record on the server session to keep it authoritative (no fork).
                  productApiClient
                    .recordInterviewTurn(interviewId, { role: "user", content: text })
                    .then((r) => setSession(r.session))
                    .catch(() => setSession((prev) => (prev ? receiveUserTurn(prev, text) : prev)));
                  // Phase 8: regenerate pre_signals for the next turn (voice path).
                  if (interviewId) {
                    productApiClient
                      .generateInterviewPreSignals(interviewId)
                      .then((res) => {
                        setSession((prev) => (prev ? { ...prev, interactionPreSignals: res.preSignals } : prev));
                      })
                      .catch(() => {
                        // keep existing signals on failure
                      });
                  }
                  // 🔴-1 (honest scope): NO per-turn instruction refresh here. The
                  // LiveKit cascade's instructions live in the Python agent
                  // (agent-context), not in a client-side session.update — so memory
                  // recall freshness on this path depends on whether that Python agent
                  // re-fetches /api/realtime-voice/agent-context each turn (that side's
                  // concern). This task fixed ONLY the bailian omni (WS/WebRTC) path,
                  // which DOES refresh via connection.updateInstructions above.
                },
                onAssistantTranscript: (text, isFinal) => {
                  if (!isFinal || !text.trim()) return;
                  setVoiceStatus("speaking");
                  setSession((prev) =>
                    prev ? appendAssistantTranscriptFinal(prev, text, assistantTranscriptTurnRef) : prev
                  );
                },
                onAudioLevel: (level) => setAudioLevel(level),
                onError: (err) => {
                  setNotice(buildNotice("warning", "语音连接失败", err.message));
                },
              },
            });

            // Publish the microphone — without this the agent never hears the user.
            await livekitSession.startListening();
            setLivekitVoiceSession(livekitSession);
            setRecording(true);
            setVoiceStatus("listening");
            setNotice(
              buildNotice(
                "success",
                "实时语音会话已就绪",
                "LiveKit 级联 (Paraformer→Qwen→CosyVoice) 已连接"
              )
            );
            return;
          } catch {
            setNotice(buildNotice("warning", "LiveKit 连接失败", "请确认 LiveKit Server 和 Python Agent 已启动"));
            return;
          }
        }

        // Bailian mode (default): direct DashScope omni via WebSocket proxy
        // or WebRTC — single hop, integrated STT+LLM+TTS with server VAD.
        try {
          setVoiceStatus("connecting");
          // Augment the session with the scripted opening line (sourced from the
          // interview card's suggestedOpening). The WS path uses this to send an
          // initial response.create so the AI proactively opens with the prepared
          // tracking-point question rather than improvising small-talk.
          const sessionWithOpening = {
            ...voiceSession,
            ...(card.suggestedOpening ? { openingLine: card.suggestedOpening } : {})
          };
          if (voiceSession.transport === "webrtc") {
            // ponytail: the WebRTC omni client is incomplete (no transcript/audio/turn
            // callbacks, no DataChannel parsing) — it would connect but record nothing.
            // Until it's finished, fall back to the working WebSocket path.
            console.warn(JSON.stringify({ event: "webrtc_incomplete_fallback_to_ws" }));
            setNotice(buildNotice("info", "已改用 WebSocket 实时语音", "WebRTC 通道尚未完整支持，已自动切换。"));
          }
          const connection = await connectBailianRealtimeWebsocket(sessionWithOpening, {
                productApiBaseUrl: `ws://${location.hostname}:3210`,
                preSignals: session?.interactionPreSignals,
                onAudioLevel: (level) => setAudioLevel(level),
                onSpeechStart: () => setVoiceStatus("listening"),
                onSpeechEnd: () => setVoiceStatus("speaking"),
                onGuidance: (text) => {
                  // Light up the in-conversation guidance indicator (the visual badge
                  // in InterviewView), and whisper short guidance via SpeechSynthesis.
                  setGuidanceState(prev => ({
                    active: true,
                    kind: "nudge",
                    text,
                    countThisTurn: prev.countThisTurn + 1,
                    lastTimestamp: new Date().toISOString()
                  }));
                  if (text.length < 40) {
                    try {
                      const utterance = new SpeechSynthesisUtterance(text);
                      utterance.lang = "zh-CN";
                      utterance.rate = 1.1;
                      utterance.volume = 0.7;
                      speechSynthesis.cancel();
                      speechSynthesis.speak(utterance);
                    } catch { /* SpeechSynthesis not available */ }
                  }
                },
                onUserTranscript: (text, isFinal) => {
                  setLiveUserTranscript(text);
                  if (!isFinal || !text.trim()) return;
                  // Record on the server session to keep it authoritative (no fork).
                  const voiceSid = session?.id ?? "";
                  if (voiceSid) {
                    productApiClient
                      .recordInterviewTurn(voiceSid, { role: "user", content: text })
                      .then((r) => setSession(r.session))
                      .catch(() => setSession((prev) => (prev ? receiveUserTurn(prev, text) : prev)));
                  } else {
                    setSession((prev) => (prev ? receiveUserTurn(prev, text) : prev));
                  }
                  // Phase 8: regenerate pre_signals for the next turn and push
                  // them into the live connection (the voice model can't emit them).
                  if (voiceSid) {
                    productApiClient
                      .generateInterviewPreSignals(voiceSid)
                      .then((res) => {
                        setSession((prev) => (prev ? { ...prev, interactionPreSignals: res.preSignals } : prev));
                        if ("updatePreSignals" in connection) connection.updatePreSignals(res.preSignals);
                      })
                      .catch(() => {
                        // keep existing signals on failure
                      });
                    // 🔴-1: recompute the omni voice model's instructions against THIS
                    // turn's utterance so its memory recall tracks the conversation
                    // (the realtime session set instructions only once at open — an
                    // opening-time snapshot). Push the refreshed string via
                    // session.update. Non-blocking; silent on failure so a recall
                    // hiccup never disrupts the live voice experience.
                    productApiClient
                      .refreshVoiceInstructions(voiceSid, text)
                      .then((res) => {
                        if ("updateInstructions" in connection) connection.updateInstructions(res.instructions);
                      })
                      .catch(() => {
                        // keep the existing (opening-time) instructions on failure
                      });
                  }
                },
                onAssistantTranscript: (text, isFinal) => {
                  if (!isFinal || !text.trim()) return;
                  setSession((prev) =>
                    prev ? appendAssistantTranscriptFinal(prev, text, assistantTranscriptTurnRef) : prev
                  );
                },
                onError: (err) => {
                  setNotice(buildNotice("warning", "语音连接异常", err.message));
                }
              });
          setRealtimeVoiceConnection(connection);
          setRecording(true);
          setVoiceStatus("listening");
          setNotice(
            buildNotice(
              "success",
              "实时语音会话已就绪",
              `${voiceSession.model} · WebSocket 已连接`
            )
          );
        } catch {
          setNotice(
            buildNotice(
              "warning",
              "语音连接失败",
              "百炼 WebSocket 连接失败。"
            )
          );
          return;
        }
      } else {
        setRecording(false);
        setNotice(
          buildNotice(
            "warning",
            "实时语音未完全配置",
            "请检查 API Key 配置。"
          )
        );
      }
      return;
    } catch {
      setApiPersistenceEnabled(false);
    }

    setRealtimeVoiceSession(null);
    setNotice(buildNotice("warning", "实时语音不可用", "Product API 不可用，无法开始语音专访，请检查服务后重试。"));
  }

  return (
    <>
    <a className="skip-link" href="#main-content">跳到主内容</a>
    <div className="app-shell">
      <aside className="sidebar" aria-label="主导航">
        <div className="brand">
          <div className="brand-mark"><Volume2 size={20} /></div>
          <div>
            <strong>私人专访编辑</strong>
            <span>认知资产工作台</span>
          </div>
        </div>
        <nav className="nav-list">
          {groupedNavigation.map((group) => (
            <section className="nav-group" key={group.label} aria-label={`${group.label}导航`}>
              <span className="nav-group-label">{group.label}</span>
              <div className="nav-group-items">
                {group.items.map((item) => {
                  const Icon = navIconByView[item.id];
                  return (
                    <button
                      key={item.id}
                      className={view === item.id ? "nav-item active" : "nav-item"}
                      type="button"
                      onClick={() => setView(item.id)}
                    >
                      <Icon size={18} />
                      <span>{item.label}</span>
                    </button>
                  );
                })}
              </div>
            </section>
          ))}
        </nav>
        <div className="sidebar-status">
          <ShieldCheck size={18} />
          <span>本地演示数据，用户可随时重置和修正记忆。</span>
        </div>
      </aside>

      <main id="main-content" className="main-area">
        {notice && (
          <section className={`notice ${notice.kind}`} aria-live="polite" aria-atomic="true">
            <strong>{notice.message}</strong>
            {notice.detail && <span>{notice.detail}</span>}
          </section>
        )}
        {resumeCard && view !== "interview" && session?.id !== resumeCard.sessionId && (
          <section className="resume-banner" aria-label="未完成的专访">
            <div className="resume-banner-main">
              <span className="resume-banner-eyebrow">未完成的专访 · 已进行 {resumeCard.turnCount} 轮</span>
              <strong>{resumeCard.title}</strong>
              <p>{resumeCard.pendingQuestion}</p>
            </div>
            <button className="primary-action" type="button" onClick={() => continueInterview(resumeCard.sessionId)}>
              <Play size={16} />继续专访
            </button>
          </section>
        )}
        {view === "home" && (
          <HomeView
            state={productState}
            card={card}
            monthlyReview={monthlyReview}
            onStart={launchInterview}
            onOpenTrack={openTrack}
            onNavigate={(v) => setView(v as Parameters<typeof setView>[0])}
          />
        )}
        {view === "interview" && (
          <InterviewView
            card={card}
            session={session}
            pendingMode={pendingMode}
            input={interviewInput}
            recording={recording}
            realtimeState={realtimeState}
            audioLevel={audioLevel}
            voiceStatus={voiceStatus}
            liveUserTranscript={liveUserTranscript}
            voiceTransport={
              livekitVoiceSession ? "livekit"
              : realtimeVoiceSession ? "websocket"
              : null
            }
            onInput={setInterviewInput}
            onStart={startInterview}
            onSubmit={submitTurn}
            onFinish={finishInterview}
            onControl={applyInterviewControl}
            onToggleRecording={toggleRealtimeRecording}
            onInterrupt={interruptAssistant}
            submitting={submittingTurn}
            starting={startingInterview}
            guidanceState={guidanceState}
          />
        )}
        {view === "search" && (
          <SearchIntelligenceView
            state={productState}
            topic={searchTopic}
            activeBriefId={activeSearchBriefId}
            task={searchTask}
            onTopic={setSearchTopic}
            onCreate={createSearchMaterial}
            onRetry={retrySearchMaterial}
            onUseBrief={startFromBrief}
            onDeleteBrief={removeSearchBrief}
            onSetDefaultProvider={setDefaultSearchProvider}
            onAutoBrief={autoBrief}
            onRefreshBrief={refreshBrief}
            onTrackBrief={trackBrief}
            onAutoRun={autoRunResearch}
            onConvertToDebt={briefToDebt}
            onConvertToPoint={briefToPoint}
            onConvertToQuestion={briefToQuestion}
            refreshingBriefId={refreshingBriefId}
            trackingBriefId={trackingBriefId}
          />
        )}
        {view === "corpus" && (
          <CorpusLearningView
            state={productState}
            mediaType={corpusMediaType}
            title={corpusTitle}
            sourceUrl={corpusSourceUrl}
            content={corpusContent}
            focus={corpusFocus}
            transcribing={corpusTranscribing}
            analyzing={corpusAnalyzing}
            audioFileName={corpusAudioFileName}
            onMediaType={setCorpusMediaType}
            onTitle={setCorpusTitle}
            onSourceUrl={setCorpusSourceUrl}
            onContent={setCorpusContent}
            onFocus={setCorpusFocus}
            onSelectAudioFile={selectCorpusAudioFile}
            onClearAudioFile={clearCorpusAudioFile}
            onTranscribeAudio={transcribeCorpusAudio}
            onAnalyze={analyzeCorpus}
            onApprovePatch={applyPlaybookPatch}
            onDeleteInsight={removeCorpusInsight}
          />
        )}
        {view === "podcast" && (
          <PodcastStudioView
            state={productState}
            noteId={podcastNoteId}
            voice={podcastVoice}
            sourceType={podcastSourceType}
            sourceId={podcastSourceId}
            editingScript={podcastEditingScript}
            onNoteId={setPodcastNoteId}
            onVoice={setPodcastVoice}
            onSourceType={setPodcastSourceType}
            onSourceId={setPodcastSourceId}
            onEditingScript={setPodcastEditingScript}
            onGenerateScript={generatePodcastScript}
            onSynthesizeSpeech={synthesizePodcastSpeech}
            onDeleteEpisode={removePodcastEpisode}
            onSaveDefaultVoice={saveDefaultPodcastVoice}
          />
        )}
        {view === "notes" && <NotesView state={productState} onStart={launchInterview} onSaveQuestion={saveNoteQuestion} />}
        {view === "my-assets" && (
          <MyAssetsView
            state={productState}
            query={assetQuery}
            results={assetResults}
            filter={assetFilter}
            selectedAssetKey={selectedAssetKey}
            onQuery={setAssetQuery}
            onFilter={setAssetFilter}
            onSelectAsset={setSelectedAssetKey}
            onToggleImportant={(assetId) => setProductState(toggleAssetImportance(productState, assetId))}
            onPointStatus={(assetId, status) => setProductState(updatePointStatus(productState, assetId, status))}
            onQuestionStatus={(assetId, status) => setProductState(updateQuestionStatus(productState, assetId, status))}
            onDebtStatus={(assetId, status) => setProductState(updateKnowledgeDebtStatus(productState, assetId, status))}
            onDecisionStatus={(assetId, status) => setProductState(updateDecisionStatus(productState, assetId, status))}
            onDecisionConfirm={confirmDecision}
            confirmingDecisionId={confirmingDecisionId}
            onGeneratePodcast={(noteId) => {
              setPodcastNoteId(noteId);
              setPodcastSourceType("note");
              setPodcastSourceId("");
              setView("podcast");
            }}
          />
        )}
        {view === "themes" && <ThemesView state={productState} review={monthlyReview} yearlyReview={yearlyReview} radar={radar} onStart={launchInterview} onOpenTrack={openTrack} />}
        {view === "track" && (
          <TrackWorkspaceView
            workspace={buildTrackWorkspace(productState, selectedTrackId ?? "")}
            onBack={() => setView("home")}
            onContinue={() => launchInterview("long-term")}
          />
        )}
        {view === "memory" && (
          <MemoryGovernanceView
            state={productState}
            importing={importing}
            onImport={importMemoryDocument}
            onApprove={approveCandidate}
            onReject={rejectCandidate}
            onEditCandidate={editCandidate}
            onDeprecate={deprecateRecord}
            onDeleteRecord={deleteRecord}
            onConsolidate={consolidateMemory}
          />
        )}
        {view === "config" && (
          <ConfigView
            state={productState}
            status={systemStatus}
            systemCapabilities={systemCapabilities}
            runtimeConfig={runtimeConfig}
            runtimeConfigSaving={runtimeConfigSaving}
            section={configSection}
            onSection={setConfigSection}
            onCleanupGeneratedArtifacts={cleanupGeneratedArtifacts}
            onSaveRuntimeConfig={saveRuntimeConfig}
            onSaveProductConfig={saveProductConfig}
            voices={voices}
            voicesLoading={voicesLoading}
            onUploadVoice={uploadVoice}
            onDeleteVoice={deleteVoice}
          />
        )}
        {view === "profile" && (
          <ProfileView
            state={productState}
            correctionText={correctionText}
            onCorrectionText={setCorrectionText}
            onAddCorrection={addCorrection}
            onReset={resetData}
            onExport={exportData}
            onImport={importData}
            onPrivacyReport={showPrivacyReport}
            onPurge={purgeData}
            onSetProductState={setProductState}
          />
        )}
      </main>
    </div>
    </>
  );
}

/**
 * P1-12: fold a `final` assistant transcript segment into the live session without
 * collapsing a multi-segment reply to its last segment.
 *
 * A single realtime assistant turn can emit several `final` segments:
 *  - omni (bailian): both `response.audio_transcript.done` and `response.text.done`
 *    fire for one response — usually the SAME text in two modalities (a duplicate),
 *    occasionally distinct;
 *  - livekit: the Python agent ships one `TranscriptionSegment` per sentence — genuine
 *    distinct continuation segments.
 *
 * Rules:
 *  - The FIRST final for a given assistant-turn index replaces that turn's content.
 *  - Later finals for the SAME turn append — UNLESS the segment is already contained in
 *    the accumulated content (the duplicate-modality case), which is skipped so the
 *    spoken+text duplicate doesn't double the reply.
 *  - The turn index advancing (a new user+assistant pair was appended) is what resets
 *    "first final" — so the next turn starts clean.
 *
 * `turnRef` carries the assistant-turn index that has already absorbed a final.
 */
export function appendAssistantTranscriptFinal(
  session: InterviewSession,
  text: string,
  turnRef: MutableRefObject<number>
): InterviewSession {
  const trimmed = text.trim();
  if (!trimmed) {
    return session;
  }
  const turns = [...session.turns];
  const lastIdx = turns.length - 1;
  if (lastIdx < 0 || turns[lastIdx].role !== "assistant") {
    return session;
  }

  const isNewTurn = turnRef.current !== lastIdx;
  const prevContent = turns[lastIdx].content;

  if (isNewTurn) {
    turns[lastIdx] = { ...turns[lastIdx], content: trimmed };
    turnRef.current = lastIdx;
    return { ...session, turns };
  }

  // Same turn, subsequent final: skip the duplicate-modality echo, otherwise append.
  if (prevContent.includes(trimmed) || trimmed.includes(prevContent)) {
    // Prefer the longer of the two so a fuller restatement isn't lost.
    if (trimmed.length > prevContent.length) {
      turns[lastIdx] = { ...turns[lastIdx], content: trimmed };
      return { ...session, turns };
    }
    return session;
  }

  const separator = prevContent && !prevContent.endsWith(" ") ? " " : "";
  turns[lastIdx] = { ...turns[lastIdx], content: `${prevContent}${separator}${trimmed}` };
  return { ...session, turns };
}

function buildLocalAudioTranscriptionDraft(sourceUrl: string) {
  return [
    `主持人：这段音频来自 ${sourceUrl}，当前还没有完成自动转写。`,
    "被访者：请在这里补充被访者的关键原话、停顿和情绪变化。",
    "主持人：补齐后我会分析这段专访如何索要具体时刻、推进反方观点和控制节奏。"
  ].join("\n");
}
