import {
  Archive,
  BookOpen,
  Brain,
  Compass,
  Headphones,
  Mic,
  Search,
  Settings,
  ShieldCheck,
  SlidersHorizontal,
  Upload,
  Volume2
} from "lucide-react";
import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import {
  analyzeImportedInterview,
  approvePlaybookPatch,
  buildCognitiveRadar,
  buildInterviewCard,
  buildMonthlyReview,
  buildRealtimeTurnState,
  buildSearchBrief,
  createSearchBriefFromInput,
  buildSystemStatus,
  buildYearlyReview,
  createQuestionFromNote,
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
  updateInterviewControl,
  updateKnowledgeDebtStatus,
  updatePointStatus,
  updateQuestionStatus
} from "./domain/engine";
import { executeSearchProvider } from "./capabilities/search";
import { createIdleCapabilityTask, startCapabilityTask } from "./capabilities/task";
import { productApiClient, getProductApiBaseUrl, type ReviewsResponse } from "./api/productApi";
import type { RealtimeVoiceSessionResponse, SystemCapabilitiesResponse, SystemConfigResponse, SystemConfigUpdateRequest, VoiceInfo } from "./api/productApi";
import {
  connectBailianRealtimeWebrtc,
  type BailianRealtimeWebrtcConnection
} from "./realtime/bailianWebrtc";
import {
  connectBailianRealtimeWebsocket,
  type BailianRealtimeWebsocketConnection
} from "./realtime/bailianWebsocket";
import { createLivekitVoiceSession, type LivekitVoiceSession } from "./realtime/livekitVoice";
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
  IntelItem,
  InterviewControlAction,
  InterviewMode,
  InterviewSession,
  PodcastSourceType,
  ProductState,
  SearchBriefInput,
  SearchProviderId,
  SystemConfig
} from "./domain/types";
import { AssetsView } from "./features/assets/AssetsView";
import { ConfigView } from "./features/config/ConfigView";
import { CorpusLearningView } from "./features/corpus/CorpusLearningView";
import { HomeView } from "./features/home/HomeView";
import { InterviewView } from "./features/interview/InterviewView";
import { NotesView } from "./features/notes/NotesView";
import { PodcastStudioView } from "./features/podcast/PodcastStudioView";
import { ProfileView } from "./features/profile/ProfileView";
import { SearchIntelligenceView } from "./features/search/SearchIntelligenceView";
import { ThemesView } from "./features/themes/ThemesView";
import { MemoryGovernanceView } from "./features/memory/MemoryGovernanceView";
import { IntelView } from "./features/intel/IntelView";
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
  intel: Search,
  corpus: Upload,
  podcast: Headphones,
  notes: BookOpen,
  assets: Archive,
  themes: Brain,
  memory: Brain,
  config: SlidersHorizontal,
  profile: Settings
};

export default function App() {
  const [productState, setProductState] = useState<ProductState>(() => loadProductState());
  const [apiPersistenceEnabled, setApiPersistenceEnabled] = useState(false);
  const [systemCapabilities, setSystemCapabilities] = useState<SystemCapabilitiesResponse | null>(null);
  const [serverReviews, setServerReviews] = useState<ReviewsResponse | null>(null);
  const [importing, setImporting] = useState(false);
  const [runningTaskId, setRunningTaskId] = useState<string | null>(null);
  const [runtimeConfig, setRuntimeConfig] = useState<SystemConfigResponse | null>(null);
  const [runtimeConfigSaving, setRuntimeConfigSaving] = useState(false);
  const [view, setView] = useState<View>("home");
  const [session, setSession] = useState<InterviewSession | null>(null);
  const [pendingMode, setPendingMode] = useState<InterviewMode>("decision");
  const [notice, setNotice] = useState<UiNotice | null>(null);
  const [interviewInput, setInterviewInput] = useState("");
  const [correctionText, setCorrectionText] = useState("");
  const [assetQuery, setAssetQuery] = useState("");
  const [assetFilter, setAssetFilter] = useState<AssetFilter>("all");
  const [selectedAssetKey, setSelectedAssetKey] = useState<string | undefined>(undefined);
  const [configSection, setConfigSection] = useState<ConfigSection>("overview");
  const [recording, setRecording] = useState(false);
  const [realtimeVoiceSession, setRealtimeVoiceSession] = useState<RealtimeVoiceSessionResponse | null>(null);
  const [realtimeVoiceConnection, setRealtimeVoiceConnection] = useState<BailianRealtimeWebrtcConnection | BailianRealtimeWebsocketConnection | LivekitVoiceSession | null>(null);
  const [livekitVoiceSession, setLivekitVoiceSession] = useState<LivekitVoiceSession | null>(null);
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
  const [podcastNoteId, setPodcastNoteId] = useState(() => productState.notes[0]?.id ?? "");
  const [podcastVoice, setPodcastVoice] = useState(productState.systemConfig.voice.podcastVoice);
  const [podcastSourceType, setPodcastSourceType] = useState<PodcastSourceType>("note");
  const [podcastSourceId, setPodcastSourceId] = useState("");
  const [podcastEditingScript, setPodcastEditingScript] = useState("");
  const [corpusMediaType, setCorpusMediaType] = useState<CorpusImportInput["mediaType"]>("text");
  const [corpusTitle, setCorpusTitle] = useState("优秀专访样本");
  const [corpusSourceUrl, setCorpusSourceUrl] = useState("");
  const [corpusTranscribing, setCorpusTranscribing] = useState(false);
  const [corpusContent, setCorpusContent] = useState(
    "主持人：你刚才说增长很难，能不能讲一个具体时刻？\n被访者：真正困难是团队不敢暴露坏消息。\n主持人：如果反过来看，是不是机制奖励了报喜不报忧？"
  );

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
            // Another writer advanced the server — adopt its newer content wholesale.
            lastSavedContentRef.current = productStateContentSignature(server);
            setProductState(server);
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

  async function importMemoryDocument(title: string, content: string) {
    setImporting(true);
    try {
      const result = await productApiClient.importDocument({ title, content, sourceType: "text" });
      setProductState(result.state);
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
      .then((next) => setProductState(next))
      .catch(() => setNotice(buildNotice("warning", "操作失败", "记忆治理需要后端在线。")));
  }
  const approveCandidate = (id: string) => withMemoryAction(() => productApiClient.approveMemoryCandidate(id));
  const rejectCandidate = (id: string) => withMemoryAction(() => productApiClient.rejectMemoryCandidate(id));
  const editCandidate = (id: string, text: string) => withMemoryAction(() => productApiClient.updateMemoryCandidate(id, text));
  const deprecateRecord = (id: string) => withMemoryAction(() => productApiClient.deprecateMemoryRecord(id));
  const deleteRecord = (id: string) => withMemoryAction(() => productApiClient.deleteMemoryRecord(id));

  async function createIntelTask(name: string, keywords: string[]) {
    try {
      const result = await productApiClient.createIntelTask({ name, keywords });
      setProductState(result.state);
      setApiPersistenceEnabled(true);
      setNotice(buildNotice("success", "情报任务已创建", `「${result.task.name}」已开始监控，点击运行抓取首批情报。`));
    } catch {
      setNotice(buildNotice("warning", "创建失败", "情报中心需要后端在线。"));
    }
  }
  async function runIntelTask(taskId: string) {
    setRunningTaskId(taskId);
    try {
      const result = await productApiClient.runIntelTask(taskId);
      setProductState(result.state);
      setNotice(buildNotice("success", "情报抓取完成", `新增 ${result.count} 条情报。`));
    } catch {
      setNotice(buildNotice("warning", "抓取失败", "需要后端在线且配置搜索 key。"));
    } finally {
      setRunningTaskId(null);
    }
  }
  const deleteIntelTaskHandler = (taskId: string) => withMemoryAction(() => productApiClient.deleteIntelTask(taskId));
  const intelItemStatus = (itemId: string, status: IntelItem["status"]) =>
    withMemoryAction(() => productApiClient.updateIntelItemStatus(itemId, status));
  const intelToDebt = (itemId: string) => withMemoryAction(() => productApiClient.intelItemToDebt(itemId));
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
    [recording, session, audioLevel, voiceStatus, liveUserTranscript, guidanceState]
  );

  // 引导触发时的副作用
  useEffect(() => {
    if (realtimeState?.guidance && !guidanceState.active) {
      setGuidanceState(prev => ({
        active: true,
        kind: realtimeState.guidance!.kind,
        text: realtimeState.guidance!.text,
        countThisTurn: prev.countThisTurn + 1,
        lastTimestamp: new Date().toISOString()
      }));
      const timer = setTimeout(() => {
        setGuidanceState(prev => ({ ...prev, active: false }));
      }, 2500);
      return () => clearTimeout(timer);
    }
  }, [realtimeState?.guidance]);

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
    if (livekitVoiceSession) {
      livekitVoiceSession.interrupt();
      setVoiceStatus("interrupted");
      setTimeout(() => setVoiceStatus("listening"), 1500);
    }
  }

  function prepareInterview(mode: InterviewMode = "decision", searchBriefId = activeSearchBriefId) {
    setPendingMode(mode);
    setActiveSearchBriefId(searchBriefId);
    setSession(null);
    closeRealtimeVoiceSession();
    setView("interview");
  }

  async function startInterview(mode: InterviewMode = pendingMode, searchBriefId = activeSearchBriefId) {
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
    } catch {
      setApiPersistenceEnabled(false);
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
    } catch {
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
    prepareInterview("learning", briefId);
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
    } catch {
      setApiPersistenceEnabled(false);
    }

    const { brief, nextState } = buildSearchBrief(productState, "本周值得讨论的 AI 产品变化", productState.systemConfig.search.activeProvider);
    setProductState(nextState);
    setActiveSearchBriefId(brief.id);
    setNotice(buildNotice("success", "自动简报已生成（本地）", `已选中「${brief.topic}」，可以带入下一次专访。`));
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
    } catch {
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

    const updatedEpisode = {
      ...episode,
      script: podcastEditingScript,
      scriptReviewStatus: "用户确认" as const,
      status: "ready" as const
    };
    const updatedState = {
      ...productState,
      podcastEpisodes: productState.podcastEpisodes.map((ep) =>
        ep.id === episodeId ? updatedEpisode : ep
      )
    };

    try {
      const { state: persisted } = await productApiClient.saveState(updatedState);
      setProductState(persisted);
      setApiPersistenceEnabled(true);
      setPodcastEditingScript("");
      setNotice(buildNotice("success", "语音合成已确认", `播客 "${episode.title}" 脚本已确认，等待 TTS 渲染。`));
      return;
    } catch {
      setApiPersistenceEnabled(false);
    }

    setProductState(updatedState);
    setPodcastEditingScript("");
    setNotice(buildNotice("success", "语音合成已确认", `播客 "${episode.title}" 脚本已确认，等待 TTS 渲染。`));
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

    try {
      const apiRun = await productApiClient.analyzeCorpusImport(input);
      setProductState(apiRun.state);
      setApiPersistenceEnabled(true);
      setNotice(buildNotice("success", "语料分析已完成", "已生成可确认的访谈策略补丁。"));
      setView("corpus");
      return;
    } catch {
      setApiPersistenceEnabled(false);
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
    if (!sourceUrl) {
      setNotice(buildNotice("warning", "需要音频 URL", "请先填写可公网访问的音频文件地址。"));
      return;
    }

    const title = corpusTitle.trim() || "未命名音频专访样本";
    setCorpusMediaType("audio");
    setCorpusTranscribing(true);

    try {
      const apiRun = await productApiClient.transcribeCorpusAudio({
        title,
        sourceUrl,
        languageHint: "zh"
      });
      setCorpusContent(apiRun.transcription.text);
      setNotice(
        apiRun.transcription.status === "ready"
          ? buildNotice("success", "音频转写已完成", `已生成 ${apiRun.transcription.model} 转写稿，可继续分析。`)
          : buildNotice("warning", "音频转写已降级", apiRun.transcription.degradedReason)
      );
      return;
    } catch {
      setApiPersistenceEnabled(false);
      setCorpusContent(buildLocalAudioTranscriptionDraft(sourceUrl));
      setNotice(buildNotice("warning", "音频转写暂不可用", "Product API 未连接，已生成可编辑的手工转写模板。"));
    } finally {
      setCorpusTranscribing(false);
    }
  }

  function removeCorpusInsight(insightId: string) {
    if (typeof window !== "undefined" && !window.confirm("确定要删除这次语料分析吗？已应用的 PlaybookPatch 会保留为历史记录。")) {
      return;
    }
    setProductState(deleteCorpusInsightBundle(productState, insightId));
    setNotice(buildNotice("warning", "语料分析已删除", "已应用的引擎补丁仍会保留。"));
  }

  function applyPlaybookPatch(patchId: string) {
    setProductState(approvePlaybookPatch(productState, patchId));
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

    try {
      const apiRun = await productApiClient.sendInterviewTurn(session.id, { content });
      setSession(apiRun.session.interactionPreSignals
        ? { ...session, interactionPreSignals: apiRun.session.interactionPreSignals }
        : apiRun.session);
      setProductState(apiRun.state);
      setApiPersistenceEnabled(true);
      return;
    } catch {
      setApiPersistenceEnabled(false);
    }

    setSession(receiveUserTurn(session, content));
    setInterviewInput("");
  }

  async function finishInterview() {
    if (!session || session.turns.length === 0) {
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
    } catch {
      setApiPersistenceEnabled(false);
    }

    const result = finalizeSession(productState, session);
    setProductState(result.nextState);
    setSession(null);
    closeRealtimeVoiceSession();
    setNotice(buildNotice("success", "专访档案已生成", "双轨笔记和认知资产已更新。"));
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
    } catch {
      setApiPersistenceEnabled(false);
    }

    setSession(updateInterviewControl(session, action));
    setNotice(buildNotice("info", "访谈控制已应用", `下一轮会按「${controlLabel}」调整。`));
  }

  function saveNoteQuestion(noteId: string, index: number) {
    setProductState(createQuestionFromNote(productState, noteId, index));
    setNotice(buildNotice("success", "问题已保存到资产库", "你可以在问题资产中继续标记状态。"));
    setView("assets");
  }

  function addCorrection() {
    if (!correctionText.trim()) {
      return;
    }
    setProductState(markMemoryCorrection(productState, correctionText.trim()));
    setNotice(buildNotice("success", "记忆修正已保存", "后续访谈会参考这条边界。"));
    setCorrectionText("");
  }

  async function resetData() {
    if (typeof window !== "undefined" && !window.confirm("确定要重置本地演示数据吗？这会清空当前浏览器里的访谈和资产状态。")) {
      return;
    }
    let nextState: ProductState;
    try {
      nextState = await productApiClient.resetState();
      setApiPersistenceEnabled(true);
      saveProductState(nextState);
    } catch {
      setApiPersistenceEnabled(false);
      nextState = resetProductState();
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
    setNotice(buildNotice("warning", "演示数据已重置", "当前浏览器状态已恢复为初始样例。"));
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
        instructions: buildRealtimeVoiceInstructions(session, card),
        voice: productState.systemConfig.voice.defaultVoice
      });
      setRealtimeVoiceSession(voiceSession);
      setApiPersistenceEnabled(true);

      if (voiceSession.status === "ready") {
        const voiceMode = productState.systemConfig.voice.realtimeMode ?? "bailian";
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
                  setSession((prev) => {
                    if (!prev) return prev;
                    return receiveUserTurn(prev, text);
                  });
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
                },
                onAssistantTranscript: (text, isFinal) => {
                  if (!isFinal || !text.trim()) return;
                  setVoiceStatus("speaking");
                  setSession((prev) => {
                    if (!prev) return prev;
                    const turns = [...prev.turns];
                    const lastIdx = turns.length - 1;
                    if (lastIdx >= 0 && turns[lastIdx].role === "assistant") {
                      turns[lastIdx] = { ...turns[lastIdx], content: text };
                    }
                    return { ...prev, turns };
                  });
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
          const connection = voiceSession.transport === "webrtc"
            ? await connectBailianRealtimeWebrtc(voiceSession, { productApiClient })
            : await connectBailianRealtimeWebsocket(voiceSession, {
                productApiBaseUrl: `ws://${location.hostname}:8787`,
                preSignals: session?.interactionPreSignals,
                onAudioLevel: (level) => setAudioLevel(level),
                onSpeechStart: () => setVoiceStatus("listening"),
                onSpeechEnd: () => setVoiceStatus("speaking"),
                onGuidance: (text) => {
                  // Inject guidance whisper via browser SpeechSynthesis.
                  // Short utterances only — long guidance gets shown in UI.
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
                  setNotice(buildNotice("info", "引导", text));
                },
                onUserTranscript: (text, isFinal) => {
                  setLiveUserTranscript(text);
                  if (!isFinal || !text.trim()) return;
                  setSession((prev) => {
                    if (!prev) return prev;
                    const updated = receiveUserTurn(prev, text);
                    const lastTurn = updated.turns[updated.turns.length - 1];
                    if (lastTurn?.role === "assistant" && lastTurn.strategy) {
                      if ("setStrategy" in connection) connection.setStrategy(lastTurn.strategy);
                    }
                    return updated;
                  });
                  // Phase 8: regenerate pre_signals for the next turn and push
                  // them into the live connection (the voice model can't emit them).
                  const voiceSid = session?.id;
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
                  }
                },
                onAssistantTranscript: (text, isFinal) => {
                  if (!isFinal || !text.trim()) return;
                  setSession((prev) => {
                    if (!prev) return prev;
                    const turns = [...prev.turns];
                    const lastAssistantIdx = turns.length - 1;
                    if (lastAssistantIdx >= 0 && turns[lastAssistantIdx].role === "assistant") {
                      turns[lastAssistantIdx] = { ...turns[lastAssistantIdx], content: text };
                    }
                    return { ...prev, turns };
                  });
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
              `${voiceSession.model} · ${voiceSession.transport === "webrtc" ? "WebRTC" : "WebSocket"} 已连接`
            )
          );
        } catch {
          setNotice(
            buildNotice(
              "warning",
              "语音连接失败",
              voiceSession.transport === "webrtc"
                ? "WebRTC 连接失败，可设置 BAILIAN_REALTIME_TRANSPORT=websocket 使用 WebSocket。"
                : "百炼 WebSocket 连接失败。"
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
      return;      return;
    } catch {
      setApiPersistenceEnabled(false);
    }

    setRecording(true);
    setRealtimeVoiceSession(null);
    setNotice(buildNotice("warning", "实时语音已降级", "Product API 不可用，当前仅模拟录音节奏。"));
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
        {view === "home" && (
          <HomeView state={productState} card={card} monthlyReview={monthlyReview} onStart={prepareInterview} />
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
              : realtimeVoiceSession?.transport ?? null
            }
            onInput={setInterviewInput}
            onStart={startInterview}
            onSubmit={submitTurn}
            onFinish={finishInterview}
            onControl={applyInterviewControl}
            onToggleRecording={toggleRealtimeRecording}
            onInterrupt={interruptAssistant}
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
          />
        )}
        {view === "corpus" && (
          <CorpusLearningView
            state={productState}
            mediaType={corpusMediaType}
            title={corpusTitle}
            sourceUrl={corpusSourceUrl}
            content={corpusContent}
            transcribing={corpusTranscribing}
            onMediaType={setCorpusMediaType}
            onTitle={setCorpusTitle}
            onSourceUrl={setCorpusSourceUrl}
            onContent={setCorpusContent}
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
        {view === "notes" && <NotesView state={productState} onStart={prepareInterview} onSaveQuestion={saveNoteQuestion} />}
        {view === "assets" && (
          <AssetsView
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
          />
        )}
        {view === "themes" && <ThemesView state={productState} review={monthlyReview} yearlyReview={yearlyReview} radar={radar} onStart={prepareInterview} />}
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
          />
        )}
        {view === "intel" && (
          <IntelView
            state={productState}
            runningTaskId={runningTaskId}
            onCreate={createIntelTask}
            onRun={runIntelTask}
            onDeleteTask={deleteIntelTaskHandler}
            onItemStatus={intelItemStatus}
            onToDebt={intelToDebt}
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
            onApprovePatch={applyPlaybookPatch}
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
          />
        )}
      </main>
    </div>
    </>
  );
}

function buildRealtimeVoiceInstructions(session: InterviewSession | null, card: ReturnType<typeof buildInterviewCard>) {
  return [
    "你是一个真正的私人专访主持人。",
    "每次只问一个核心问题，优先追具体事件、真实张力和可验证假设。",
    `本次主题：${session?.title ?? card.title}`,
    `为什么现在聊：${card.whyNow}`,
    `建议开场：${card.suggestedOpening}`,
    "不要长篇输出，不要替用户下结论，不要像客服。"
  ].join("\n");
}

function buildLocalAudioTranscriptionDraft(sourceUrl: string) {
  return [
    `主持人：这段音频来自 ${sourceUrl}，当前还没有完成自动转写。`,
    "被访者：请在这里补充被访者的关键原话、停顿和情绪变化。",
    "主持人：补齐后我会分析这段专访如何索要具体时刻、推进反方观点和控制节奏。"
  ].join("\n");
}
