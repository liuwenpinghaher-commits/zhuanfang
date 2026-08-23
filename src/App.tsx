import {
  Archive,
  BookOpen,
  Brain,
  Compass,
  Headphones,
  Library,
  MessagesSquare,
  Mic,
  Monitor,
  Moon,
  Play,
  Search,
  Settings,
  SlidersHorizontal,
  Sun,
  Upload,
  Volume2
} from "lucide-react";
import { MutableRefObject, useEffect, useMemo, useRef, useState } from "react";
import { useOfflineProductSync } from "./hooks/useOfflineProductSync";
import { useSearchBriefActions } from "./hooks/useSearchBriefActions";
import { useCorpusPlaybookActions } from "./hooks/useCorpusPlaybookActions";
import { useInterviewSessionActions } from "./hooks/useInterviewSessionActions";
import { useRealtimeVoiceControls } from "./hooks/useRealtimeVoiceControls";
import {
  buildCognitiveRadar,
  buildInterviewCard,
  buildInterviewResumeCards,
  buildRealtimeTurnState,
  buildSystemStatus,
  countPendingMemoryCandidates,
  createQuestionFromNote,
  markMemoryCorrection,
  pickInterviewLaunchRecommendation,
  receiveUserTurn,
  resolveInterviewTopicHint,
  searchProductAssets,
  toggleAssetImportance,
  interviewLaunchFromAsset,
  knowledgeFocusFromAsset,
  updateDecisionStatus,
  updateKnowledgeDebtStatus,
  updatePointStatus,
  updateQuestionStatus,
  pairPodcastGuestVoice,
  withSystemConfigVersion,
} from "./domain/engine";
import { addAnnotation, removeAnnotation } from "./domain/raw-material";
import { deleteImportSource } from "./domain/material";
import { createIdleCapabilityTask, failCapabilityTask, startCapabilityTask } from "./capabilities/task";
import { productApiClient, isNetworkError, ApiError, type PersistHealthLite, type PurgeReceipt, type ResetReceipt, type ReviewsResponse } from "./api/productApi";
import type { ColdLayerMode, RealtimeVoiceSessionResponse, StateImportResult, SystemCapabilitiesResponse, SystemConfigResponse, SystemConfigUpdateRequest, VoiceInfo } from "./api/productApi";
// WebRTC omni client is incomplete (no callbacks/turn recording); the connect path is
// downlined to WebSocket in startVoiceSession. Type kept for the connection union only.
import type { BailianRealtimeWebrtcConnection } from "./realtime/realtimeTypes";
import type { BailianRealtimeWebsocketConnection } from "./realtime/bailianWebsocket";
import type { LivekitVoiceSession } from "./realtime/livekitVoice";
import type {
  CascadedPipeline,
  TranscriptReviewItem,
  TtsSink
} from "./realtime/cascadedPipeline";
import { runVoiceReviewAction } from "./realtime/voiceReviewAction";
import type { SessionAudioRecorder } from "./realtime/sessionAudioRecorder";
import {
  createVoiceTransportStateGuard,
  type VoiceUiStatus
} from "./realtime/voiceTransportLifecycle";
import {
  dedupeGeneratedArtifacts,
  deleteCorpusInsightBundle,
  deleteSearchBrief
} from "./domain/lifecycle";
import { CACHE_CORRUPTION_MARKER_KEY, isPristineDemoState, loadProductState, normalizeProductState, productStateContentSignature, resetProductState, saveProductState } from "./domain/storage";
// F-05: 持久 outbox + 三方合并 + autosave 退避。离线修改绝不能被远端旧快照静默覆盖。
import {
  backupUnsyncedState,
  clearOfflineOutbox,
  hasUnsyncedLocalChanges,
  nextBackoffMs,
  readOfflineOutbox,
  reconcileOfflineOutbox,
  upsertOfflineOutbox,
  writeOfflineOutbox,
  type OfflineOutbox,
  type OfflineSyncConflict
} from "./domain/offline-sync";
import type {
  AssetStatus,
  ChatCitation,
  CorpusImportInput,
  InterviewControlAction,
  InterviewMode,
  InterviewSession,
  KnowledgeSourceType,
  PodcastEpisode, PodcastSourceType,
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
import { MaterialLibraryView } from "./features/material/MaterialLibraryView";
import { AssetChatView, ASSET_CHAT_DRAFT_ID } from "./features/chat/AssetChatView";
import { deleteChatSession } from "./domain/knowledge";
import { buildTrackWorkspace } from "./domain/timeline";
import {
  buildNotice,
  groupedNavigation,
  type AssetFilter,
  type ConfigSection,
  type UiNotice,
  type View
} from "./ui";
import {
  applyDocumentTheme,
  cycleThemePreference,
  getSystemTheme,
  readStoredThemePreference,
  resolveTheme,
  themePreferenceLabel,
  themeToggleAriaLabel,
  writeStoredThemePreference,
  type ResolvedTheme,
  type ThemePreference
} from "./theme";

const navIconByView: Record<View, typeof Compass> = {
  home: Compass,
  interview: Mic,
  search: Search,
  corpus: Upload,
  podcast: Headphones,
  notes: BookOpen,
  material: Library,
  "asset-chat": MessagesSquare,
  "my-assets": Archive,
  themes: Brain,
  memory: Brain,
  config: SlidersHorizontal,
  profile: Settings,
  track: Brain
};

interface SyncConflictState {
  outbox: OfflineOutbox;
  remoteState: ProductState;
  mergedState: ProductState;
  conflicts: OfflineSyncConflict[];
}

export default function App() {
  const startupOutboxRef = useRef<OfflineOutbox | null>(null);
  const [productState, setProductState] = useState<ProductState>(() => {
    // 未决 outbox 是离线工作的权威本地副本；普通 localStorage state 可能已被一次错误
    // 采纳远端覆盖。启动时优先恢复 outbox.localState，直到重连合并/用户裁决完成。
    const pending = readOfflineOutbox();
    startupOutboxRef.current = pending;
    return pending?.localState ?? loadProductState();
  });
  const [apiPersistenceEnabled, setApiPersistenceEnabled] = useState(false);
  const [systemCapabilities, setSystemCapabilities] = useState<SystemCapabilitiesResponse | null>(null);
  const [serverReviews, setServerReviews] = useState<ReviewsResponse | null>(null);
  // P3-08:LLM 复盘取不到时静默退回确定性本地复盘——旅程8失败此前零信号。用此标记让复盘视图
  // 如实标注"本地生成(LLM 复盘暂不可用)",而不是让用户误以为看的是 LLM 综述。
  const [reviewsError, setReviewsError] = useState<string | null>(null);
  const [reviewsLoading, setReviewsLoading] = useState(false);
  /** 手动重试复盘（不依赖资产签名变化）。 */
  const [reviewsNonce, setReviewsNonce] = useState(0);
  const [importing, setImporting] = useState(false);
  const [runtimeConfig, setRuntimeConfig] = useState<SystemConfigResponse | null>(null);
  const [runtimeConfigSaving, setRuntimeConfigSaving] = useState(false);
  const [productConfigSaving, setProductConfigSaving] = useState(false);
  const [view, setView] = useState<View>("home");
  const [themePreference, setThemePreference] = useState<ThemePreference>(() => readStoredThemePreference());
  const [systemTheme, setSystemTheme] = useState<ResolvedTheme>(() => getSystemTheme());
  const resolvedTheme = useMemo(
    () => resolveTheme(themePreference, systemTheme),
    [themePreference, systemTheme]
  );
  const [session, setSession] = useState<InterviewSession | null>(null);
  const [pendingMode, setPendingMode] = useState<InterviewMode>("decision");
  const [notice, setNotice] = useState<UiNotice | null>(null);
  // N-02:权威库(surreal)落库健康度——degraded 期间常驻顶栏警告(独立持久状态,区别于一次性 notice)。
  // 由低频轮询 route-agnostic 的 GET /api/health 驱动(见下方 health 轮询 effect):后端仅在
  // consecutiveFailures>0 时带 persist.degraded → 亮灯,健康/内存档/离线 → null 清零。轮询覆盖全部
  // "200+异步落库"写路径(资产确认/记忆编辑等从不 PUT /api/state,却共享同一 persistQueue)。
  const [persistHealth, setPersistHealth] = useState<PersistHealthLite | null>(null);
  const [interviewInput, setInterviewInput] = useState("");
  const [failedTurnContent, setFailedTurnContent] = useState<string | null>(null);
  const [submittingTurn, setSubmittingTurn] = useState(false);
  const [startingInterview, setStartingInterview] = useState(false);
  // 同步防重入:setStartingInterview 是异步 state,挡不住"创建请求在途时"的二次触发(双击 /
  // 快速重渲染),会创建多个空 session。startInterview 入口用这个 ref 同步短路。
  const startingRef = useRef(false);
  const pendingSessionCreateRef = useRef<{
    id: string;
    signature: string;
  } | null>(null);
  // P3-19:录音开关同步防重入。开始录音的连接建立(创建 voice session + 连 ASR/TTS WS)是异步的,
  // recording state 要等连接就绪才置 true——期间双击/快速重渲染会开出两条 pipeline、两个 getUserMedia
  // (mic 泄漏)。与 startingRef 同构:进"开始"分支前同步短路,连接流程 settle 后在 finally 复位。
  const togglingRef = useRef(false);
  // 同步防重入:/end 要调真实 LLM 做档案抽取(数秒),用户等不及会重复点"结束"。没有这个 guard,
  // 第一次成功 completed 后,后续点击全部 409(已结束)→ "结束失败"提示覆盖成功 → 诱导继续点。
  const finishingRef = useRef(false);
  const [finishingInterview, setFinishingInterview] = useState(false); // UI:结束按钮显示"正在生成档案…"
  const [lastInterviewSummary, setLastInterviewSummary] = useState<null | {
    noteTitle: string;
    pendingMemory: number;
    destination: "notes" | "memory";
    doNotSave: boolean;
    finishedAt: string;
  }>(null);
  const [correctionText, setCorrectionText] = useState("");
  const [assetQuery, setAssetQuery] = useState("");
  const [assetFilter, setAssetFilter] = useState<AssetFilter>("all");
  const [assetImportantOnly, setAssetImportantOnly] = useState(false);
  const [assetSortMode, setAssetSortMode] = useState<"updated-desc" | "important-first">("updated-desc");
  const [selectedAssetKey, setSelectedAssetKey] = useState<string | undefined>(undefined);
  const [confirmingDecisionId, setConfirmingDecisionId] = useState<string | undefined>(undefined);
  const [configSection, setConfigSection] = useState<ConfigSection>("status");
  const [selectedTrackId, setSelectedTrackId] = useState<string | null>(null);
  /** 从双轨笔记「打开专访档案」跳入我的资产时高亮对应场次。 */
  const [archiveFocusSessionId, setArchiveFocusSessionId] = useState<string | null>(null);
  /** 从素材库「去审核」跳入记忆时，优先展示该 import source 的候选。 */
  const [memoryFocusSourceId, setMemoryFocusSourceId] = useState<string | null>(null);
  /** 从资产对话 citation 跳入记忆时高亮已确认记忆。 */
  const [memoryFocusRecordId, setMemoryFocusRecordId] = useState<string | null>(null);
  /** 从资产对话 citation 跳入素材库时展开对应素材。 */
  const [materialFocusSourceId, setMaterialFocusSourceId] = useState<string | null>(null);
  /** 跨模块带入资产对话的预填问句。 */
  const [assetChatPrefill, setAssetChatPrefill] = useState<string | null>(null);
  const [assetChatFocus, setAssetChatFocus] = useState<{
    sourceType: KnowledgeSourceType;
    sourceId: string;
  } | null>(null);
  const [recording, setRecording] = useState(false);
  const [realtimeVoiceSession, setRealtimeVoiceSession] = useState<RealtimeVoiceSessionResponse | null>(null);
  const [realtimeVoiceConnection, setRealtimeVoiceConnection] = useState<BailianRealtimeWebrtcConnection | BailianRealtimeWebsocketConnection | LivekitVoiceSession | null>(null);
  const [livekitVoiceSession, setLivekitVoiceSession] = useState<LivekitVoiceSession | null>(null);
  // Cascade pipeline instance — held in a ref so closing it doesn't trigger re-render.
  const cascadePipelineRef = useRef<CascadedPipeline | null>(null);
  const voiceTransportStateGuardRef = useRef(createVoiceTransportStateGuard());
  // Whole-session voice recorder — held in a ref so its lifecycle is decoupled from
  // render. Only set when the cascade ASR tees us a live mic stream (voice path);
  // null on the text path so we naturally skip recording. Recording is best-effort:
  // a failed start/stop/upload must never block ending the interview.
  const audioRecorderRef = useRef<SessionAudioRecorder | null>(null);
  // Host (interviewer) TTS sink — held in a ref so finishInterview() can drain its
  // side-channel PCM tap into a WAV and upload it as role=interviewer. Only set on
  // the voice path; null on the text path (no TTS) → interviewer upload skipped.
  const ttsSinkRef = useRef<TtsSink | null>(null);
  // P1-12: which assistant turn index has already absorbed a `final` transcript
  // segment. A realtime turn can emit MULTIPLE finals (omni: audio_transcript.done
  // + text.done; livekit: one TranscriptionSegment per sentence) — the first final
  // for a given turn REPLACES the turn content, later finals APPEND, so a multi-part
  // reply isn't collapsed to its last segment. Reset implicitly: when the assistant
  // turn index advances (a new user+assistant pair was appended) the first final
  // again replaces. A ref (not state) so accumulation never triggers a re-render race.
  const assistantTranscriptTurnRef = useRef<number>(-1);
  const [audioLevel, setAudioLevel] = useState(0);
  const [voiceStatus, setVoiceStatus] = useState<VoiceUiStatus>("idle");
  const [liveUserTranscript, setLiveUserTranscript] = useState("");
  const [voiceReviewItem, setVoiceReviewItem] = useState<TranscriptReviewItem | null>(null);
  const voiceReviewItemRef = useRef<TranscriptReviewItem | null>(null);
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
  const [podcastGuestVoice, setPodcastGuestVoice] = useState(
    () =>
      productState.systemConfig.voice.podcastGuestVoice ??
      pairPodcastGuestVoice(productState.systemConfig.voice.podcastVoice)
  );
  const [podcastSourceType, setPodcastSourceType] = useState<PodcastSourceType>("note");
  const [podcastSourceId, setPodcastSourceId] = useState("");
  const [podcastFormat, setPodcastFormat] = useState<PodcastEpisode["format"]>("solo");
  const [podcastEditingScript, setPodcastEditingScript] = useState("");
  const [episodeVoice, setEpisodeVoice] = useState("");
  const [episodeGuestVoice, setEpisodeGuestVoice] = useState("");
  const [podcastActiveEpisodeId, setPodcastActiveEpisodeId] = useState<string | null>(null);
  const [podcastGenerating, setPodcastGenerating] = useState(false);
  const [podcastSynthesizing, setPodcastSynthesizing] = useState(false);
  const [podcastConfirming, setPodcastConfirming] = useState(false);
  const [podcastDeletingId, setPodcastDeletingId] = useState<string | null>(null);
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
  const [chatSessionId, setChatSessionId] = useState<string | null>(null);
  /** 语料分析成功后高亮并滚到对应 insight。 */
  const [corpusFocusInsightId, setCorpusFocusInsightId] = useState<string | null>(null);
  // 引用跳源:逐字稿引用点击后,要在双轨笔记里展开的会话 + 高亮的轮次。
  // nonce 每次点击自增,使 NotesView 的 effect 即便 sessionId/turnId 未变(连点同一引用)也重新触发滚动高亮。
  const [notesFocus, setNotesFocus] = useState<{ sessionId: string; turnId?: string; nonce: number } | null>(null);

  function episodeGuestDraft(episode: PodcastEpisode): string {
    const stored = episode.guestVoice?.trim();
    if (stored) return stored;
    if (episode.format === "host-guest") return pairPodcastGuestVoice(episode.voice);
    return "";
  }

  function openEpisodeDraft(episode: PodcastEpisode) {
    setPodcastActiveEpisodeId(episode.id);
    setPodcastEditingScript(episode.script);
    setEpisodeVoice(episode.voice);
    setEpisodeGuestVoice(episodeGuestDraft(episode));
  }

  useEffect(() => {
    applyDocumentTheme(resolvedTheme);
  }, [resolvedTheme]);

  useEffect(() => {
    writeStoredThemePreference(themePreference);
  }, [themePreference]);

  // URL state: my-assets keeps filter/sort; material/other views write ?view= to avoid sticky my-assets.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const applyFromUrl = () => {
      const params = new URLSearchParams(window.location.search);
      const v = params.get("view");
      if (v === "my-assets" || v === "assets") {
        setView("my-assets");
      } else if (v === "material") {
        setView("material");
      } else if (v === "memory") {
        setView("memory");
      } else if (v === "notes") {
        setView("notes");
      } else if (v === "themes") {
        setView("themes");
      } else if (v === "asset-chat") {
        setView("asset-chat");
        const chat = params.get("chat");
        if (chat === ASSET_CHAT_DRAFT_ID || chat === "new") {
          setChatSessionId(ASSET_CHAT_DRAFT_ID);
        } else if (chat) {
          setChatSessionId(chat);
        }
      } else if (v === "config") {
        setView("config");
      } else if (v === "corpus") {
        setView("corpus");
      } else if (v === "profile") {
        setView("profile");
      } else if (v === "interview") {
        setView("interview");
      } else if (v === "search") {
        setView("search");
      } else if (v === "podcast") {
        setView("podcast");
      } else if (v === "track") {
        setView("track");
      } else if (v === "home") {
        setView("home");
      }
      const f = params.get("filter");
      if (f === "all" || f === "points" || f === "questions" || f === "decisions" || f === "debts") {
        setAssetFilter(f);
      }
      if (params.get("important") === "1") setAssetImportantOnly(true);
      if (params.get("important") === "0") setAssetImportantOnly(false);
      const s = params.get("sort");
      if (s === "updated-desc" || s === "important-first") setAssetSortMode(s);
    };
    applyFromUrl();
    window.addEventListener("popstate", applyFromUrl);
    return () => window.removeEventListener("popstate", applyFromUrl);
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    if (view === "my-assets") {
      params.set("view", "my-assets");
      params.set("filter", assetFilter);
      params.set("important", assetImportantOnly ? "1" : "0");
      params.set("sort", assetSortMode);
      params.delete("chat");
    } else if (view === "asset-chat") {
      params.set("view", "asset-chat");
      params.delete("filter");
      params.delete("important");
      params.delete("sort");
      if (chatSessionId && chatSessionId !== ASSET_CHAT_DRAFT_ID) {
        params.set("chat", chatSessionId);
      } else if (chatSessionId === ASSET_CHAT_DRAFT_ID) {
        params.set("chat", "new");
      } else {
        params.delete("chat");
      }
    } else {
      // Prevent sticky my-assets query from hijacking refresh while on 素材库 etc.
      params.set("view", view);
      params.delete("filter");
      params.delete("important");
      params.delete("sort");
      params.delete("chat");
    }
    const next = `${window.location.pathname}?${params.toString()}`;
    const cur = `${window.location.pathname}${window.location.search}`;
    if (next !== cur) {
      window.history.replaceState(null, "", next);
    }
  }, [view, assetFilter, assetImportantOnly, assetSortMode, chatSessionId]);

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => setSystemTheme(mq.matches ? "dark" : "light");
    onChange();
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  useEffect(() => {
    saveProductState(productState);
  }, [productState]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    let cancelled = false;
    const poll = async () => {
      try {
        const health = await productApiClient.getHealth();
        if (cancelled) return;
        if (health.persist?.degraded && health.persist.consecutiveFailures > 0) {
          setPersistHealth({
            consecutiveFailures: health.persist.consecutiveFailures,
            lastErrorAt: health.persist.lastErrorAt
          });
        } else {
          setPersistHealth(null);
        }
      } catch {
        // 健康接口自己失败不等于落库失败，不亮存盘红灯。
      }
    };
    void poll();
    const timer = window.setInterval(() => void poll(), 15_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    if (view !== "config") return;
    let cancelled = false;
    setVoicesLoading(true);
    productApiClient
      .listVoices()
      .then((list) => {
        if (cancelled) return;
        const custom = Array.isArray(list.custom) ? list.custom : [];
        const preset = Array.isArray(list.preset) ? list.preset : [];
        setVoices([...custom, ...preset]);
      })
      .catch((err) => {
        if (cancelled) return;
        console.warn(JSON.stringify({
          event: "list_voices_failed",
          error: err instanceof Error ? err.message : String(err)
        }));
        setNotice(buildNotice("warning", "音色列表未能刷新", "稍后打开系统配置再试。已复刻的声音还在服务器上。"));
      })
      .finally(() => {
        if (!cancelled) setVoicesLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [view]);

  useEffect(() => {
    if (view !== "themes") return;
    let cancelled = false;
    setReviewsLoading(true);
    productApiClient
      .getReviews()
      .then((payload) => {
        if (cancelled) return;
        setServerReviews(payload);
        setReviewsError(null);
      })
      .catch((err) => {
        if (cancelled) return;
        setServerReviews(null);
        const conflict = err instanceof ApiError;
        const body = conflict && err.body && typeof err.body === "object"
          ? (err.body as { error?: unknown }).error
          : undefined;
        setReviewsError(
          typeof body === "string" && body.trim()
            ? body
            : isNetworkError(err)
              ? "复盘暂时连不上服务器。"
              : "复盘暂时不可用。"
        );
      })
      .finally(() => {
        if (!cancelled) setReviewsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [view, reviewsNonce]);

  const podcastViewEnteredRef = useRef(false);
  useEffect(() => {
    if (view !== "podcast") {
      podcastViewEnteredRef.current = false;
      return;
    }
    if (podcastViewEnteredRef.current) return;
    podcastViewEnteredRef.current = true;
    if (podcastActiveEpisodeId) return;
    const pending = productState.podcastEpisodes.find((item) => item.scriptReviewStatus === "待确认");
    if (!pending) return;
    openEpisodeDraft(pending);
  }, [view, podcastActiveEpisodeId, productState.podcastEpisodes]);

  const productStateRef = useRef(productState);
  productStateRef.current = productState;

  const {
    syncConflict,
    syncResolving,
    lastSavedContentRef,
    offlineOutboxRef,
    lastSyncedStateRef,
    offlineObservedSignatureRef,
    outboxStagingFailedRef,
    acceptAuthoritativeState,
    acknowledgeSavedState,
    synchronizeOfflineOutbox,
    stageOfflineState,
    clearPendingSync,
    writePendingOutbox,
    scheduleReconnectProbe,
    shouldProbeReconnect,
    keepLocalConflictVersion,
    useRemoteConflictVersion,
    alignOfflineBaseline,
    flushPendingProductState
  } = useOfflineProductSync({
    productState,
    setProductState,
    productStateRef,
    apiPersistenceEnabled,
    setApiPersistenceEnabled,
    setNotice,
    initialOutbox: startupOutboxRef.current
  });

  /** 细粒度 route 成功回执：无 pending 则整态采纳；有 pending 则当 remote 走三方合并。 */
  function adoptServerState(next: ProductState) {
    const pending = offlineOutboxRef.current;
    if (!pending) {
      acceptAuthoritativeState(next);
      return;
    }
    void synchronizeOfflineOutbox(pending, next).catch((err) => {
      setApiPersistenceEnabled(false);
      setNotice(
        buildNotice(
          "warning",
          "服务端更新已收到，但本地同步未完成",
          err instanceof Error ? err.message : String(err)
        )
      );
      if (shouldProbeReconnect(err)) {
        scheduleReconnectProbe();
      }
    });
  }

  async function saveProfile(nextState: ProductState): Promise<ProductState> {
    try {
      const result = await productApiClient.saveState(nextState);
      if (result.conflicted) {
        throw new Error("服务器版本已更新，档案未保存。请刷新后重试。");
      }
      acceptAuthoritativeState(result.state);
      return result.state;
    } catch (error) {
      if (isNetworkError(error)) {
        setApiPersistenceEnabled(false);
        scheduleReconnectProbe();
      }
      throw error;
    }
  }


  const {
    selectCorpusAudioFile,
    clearCorpusAudioFile,
    removeCorpusInsight,
    applyPlaybookPatch,
    revertPatch,
    cleanupGeneratedArtifacts
  } = useCorpusPlaybookActions({
    productState,
    setProductState,
    setNotice,
    setView: setView as any,
    setCorpusAudioBase64,
    setCorpusAudioFileName,
    setCorpusMediaType: setCorpusMediaType as any,
    setCorpusSourceUrl,
    adoptServerState
  });

  // 本地缓存损坏如实告知（loadProductState 在 useState 初始化器里发现 JSON 损坏时
  // 只能落 sessionStorage 标记）：挂载后检查标记 → 明确提示，不把"本地数据损坏"
  // 掩盖成"看起来正常的初始数据"。服务端在线时首次同步会恢复权威数据。
  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      const corruptedAt = window.sessionStorage.getItem(CACHE_CORRUPTION_MARKER_KEY);
      if (corruptedAt) {
        window.sessionStorage.removeItem(CACHE_CORRUPTION_MARKER_KEY);
        setNotice(buildNotice(
          "danger",
          "本地缓存已损坏",
          "浏览器缓存的数据无法解析，已回退到初始状态。后端在线时会在首次同步恢复服务器数据；若后端也不可用，请勿继续编辑以免混淆。"
        ));
      }
    } catch {
      // sessionStorage 不可用:无标记可读,console 里已有 local_cache_corrupted 信号。
    }
  }, []);

  // 语音路径每轮 pre_signals / 指令刷新失败：实时对话不中断（显式实时策略），
  // 但失败必须可观测——结构化日志逐次记录，连续第 2 次失败向用户提示一次
  // "读不到最新资料"，绝不让记忆召回静默滞留在开场快照。成功后计数归零。
  const voiceRecallFailuresRef = useRef(0);
  const voiceStaleNoticeShownRef = useRef(false);
  function voiceRecallRefreshFailed(kind: "pre_signals" | "voice_instructions", err: unknown) {
    voiceRecallFailuresRef.current += 1;
    console.warn(JSON.stringify({
      event: "voice_recall_refresh_failed",
      kind,
      consecutive: voiceRecallFailuresRef.current,
      error: err instanceof Error ? err.message : String(err)
    }));
    if (voiceRecallFailuresRef.current >= 2 && !voiceStaleNoticeShownRef.current) {
      voiceStaleNoticeShownRef.current = true;
      setNotice(buildNotice("warning", "语音记忆刷新失败", "暂时读取不到你最新的资料，后续追问可能引用不到最近内容。"));
    }
  }
  function voiceRecallRefreshSucceeded() {
    voiceRecallFailuresRef.current = 0;
  }

  // 语音路径（omni/livekit）record-turn 落库失败：保留本地 fork 保证对话连续性，
  // 但绝不静默——服务端会话已缺了这一轮，归档会缺内容，日志与用户提示都要有信号。
  function recordTurnFailedFallback(text: string, err: unknown) {
    console.warn(
      JSON.stringify({
        event: "record_turn_failed",
        error: err instanceof Error ? err.message : String(err)
      })
    );
    setNotice(buildNotice("warning", "这一轮未写入服务端记录", "归档时可能缺失该轮内容。"));
    setSession((prev) => (prev ? receiveUserTurn(prev, text) : prev));
  }

  // 引用跳源：切到对应视图并尽量精确 focus（笔记场次 / 记忆 id / 素材 / 资产 key / 主题 Track）。
  // Phase A: launch + card share cognitive revisit queue (not ad-hoc theme heat only).
  const launchRecommendation = useMemo(
    () =>
      pickInterviewLaunchRecommendation(productState, {
        ...(activeSearchBriefId ? { searchBriefId: activeSearchBriefId } : {})
      }),
    [activeSearchBriefId, productState]
  );
  const revisitQueue = launchRecommendation.queue;
  const pendingMemoryCount = useMemo(
    () => countPendingMemoryCandidates(productState),
    [productState]
  );
  const suggestedTopicHint = useMemo(() => {
    if (activeSearchBriefId) {
      return resolveInterviewTopicHint(productState, { searchBriefId: activeSearchBriefId });
    }
    return (
      launchRecommendation.topicHint ||
      resolveInterviewTopicHint(productState, {})
    );
  }, [activeSearchBriefId, launchRecommendation.topicHint, productState]);
  // Card auto path: omit user topicHint so buildInterviewCard consumes revisit queue.
  const card = useMemo(
    () => buildInterviewCard(productState, activeSearchBriefId, undefined),
    [activeSearchBriefId, productState]
  );
  const recommendedLaunch = useMemo(
    () => ({
      mode: launchRecommendation.mode,
      reason: launchRecommendation.reason,
      topicHint: launchRecommendation.topicHint,
      relatedThemeIds: launchRecommendation.relatedThemeIds
    }),
    [launchRecommendation]
  );
  // Resume: surface every unfinished session; keeping only the newest one hid older active work.
  const resumeCards = useMemo(() => buildInterviewResumeCards(productState), [productState]);
  // 认知雷达是本地确定性真实计数（非 LLM 叙事），始终可算可渲染。
  const localRadar = useMemo(() => buildCognitiveRadar(productState), [productState]);
  // LLM 综述只认服务端产出——不可用就把真实原因暴露给用户（reviewsError），
  // 绝不用本地确定性模板叙事顶替冒充。
  const monthlyReview = serverReviews?.monthly ?? null;
  const yearlyReview = serverReviews?.yearly ?? null;
  const radar = serverReviews?.radar ?? localRadar;

  const {
    closeRealtimeVoiceSession,
    interruptAssistant,
    toggleRealtimeRecording,
    refreshLiveVoiceInstructions
  } = useRealtimeVoiceControls({
    session,
    setSession,
    productState,
    card,
    recording,
    setRecording,
    voiceStatus,
    setVoiceStatus,
    realtimeVoiceSession,
    setRealtimeVoiceSession,
    realtimeVoiceConnection,
    setRealtimeVoiceConnection,
    livekitVoiceSession,
    setLivekitVoiceSession,
    cascadePipelineRef,
    voiceTransportStateGuardRef,
    audioRecorderRef,
    ttsSinkRef,
    assistantTranscriptTurnRef,
    voiceReviewItemRef,
    setVoiceReviewItem,
    setLiveUserTranscript,
    setAudioLevel,
    setInterviewInput,
    setFailedTurnContent,
    setGuidanceState,
    setNotice,
    setApiPersistenceEnabled,
    togglingRef,
    adoptServerState,
    recordTurnFailedFallback,
    voiceRecallRefreshSucceeded,
    voiceRecallRefreshFailed
  });

  const {
    continueInterview,
    discardEmptyInterview,
    launchInterview,
    startInterview,
    submitTurn,
    finishInterview,
    applyInterviewControl,
    suppressRevisit
  } = useInterviewSessionActions({
    productState,
    setProductState,
    session,
    setSession,
    pendingMode,
    setPendingMode,
    activeSearchBriefId,
    setActiveSearchBriefId,
    recommendedMode: recommendedLaunch.mode,
    interviewInput,
    setInterviewInput,
    setFailedTurnContent,
    setSubmittingTurn,
    setStartingInterview,
    setFinishingInterview,
    setLastInterviewSummary,
    setNotice,
    setView,
    setApiPersistenceEnabled,
    startingRef,
    finishingRef,
    pendingSessionCreateRef,
    audioRecorderRef,
    ttsSinkRef,
    cascadePipelineRef,
    adoptServerState,
    closeRealtimeVoiceSession,
    scheduleReconnectProbe,
    onControlApplied: refreshLiveVoiceInstructions,
    flushPendingProductState
  });

  const {
    retrySearchMaterial,
    startFromBrief,
    briefToDebt,
    briefToPoint,
    briefToQuestion,
    removeSearchBrief,
    setDefaultSearchProvider
  } = useSearchBriefActions({
    productState,
    setProductState,
    setNotice,
    setActiveSearchBriefId,
    launchInterview: (mode, briefId) => {
      void launchInterview(mode, briefId);
    },
    createSearchMaterial: (providerId) => {
      void createSearchMaterial(providerId);
    },
    searchTaskProviderId: (searchTask.providerId as SearchProviderId | undefined),
    defaultSearchProvider: productState.systemConfig.search.activeProvider
  });

  function handleCitationClick(citation: ChatCitation) {
    const label = citation.sourceLabel ?? citation.sourceType;
    if (citation.sourceType === "transcript") {
      const [sessionId, turnId] = citation.sourceId.split("#");
      if (sessionId) {
        setNotesFocus((prev) => ({ sessionId, ...(turnId ? { turnId } : {}), nonce: (prev?.nonce ?? 0) + 1 }));
      }
      setView("notes");
    } else if (citation.sourceType === "note") {
      const note = productState.notes.find((n) => n.id === citation.sourceId);
      const sessionId = note?.sessionId;
      if (sessionId) {
        setNotesFocus((prev) => ({ sessionId, nonce: (prev?.nonce ?? 0) + 1 }));
      }
      setView("notes");
    } else if (citation.sourceType === "memory") {
      setMemoryFocusRecordId(citation.sourceId);
      setMemoryFocusSourceId(null);
      setView("memory");
    } else if (citation.sourceType === "material") {
      setMaterialFocusSourceId(citation.sourceId);
      setView("material");
    } else if (citation.sourceType === "theme") {
      openTrack(citation.sourceId);
      setNotice(buildNotice("info", "已定位来源", `${citation.title}（${label}）`));
      return;
    } else if (citation.sourceType === "point") {
      setSelectedAssetKey(`points:${citation.sourceId}`);
      setAssetFilter("points");
      setView("my-assets");
    } else if (citation.sourceType === "decision") {
      setSelectedAssetKey(`decisions:${citation.sourceId}`);
      setAssetFilter("decisions");
      setView("my-assets");
    } else if (citation.sourceType === "debt") {
      setSelectedAssetKey(`debts:${citation.sourceId}`);
      setAssetFilter("debts");
      setView("my-assets");
    } else {
      setView("my-assets");
    }
    setNotice(buildNotice("info", "已定位来源", `${citation.title}（${label}）`));
  }

  function openAssetChat(opts?: {
    prefill?: string;
    focusSource?: { sourceType: KnowledgeSourceType; sourceId: string } | null;
  }) {
    setChatSessionId(ASSET_CHAT_DRAFT_ID);
    setAssetChatFocus(opts?.focusSource ?? null);
    if (opts?.prefill?.trim()) {
      setAssetChatPrefill(opts.prefill.trim());
    }
    setView("asset-chat");
  }

  async function importMemoryDocument(title: string, content: string) {
    setImporting(true);
    try {
      const result = await productApiClient.importDocument({ title, content, sourceType: "text" });
      adoptServerState(result.state);
      setApiPersistenceEnabled(true);
      // Journey honesty: surface embedding coverage instead of always "success".
      if (result.warning || result.embeddingReady === false) {
        const coverage =
          typeof result.embeddedChunkCount === "number" && typeof result.chunkCount === "number"
            ? `向量 ${result.embeddedChunkCount}/${result.chunkCount}。`
            : "";
        setNotice(
          buildNotice(
            "warning",
            "导入完成（向量未就绪）",
            `${coverage}${result.warning ?? "跨会话向量召回可能暂不可用；候选记忆仍可审核。"} 已抽取 ${result.candidateCount} 条候选。`
          )
        );
      } else {
        setNotice(
          buildNotice(
            "success",
            "导入完成",
            `抽取了 ${result.candidateCount} 条候选记忆${
              typeof result.embeddedChunkCount === "number" ? `，向量 ${result.embeddedChunkCount} 段` : ""
            }。可在素材库点「去审核」，或前往「记忆」。`
          )
        );
      }
      return {
        sourceId: result.sourceId,
        candidateCount: result.candidateCount,
        chunkCount: result.chunkCount,
        embeddedChunkCount: result.embeddedChunkCount,
        embeddingReady: result.embeddingReady,
        warning: result.warning
      };
    } catch (err) {
      const detail =
        err instanceof ApiError
          ? (() => {
              const body = err.body as { error?: unknown } | undefined;
              if (body && typeof body.error === "string" && body.error.trim()) return body.error.trim();
              if (err.status === 503) return "复盘/导入 LLM 未配置或不可用（常见于缺少 DASHSCOPE_API_KEY）。";
              if (err.status === 429) return "本时段导入 LLM 预算已用尽，请稍后重试。";
              if (err.status === 422) return "正文为空或超过上限，请检查后重试。";
              if (err.status >= 500) return `服务端导入失败（${err.status}）。`;
              return err.message;
            })()
          : err instanceof Error && err.message
            ? err.message
            : "需要后端在线才能导入并抽取候选记忆。";
      setNotice(buildNotice("warning", "导入失败", detail));
      throw err instanceof Error ? err : new Error(detail);
    } finally {
      setImporting(false);
    }
  }

  function withMemoryAction(
    run: () => Promise<
      | ProductState
      | {
          state: ProductState;
          warning?: string;
          embeddingReady?: boolean;
          vectorRecallAvailable?: boolean;
        }
    >
  ) {
    // P3-03:返回链——让 MemoryGovernanceView 的 loading/done/error 状态机能真正 await 到完成
    //(此前返回 undefined,await 立即 resolve → loading/done 瞬时假信号、error 永不触发、防重入窗口≈0)。
    // P3-02:区分业务冲突(409/422/404:记忆状态已变,重试无益)与后端离线,不再一律"需要后端在线"。
    // rethrow 让 await 侧(approve/reject/编辑候选)的 catch 落到 error 状态;fire-and-forget 侧
    //(deprecate/delete)在各自调用点 .catch 兜底,避免未处理 rejection。
    return run()
      .then((next) => {
        const payload =
          next && typeof next === "object" && "state" in (next as object)
            ? (next as {
                state: ProductState;
                warning?: string;
                embeddingReady?: boolean;
                vectorRecallAvailable?: boolean;
                blocked?: boolean;
                candidate?: { status?: string };
                record?: unknown;
              })
            : null;
        const state = payload ? payload.state : (next as ProductState);
        adoptServerState(state);
        // Conflict approve must never look like success (domain may leave candidate pending).
        if (payload?.blocked === true) {
          setNotice(
            buildNotice(
              "warning",
              "确认已拦截",
              "候选与用户修正冲突，未写入长期记忆。请拒绝或改写后再确认。"
            )
          );
          return;
        }
        const confirmed =
          payload?.record != null ||
          payload?.candidate?.status === "approved" ||
          // Non-approve memory actions return bare ProductState (no payload wrapper fields).
          !payload;
        // R-P2-06: surface approve embedding warnings only after a real confirm.
        if (payload?.warning && confirmed) {
          setNotice(buildNotice("warning", "已处理，但需注意", payload.warning));
        } else if (payload && payload.embeddingReady === false && confirmed && payload.record != null) {
          setNotice(
            buildNotice(
              "warning",
              "已确认，向量未就绪",
              "记忆已写入，但跨会话向量召回可能暂不可用（嵌入未完成或未配置）。"
            )
          );
        }
      })
      .catch((err) => {
        const conflict = err instanceof ApiError && (err.status === 409 || err.status === 422 || err.status === 404);
        const body =
          err instanceof ApiError && err.body && typeof err.body === "object"
            ? (err.body as { error?: unknown; state?: ProductState; blocked?: boolean })
            : null;
        const serverError = body && typeof body.error === "string" ? body.error.trim() : "";
        const isApproveBlock =
          conflict &&
          (body?.blocked === true || serverError.includes("冲突") || serverError.includes("拦截"));
        // If a 409 body still carries authoritative state (revision bump), adopt it so the
        // next optimistic PUT does not race on a stale client revision. approveMemoryCandidate
        // normally returns blocked+state without throw; this is a safety net for other callers.
        if (body?.state && typeof body.state === "object" && "revision" in body.state) {
          adoptServerState(body.state as ProductState);
        }
        setNotice(buildNotice(
          "warning",
          isApproveBlock ? "确认已拦截" : conflict ? "操作未生效" : "操作失败",
          isApproveBlock
            ? serverError || "候选与用户修正冲突，未写入长期记忆。请拒绝或改写后再确认。"
            : conflict
              ? serverError || "该记忆的状态已变化(可能已被处理或清理),请刷新后重试。"
              : "记忆治理需要后端在线。"
        ));
        throw err;
      });
  }
  function confirmDecision(id: string) {
    setConfirmingDecisionId(id);
    void flushPendingProductState()
      .then(() => productApiClient.confirmDecision(id))
      .then((next) => adoptServerState(next))
      // P3-02:区分业务冲突(409/422/404:决策已确认或状态已变)与后端离线,不再一律"需要后端在线"。
      .catch((err) => {
        const conflict = err instanceof ApiError && (err.status === 409 || err.status === 422 || err.status === 404);
        setNotice(buildNotice(
          "warning",
          conflict ? "操作未生效" : "操作失败",
          conflict ? "该决策的状态已变化(可能已确认),请刷新后重试。" : "确认决策需要后端在线。"
        ));
      })
      .finally(() => setConfirmingDecisionId(undefined));
  }

  const approveCandidate = (id: string, mode?: "merge" | "add") =>
    withMemoryAction(() => productApiClient.approveMemoryCandidate(id, mode ? { mode } : undefined));
  const resolveConflictCandidate = (id: string, keepSide: "a" | "b") =>
    withMemoryAction(() => productApiClient.resolveMemoryConflict(id, { keepSide }));
  const rejectCandidate = (id: string) => withMemoryAction(() => productApiClient.rejectMemoryCandidate(id));
  const editCandidate = (id: string, text: string) => withMemoryAction(() => productApiClient.updateMemoryCandidate(id, text));
  const deprecateRecord = (id: string) => {
    // 撤销会让记忆退出访谈与对话召回——状态突变需显式确认，与全站破坏性操作约定一致。
    if (!window.confirm("确定撤销这条长期记忆吗？撤销后它将不再进入访谈与资产对话的召回。")) return;
    // fire-and-forget(onClick 不 await):notice 已由 withMemoryAction 弹出,这里 .catch 兜底防未处理 rejection。
    return withMemoryAction(() => productApiClient.deprecateMemoryRecord(id)).catch(() => {});
  };
  const deleteRecord = (id: string) => {
    // 删除一条已确认长期记忆不可撤销，必须二次确认，避免误点单击即永久丢失。
    if (!window.confirm("确定永久删除这条长期记忆吗？此操作不可撤销。")) return;
    return withMemoryAction(() => productApiClient.deleteMemoryRecord(id)).catch(() => {});
  };
  const editMemoryRecord = async (recordId: string, text: string) => {
    // 修正后端会自动重算 embedding。用 adoptServerState 采纳权威态，避免冗余 PUT。
    try {
      const next = await productApiClient.updateMemoryRecordText(recordId, text);
      adoptServerState(next);
      setNotice(buildNotice("success", "记忆已更新", "已保存修正并重新计算语义索引。"));
    } catch {
      setNotice(buildNotice("warning", "记忆修改未保存", "请稍后重试。"));
    }
  };
  const consolidateMemory = () => {
    // 整理会自动合并并删除被判定为近重复的记忆条目，不可撤销，需显式确认。
    if (!window.confirm("整理记忆会自动合并并删除被判定为近重复的记忆条目，且不可撤销。是否继续？")) return;
    return productApiClient
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
  };

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

  async function uploadVoice(audioBase64: string, preferredName: string) {
    const voice = await productApiClient.createVoice({ audioBase64, preferredName });
    setVoices((prev) => [...prev, voice]);
    setNotice(buildNotice("success", "音色创建成功", `音色 "${voice.name}" 已创建，可在音色列表中选择。`));
  }

  async function deleteVoice(voiceId: string) {
    // 删除复刻音色不可恢复（需重新上传录音复刻），二次确认避免误删。
    if (!window.confirm(`确定删除音色「${voiceId}」吗？删除后需重新上传录音复刻，无法恢复。`)) return;
    try {
      await productApiClient.deleteVoice(voiceId);
    } catch (err) {
      // 删除未生效（网络或服务端错误）：绝不从本地列表移除，否则就是假成功。
      console.warn(
        JSON.stringify({
          event: "delete_voice_failed",
          voiceId,
          error: err instanceof Error ? err.message : String(err)
        })
      );
      setNotice(buildNotice("warning", "删除音色失败", "请稍后重试。"));
      return;
    }
    setVoices((prev) => prev.filter((v) => v.voice !== voiceId));
    setNotice(buildNotice("warning", "音色已删除", `音色 "${voiceId}" 已移除。`));
  }

  /** 打开单条主题线工作区。 */
  function openTrack(id: string) {
    setSelectedTrackId(id);
    setView("track");
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
      adoptServerState(apiRun.state);
      setApiPersistenceEnabled(true);
      setActiveSearchBriefId(apiRun.brief.id);
      setSearchTopic(apiRun.brief.topic);
      setNotice(buildNotice("success", "搜索简报已生成", `已选中「${apiRun.brief.topic}」，可以带入下一次专访。`));
    } catch (err) {
      // 失败即如实暴露（后端不可达/服务返回错误都一样）——
      // 不再离线本地捏造简报并用与真实成功相同的提示冒充。
      const message = err instanceof Error && err.message ? err.message : "请检查服务与配置后重试。";
      if (isNetworkError(err)) {
        setApiPersistenceEnabled(false);
      }
      setSearchTask(failCapabilityTask(runningTask, message));
      setNotice(buildNotice("danger", "搜索简报生成失败", message));
    }
  }








  async function autoBrief(themeId?: string, debtId?: string) {
    setView("search");

    try {
      const response = await productApiClient.createAutoBrief({ themeId, debtId });
      adoptServerState(response.state);
      setApiPersistenceEnabled(true);
      setActiveSearchBriefId(response.brief.id);
      setNotice(buildNotice("success", "自动简报已生成", `已选中「${response.brief.topic}」，可以带入下一次专访。`));
    } catch (err) {
      // 失败即如实暴露——不再本地捏造占位简报（哪怕带"本地占位"标注也是假数据入库）。
      const message = err instanceof Error && err.message ? err.message : "请检查服务与配置后重试。";
      if (isNetworkError(err)) {
        setApiPersistenceEnabled(false);
      }
      setNotice(buildNotice("danger", "自动简报生成失败", message));
    }
  }

  async function refreshBrief(briefId: string) {
    setRefreshingBriefId(briefId);
    try {
      const response = await productApiClient.refreshSearchBrief(briefId);
      adoptServerState(response.state);
      setApiPersistenceEnabled(true);
      setNotice(buildNotice("success", "外部调研已刷新", `「${response.brief.topic}」的研究内容已更新。`));
    } catch (err) {
      const message = err instanceof Error && err.message ? err.message : "刷新未完成，请重试。";
      if (isNetworkError(err)) {
        setApiPersistenceEnabled(false);
      }
      setNotice(buildNotice("danger", "刷新失败", `${message}（原简报未变。）`));
    } finally {
      setRefreshingBriefId(null);
    }
  }

  async function trackBrief(briefId: string, tracked: boolean) {
    setTrackingBriefId(briefId);
    try {
      const response = await productApiClient.trackSearchBrief(briefId, tracked);
      adoptServerState(response.state);
      setApiPersistenceEnabled(true);
      setNotice(buildNotice("success", tracked ? "已标记为持续追踪" : "已取消持续追踪", tracked ? "该主题将持续追踪，可随时刷新获取最新研究。" : "已取消持续追踪标记。"));
    } catch (err) {
      if (isNetworkError(err)) {
        // 后端不可达：保留本地乐观更新，但如实告知"尚未同步"，不能伪装成成功。
        setApiPersistenceEnabled(false);
        setProductState((current) => ({
          ...current,
          searchBriefs: current.searchBriefs.map((b) => (b.id === briefId ? { ...b, tracked } : b))
        }));
        setNotice(
          buildNotice(
            "warning",
            tracked ? "已在本地标记（尚未同步）" : "已在本地取消追踪（尚未同步）",
            // F-05: 与持久 outbox + 自动重连实现如实对齐。
            "后端不可用，改动已进入浏览器离线队列；恢复后会自动合并同步。"
          )
        );
      } else {
        // 服务端在线但返回 4xx/5xx：不是"后端不可用"，绝不关掉持久化、也不本地 fork
        // tracked 状态（那会与服务端真相分叉）。提示失败并采纳服务端当前状态。
        setNotice(buildNotice("warning", "标记失败", "服务返回错误，请稍后重试。"));
        try {
          adoptServerState(await productApiClient.getState());
        } catch {
          // 拉取服务端状态也失败：保持现状，用户可重试。
        }
      }
    } finally {
      setTrackingBriefId(null);
    }
  }

  async function autoRunResearch() {
    try {
      const response = await productApiClient.autoRunResearch();
      adoptServerState(response.state);
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
    if (!effectiveSourceId || podcastGenerating) {
      return;
    }

    setPodcastGenerating(true);
    try {
      const apiRun = await productApiClient.generatePodcastEpisode({
        ...(podcastSourceType === "note" ? { noteId: effectiveSourceId } : {}),
        sourceType: podcastSourceType,
        sourceId: effectiveSourceId,
        format: podcastFormat,
        voice: podcastVoice,
        ...(podcastFormat === "host-guest" && podcastGuestVoice.trim()
          ? { guestVoice: podcastGuestVoice.trim() }
          : {})
      });
      adoptServerState(apiRun.state);
      setApiPersistenceEnabled(true);
      if (podcastSourceType === "note") {
        setPodcastNoteId(effectiveSourceId);
      } else {
        setPodcastSourceId(effectiveSourceId);
      }
      openEpisodeDraft(apiRun.episode);
      const voiceSummary =
        apiRun.episode.format === "host-guest"
          ? `主持人 ${apiRun.episode.voice}，来宾 ${apiRun.episode.guestVoice ?? pairPodcastGuestVoice(apiRun.episode.voice)}`
          : `声音：${apiRun.episode.voice}`;
      setNotice(buildNotice("success", "播客脚本已生成", voiceSummary));
      setView("podcast");
    } catch (err) {
      const serverReason =
        err instanceof ApiError && err.body && typeof err.body === "object"
          ? (err.body as { error?: unknown }).error
          : undefined;
      const message =
        typeof serverReason === "string" && serverReason
          ? serverReason
          : err instanceof Error && err.message
            ? err.message
            : "请检查服务与配置后重试。";
      if (isNetworkError(err)) {
        setApiPersistenceEnabled(false);
      }
      setNotice(buildNotice("danger", "播客脚本生成失败", message));
    } finally {
      setPodcastGenerating(false);
    }
  }

  async function confirmPodcastScript(episodeId: string): Promise<boolean> {
    const targetId = episodeId || podcastActiveEpisodeId || "";
    const episode = productState.podcastEpisodes.find((ep) => ep.id === targetId);
    if (!episode || podcastConfirming) {
      return false;
    }
    const scriptToConfirm =
      targetId === podcastActiveEpisodeId ? podcastEditingScript : episode.script;
    if (!scriptToConfirm.trim()) {
      setNotice(buildNotice("warning", "口播稿不能为空", "先写几句再确认。"));
      return false;
    }

    setPodcastConfirming(true);
    try {
      const res = await productApiClient.confirmPodcastScript(targetId, scriptToConfirm);
      adoptServerState(res.state);
      setApiPersistenceEnabled(true);
      setPodcastEditingScript(res.episode.script);
      setPodcastActiveEpisodeId(targetId);
      setNotice(buildNotice("success", "口播稿已确认", `「${res.episode.title}」已定稿，可以稍后合成。`));
      return true;
    } catch (err) {
      const conflict = err instanceof ApiError && (err.status === 409 || err.status === 422 || err.status === 404);
      if (isNetworkError(err)) {
        setApiPersistenceEnabled(false);
      }
      setNotice(
        buildNotice(
          "warning",
          conflict ? "操作未生效" : "确认口播稿失败",
          conflict ? "这篇稿的状态已变化，请刷新后再试。" : "确认口播稿需要后端在线。"
        )
      );
      return false;
    } finally {
      setPodcastConfirming(false);
    }
  }

  async function confirmAndSynthesizePodcast(episodeId: string) {
    const confirmed = await confirmPodcastScript(episodeId);
    if (!confirmed) return;
    await synthesizePodcastSpeech(episodeId, { alreadyConfirmed: true });
  }

  async function synthesizePodcastSpeech(episodeId: string, opts?: { alreadyConfirmed?: boolean }) {
    const targetId = episodeId || podcastActiveEpisodeId || "";
    const episode = productState.podcastEpisodes.find((ep) => ep.id === targetId);
    if (!episode || podcastSynthesizing) {
      return;
    }

    const dirty = targetId === podcastActiveEpisodeId && podcastEditingScript !== episode.script;
    if (!opts?.alreadyConfirmed && (episode.scriptReviewStatus !== "用户确认" || dirty)) {
      setNotice(buildNotice("warning", "请先确认口播稿", "确认之后才会合成语音。"));
      return;
    }

    setPodcastSynthesizing(true);
    try {
      const usingDraft = targetId === podcastActiveEpisodeId;
      const host = usingDraft && episodeVoice.trim() ? episodeVoice.trim() : episode.voice;
      const guest =
        usingDraft && episodeGuestVoice.trim()
          ? episodeGuestVoice.trim()
          : episode.guestVoice?.trim() ||
            (episode.format === "host-guest" ? pairPodcastGuestVoice(episode.voice) : "");
      const { state: synthState } = await productApiClient.synthesizePodcastEpisode(targetId, {
        voice: host,
        ...(guest ? { guestVoice: guest } : {})
      });
      adoptServerState(synthState);
      setApiPersistenceEnabled(true);
      setPodcastActiveEpisodeId(targetId);
      setNotice(buildNotice("success", "语音合成完成", `播客「${episode.title}」音频已渲染。`));
    } catch (err) {
      if (err instanceof ApiError && err.body && typeof err.body === "object" && "state" in err.body) {
        const bodyState = (err.body as { state?: unknown }).state;
        if (bodyState) {
          adoptServerState(normalizeProductState(bodyState));
        }
      }
      const message = err instanceof Error && err.message ? err.message : "TTS 请求失败。";
      setNotice(buildNotice("danger", "语音合成失败", `${message}（脚本已保留，可重试。）`));
    } finally {
      setPodcastSynthesizing(false);
    }
  }

  async function removePodcastEpisode(episodeId: string) {
    if (typeof window !== "undefined" && !window.confirm("确定要删除这条播客生成结果吗？来源笔记不会被删除。")) {
      return;
    }
    setPodcastDeletingId(episodeId);
    try {
      const next = await productApiClient.deletePodcastEpisode(episodeId);
      adoptServerState(next);
      setApiPersistenceEnabled(true);
      if (podcastActiveEpisodeId === episodeId) {
        setPodcastActiveEpisodeId(null);
        setPodcastEditingScript("");
        setEpisodeVoice("");
        setEpisodeGuestVoice("");
      }
      setNotice(buildNotice("warning", "播客生成结果已删除", "来源笔记和认知资产保持不变。"));
    } catch (err) {
      const message = err instanceof Error && err.message ? err.message : "删除失败，请重试。";
      if (isNetworkError(err)) {
        setApiPersistenceEnabled(false);
      }
      setNotice(buildNotice("danger", "播客删除失败", message));
    } finally {
      setPodcastDeletingId(null);
    }
  }

  async function forgetSessionNote(
    noteId: string,
    options: { exclusiveAssets: boolean; confirmedMemory: boolean }
  ) {
    try {
      const { state: next, receipt } = await productApiClient.forgetSessionNote(noteId, options);
      adoptServerState(next);
      setApiPersistenceEnabled(true);
      if (podcastNoteId === noteId) {
        setPodcastNoteId(next.notes[0]?.id ?? "");
      }
      const coldFailed = receipt.partialColdFailure;
      setNotice(
        buildNotice(
          coldFailed ? "warning" : "success",
          coldFailed ? "这场记录已拿走，有些原文还在" : "这场已拿走",
          coldFailed
            ? `${receipt.summary}录音或原文有一部分没删干净，可以再试一次。`
            : receipt.summary
        )
      );
    } catch (err) {
      const message = err instanceof Error && err.message ? err.message : "这场没能拿走，请再试一次。";
      if (isNetworkError(err)) {
        setApiPersistenceEnabled(false);
      }
      setNotice(buildNotice("danger", "这场没能拿走", message));
      throw err;
    }
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
      adoptServerState(apiRun.state);
      setApiPersistenceEnabled(true);
      const newestInsight = (apiRun.state.corpusInsights || [])
        .slice()
        .sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")))[0];
      if (newestInsight?.id) setCorpusFocusInsightId(newestInsight.id);
      setNotice(buildNotice("success", "语料分析已完成", "已生成可解释的提问技法改进建议；可在下方审阅并确认影响引擎。"));
      setView("corpus");
    } catch (err) {
      // 失败即如实暴露——不再在后端不可达时用本地关键词模板分析冒充 LLM 分析结果。
      const message = err instanceof Error && err.message ? err.message : "请检查服务与配置后重试。";
      if (isNetworkError(err)) {
        setApiPersistenceEnabled(false);
      }
      setNotice(buildNotice("danger", "语料分析失败", message));
    } finally {
      setCorpusAnalyzing(false);
    }
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

    // 公网 URL 走真转写（SenseVoice）；本地文件后端会如实 422（能力边界：SenseVoice 只收公网 URL）。
    const request = sourceUrl
      ? { title, sourceUrl, languageHint: "zh" }
      : { title, sourceUrl: "", languageHint: "zh", audioBase64: corpusAudioBase64, fileName: corpusAudioFileName };

    try {
      const apiRun = await productApiClient.transcribeCorpusAudio(request);
      setCorpusContent(apiRun.transcription.text);
      setNotice(buildNotice("success", "音频转写已完成", `已生成 ${apiRun.transcription.model} 转写稿，可继续分析。`));
    } catch (err) {
      // 失败/能力边界即如实暴露——不再生成占位"手工转写模板"冒充转写稿。
      // 用户仍可直接在语料输入框手动粘贴转写文本（正常输入路径，无需模板）。
      const message = err instanceof Error && err.message ? err.message : "转写未完成，请重试。";
      if (isNetworkError(err)) {
        setApiPersistenceEnabled(false);
      }
      setNotice(buildNotice("danger", "音频转写失败", message));
    } finally {
      setCorpusTranscribing(false);
    }
  }




  // N-13:apply/revert 接后端 CAS 路由(与 confirmDecision 同款权威态语义),不再前端本地 mutate+
  // autosave 那条与后端语义分叉的平行路径。后端对非法流转响亮回 409/422 → .catch 如实提示,
  // 顺带根治 P3-01(revert 对非 applied 补丁的"假成功"):不再无脑报成功。采纳后端权威态(revision
  // 已 bump),避免下一次乐观 PUT 撞 409。



  async function saveRuntimeConfig(updates: SystemConfigUpdateRequest) {
    setRuntimeConfigSaving(true);
    try {
      const result = await productApiClient.updateSystemConfig(updates);
      const capabilities = await productApiClient.getSystemCapabilities();
      setRuntimeConfig(result.config);
      setSystemCapabilities(capabilities);
      setNotice(buildNotice("success", "运行配置已保存", `已更新 ${result.settingsUpdated.length} 项服务端配置。`));
    } catch (err) {
      // P3-07:422 是服务端校验拒绝,body.error 带具体中文原因(如某项配置非法);此前一律吞成
      // "env 文件可写"误导排查方向。有服务端原因就如实透出,只有网络/未知才回退到通用提示。
      const serverReason = err instanceof ApiError && err.body && typeof err.body === "object"
        ? (err.body as { error?: unknown }).error
        : undefined;
      setNotice(buildNotice(
        "danger",
        "运行配置保存失败",
        typeof serverReason === "string" && serverReason
          ? serverReason
          : "请确认 Product API 正在运行，且本地 env 文件可写。"
      ));
    } finally {
      setRuntimeConfigSaving(false);
    }
  }

  async function saveProductConfig(nextConfig: SystemConfig) {
    const clamped: SystemConfig = {
      ...nextConfig,
      search: {
        ...nextConfig.search,
        activeProvider: nextConfig.search.activeProvider === "anysearch" ? "anysearch" : "bailian"
      },
      voice: {
        ...nextConfig.voice,
        ttsProvider: "bailian"
      }
    };
    const nextState = withSystemConfigVersion(productState, clamped, {
      changedBy: "user",
      reason: "用户保存产品策略",
      createdAt: new Date().toISOString()
    });
    setProductConfigSaving(true);
    try {
      const result = await productApiClient.saveState(nextState);
      if (result.conflicted) {
        setNotice(buildNotice("danger", "没能保存", "服务器上的内容已经变了，请刷新后再改。"));
        return;
      }
      acceptAuthoritativeState(result.state);
      setApiPersistenceEnabled(true);
      setPodcastVoice(clamped.voice.podcastVoice);
      setPodcastGuestVoice(
        clamped.voice.podcastGuestVoice ?? pairPodcastGuestVoice(clamped.voice.podcastVoice)
      );
      setNotice(buildNotice("success", "产品策略已保存", "下一场专访、下一次搜索会按新规矩走。"));
    } catch (err) {
      const message = err instanceof Error && err.message ? err.message : "没能写入，请再试一次。";
      if (isNetworkError(err)) {
        setApiPersistenceEnabled(false);
      }
      setNotice(buildNotice("danger", "产品策略没能保存", message));
      throw err;
    } finally {
      setProductConfigSaving(false);
    }
  }

  function saveDefaultPodcastVoice() {
    const nextVoice = {
      ...productState.systemConfig.voice,
      podcastVoice,
      ...(podcastFormat === "host-guest" && podcastGuestVoice.trim()
        ? { podcastGuestVoice: podcastGuestVoice.trim() }
        : {})
    };
    const nextConfig = {
      ...productState.systemConfig,
      voice: nextVoice
    };
    const nextState = {
      ...productState,
      systemConfig: nextConfig
    };
    setProductState(nextState);
    const summary =
      podcastFormat === "host-guest"
        ? `主持人 ${podcastVoice}，来宾 ${podcastGuestVoice}`
        : `默认声音已设为：${podcastVoice}`;
    setNotice(buildNotice("success", "播客默认声音已更新", summary));
  }

  function saveNoteQuestion(noteId: string, index: number) {
    const note = productState.notes.find((item) => item.id === noteId);
    const questionText = note?.nextQuestions[index]?.trim() ?? "";
    if (questionText) {
      const norm = questionText.replace(/[\s。，、；：！？·.,;:!?]/g, "");
      const exists = productState.questions.some(
        (item) => item.question.replace(/[\s。，、；：！？·.,;:!?]/g, "") === norm
      );
      if (exists) {
        setNotice(buildNotice("info", "问题已在资产库", "相同回访问题已保存过，无需重复添加。"));
        return;
      }
    }
    const next = createQuestionFromNote(productState, noteId, index);
    if (next === productState) {
      // createQuestionFromNote returns the original state untouched when the note
      // or the回访 question can't be found — don't claim a false success.
      setNotice(buildNotice("warning", "未能保存问题", "该回访问题不存在或已失效，请刷新后重试。"));
      return;
    }
    setProductState(next);
    // 留在笔记阅读流，避免打断回访；需要治理状态时再去资产库。
    setNotice(buildNotice("success", "问题已保存到资产库", "可继续阅读本场笔记，或稍后在「我的资产 → 资产库」标记状态。"));
  }

  function addCorrection() {
    if (!correctionText.trim()) {
      return;
    }
    setProductState(markMemoryCorrection(productState, correctionText.trim()));
    setNotice(buildNotice("success", "记忆修正已保存", "后续访谈会参考这条边界。"));
    setCorrectionText("");
  }

  // 专访旁注:沿 addCorrection 模式(域函数 + setProductState → 走现有 autosave)。
  // Task 11 会把这两个 handler 传给 RawMaterialViewer。
  function addInterviewAnnotation(sessionId: string, turnId: string, text: string) {
    setProductState(addAnnotation(productState, sessionId, turnId, text));
    setNotice(buildNotice("success", "旁注已保存", "已挂到该轮对话，可随时删除。"));
  }
  function removeInterviewAnnotation(id: string) {
    setProductState(removeAnnotation(productState, id));
    setNotice(buildNotice("info", "旁注已删除", "该轮旁注已移除。"));
  }

  async function exportData() {
    return productApiClient.exportState();
  }

  async function importData(payload: unknown, coldLayerMode?: ColdLayerMode): Promise<StateImportResult> {
    const result = await productApiClient.importState(payload, coldLayerMode);
    acceptAuthoritativeState(result.state);
    setSession(null);
    closeRealtimeVoiceSession();
    if (!result.receipt) {
      setNotice(buildNotice("warning", "备份已导入，但完整性未知", "服务端未返回恢复清单；请先核对逐字稿与录音，再执行清空操作。"));
    } else if (result.receipt.partial) {
      setNotice(
        buildNotice(
          "warning",
          "备份已部分恢复",
          `已恢复 ${result.receipt.restored.rawMaterials} 份逐字稿、${result.receipt.restored.audios} 段录音；仍有 ${result.receipt.missing.audioSessions.length} 段录音缺失。`
        )
      );
    } else {
      setNotice(buildNotice("success", "数据已从备份完整恢复", "热态、逐字稿、录音与知识索引恢复清单均已确认。"));
    }
    return result;
  }

  async function showPrivacyReport() {
    return productApiClient.getPrivacyReport();
  }

  async function purgeData() {
    // B2 审查(Important):purge 的文案按结果分流——默认成功文案只在服务端确认全部清空时使用,
    // 与 resetData 的 F-03 口径一致。
    let nextState: ProductState & { purgeReceipt?: PurgeReceipt };
    let notice = buildNotice("warning", "个人数据已彻底清空", "所有专访、记忆与资产已删除，Provider 配置已保留。");
    try {
      nextState = await productApiClient.purgeState();
      if (nextState.purgeReceipt?.partialFailure) {
        // 防御:契约上 200 时 partialFailure 恒为 false,但若服务端行为漂移也不能谎报成功(同 resetData)。
        notice = buildNotice("warning", "服务端部分个人数据未删除", `${describeStoreReceiptFailures(nextState.purgeReceipt)}，请重试"清空个人数据"。`);
      }
    } catch (err) {
      // B2 审查(Important):部分失败 = 500 + body{error, state, purgeReceipt}——服务端热态
      // **已经清空**(hotStateCommitted,隐私删除最大化),只是某些冷层库删除失败。此前前端
      // 只显示通用错误、不采纳 body.state:UI 仍摆着全部私人数据,与服务端事实(已删)相反。
      const partialBody =
        err instanceof ApiError &&
        err.status === 500 &&
        err.body &&
        typeof err.body === "object" &&
        typeof (err.body as { purgeReceipt?: unknown }).purgeReceipt === "object" &&
        (err.body as { purgeReceipt?: unknown }).purgeReceipt !== null &&
        typeof (err.body as { state?: unknown }).state === "object" &&
        (err.body as { state?: unknown }).state !== null
          ? (err.body as { state: unknown; purgeReceipt: PurgeReceipt })
          : undefined;
      if (!partialBody) {
        // P3-04:R2b 治理事务整体回滚(500 + rolledBack,无 state)——热态/冷层未删(数据完好),
        // 但 local-object 文件层是非事务的、已被删除。此前落到通用错误、artifactPurge 不可见,用户不知
        // "文件已删而状态未删"。如实告知:状态已回滚,但已删的本地音频文件无法随回滚恢复。
        const rollbackBody =
          err instanceof ApiError && err.status === 500 && err.body && typeof err.body === "object" &&
          (err.body as { rolledBack?: unknown }).rolledBack === true
            ? (err.body as { artifactPurge?: { deleted?: number } })
            : undefined;
        if (rollbackBody) {
          const deleted = rollbackBody.artifactPurge?.deleted ?? 0;
          const artifactNote = deleted > 0
            ? `已删除 ${deleted} 个本地音频文件(文件层非事务,无法随回滚恢复)。`
            : "";
          throw new Error(`清空已整体回滚,数据未删除,请查看服务端日志后重试。${artifactNote}`);
        }
        // 网络失败(后端没确认任何删除)/其他 4xx(服务端拒绝、什么都没删):不动本地状态,
        // 原样抛给 ProfileView 的 catch 如实展示(见 describeGovernanceError)——绝不谎报清空。
        throw err;
      }
      // 采纳服务端已清空的热态。整库替换必须走 acceptAuthoritativeState(C-1:outbox 生命周期
      // 入口,清 pending outbox + 对齐三基线,否则 pre-purge 的私人数据会从 outbox 复活/推回
      // 刚清空的服务器),并同步覆写 localStorage 主键(purge 的隐私语义要求同步落地)。
      const partialState = normalizeProductState(partialBody.state);
      const failures = describeStoreReceiptFailures(partialBody.purgeReceipt);
      acceptAuthoritativeState(partialState);
      saveProductState(partialState);
      setSession(null);
      closeRealtimeVoiceSession();
      setNotice(buildNotice("warning", "服务端部分个人数据未删除", `${failures}，热态与界面已清空，请重试"清空个人数据"以删除残留。`));
      // 抛出中文错误让 ProfileView 的行内状态如实显示"部分失败",而不是"个人数据已彻底清空"。
      throw new Error(`${failures}，热态与界面已清空，请重试"清空个人数据"以删除残留。`);
    }
    // C-1(补审查):purge 是整库替换,必须走 acceptAuthoritativeState 统一生命周期——
    // 清 pending outbox + 对齐三个基线 ref(+内部 setSyncConflict(null))。此前只
    // saveProductState:pending outbox 留在 localStorage(内含 purge 前 base+local 两份
    // 全量个人数据,正是 purge 承诺删除的隐私残留),重开页面时启动逻辑会把它当权威本地
    // 副本复活,三方合并还可能把 purge 前数据整包 PUT 回刚清空的服务器。
    acceptAuthoritativeState(nextState);
    // 立即覆写 localStorage 主键,不等 autosave effect 的下一帧——purge 的隐私语义要求同步落地。
    saveProductState(nextState);
    setSession(null);
    closeRealtimeVoiceSession();
    setNotice(notice);
    return nextState;
  }

  async function resetData() {
    // 文案必须如实：reset 清空的是全部数据（含用户自己的真实记录），不只是内置示例。
    if (typeof window !== "undefined" && !window.confirm("确定清空全部数据吗？这会删除所有访谈、资产、记忆与逐字稿（包括你自己的真实记录，不只是示例），且无法撤销。")) {
      return;
    }
    let nextState: ProductState;
    // 审计修复 F-03:此前任何 API 失败(网络断/4xx/5xx)都本地清空并统一显示"全部数据已清空"
    // ——服务端与冷层的私密数据可能原封不动,却对用户宣称删除成功。改为按失败类型分流,
    // 默认成功文案只在服务端确认全部清空时使用。
    let notice = buildNotice("warning", "全部数据已清空", "可以开始记录你自己的真实访谈了。");
    try {
      const { resetReceipt, ...serverState } = await productApiClient.resetState();
      nextState = serverState;
      // C-1(补审查):reset 是整库替换,统一走 acceptAuthoritativeState(清 pending outbox +
      // 对齐 lastSynced/lastSaved/offlineObserved 三基线 + setSyncConflict(null) + 恢复在线)。
      // 此前只 saveProductState+setProductState:pending outbox 在崩溃/关页后重开时被启动
      // 逻辑(优先采用 outbox.localState)复活,三方合并冲突条还可把 pre-reset 全量数据
      // PUT 回刚清空的服务器。
      acceptAuthoritativeState(nextState);
      saveProductState(nextState);
      if (resetReceipt?.partialFailure) {
        // 防御:契约上 200 时 partialFailure 恒为 false,但若服务端行为漂移也不能谎报成功。
        notice = buildNotice("warning", "服务端部分数据未清空", `${describeStoreReceiptFailures(resetReceipt)}，请重试"清空全部数据"。`);
      }
    } catch (err) {
      // 服务端部分失败(500 + resetReceipt):热态已清并随 body 带回,只是某些冷层库删除失败。
      const partialBody =
        err instanceof ApiError &&
        err.status === 500 &&
        err.body &&
        typeof err.body === "object" &&
        typeof (err.body as { resetReceipt?: unknown }).resetReceipt === "object" &&
        (err.body as { resetReceipt?: unknown }).resetReceipt !== null &&
        typeof (err.body as { state?: unknown }).state === "object" &&
        (err.body as { state?: unknown }).state !== null
          ? (err.body as { state: unknown; resetReceipt: ResetReceipt })
          : undefined;
      if (partialBody) {
        // 采纳服务端已清空的热态、保持在线,如实列出未删除的库并提示重试——绝不宣称"已清空"。
        nextState = normalizeProductState(partialBody.state);
        // C-1:500+resetReceipt 分支采纳的 body.state 同样是整库替换,走同一生命周期入口,
        // 否则 pre-reset outbox 残留同样会复活/推回。
        acceptAuthoritativeState(nextState);
        saveProductState(nextState);
        notice = buildNotice(
          "warning",
          "服务端部分数据未清空",
          `${describeStoreReceiptFailures(partialBody.resetReceipt)}，界面数据已重置，请重试"清空全部数据"以删除残留。`
        );
      } else if (isNetworkError(err)) {
        // 网络不可达:后端没有确认任何删除,只能重置本地视图——文案必须如实,不复用成功文案。
        setApiPersistenceEnabled(false);
        // Preserve the current revision so the post-reset auto-save isn't rejected by
        // optimistic-concurrency and doesn't re-adopt the server's demo state.
        nextState = { ...resetProductState(), revision: productState.revision };
        // C-2(补审查):reset 空态绝不能被当成一次"离线编辑"进 outbox。此前该空态会被
        // autosave 离线分支 stage(base=旧服务端态),重连三方合并判成"本地删除一切、远端
        // 未变"→ 无冲突自动 PUT 空态:热态看似清空成功,用户不会再执行真正的 reset,而
        // 服务端冷层(逐字稿/录音/知识索引)被绕过、永久残留且零提示。修法(取语义最诚实
        // 的"对齐离线基线到空态"方案):
        //   1) clearPendingSync 丢弃 pending outbox——里面的 pre-reset 数据正是用户明确
        //      要求删除的,不能留着等复活(同时 setSyncConflict(null));
        //   2) 三个基线 ref 全部对齐到空态签名 → autosave 离线分支视空态为"无新编辑",
        //      不 stage、不 PUT;
        //   3) 重连后 mount 路径无 pending → 采纳服务端现状(旧数据重新出现在界面),与
        //      官方文案「恢复连接后请重新执行清空」行为完全一致——绝不伪装服务端已清空。
        // 离线期间的新工作(比如又做了一场访谈)相对空态签名有变化,会以空态为新基线重新
        // 开始 stage,不会被误吞;重连合并时"服务端旧数据 + 新访谈"都保留,仍等用户重新清空。
        clearPendingSync();
        const localResetSignature = productStateContentSignature(nextState);
        lastSyncedStateRef.current = nextState;
        lastSavedContentRef.current = localResetSignature;
        offlineObservedSignatureRef.current = localResetSignature;
        // I-2:立即启动重连探测——恢复后自动拉回服务端现状,用户随即可重新执行真正的清空。
        scheduleReconnectProbe();
        notice = buildNotice("warning", "仅本地视图已重置", "后端未确认删除：服务端与冷层数据可能仍在，恢复连接后请重新执行清空。");
      } else {
        // 其他 4xx/5xx(如 422):服务端拒绝且什么都没删——不动本地状态,直接报错返回。
        // N-11:优先显示服务端 generic 中文 error(治理 500 已门控:生产不含 SurrealDB 原始报文);
        // detail 仅非生产 profile 存在(服务端 governanceErrorDetail 门控),存在即附上便于本地调试。
        const errBody = err instanceof ApiError && err.body && typeof err.body === "object" ? (err.body as { error?: unknown; detail?: unknown }) : undefined;
        const serverMessage = errBody && typeof errBody.error === "string"
          ? errBody.error
          : err instanceof Error
            ? err.message
            : String(err);
        const serverDetail = errBody && typeof errBody.detail === "string" ? errBody.detail : undefined;
        setNotice(buildNotice("danger", "清空失败", serverDetail ? `服务端未执行清空：${serverMessage}（${serverDetail}）` : `服务端未执行清空：${serverMessage}`));
        return;
      }
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
    setPodcastFormat("solo");
    setPodcastEditingScript("");
    setEpisodeVoice("");
    setEpisodeGuestVoice("");
    setPodcastActiveEpisodeId(null);
    setPodcastGenerating(false);
    setPodcastSynthesizing(false);
    setPodcastDeletingId(null);
    setCorpusMediaType("text");
    setCorpusSourceUrl("");
    setCorpusAudioBase64("");
    setCorpusAudioFileName("");
    // F-03:文案由上方分流决定——只有服务端确认全部清空才是成功文案。
    setNotice(notice);
    setView("home");
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
        <nav className="nav-list" aria-label="应用导航">
          {groupedNavigation.map((group) => (
            <section className="nav-group" key={group.label} aria-label={`${group.label}导航`}>
              <span className="nav-group-label">{group.label}</span>
              <div className="nav-group-items">
                {group.items.map((item) => {
                  const Icon = navIconByView[item.id];
                  const active = view === item.id;
                  return (
                    <button
                      key={item.id}
                      className={active ? "nav-item active" : "nav-item"}
                      type="button"
                      aria-current={active ? "page" : undefined}
                      onClick={() => setView(item.id)}
                    >
                      <Icon size={18} aria-hidden />
                      <span>{item.label}</span>
                    </button>
                  );
                })}
              </div>
            </section>
          ))}
        </nav>
        <div className="sidebar-footer">
          <button
            type="button"
            className="theme-toggle"
            aria-label={themeToggleAriaLabel(themePreference, resolvedTheme)}
            title={`外观：${themePreferenceLabel(themePreference)}`}
            onClick={() => setThemePreference((prev) => cycleThemePreference(prev))}
          >
            {themePreference === "light" ? (
              <Sun size={16} aria-hidden />
            ) : themePreference === "dark" ? (
              <Moon size={16} aria-hidden />
            ) : (
              <Monitor size={16} aria-hidden />
            )}
            <span className="theme-toggle-copy">
              <strong>外观</strong>
              <small>
                {themePreferenceLabel(themePreference)}
                {themePreference === "system" ? ` · ${resolvedTheme === "light" ? "亮" : "暗"}` : ""}
              </small>
            </span>
          </button>
        </div>
      </aside>

      <main id="main-content" className="main-area">
        {syncConflict && (
          <section
            className="sync-conflict-banner"
            role="alert"
            aria-labelledby="sync-conflict-title"
            aria-describedby="sync-conflict-detail"
          >
            <div className="sync-conflict-copy">
              <span className="sync-conflict-eyebrow">离线同步需要你的决定</span>
              <strong id="sync-conflict-title">检测到 {syncConflict.conflicts.length} 处双端冲突</strong>
              <p id="sync-conflict-detail">
                本地工作没有被覆盖。请选择保留当前本地版本并同步，或明确采用服务器版本。
              </p>
              {/* P3-11:灾备指纹提示——服务器版本若与首次运行的示例数据逐字一致,极可能是后端
                  数据库被清空/损坏后重启返回的初始 demo 态。此时"采用服务器版本"会用示例覆盖真实
                  记录,必须显式警示,而不是让用户把 demo 当权威盲选。 */}
              {isPristineDemoState(syncConflict.remoteState) && (
                <strong className="sync-conflict-demo-warning" role="alert">
                  ⚠ 服务器版本看起来是示例/初始数据——后端数据库可能被重置或损坏后重启。采用它会用示例数据覆盖你的本地记录。除非你确认服务器已正确恢复，否则请「保留本地并同步」。
                </strong>
              )}
              <span className="sync-conflict-paths" title={syncConflict.conflicts.map((item) => item.path).join("、")}>
                涉及：{syncConflict.conflicts.slice(0, 3).map((item) => item.path).join("、")}
                {syncConflict.conflicts.length > 3 ? ` 等 ${syncConflict.conflicts.length} 处` : ""}
              </span>
            </div>
            <div className="sync-conflict-actions" aria-label="同步冲突处理">
              <button
                className="primary-action"
                type="button"
                disabled={syncResolving}
                onClick={() => void keepLocalConflictVersion()}
              >
                {syncResolving ? "正在同步…" : "保留本地并同步"}
              </button>
              <button
                className="secondary-action"
                type="button"
                disabled={syncResolving}
                onClick={() => void useRemoteConflictVersion()}
              >
                采用服务器版本
              </button>
            </div>
          </section>
        )}
        {/* N-02:权威库落库降级的持久顶栏警告——常驻于 degraded 期间(consecutiveFailures>0),
            由 health 轮询 effect 驱动(GET /api/health 恢复报健康 → setPersistHealth(null))即消失。
            独立持久状态,区别于下方一次性 notice(它是持续状态而非瞬时提示,非复用 buildNotice)。
            role=alert + assertive 让读屏立即播报这条数据安全风险。 */}
        {persistHealth && persistHealth.consecutiveFailures > 0 && (
          <section className="notice danger" role="alert" aria-live="assertive" aria-atomic="true">
            <strong>本地数据库写入异常，最近改动可能未保存，请检查后端日志。</strong>
            <span>
              服务端已连续 {persistHealth.consecutiveFailures} 次落库失败
              {persistHealth.lastErrorAt ? `（最近一次 ${new Date(persistHealth.lastErrorAt).toLocaleString()}）` : ""}
              。恢复后本提示会自动消失。
            </span>
          </section>
        )}
        {pendingMemoryCount > 0 && view !== "memory" && (
          <section
            className="notice warning sticky-memory-hitl"
            role="status"
            aria-live="polite"
            data-testid="sticky-memory-hitl"
          >
            <strong>{pendingMemoryCount} 条记忆待确认</strong>
            <span>未确认不会进入跨会话召回。关闭上场摘要后此条仍保留，直到全部审核完毕。</span>
            <button type="button" className="primary-action" onClick={() => setView("memory")}>
              去记忆治理
            </button>
          </section>
        )}
        {notice && (
          <section className={`notice ${notice.kind}`} aria-live="polite" aria-atomic="true">
            <strong>{notice.message}</strong>
            {notice.detail && <span>{notice.detail}</span>}
          </section>
        )}
        {view !== "interview" && view !== "home" && resumeCards.some((card) => session?.id !== card.sessionId) && (
          <section className="resume-banner resume-session-picker" aria-label="未完成的专访">
            <div className="resume-banner-main">
              <span className="resume-banner-eyebrow">未完成的专访 · 共 {resumeCards.length} 场</span>
              <strong>选择要继续的专访</strong>
              <p className="field-help">空场可直接移除，避免占满主题线等页面。</p>
              <div className="resume-session-list">
                {resumeCards.map((card) => {
                  const empty = card.turnCount === 0;
                  return (
                    <article className="resume-session-option is-static" key={card.sessionId}>
                      <div>
                        <strong>
                          {card.title}
                          {empty ? " · 尚未开始对话" : ` · ${card.turnCount} 轮`}
                        </strong>
                        <small>{card.pendingQuestion}</small>
                      </div>
                      <div className="form-actions">
                        <button
                          className="primary-action"
                          type="button"
                          onClick={() => continueInterview(card.sessionId)}
                        >
                          继续
                        </button>
                        {empty && (
                          <button
                            className="secondary-action"
                            type="button"
                            onClick={() => void discardEmptyInterview(card.sessionId)}
                          >
                            移除空场
                          </button>
                        )}
                      </div>
                    </article>
                  );
                })}
              </div>
            </div>
          </section>
        )}
        {view === "home" && (
          <HomeView
            state={productState}
            card={card}
            suggestedTopicHint={suggestedTopicHint}
            recommendedMode={recommendedLaunch.mode}
            recommendationReason={recommendedLaunch.reason}
            recommendedRelatedThemeIds={recommendedLaunch.relatedThemeIds}
            resumeCards={resumeCards}
            activeBriefId={activeSearchBriefId}
            starting={startingInterview}
            lastInterviewSummary={lastInterviewSummary}
            revisitQueue={revisitQueue}
            pendingMemoryCount={pendingMemoryCount}
            onStart={(mode, topicHint, relatedThemeIds) =>
              void launchInterview(mode, activeSearchBriefId, topicHint, relatedThemeIds)
            }
            onContinue={continueInterview}
            onDiscardEmpty={(id) => void discardEmptyInterview(id)}
            onClearBrief={() => setActiveSearchBriefId(undefined)}
            onDismissLastSummary={() => setLastInterviewSummary(null)}
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
            voiceReviewItem={voiceReviewItem}
            voiceTransport={
              livekitVoiceSession ? "livekit"
              : realtimeVoiceSession ? "websocket"
              : null
            }
            onInput={(value) => {
              setInterviewInput(value);
              if (value !== failedTurnContent) {
                setFailedTurnContent(null);
              }
            }}
            onStart={startInterview}
            launchSearchBriefId={activeSearchBriefId}
            launchTopicHint={suggestedTopicHint}
            launchRelatedThemeIds={recommendedLaunch.relatedThemeIds}
            onSubmit={submitTurn}
            onFinish={finishInterview}
            onControl={applyInterviewControl}
            onSuppressRevisit={suppressRevisit}
            onToggleRecording={toggleRealtimeRecording}
            onInterrupt={interruptAssistant}
            onVoiceReviewText={(text) => {
              const item = voiceReviewItemRef.current;
              if (!item) return;
              const nextItem = { ...item, text };
              voiceReviewItemRef.current = nextItem;
              setVoiceReviewItem(nextItem);
            }}
            onConfirmVoiceReview={() => {
              const item = voiceReviewItemRef.current;
              const pipeline = cascadePipelineRef.current;
              if (!item?.text.trim() || !pipeline) return;
              runVoiceReviewAction({
                ref: voiceReviewItemRef,
                clearRendered: () => setVoiceReviewItem(null),
                action: (current) => pipeline.confirmQuarantinedTranscript(current.text.trim()),
              });
            }}
            onDiscardVoiceReview={() => {
              const pipeline = cascadePipelineRef.current;
              if (!pipeline) return;
              runVoiceReviewAction({
                ref: voiceReviewItemRef,
                clearRendered: () => setVoiceReviewItem(null),
                action: () => pipeline.discardQuarantinedTranscript(),
              });
            }}
            submitting={submittingTurn}
            retryAvailable={failedTurnContent !== null && failedTurnContent === interviewInput}
            starting={startingInterview}
            finishing={finishingInterview}
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
            focusInsightId={corpusFocusInsightId}
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
            onRevertPatch={revertPatch}
            onDeleteInsight={removeCorpusInsight}
            onOpenConfig={() => setView("config")}
            onGoInterview={() => setView("interview")}
          />
        )}
        {view === "podcast" && (
          <PodcastStudioView
            state={productState}
            noteId={podcastNoteId}
            voice={podcastVoice}
            guestVoice={podcastGuestVoice}
            sourceType={podcastSourceType}
            sourceId={podcastSourceId}
            format={podcastFormat}
            editingScript={podcastEditingScript}
            episodeVoice={episodeVoice}
            episodeGuestVoice={episodeGuestVoice}
            activeEpisodeId={podcastActiveEpisodeId}
            generating={podcastGenerating}
            synthesizing={podcastSynthesizing}
            confirming={podcastConfirming}
            deletingEpisodeId={podcastDeletingId}
            onNoteId={setPodcastNoteId}
            onVoice={setPodcastVoice}
            onGuestVoice={setPodcastGuestVoice}
            onSourceType={setPodcastSourceType}
            onSourceId={setPodcastSourceId}
            onFormat={setPodcastFormat}
            onEditingScript={setPodcastEditingScript}
            onEpisodeVoice={setEpisodeVoice}
            onEpisodeGuestVoice={setEpisodeGuestVoice}
            onBeginEditEpisode={openEpisodeDraft}
            onActiveEpisodeId={setPodcastActiveEpisodeId}
            onGenerateScript={generatePodcastScript}
            onConfirmScript={(id) => void confirmPodcastScript(id)}
            onConfirmAndSynthesize={(id) => void confirmAndSynthesizePodcast(id)}
            onSynthesizeSpeech={synthesizePodcastSpeech}
            onDeleteEpisode={removePodcastEpisode}
            onSaveDefaultVoice={saveDefaultPodcastVoice}
          />
        )}
        {view === "notes" && (
          <NotesView
            state={productState}
            onStart={(mode, topicHint, relatedThemeIds) =>
              void launchInterview(mode, activeSearchBriefId, topicHint, relatedThemeIds)
            }
            onSaveQuestion={saveNoteQuestion}
            onAddAnnotation={addInterviewAnnotation}
            onRemoveAnnotation={removeInterviewAnnotation}
            getRawMaterial={(sessionId) => productApiClient.getRawMaterial(sessionId)}
            getAudioMeta={(sessionId, role) => productApiClient.getSessionAudioMeta(sessionId, role)}
            audioUrl={(sessionId) => productApiClient.sessionAudioUrl(sessionId)}
            getAudioBlob={(sessionId, role) => productApiClient.fetchSessionAudioBlob(sessionId, role)}
            focus={notesFocus}
            onOpenTrack={openTrack}
            onGeneratePodcast={(noteId) => {
              setPodcastNoteId(noteId);
              setPodcastSourceType("note");
              setPodcastSourceId("");
              setView("podcast");
            }}
            onOpenArchive={(sessionId) => {
              setArchiveFocusSessionId(sessionId);
              setView("my-assets");
            }}
            onForgetNote={forgetSessionNote}
          />
        )}
        {view === "material" && (
          <MaterialLibraryView
            state={productState}
            onImport={importMemoryDocument}
            onRebuildIndex={() => productApiClient.rebuildKnowledgeIndex()}
            onAskMaterials={(question) => productApiClient.queryRag(question)}
            onDeleteSource={(id) => {
              // 素材删除会连带清其知识索引块(经包装的 PUT autosave 触发 reindex),不可撤销 → 二次确认。
              if (typeof window !== "undefined" && !window.confirm("确定删除这份素材吗？它在知识库/资产对话中的索引也会一并移除，无法撤销。")) {
                return;
              }
              setProductState(deleteImportSource(productState, id));
              setNotice(buildNotice("info", "素材已删除", "列表已更新；知识索引将随同步重建。"));
            }}
            onReviewMemory={(sourceId) => {
              setMemoryFocusSourceId(sourceId ?? null);
              setView("memory");
            }}
            onStartInterview={(mode, topicHint, relatedThemeIds) =>
              void launchInterview(mode, activeSearchBriefId, topicHint, relatedThemeIds)
            }
            focusSourceId={materialFocusSourceId}
            onOpenAssetChat={(title) =>
              openAssetChat({
                prefill: title?.trim()
                  ? `关于《${title.trim()}》这份素材，有哪些值得记住的判断或问题？`
                  : undefined
              })
            }
            onOpenTrack={openTrack}
          />
        )}
        {view === "asset-chat" && (
          <AssetChatView
            state={productState}
            selectedSessionId={chatSessionId}
            onSelectChat={(id) => {
              setChatSessionId(id);
              setAssetChatFocus(null);
            }}
            onNewChat={() => {
              setChatSessionId(ASSET_CHAT_DRAFT_ID);
              setAssetChatFocus(null);
            }}
            prefill={assetChatPrefill}
            onPrefillConsumed={() => setAssetChatPrefill(null)}
            onOpenMaterial={() => setView("material")}
            onStartInterview={(topicHint) => void launchInterview("decision", activeSearchBriefId, topicHint)}
            onSend={async (sid, msg) => {
              try {
                const result = await productApiClient.sendChatMessage(
                  sid,
                  msg,
                  assetChatFocus ?? undefined
                );
                adoptServerState(result.state);
                setApiPersistenceEnabled(true);
                setChatSessionId(result.sessionId);
              } catch (err) {
                // 让 AssetChatView 展示 formatChatSendError；网络错误时同步持久化标志。
                if (isNetworkError(err)) {
                  setApiPersistenceEnabled(false);
                  scheduleReconnectProbe();
                }
                throw err;
              }
            }}
            onDeleteChat={(id) => {
              // 删除整条对话历史不可撤销 → 二次确认(与全站删除约定一致)。
              if (typeof window !== "undefined" && !window.confirm("确定删除这条对话吗？整段对话历史将被移除，无法撤销。")) {
                return;
              }
              setProductState(deleteChatSession(productState, id));
              if (chatSessionId === id) {
                const rest = productState.chatSessions.filter((s) => s.id !== id);
                setChatSessionId(rest[0]?.id ?? ASSET_CHAT_DRAFT_ID);
              }
            }}
            onCitationClick={handleCitationClick}
          />
        )}
        {view === "my-assets" && (
          <MyAssetsView
            state={productState}
            query={assetQuery}
            results={assetResults}
            filter={assetFilter}
            selectedAssetKey={selectedAssetKey}
            focusSessionId={archiveFocusSessionId}
            importantOnly={assetImportantOnly}
            sortMode={assetSortMode}
            onQuery={setAssetQuery}
            onFilter={setAssetFilter}
            onImportantOnly={setAssetImportantOnly}
            onSortMode={setAssetSortMode}
            onSelectAsset={setSelectedAssetKey}
            onToggleImportant={(assetId) => setProductState(toggleAssetImportance(productState, assetId))}
            onPointStatus={(assetId, status) => setProductState(updatePointStatus(productState, assetId, status))}
            onQuestionStatus={(assetId, status) => setProductState(updateQuestionStatus(productState, assetId, status))}
            onDebtStatus={(assetId, status) => setProductState(updateKnowledgeDebtStatus(productState, assetId, status))}
            onDecisionStatus={(assetId, status) => setProductState(updateDecisionStatus(productState, assetId, status))}
            onDecisionConfirm={confirmDecision}
            confirmingDecisionId={confirmingDecisionId}
            onBringIntoInterview={(asset) => {
              const launch = interviewLaunchFromAsset(asset);
              setNotice(buildNotice("info", "已带入下一次专访", asset.summary.slice(0, 120)));
              void launchInterview(launch.mode, activeSearchBriefId, launch.topicHint, launch.relatedThemeIds);
            }}
            onAskAsset={(asset) =>
              openAssetChat({
                prefill: `关于我的${asset.kind === "points" ? "观点" : asset.kind === "questions" ? "问题" : asset.kind === "decisions" ? "决策" : "知识债"}「${asset.title}」：${asset.summary.slice(0, 120)}。请结合我的资料说明含义与未决问题。`,
                focusSource: knowledgeFocusFromAsset(asset.kind, asset.id)
              })
            }
            onGeneratePodcast={(noteId) => {
              setPodcastNoteId(noteId);
              setPodcastSourceType("note");
              setPodcastSourceId("");
              setView("podcast");
            }}
            onOpenNote={(sessionId) => {
              setNotesFocus((prev) => ({
                sessionId,
                nonce: (prev?.nonce ?? 0) + 1
              }));
              setView("notes");
            }}
          />
        )}
        {view === "themes" && (
          <ThemesView
            state={productState}
            review={monthlyReview}
            yearlyReview={yearlyReview}
            radar={radar}
            reviewsError={reviewsError}
            reviewsLoading={reviewsLoading}
            onRetryReviews={() => setReviewsNonce((n) => n + 1)}
            onStart={(mode, topicHint, relatedThemeIds) =>
              void launchInterview(mode, activeSearchBriefId, topicHint, relatedThemeIds)
            }
            onOpenTrack={openTrack}
          />
        )}
        {view === "track" && (
          <TrackWorkspaceView
            workspace={buildTrackWorkspace(productState, selectedTrackId ?? "")}
            onBack={() => setView("themes")}
            onContinue={() => {
              const track = buildTrackWorkspace(productState, selectedTrackId ?? "");
              const theme = track.theme;
              const hint = theme?.nextQuestion?.trim() || theme?.name;
              void launchInterview("long-term", activeSearchBriefId, hint, theme?.id ? [theme.id] : undefined);
            }}
            onOpenSession={(sessionId) => {
              setNotesFocus((prev) => ({
                sessionId,
                nonce: (prev?.nonce ?? 0) + 1
              }));
              setView("notes");
            }}
            onOpenAsset={(key) => {
              setSelectedAssetKey(key);
              setAssetFilter(
                key.startsWith("points:")
                  ? "points"
                  : key.startsWith("questions:")
                    ? "questions"
                    : key.startsWith("decisions:")
                      ? "decisions"
                      : key.startsWith("debts:")
                        ? "debts"
                        : "all"
              );
              setView("my-assets");
            }}
            onOpenSource={() => setView("material")}
            state={productState}
            onAddAnnotation={addInterviewAnnotation}
            onRemoveAnnotation={removeInterviewAnnotation}
            getRawMaterial={(sessionId) => productApiClient.getRawMaterial(sessionId)}
            getAudioMeta={(sessionId, role) => productApiClient.getSessionAudioMeta(sessionId, role)}
            audioUrl={(sessionId) => productApiClient.sessionAudioUrl(sessionId)}
            getAudioBlob={(sessionId, role) => productApiClient.fetchSessionAudioBlob(sessionId, role)}
          />
        )}
        {view === "memory" && (
          <MemoryGovernanceView
            state={productState}
            importing={importing}
            focusSourceId={memoryFocusSourceId}
            focusRecordId={memoryFocusRecordId}
            onImport={(title, content) => {
              void importMemoryDocument(title, content).catch(() => {
                /* notice already set */
              });
            }}
            onApprove={approveCandidate}
            onResolveConflict={resolveConflictCandidate}
            onReject={rejectCandidate}
            onEditCandidate={editCandidate}
            onDeprecate={deprecateRecord}
            onDeleteRecord={deleteRecord}
            onEditRecord={editMemoryRecord}
            onConsolidate={consolidateMemory}
            onAddAnnotation={addInterviewAnnotation}
            onRemoveAnnotation={removeInterviewAnnotation}
            getRawMaterial={(sessionId) => productApiClient.getRawMaterial(sessionId)}
            getAudioMeta={(sessionId, role) => productApiClient.getSessionAudioMeta(sessionId, role)}
            audioUrl={(sessionId) => productApiClient.sessionAudioUrl(sessionId)}
            getAudioBlob={(sessionId, role) => productApiClient.fetchSessionAudioBlob(sessionId, role)}
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
            productConfigSaving={productConfigSaving}
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
            onSaveProfile={saveProfile}
            onOpenMemory={() => setView("memory")}
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

// F-03/B2 notice 辅助:把 reset/purge 回执里 failed 的库翻译成用户可读的中文清单。
// reset 与 purge 的 stores 三态口径一致(cleared/not-configured/failed: <原因>),共用一份翻译。
// 纯函数,放模块级避免组件每次 render 重建。
function describeStoreReceiptFailures(receipt: ResetReceipt | PurgeReceipt): string {
  const labels: Record<string, string> = {
    "raw-material": "逐字稿冷层",
    audio: "录音",
    "knowledge-index": "知识索引"
  };
  const failed = Object.entries(receipt.stores ?? {})
    .filter(([, outcome]) => typeof outcome === "string" && outcome.startsWith("failed"))
    .map(([store]) => labels[store] ?? store);
  return failed.length > 0 ? `以下数据未能删除：${failed.join("、")}` : "部分服务端数据未能删除";
}
