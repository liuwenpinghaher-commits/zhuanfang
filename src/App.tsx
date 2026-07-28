import {
  Archive,
  BookOpen,
  Brain,
  Compass,
  Headphones,
  Library,
  MessagesSquare,
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
  buildCognitiveRadar,
  buildInterviewCard,
  buildInterviewResumeCard,
  buildRealtimeTurnState,
  buildSystemStatus,
  createQuestionFromNote,
  createKnowledgeDebtFromSearchBrief,
  createPointFromSearchBrief,
  createQuestionFromSearchBrief,
  markMemoryCorrection,
  receiveUserTurn,
  searchProductAssets,
  toggleAssetImportance,
  buildRealtimeVoiceInstructions,
  updateDecisionStatus,
  updateKnowledgeDebtStatus,
  updatePointStatus,
  updateQuestionStatus
} from "./domain/engine";
import { addAnnotation, removeAnnotation } from "./domain/raw-material";
import { deleteImportSource } from "./domain/material";
import { createIdleCapabilityTask, failCapabilityTask, startCapabilityTask } from "./capabilities/task";
import { productApiClient, isNetworkError, ApiError, type PersistHealthLite, type PurgeReceipt, type ResetReceipt, type ReviewsResponse, deriveRealtimeApiWsBaseUrl, withAuthTokenQuery, resolveProductApiToken, getProductApiBaseUrl} from "./api/productApi";
import type { ColdLayerMode, RealtimeVoiceSessionResponse, StateImportResult, SystemCapabilitiesResponse, SystemConfigResponse, SystemConfigUpdateRequest, VoiceInfo } from "./api/productApi";
// WebRTC omni client is incomplete (no callbacks/turn recording); the connect path is
// downlined to WebSocket in startVoiceSession. Type kept for the connection union only.
import type { BailianRealtimeWebrtcConnection } from "./realtime/realtimeTypes";
import {
  connectBailianRealtimeWebsocket,
  type BailianRealtimeWebsocketConnection
} from "./realtime/bailianWebsocket";
import { createLivekitVoiceSession, type LivekitVoiceSession } from "./realtime/livekitVoice";
import { connectCascadedPipeline, type CascadedPipeline, type TtsSink } from "./realtime/cascadedPipeline";
import { createBrowserAsrSource } from "./realtime/cascadedAsrSource";
import { createBrowserTtsSink } from "./realtime/cascadedTtsSink";
import { pcmS16leMonoToWav } from "./realtime/pcmWav";
import { createSessionAudioRecorder, type SessionAudioRecorder } from "./realtime/sessionAudioRecorder";
import {
  dedupeGeneratedArtifacts,
  deleteCorpusInsightBundle,
  deletePodcastEpisode,
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
import { shouldStageLocalBeforeAdopt } from "./domain/adopt-stage";
import type {
  AssetStatus,
  ChatCitation,
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
import { MaterialLibraryView } from "./features/material/MaterialLibraryView";
import { AssetChatView } from "./features/chat/AssetChatView";
import { deleteChatSession } from "./domain/knowledge";
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
import { appendAssistantTranscriptFinal } from "./domain/session-transcript";

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

// 实时语音 WS 基址：HTTPS 页面必须用 wss(否则浏览器以 mixed-content 拦截 ws://,生产语音不可用),
// 且生产经 API 同源托管(fastifyStatic),WS 走同源 host;dev 下前端在 vite 端口、API 在 3210,需显式指向。
function realtimeApiWsBaseUrl(): string {
  return deriveRealtimeApiWsBaseUrl(getProductApiBaseUrl());
}

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
  const [importing, setImporting] = useState(false);
  const [runtimeConfig, setRuntimeConfig] = useState<SystemConfigResponse | null>(null);
  const [runtimeConfigSaving, setRuntimeConfigSaving] = useState(false);
  const [view, setView] = useState<View>("home");
  const [session, setSession] = useState<InterviewSession | null>(null);
  const [pendingMode, setPendingMode] = useState<InterviewMode>("decision");
  const [notice, setNotice] = useState<UiNotice | null>(null);
  // N-02:权威库(surreal)落库健康度——degraded 期间常驻顶栏警告(独立持久状态,区别于一次性 notice)。
  // 由低频轮询 route-agnostic 的 GET /api/health 驱动(见下方 health 轮询 effect):后端仅在
  // consecutiveFailures>0 时带 persist.degraded → 亮灯,健康/内存档/离线 → null 清零。轮询覆盖全部
  // "200+异步落库"写路径(资产确认/记忆编辑等从不 PUT /api/state,却共享同一 persistQueue)。
  const [persistHealth, setPersistHealth] = useState<PersistHealthLite | null>(null);
  const [interviewInput, setInterviewInput] = useState("");
  const [submittingTurn, setSubmittingTurn] = useState(false);
  const [startingInterview, setStartingInterview] = useState(false);
  // 同步防重入:setStartingInterview 是异步 state,挡不住"创建请求在途时"的二次触发(双击 /
  // 快速重渲染),会创建多个空 session。startInterview 入口用这个 ref 同步短路。
  const startingRef = useRef(false);
  // P3-19:录音开关同步防重入。开始录音的连接建立(创建 voice session + 连 ASR/TTS WS)是异步的,
  // recording state 要等连接就绪才置 true——期间双击/快速重渲染会开出两条 pipeline、两个 getUserMedia
  // (mic 泄漏)。与 startingRef 同构:进"开始"分支前同步短路,连接流程 settle 后在 finally 复位。
  const togglingRef = useRef(false);
  // 同步防重入:/end 要调真实 LLM 做档案抽取(数秒),用户等不及会重复点"结束"。没有这个 guard,
  // 第一次成功 completed 后,后续点击全部 409(已结束)→ "结束失败"提示覆盖成功 → 诱导继续点。
  const finishingRef = useRef(false);
  const [finishingInterview, setFinishingInterview] = useState(false); // UI:结束按钮显示"正在生成档案…"
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
  const [chatSessionId, setChatSessionId] = useState<string | null>(null);
  // 引用跳源:逐字稿引用点击后,要在双轨笔记里展开的会话 + 高亮的轮次。
  // nonce 每次点击自增,使 NotesView 的 effect 即便 sessionId/turnId 未变(连点同一引用)也重新触发滚动高亮。
  const [notesFocus, setNotesFocus] = useState<{ sessionId: string; turnId?: string; nonce: number } | null>(null);

  useEffect(() => {
    saveProductState(productState);
  }, [productState]);

  const lastSavedContentRef = useRef<string>("");
  const offlineOutboxRef = useRef<OfflineOutbox | null>(startupOutboxRef.current);
  const lastSyncedStateRef = useRef<ProductState>(startupOutboxRef.current?.baseState ?? productState);
  const productStateRef = useRef(productState);
  productStateRef.current = productState;
  const offlineObservedSignatureRef = useRef(productStateContentSignature(productState));
  const [syncConflict, setSyncConflict] = useState<SyncConflictState | null>(null);
  const [syncResolving, setSyncResolving] = useState(false);
  // 连续 autosave 失败计数：成功清零；首次跨过阈值(2)时弹一次警告，避免每 300ms 刷屏，
  // 也避免"改动早已没在保存、用户毫不知情"的零信号静默丢失。
  const autosaveFailuresRef = useRef(0);
  // F-05: autosave 失败后的自动重试。此前失败只能靠"下一次内容变化"才会再试,与 notice
  // 承诺的"恢复后会自动重试"不符。现在失败后按有界指数退避主动重发当前 productState:
  // 到点 bump nonce 让保存 effect 重跑(签名≠lastSaved 会走完整保存路径)。timer 放 ref
  // 防重入(在途 timer 不叠加),卸载时统一清理。
  const autosaveRetryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [autosaveRetryNonce, setAutosaveRetryNonce] = useState(0);
  const reconnectFailuresRef = useRef(0);
  const [reconnectNonce, setReconnectNonce] = useState(0);
  // F-05 补审查 I-2:重连探测 timer 从 mount effect 的局部变量提升为共享 ref——所有
  // "转入离线"的路径(不只是初次打开即离线)都能通过 scheduleReconnectProbe 启动探测。
  const reconnectProbeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // F-05 补审查 I-5:outbox 落盘失败(配额/隐私模式)的内存标志。置位时持久层没有可信
  // 副本,重连合并须以内存态兜底;另一枚用于"同一失败 streak 只提示一次",不刷屏。
  const outboxStagingFailedRef = useRef(false);
  const outboxStagingNoticeShownRef = useRef(false);
  useEffect(
    () => () => {
      // 组件卸载时清掉在途的重试/探测 timer,避免卸载后 setState。
      if (autosaveRetryTimerRef.current !== null) {
        clearTimeout(autosaveRetryTimerRef.current);
        autosaveRetryTimerRef.current = null;
      }
      if (reconnectProbeTimerRef.current !== null) {
        clearTimeout(reconnectProbeTimerRef.current);
        reconnectProbeTimerRef.current = null;
      }
    },
    []
  );

  // F-05 补审查 I-2:把 mount catch 里的退避探测抽成共享入口。此前只有"初次打开即离线"
  // 会安排探测;运行中途转离线(autosave 409 合并失败、adoptServerState/冲突裁决失败、
  // 离线开始新访谈等)后没有任何自动重连,与「后端恢复后会自动合并同步」的文案不符。
  // 到点 bump reconnectNonce → 复用 mount 的 getState + 三方合并路径。timer 去重:在途
  // 探测未到点时重复调用不叠加、也不推高退避档位。
  function scheduleReconnectProbe() {
    if (reconnectProbeTimerRef.current !== null) return;
    reconnectFailuresRef.current += 1;
    const delayMs = nextBackoffMs(reconnectFailuresRef.current);
    reconnectProbeTimerRef.current = setTimeout(() => {
      reconnectProbeTimerRef.current = null;
      setReconnectNonce((n) => n + 1);
    }, delayMs);
  }

  function cancelReconnectProbe() {
    if (reconnectProbeTimerRef.current !== null) {
      clearTimeout(reconnectProbeTimerRef.current);
      reconnectProbeTimerRef.current = null;
    }
  }

  // F-05 补审查 M-5:只对"再试可能自愈"的失败继续轮询——网络不可达与 5xx。4xx(401/403/
  // 422 等)是凭据/请求问题,轮询只会无限重复同一错误,应停下等用户处理(改 token/改配置)。
  function shouldProbeReconnect(err: unknown): boolean {
    return isNetworkError(err) || (err instanceof ApiError && err.status >= 500);
  }

  function writePendingOutbox(next: OfflineOutbox) {
    offlineOutboxRef.current = next;
    if (!writeOfflineOutbox(next)) {
      // F-05 补审查 I-5:落盘失败置内存标志(重连合并据此以内存态为 local 走三方合并,
      // 而不是误判"无 pending"直接采纳远端);同一失败 streak 只弹一次提示——离线期间
      // 每次编辑都会 stage,不去重会每 300ms 刷一条 danger 通知。
      outboxStagingFailedRef.current = true;
      if (!outboxStagingNoticeShownRef.current) {
        outboxStagingNoticeShownRef.current = true;
        setNotice(
          buildNotice(
            "danger",
            "离线同步队列无法保存",
            "浏览器存储空间不足或被禁用。请先导出备份，并保持本页面打开，避免未同步修改丢失。"
          )
        );
      }
      return;
    }
    // 写恢复成功:本轮失败 streak 结束,之后再失败会重新提示一次。
    outboxStagingFailedRef.current = false;
    outboxStagingNoticeShownRef.current = false;
  }

  function stageOfflineState(localState: ProductState, conflicts?: OfflineSyncConflict[]): OfflineOutbox {
    const next = upsertOfflineOutbox({
      existing: offlineOutboxRef.current,
      baseState: lastSyncedStateRef.current,
      localState,
      ...(conflicts ? { conflicts } : {})
    });
    writePendingOutbox(next);
    return next;
  }

  function clearPendingSync() {
    offlineOutboxRef.current = null;
    // I-5:outbox 生命周期结束,落盘失败 streak 一并归零(下轮失败重新提示)。
    outboxStagingFailedRef.current = false;
    outboxStagingNoticeShownRef.current = false;
    clearOfflineOutbox();
    setSyncConflict(null);
  }

  function acceptAuthoritativeState(state: ProductState) {
    const signature = productStateContentSignature(state);
    lastSavedContentRef.current = signature;
    lastSyncedStateRef.current = state;
    offlineObservedSignatureRef.current = signature;
    clearPendingSync();
    productStateRef.current = state;
    setProductState(state);
    setApiPersistenceEnabled(true);
    // I-2:整状态采纳成功 = 服务端可达,重连退避归零并取消在途探测(避免恢复后再空跑一次)。
    reconnectFailuresRef.current = 0;
    cancelReconnectProbe();
  }

  /**
   * 确认一次 PUT 已落库，同时保护请求在途期间产生的更晚编辑：只有当前内容仍等于本次
   * attempted 才清 outbox；否则以本次 server 返回态为新 base，把更晚编辑继续留在 outbox。
   */
  function acknowledgeSavedState(serverState: ProductState, attemptedSignature: string) {
    autosaveFailuresRef.current = 0;
    lastSyncedStateRef.current = serverState;
    setSyncConflict(null);
    setApiPersistenceEnabled(true);
    const current = productStateRef.current;
    const currentSignature = productStateContentSignature(current);
    if (currentSignature === attemptedSignature) {
      // 请求在途期间没有更晚编辑：直接采纳服务端 normalize 后的完整形状，避免客户端
      // 只合 revision 而长期停留在与服务端不同的内容结构。
      const serverSignature = productStateContentSignature(serverState);
      lastSavedContentRef.current = serverSignature;
      offlineObservedSignatureRef.current = serverSignature;
      productStateRef.current = serverState;
      setProductState(serverState);
      clearPendingSync();
      return;
    }

    lastSavedContentRef.current = attemptedSignature;
    const currentWithRevision = current.revision === serverState.revision
      ? current
      : { ...current, revision: serverState.revision };
    productStateRef.current = currentWithRevision;
    offlineObservedSignatureRef.current = currentSignature;
    setProductState(currentWithRevision);

    const pending = upsertOfflineOutbox({
      baseState: serverState,
      localState: currentWithRevision
    });
    writePendingOutbox(pending);
  }

  function presentSyncConflict(
    outbox: OfflineOutbox,
    remoteState: ProductState,
    mergedState: ProductState,
    conflicts: OfflineSyncConflict[]
  ) {
    const pending = upsertOfflineOutbox({
      existing: outbox,
      baseState: outbox.baseState,
      localState: mergedState,
      conflicts
    });
    writePendingOutbox(pending);
    lastSyncedStateRef.current = remoteState;
    lastSavedContentRef.current = productStateContentSignature(remoteState);
    offlineObservedSignatureRef.current = productStateContentSignature(mergedState);
    productStateRef.current = mergedState;
    setProductState(mergedState);
    setApiPersistenceEnabled(false);
    setSyncConflict({ outbox: pending, remoteState, mergedState, conflicts });
    setNotice(
      buildNotice(
        "warning",
        "离线修改与服务器版本存在冲突",
        `检测到 ${conflicts.length} 处同一内容被双端修改。系统已保留本地工作，等待你选择版本。`
      )
    );
  }

  // F-05 补审查 I-1:同步流程无并发互斥——mount 重连、autosave 409、adoptServerState
  // (14+ 调用点)与冲突裁决可能并发触发,core 内部"读 refs → await PUT → 写 refs +
  // setProductState"的序列一旦交错,会互相覆盖基线造成丢数据/幽灵冲突。这里用模块内
  // 单一 in-flight promise 串行化:重入的调用排队,等在途一轮完成后再执行;排队期间
  // outbox 可能已被前一轮清空/重写,因此执行时以 offlineOutboxRef 的现值为准。
  const offlineSyncQueueRef = useRef<Promise<void>>(Promise.resolve());

  function synchronizeOfflineOutbox(
    inputOutbox: OfflineOutbox,
    remoteState: ProductState,
    retryBudget = 1,
    isCancelled: () => boolean = () => false
  ): Promise<void> {
    const run = async () => {
      if (isCancelled()) return;
      const livePending = offlineOutboxRef.current;
      if (!livePending) {
        // 在途一轮已完成并清空 outbox:本次排队携带的 outbox 已过期,绝不能拿它重放
        // (会把已合并/已裁决过的数据再推一遍)。仅当排队时的 remote 比已同步基线更新时
        // 采纳之(它可能来自一个更晚的细粒度 route 回执)。
        if (remoteState.revision > lastSyncedStateRef.current.revision) {
          acceptAuthoritativeState(remoteState);
        }
        return;
      }
      // remoteState 可能比在途一轮同步后的服务端更旧:core 的 PUT 会因 stale revision 得到
      // conflicted 回执并用服务端最新态 rebase 重试,自我纠正,无需在这里预判。
      await synchronizeOfflineOutboxCore(livePending, remoteState, retryBudget, isCancelled);
    };
    const chained = offlineSyncQueueRef.current.then(run, run);
    // 队头只记录"上一个任务已结束"并吞掉 rejection——错误由各调用者处理自己返回的那条
    // promise,不能把上一个调用者的失败重复抛给下一个。
    offlineSyncQueueRef.current = chained.then(
      () => undefined,
      () => undefined
    );
    return chained;
  }

  async function synchronizeOfflineOutboxCore(
    inputOutbox: OfflineOutbox,
    remoteState: ProductState,
    retryBudget = 1,
    isCancelled: () => boolean = () => false
  ): Promise<void> {
    let outbox = inputOutbox;
    // 请求在途时用户仍可能继续编辑。合并前刷新 localState，保证后续 setProductState 不会
    // 把这段更晚编辑覆盖掉；原 base 与未决 conflicts 保持不变。
    const latestLocal = productStateRef.current;
    if (productStateContentSignature(latestLocal) !== productStateContentSignature(outbox.localState)) {
      outbox = upsertOfflineOutbox({
        existing: outbox,
        baseState: outbox.baseState,
        localState: latestLocal
      });
      writePendingOutbox(outbox);
    }

    const reconciliation = reconcileOfflineOutbox(outbox, remoteState);
    if (isCancelled()) return;
    if (reconciliation.status === "conflict") {
      presentSyncConflict(outbox, remoteState, reconciliation.state, reconciliation.conflicts);
      return;
    }

    // 内容已经一致时不制造一次无意义 revision bump；直接清 outbox 并采纳远端元数据。
    if (productStateContentSignature(reconciliation.state) === productStateContentSignature(remoteState)) {
      acceptAuthoritativeState(remoteState);
      return;
    }

    const attempted = { ...reconciliation.state, revision: remoteState.revision };
    const attemptedSignature = productStateContentSignature(attempted);
    // 先把三方合并结果同时写进 outbox 与当前 UI，再发 PUT。否则成功回执时 current 仍是
    // “合并前的 local”，会把远端独立新增误判成请求在途的新编辑，下一轮反向删掉它。
    outbox = upsertOfflineOutbox({
      existing: outbox,
      baseState: outbox.baseState,
      localState: attempted
    });
    writePendingOutbox(outbox);
    productStateRef.current = attempted;
    offlineObservedSignatureRef.current = attemptedSignature;
    lastSavedContentRef.current = attemptedSignature;
    setProductState(attempted);
    const result = await productApiClient.saveState(attempted);
    if (isCancelled()) return;
    if (!result.conflicted) {
      acknowledgeSavedState(result.state, attemptedSignature);
      setNotice(buildNotice("success", "离线修改已同步", "本地与服务器的非冲突修改已合并并保存。"));
      return;
    }

    // getState 与 PUT 之间有新写入：把刚才的远端作为新 base 再做一次三方合并，而不是
    // 用最新 revision 粗暴重推整包。仍有内容冲突就停下来让用户裁决。
    const rebased = upsertOfflineOutbox({
      baseState: remoteState,
      localState: attempted
    });
    writePendingOutbox(rebased);
    if (retryBudget > 0) {
      // I-1:递归重试直接走 core——它是同一逻辑轮次的延续,已持有队列里的执行权;
      // 若绕回 wrapper 会在自己身后排队,死锁。
      await synchronizeOfflineOutboxCore(rebased, result.state, retryBudget - 1, isCancelled);
      return;
    }
    const finalReconciliation = reconcileOfflineOutbox(rebased, result.state);
    if (finalReconciliation.status === "conflict") {
      presentSyncConflict(rebased, result.state, finalReconciliation.state, finalReconciliation.conflicts);
      return;
    }
    throw new Error("同步期间服务器持续更新，已保留 outbox，稍后重试。");
  }

  useEffect(() => {
    const signature = productStateContentSignature(productState);
    if (!apiPersistenceEnabled) {
      // 离线/冲突期间每次内容变化都刷新持久 outbox.localState。首次 render 的签名已在
      // ref 中，不会把单纯打开页面误记成一次离线编辑。
      if (signature !== offlineObservedSignatureRef.current) {
        stageOfflineState(productState, syncConflict?.conflicts);
        offlineObservedSignatureRef.current = signature;
        // I-2:离线期间产生了新的未同步修改 → 确保有一枚在途重连探测(timer 去重,不叠加)。
        // 这是所有"转离线后继续编辑"路径(搜索/播客/语料等本地降级)的兜底重连入口,
        // 不必在每个 catch 手工接线。冲突未决时不探测:重连合并只会重放同一批冲突、
        // 重复弹冲突通知,该状态必须等用户在冲突条里显式选边。
        if (!syncConflict) {
          scheduleReconnectProbe();
        }
      }
      return;
    }
    // Only the revision changed (or nothing did) — nothing new to persist; skip to avoid the save->bump->adopt loop.
    if (signature === lastSavedContentRef.current) {
      return;
    }
    const timer = setTimeout(() => {
      // PUT 前先落 outbox：即使请求发出后页面关闭/进程崩溃，重开仍有 base+local 可重放。
      const pending = stageOfflineState(productState);
      productApiClient
        .saveState(productState)
        .then(({ state: server, conflicted }) => {
          // 保存请求已能送达服务端 → 取消在途的失败重试(无论本次是否 conflicted,
          // 后续都有明确的新基线,退避重发反而会用过期内容打架)。
          if (autosaveRetryTimerRef.current !== null) {
            clearTimeout(autosaveRetryTimerRef.current);
            autosaveRetryTimerRef.current = null;
          }
          if (conflicted) {
            void synchronizeOfflineOutbox(pending, server).catch((err) => {
              setApiPersistenceEnabled(false);
              setNotice(buildNotice("warning", "同步暂未完成", err instanceof Error ? err.message : String(err)));
              // I-2:409 后的合并同步失败也算"转离线"——可自愈类失败(网络/5xx)启动探测,
              // 否则用户要等到下一次编辑才有机会重连,与「会自动同步」文案不符。
              if (shouldProbeReconnect(err)) {
                scheduleReconnectProbe();
              }
            });
          } else {
            acknowledgeSavedState(server, signature);
          }
        })
        .catch((err) => {
          // Transient error: do NOT permanently disable persistence on a network blip —
          // but never fail silently: log every failure, surface a notice once per failure
          // streak, and (F-05) schedule a bounded-backoff retry so recovery doesn't depend
          // on the user happening to make another edit.
          autosaveFailuresRef.current += 1;
          // F-05: 这份改动确实没写进服务端——PUT 前已写入持久 outbox，自动重试/重连接手。
          console.warn(
            JSON.stringify({
              event: "autosave_failed",
              consecutiveFailures: autosaveFailuresRef.current,
              error: String(err)
            })
          );
          // N-06:治理进行中的 409(GovernanceInFlightError)是**瞬态**——治理秒级结算(360s 写门为硬顶),
          // 视为可重试(有界退避重发),绝不撕毁持久化/误当离线。stale-revision 409 不会走到这里(saveState
          // 在带 current 时返回 conflicted、不抛),故此处的 409 即"治理进行中/无 current 的硬错误 409"。
          const governanceInFlight = err instanceof ApiError && err.status === 409;
          const retryable = isNetworkError(err) || (err instanceof ApiError && err.status >= 500) || governanceInFlight;
          if (retryable && autosaveRetryTimerRef.current === null) {
            const delayMs = nextBackoffMs(autosaveFailuresRef.current);
            autosaveRetryTimerRef.current = setTimeout(() => {
              autosaveRetryTimerRef.current = null;
              // bump nonce 触发本 effect 重跑:内容签名仍≠lastSaved,会重发当前最新 state。
              // 若期间内容已被成功保存(签名相等),effect 会在顶部短路,不产生多余请求。
              setAutosaveRetryNonce((n) => n + 1);
            }, delayMs);
          }
          if (err instanceof ApiError && err.status === 413) {
            setNotice(buildNotice("warning", "本地改动尚未同步到服务器", "数据体积超出服务器限制；离线 outbox 已保留，请先导出备份并清理超大内容。"));
          } else if (governanceInFlight) {
            // N-06:清空/导入/重置进行中——本地改动已进 outbox,治理结算后按退避自动重试同步;不误报"后端离线"。
            setNotice(buildNotice("warning", "服务器正在执行数据治理", "清空/导入/重置进行中，你的本地改动已保留，将在其完成后自动重试同步。"));
          } else if (autosaveFailuresRef.current === 2) {
            setNotice(
              buildNotice("warning", "本地改动尚未同步到服务器", "连续保存失败，请检查后端是否在运行；离线 outbox 已保存，并会按间隔自动重试。")
            );
          }
        });
    }, 300);
    return () => clearTimeout(timer);
  }, [apiPersistenceEnabled, productState, autosaveRetryNonce, syncConflict]);

  // N-02:权威库落库降级 banner 的数据源——低频轮询 route-agnostic 的 GET /api/health。
  // persist.degraded 是共享异步 persistQueue 的属性,与触发它的写路由无关;轮询(而非只在 PUT
  // 响应上采样)覆盖全部"200+异步落库"写路径:只做资产确认/记忆编辑而从不 PUT /api/state 的用户,
  // 撞降级时也能看到 banner。mount 立即探一次 + 每 30s 一次(低频,只读、auth 豁免、不触发写/联网);
  // 卸载清定时器。health 拉取失败(后端离线)不翻转 banner——离线本身由同步/outbox 机制提示,此处
  // 只反映 persist 降级,避免瞬时网络抖动误清/误亮。degraded 常驻、恢复即消失。
  useEffect(() => {
    let cancelled = false;
    const pollHealth = () => {
      productApiClient
        .getHealth()
        .then((health) => {
          if (cancelled) return;
          const persist = health.persist;
          setPersistHealth(
            persist && persist.degraded && persist.consecutiveFailures > 0
              ? { consecutiveFailures: persist.consecutiveFailures, ...(persist.lastErrorAt ? { lastErrorAt: persist.lastErrorAt } : {}) }
              : null
          );
        })
        .catch(() => {
          /* 后端不可达:不翻转 banner(离线信号由同步/outbox 机制负责),保留上一次已知状态。 */
        });
    };
    pollHealth(); // mount 立即探一次,不必等首个 30s 周期
    const healthTimer = setInterval(pollHealth, 30_000);
    return () => {
      cancelled = true;
      clearInterval(healthTimer);
    };
  }, []);

  // 打开即更新：首次进入外部调研视图时自动跑一次盯梢(每会话一次,静默,失败不打扰)。
  // 即时手动刷新走视图内的「自动盯梢」按钮;后台周期刷新走配置里的定时调度。
  const researchAutoOpenedRef = useRef(false);
  useEffect(() => {
    if (view !== "search" || researchAutoOpenedRef.current || !apiPersistenceEnabled) {
      return;
    }
    researchAutoOpenedRef.current = true;
    autoRunResearch().catch((err) => {
      setNotice(
        buildNotice(
          "warning",
          "自动盯梢未完成",
          err instanceof Error && err.message ? err.message : "打开调研页时自动盯梢失败，可稍后手动重试。"
        )
      );
    });
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
      .then(async (remoteState) => {
        if (cancelled) return;
        reconnectFailuresRef.current = 0;
        // I-2:本轮 getState 已成功,清掉请求在途期间其他路径可能安排的探测,避免空跑。
        cancelReconnectProbe();
        let pending = offlineOutboxRef.current;
        // 兼容上一版只写 UNSYNCED_FLAG_KEY 的现场：没有 base 快照时，以当前远端作为
        // 基线、localStorage 当前态作为本地变更，至少保证升级后第一次重连不会丢本地工作。
        if (!pending && hasUnsyncedLocalChanges()) {
          pending = upsertOfflineOutbox({
            baseState: remoteState,
            localState: productStateRef.current
          });
          writePendingOutbox(pending);
        }
        // I-5(补审查):outbox 落盘曾失败(配额/隐私模式)→ 持久层没有可信副本,但当前内存态
        // 就是用户的离线工作。以最近一次已同步基线为 base、内存态为 local 重建 outbox 走
        // 三方合并,而不是掉进下面"无 pending → 无条件采纳远端"把离线修改静默覆盖。
        if (!pending && outboxStagingFailedRef.current) {
          pending = upsertOfflineOutbox({
            baseState: lastSyncedStateRef.current,
            localState: productStateRef.current
          });
          writePendingOutbox(pending);
        }
        if (!pending) {
          acceptAuthoritativeState(remoteState);
          return;
        }
        await synchronizeOfflineOutbox(pending, remoteState, 1, () => cancelled);
      })
      .catch((err) => {
        // The demo remains usable when the optional local API is not running.
        if (!cancelled) {
          setApiPersistenceEnabled(false);
          if (offlineOutboxRef.current) {
            setNotice(
              buildNotice(
                "warning",
                "离线修改仍在等待同步",
                err instanceof Error ? err.message : "后端当前不可用；持久 outbox 已保留本地工作。"
              )
            );
          }
          // 初次打开即离线时 autosave effect 不会发请求，因此需要独立的连接探测。
          // I-2/M-5:探测已抽成共享 scheduleReconnectProbe;只对可自愈失败(网络/5xx)
          // 继续轮询——401/4xx 是凭据/配置问题,无限轮询只会重复同一错误。
          if (shouldProbeReconnect(err)) {
            scheduleReconnectProbe();
          }
        }
      });

    return () => {
      cancelled = true;
      // 探测 timer 由 scheduleReconnectProbe 持有(共享 ref),在卸载 effect 里统一清理;
      // 这里不清——nonce 变化触发的重跑本身就是探测到点,timer 已经消费掉了。
    };
  }, [reconnectNonce]);

  const card = useMemo(() => buildInterviewCard(productState, activeSearchBriefId), [activeSearchBriefId, productState]);
  // Resume: surface the most-recent unfinished (active) session so it isn't stranded.
  const resumeCard = useMemo(() => buildInterviewResumeCard(productState), [productState]);
  // 认知雷达是本地确定性真实计数（非 LLM 叙事），始终可算可渲染。
  const localRadar = useMemo(() => buildCognitiveRadar(productState), [productState]);
  // LLM 综述只认服务端产出——不可用就把真实原因暴露给用户（reviewsError），
  // 绝不用本地确定性模板叙事顶替冒充。
  const monthlyReview = serverReviews?.monthly ?? null;
  const yearlyReview = serverReviews?.yearly ?? null;
  const radar = serverReviews?.radar ?? localRadar;

// RV-P1-01: only fetch LLM reviews when user opens themes (GET must not tax system budget on home).
  // Re-fetch when asset signature changes while themes is visible.
  const reviewSignatureRef = useRef<string>("");
  useEffect(() => {
    if (view !== "themes") {
      return;
    }
    const signature = [
      productState.notes.length,
      productState.points.length,
      productState.questions.length,
      productState.decisions.length,
      productState.debts.length,
      productState.themes.length
    ].join(":");
    if (signature === reviewSignatureRef.current && serverReviews) {
      return;
    }
    reviewSignatureRef.current = signature;
    setServerReviews(null);
    setReviewsError(null);
    let cancelled = false;
    productApiClient
      .getReviews()
      .then((reviews) => {
        if (!cancelled) {
          setServerReviews(reviews);
          setReviewsError(null);
        }
      })
      .catch((err) => {
        // LLM 综述失败：如实把服务端原因暴露给用户，绝不用本地模板叙事顶替。
        if (!cancelled) setReviewsError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [view, productState]);

  // Adopt an authoritative state returned by a fine-grained route. Records it as
  // "already saved" so the debounce effect doesn't echo the whole state back in a
  // redundant full-state PUT (the route already persisted it server-side).
  // 采纳服务端返回的权威 state(turn / control / createBrief / endSession 等已在服务端持久化)。
  // 接收 server state 必须用这个而非裸 setProductState:它把内容签名记进 lastSavedContentRef,让
  // 自动保存 effect 认出"已是最新"从而跳过 PUT。否则每次接收 server state 都会触发一次冗余 PUT 把
  // 它原样写回去,而这个 PUT 携带的 revision 会被下一轮 turn 在服务端抢先 bump → 持续 409(stale
  // revision)。语音访谈每轮高频出 turn 时尤其致命,也会让"结束并生成档案"与残留 PUT 互相 race。
  function adoptServerState(next: ProductState) {
    let pending = offlineOutboxRef.current;
    // If local edits exist but have not yet been staged into the outbox (autosave
    // debounce window), stage them first so adopt cannot silently clobber them.
    if (!pending) {
      const local = productStateRef.current;
      const localSig = productStateContentSignature(local);
      const remoteSig = productStateContentSignature(next);
      if (
        shouldStageLocalBeforeAdopt({
          localSignature: localSig,
          remoteSignature: remoteSig,
          lastSavedSignature: lastSavedContentRef.current
        })
      ) {
        const staged = upsertOfflineOutbox({ baseState: next, localState: local });
        writePendingOutbox(staged);
        offlineOutboxRef.current = staged;
        pending = staged;
      }
    }
    if (!pending) {
      acceptAuthoritativeState(next);
      return;
    }
    // 细粒度 route 成功不代表可以整体覆盖 pending local：先把它当新的 remote 做三方
    // 合并；无冲突自动追写，有冲突进入同一条用户裁决 UI。
    void synchronizeOfflineOutbox(pending, next).catch((err) => {
      setApiPersistenceEnabled(false);
      setNotice(buildNotice("warning", "服务端更新已收到，但本地同步未完成", err instanceof Error ? err.message : String(err)));
      // I-2:转离线后启动重连探测(仅网络/5xx 类可自愈失败;M-5)。
      if (shouldProbeReconnect(err)) {
        scheduleReconnectProbe();
      }
    });
  }

  async function keepLocalConflictVersion() {
    if (!syncConflict || syncResolving) return;
    setSyncResolving(true);
    // 用户已显式选“保留本地”：当前界面态可能在冲突条出现后又继续编辑，因此以 ref
    // 中的最新 local 为准；以看到的 remote 为新 base，清掉旧 conflicts 后重新走安全 PUT。
    const resolved = upsertOfflineOutbox({
      baseState: syncConflict.remoteState,
      localState: productStateRef.current
    });
    writePendingOutbox(resolved);
    setSyncConflict(null);
    try {
      await synchronizeOfflineOutbox(resolved, syncConflict.remoteState, 1);
    } catch (err) {
      setApiPersistenceEnabled(false);
      setNotice(buildNotice("warning", "本地版本尚未同步", err instanceof Error ? err.message : String(err)));
      // I-2:用户已选"保留本地"但推送失败——outbox 仍持有裁决结果,启动探测在恢复后自动重推。
      if (shouldProbeReconnect(err)) {
        scheduleReconnectProbe();
      }
    } finally {
      setSyncResolving(false);
    }
  }

  async function useRemoteConflictVersion() {
    if (!syncConflict || syncResolving) return;
    setSyncResolving(true);
    try {
      // 冲突条可能已停留一段时间；用户选远端时重新读取，不能采纳冲突发生时的过期快照。
      const latestRemote = await productApiClient.getState();
      // I-3(补审查):"采用服务器版本"会丢弃本地冲突修改(含冲突条出现后的继续编辑)。
      // 丢弃前把当前本地态备份进 localStorage 最后防线(backupUnsyncedState 此前零调用),
      // 极端误操作还能从 DevTools 取回,而不是彻底不可恢复。
      backupUnsyncedState(productStateRef.current);
      acceptAuthoritativeState(latestRemote);
      // P3-11:采用后仍复核指纹——若最新远端仍是示例/初始态,如实警示这很可能是灾备后的空库,
      // 而非真实数据(本地态已备份进 localStorage 最后防线,极端误操作可从 DevTools 取回)。
      if (isPristineDemoState(latestRemote)) {
        setNotice(buildNotice(
          "warning",
          "已采用服务器版本（疑似示例/初始数据）",
          "服务器返回的内容与首次运行的示例数据一致，后端可能被重置或损坏后重启。若这不是你预期的恢复结果，本地版本已备份，请检查后端后再决定。"
        ));
      } else {
        setNotice(buildNotice("info", "已采用服务器版本", "本地冲突修改已由你明确放弃，已加载服务器最新版本。"));
      }
    } catch (err) {
      setNotice(buildNotice("warning", "暂时无法采用服务器版本", "后端当前不可用；本地 outbox 与冲突状态仍保留，请稍后重试。"));
      // I-2:后端不可达导致无法完成裁决——启动探测;恢复后用户可再点一次"采用服务器版本"。
      if (shouldProbeReconnect(err)) {
        scheduleReconnectProbe();
      }
    } finally {
      setSyncResolving(false);
    }
  }

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

  // 引用跳源（最小实现）：切到该来源类型对应的视图，并用通知给出定位提示。
  // 不强求精确滚动高亮——把用户带到正确的视图，提示来源标题即可。
  function handleCitationClick(citation: ChatCitation) {
    const targetByType: Partial<Record<ChatCitation["sourceType"], View>> = {
      note: "notes",
      transcript: "notes",
      memory: "memory",
      material: "material",
      theme: "themes",
      point: "my-assets",
      decision: "my-assets",
      debt: "my-assets"
    };
    const target = targetByType[citation.sourceType] ?? "my-assets";
    // 逐字稿引用:解析 sourceId(形如 sessionId#turnId),在双轨笔记里展开该会话并滚动高亮该轮。
    if (citation.sourceType === "transcript") {
      const [sessionId, turnId] = citation.sourceId.split("#");
      if (sessionId) {
        setNotesFocus((prev) => ({ sessionId, ...(turnId ? { turnId } : {}), nonce: (prev?.nonce ?? 0) + 1 }));
      }
    }
    setView(target);
    setNotice(buildNotice("info", "已定位来源", `${citation.title}（${citation.sourceType}）`));
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
    // P3-03:返回链——让 MemoryGovernanceView 的 loading/done/error 状态机能真正 await 到完成
    //(此前返回 undefined,await 立即 resolve → loading/done 瞬时假信号、error 永不触发、防重入窗口≈0)。
    // P3-02:区分业务冲突(409/422/404:记忆状态已变,重试无益)与后端离线,不再一律"需要后端在线"。
    // rethrow 让 await 侧(approve/reject/编辑候选)的 catch 落到 error 状态;fire-and-forget 侧
    //(deprecate/delete)在各自调用点 .catch 兜底,避免未处理 rejection。
    return run()
      .then((next) => adoptServerState(next))
      .catch((err) => {
        const conflict = err instanceof ApiError && (err.status === 409 || err.status === 422 || err.status === 404);
        setNotice(buildNotice(
          "warning",
          conflict ? "操作未生效" : "操作失败",
          conflict ? "该记忆的状态已变化(可能已被处理或清理),请刷新后重试。" : "记忆治理需要后端在线。"
        ));
        throw err;
      });
  }
  function confirmDecision(id: string) {
    setConfirmingDecisionId(id);
    productApiClient
      .confirmDecision(id)
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

const approveCandidate = (id: string, mode: "merge" | "add" = "merge") =>
    withMemoryAction(async () => {
      const res = await productApiClient.approveMemoryCandidate(id, { mode });
      if (res.warning) {
        setNotice(buildNotice("warning", "记忆已确认", res.warning));
      }
      return res.state;
    });
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
    // Drop the host TTS sink ref. The pipeline.close() above already closed the
    // sink (releasing its WS + AudioContext); we just clear the handle so a torn-
    // down session can't leak a stale sink (and its recorded PCM) into the next.
    ttsSinkRef.current = null;
    // Discard any orphan whole-session recorder (voice session torn down without a
    // proper /end upload — e.g. new interview / purge / reset). finishInterview()
    // already nulls the ref BEFORE calling us when it wants to upload, so reaching
    // here with a recorder means the recording is intentionally dropped. Stop it to
    // release the MediaRecorder; ignore the resulting blob.
    if (audioRecorderRef.current) {
      const orphan = audioRecorderRef.current;
      audioRecorderRef.current = null;
      void orphan.stop().catch(() => { /* discarded */ });
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

  async function interruptAssistant() {
    setGuidanceState(prev => ({ ...prev, countThisTurn: 0, active: false }));
    // Hit whichever transport is live. cascade / omni have full barge-in; livekit
    // mutes local playback and publishes {type:"interrupt"} so agent session.interrupt()
    // stops synthesis (see agent/main.py + parse_interrupt_data_payload).
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
  async function launchInterview(
    mode: InterviewMode = "decision",
    searchBriefId = activeSearchBriefId,
    topicHint?: string
  ) {
    setPendingMode(mode);
    setActiveSearchBriefId(searchBriefId);
    setSession(null);
    await startInterview(mode, searchBriefId, topicHint);
  }

  async function startInterview(
    mode: InterviewMode = pendingMode,
    searchBriefId = activeSearchBriefId,
    topicHint?: string
  ) {
    if (startingRef.current) return; // 已在创建中 → 跳过,避免双触发产生多个空 session
    startingRef.current = true;
    setStartingInterview(true);
    try {
      const apiRun = await productApiClient.createInterviewSession({
        mode,
        strength: productState.profile.preferredStrength,
        ...(searchBriefId ? { searchBriefId } : {}),
        ...(topicHint?.trim() ? { topicHint: topicHint.trim() } : {})
      });
      setSession(apiRun.session);
      adoptServerState(apiRun.state);
      closeRealtimeVoiceSession();
      setApiPersistenceEnabled(true);
      setView("interview");
      return;
    } catch (err) {
      // 失败即如实暴露——专访追问/归档都依赖服务端 LLM，离线本地草稿会话（确定性引擎
      // 模板追问冒充 AI 追问）已剔除。后端不可达就是不能用。
      const message = err instanceof Error && err.message ? err.message : "请检查服务后重试。";
      if (isNetworkError(err)) {
        setApiPersistenceEnabled(false);
        scheduleReconnectProbe();
        setNotice(buildNotice("danger", "无法开始专访", "后端不可达，专访功能不可用。恢复连接后请重试。"));
      } else {
        setNotice(buildNotice("danger", "无法开始专访", message));
      }
    } finally {
      startingRef.current = false;
      setStartingInterview(false);
    }
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
      const failed = response.summary.failed ?? 0;
      if (failed > 0) {
        setNotice(buildNotice(
          "warning",
          "自动盯梢部分完成",
          `新增 ${response.summary.generated} 条，刷新 ${response.summary.refreshed} 条，失败 ${failed} 条。`
        ));
      } else {
        setNotice(buildNotice("success", "自动盯梢完成", `新增 ${response.summary.generated} 条，刷新 ${response.summary.refreshed} 条。`));
      }
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
        ...(podcastSourceType === "note" ? { noteId: effectiveSourceId } : {}),
        sourceType: podcastSourceType,
        sourceId: effectiveSourceId,
        format: "solo",
        voice: podcastVoice
      });
      adoptServerState(apiRun.state);
      setApiPersistenceEnabled(true);
      setPodcastNoteId(effectiveSourceId);
      setPodcastEditingScript(apiRun.episode.script);
      setNotice(buildNotice("success", "播客脚本已生成", `使用声音配置：${apiRun.episode.voice}`));
      setView("podcast");
    } catch (err) {
      // 失败即如实暴露——不再在后端不可达时本地捏造脚本并用与真实成功相同的提示冒充。
      const message = err instanceof Error && err.message ? err.message : "请检查服务与配置后重试。";
      if (isNetworkError(err)) {
        setApiPersistenceEnabled(false);
      }
      setNotice(buildNotice("danger", "播客脚本生成失败", message));
    }
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

    // P3-09:此前先裸 setProductState 乐观更新、再 fire-and-forget 整包 saveState(PUT),然后又调
    // synthesize——而 synthesize 本身就带着 scriptToSynthesize 在服务端确认脚本 + 持久化(见下)。
    // 那条 saveState 是纯写放大:PUT 一份和 synthesize 即将持久化的同一脚本,还触发 autosave echo。
    // 收敛不丢数据(synthesize 是权威),故删除旁路 PUT,统一由 synthesize 结果走 adoptServerState。
    try {
      const { state: synthState } = await productApiClient.synthesizePodcastEpisode(episodeId, scriptToSynthesize);
      adoptServerState(synthState);   // 采纳权威态(revision 已 bump,不触发 echo PUT)
      setApiPersistenceEnabled(true);
      setPodcastEditingScript("");
      setNotice(buildNotice("success", "语音合成完成", `播客 "${episode.title}" 音频已渲染。`));
    } catch (err) {
      // 后端合成失败已如实 502/503（脚本在服务端保留），把真实原因暴露给用户。
      const message = err instanceof Error && err.message ? err.message : "TTS 请求失败。";
      setNotice(buildNotice("danger", "语音合成失败", `${message}（脚本已保留，可重试。）`));
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
      adoptServerState(apiRun.state);
      setApiPersistenceEnabled(true);
      setNotice(buildNotice("success", "语料分析已完成", "已生成可确认的访谈策略补丁。"));
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

  // N-13:apply/revert 接后端 CAS 路由(与 confirmDecision 同款权威态语义),不再前端本地 mutate+
  // autosave 那条与后端语义分叉的平行路径。后端对非法流转响亮回 409/422 → .catch 如实提示,
  // 顺带根治 P3-01(revert 对非 applied 补丁的"假成功"):不再无脑报成功。采纳后端权威态(revision
  // 已 bump),避免下一次乐观 PUT 撞 409。
  function applyPlaybookPatch(patchId: string, overrideRules?: string[]) {
    productApiClient
      .applyPlaybookPatch(patchId, overrideRules)
      .then((next) => {
        adoptServerState(next);
        setNotice(buildNotice("success", "PlaybookPatch 已应用", "系统配置已记录新的访谈策略版本。"));
        setView("config");
      })
      .catch((err) => {
        const conflict = err instanceof ApiError && (err.status === 409 || err.status === 404);
        setNotice(buildNotice(
          "warning",
          conflict ? "无法应用" : "操作失败",
          conflict ? "该补丁已处置(已应用或已撤销)或不存在,不能重复应用。" : "应用补丁需要后端在线。"
        ));
      });
  }

  function revertPatch(patchId: string) {
    productApiClient
      .revertPlaybookPatch(patchId)
      .then((next) => {
        adoptServerState(next);
        setNotice(buildNotice("info", "已撤销应用", "该访谈策略补丁已回退，后续访谈不再套用它。"));
      })
      .catch((err) => {
        const conflict = err instanceof ApiError && (err.status === 422 || err.status === 404);
        setNotice(buildNotice(
          "warning",
          conflict ? "无法撤销" : "操作失败",
          conflict ? "只有已应用的补丁可以撤销。" : "撤销补丁需要后端在线。"
        ));
      });
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
      adoptServerState(apiRun.state);
      setApiPersistenceEnabled(true);
    } catch (err) {
      // 失败即如实暴露、恢复输入让用户重试——离线本地"确定性引擎追问"已剔除。
      const message = err instanceof Error && err.message ? err.message : "本轮未送到服务端，请重试。";
      if (isNetworkError(err)) {
        setApiPersistenceEnabled(false);
      }
      setNotice(buildNotice("danger", "本轮未送达", message));
      setInterviewInput(content);
    } finally {
      setSubmittingTurn(false);
    }
  }

  async function finishInterview() {
    if (!session) {
      return;
    }
    if (finishingRef.current) return; // 防重入:/end 在途(LLM 档案抽取慢),忽略重复点击
    // Align with the server's rule: at least one USER turn (control feedback turns
    // don't count). Pre-checking avoids a 422 that the catch would misread as offline.
    const userTurnCount = session.turns.filter((turn) => turn.role === "user").length;
    if (userTurnCount === 0) {
      setNotice(buildNotice("warning", "还不能结束", "先回答至少一轮，再结束并生成档案。"));
      return;
    }

    finishingRef.current = true;
    setFinishingInterview(true);
    try {
      const endedSessionId = session.id;
      const apiRun = await productApiClient.endInterviewSession(endedSessionId);
      // The /end response is already the authoritative LIGHT state (turns
      // offloaded to cold storage). Adopt it so the autosave effect doesn't PUT
      // the (now empty) turns back and re-inflate the just-offloaded session.
      adoptServerState(apiRun.state);
      setApiPersistenceEnabled(true);
      // Whole-session voice recording: stop it BEFORE closeRealtimeVoiceSession()
      // tears down the mic tracks (MediaRecorder needs the live stream to flush its
      // final chunk), then upload. Best-effort — a failed upload only warns; it must
      // not block ending the interview. On the text path the ref is null → skipped.
      // 「本场不保存」(doNotSave) 的会话：两路音频（受访者麦克风 + 主持人 TTS）一律
      // 不上传——用户明确要求不落盘，录音仍需 stop 以释放 MediaRecorder，但直接丢弃。
      const skipAudioUpload = session.doNotSave === true;
      if (skipAudioUpload) {
        console.info(JSON.stringify({ event: "audio_upload_skipped_do_not_save", sessionId: endedSessionId }));
      }
      const recorder = audioRecorderRef.current;
      audioRecorderRef.current = null;
      if (recorder) {
        if (skipAudioUpload) {
          void recorder.stop().catch(() => { /* discarded */ });
        } else {
          void recorder
            .stop()
            .then(({ blob, durationMs, recordingStartedAt }) =>
              productApiClient.uploadSessionAudio(endedSessionId, blob, durationMs, recordingStartedAt)
            )
            .catch(() =>
              setNotice(buildNotice("warning", "录音未保存", "本场语音录音上传失败，不影响笔记与资产。"))
            );
        }
      }
      // Host (interviewer) TTS audio: drain the sink's side-channel PCM tap, wrap
      // as WAV, upload as role=interviewer. Best-effort and non-blocking — a
      // failure only warns to console. No recordingStartedAt: the host audio is
      // stitched-together AI speech with no continuous timeline, so per-turn seek
      // doesn't apply (the viewer plays it as one continuous track). The sink ref
      // is cleared by closeRealtimeVoiceSession() below; read it before that.
      const ttsSink = ttsSinkRef.current;
      if (!skipAudioUpload && ttsSink?.getRecordedPcm) {
        const rec = ttsSink.getRecordedPcm();
        if (rec && rec.pcm.length > 0) {
          const wav = pcmS16leMonoToWav(rec.pcm, rec.sampleRate);
          void productApiClient
            .uploadSessionAudio(endedSessionId, wav, undefined, undefined, "interviewer")
            .catch((err: unknown) => {
              console.warn(JSON.stringify({
                event: "interviewer_audio_upload_failed",
                error: err instanceof Error ? err.message : String(err),
              }));
            });
        }
      }
      setSession(null);
      closeRealtimeVoiceSession();
      if (session.doNotSave) {
        setNotice(buildNotice("info", "专访已结束（未写入长期资产）", "按你的选择，本场不沉淀双轨笔记与认知资产。"));
        setView("home");
} else {
        const pendingCount =
          apiRun.pendingMemoryCandidateCount ??
          apiRun.state.memoryCandidates.filter((c) => c.status === "pending").length;
        const detail =
          pendingCount > 0
            ? `双轨笔记已更新。另有 ${pendingCount} 条记忆候选待审，确认后才进入跨会话向量召回。`
            : "双轨笔记和认知资产已更新。";
        setNotice(buildNotice("success", "专访档案已生成", detail));
        // R-P1-04: pending HITL is the real next step for long-term recall — don't bury it on notes.
        setView(pendingCount > 0 ? "memory" : "notes");
      }
      return;
    } catch (err) {
      // 已结束(409)/会话不存在(404):这场专访其实已经收尾(常见于 /end 调 LLM 较慢时用户
      // 重复点"结束")。视为成功跳转,绝不误报"结束失败"再诱导继续点。
      if (err instanceof ApiError && (err.status === 409 || err.status === 404)) {
        const wasDoNotSave = session.doNotSave === true;
        setSession(null);
        closeRealtimeVoiceSession();
        if (wasDoNotSave) {
          setNotice(buildNotice("info", "专访已结束（未写入长期资产）", "这场专访已收尾，且按选择未沉淀长期资产。"));
          setView("home");
        } else {
          setNotice(buildNotice("info", "专访已结束", "这场专访已经收尾，已为你跳转到笔记。"));
          setView("notes");
        }
        return;
      }
      // 失败即如实暴露——会话保持打开可重试，离线本地确定性 finalize（模板轻量档案）已剔除。
      const message = err instanceof Error && err.message ? err.message : "请稍后重试。本次未生成档案。";
      if (isNetworkError(err)) {
        setApiPersistenceEnabled(false);
        setNotice(buildNotice("danger", "结束失败", "后端不可达，无法归档。会话已保留，恢复连接后请重试。"));
      } else {
        setNotice(buildNotice("danger", "结束失败", `${message}`));
      }
    } finally {
      finishingRef.current = false;
      setFinishingInterview(false);
    }
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
      adoptServerState(apiRun.state);
      setApiPersistenceEnabled(true);
      setNotice(buildNotice("info", "访谈控制已应用", `下一轮会按「${controlLabel}」调整。`));
    } catch (err) {
      // 失败即如实暴露——离线本地控制分叉已剔除（会话是服务端权威的，本地改了也不生效）。
      const message = err instanceof Error && err.message ? err.message : "请稍后重试。";
      if (isNetworkError(err)) {
        setApiPersistenceEnabled(false);
      }
      setNotice(buildNotice("danger", "控制未生效", message));
    }
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

  // 专访旁注:沿 addCorrection 模式(域函数 + setProductState → 走现有 autosave)。
  // Task 11 会把这两个 handler 传给 RawMaterialViewer。
  function addInterviewAnnotation(sessionId: string, turnId: string, text: string) {
    setProductState(addAnnotation(productState, sessionId, turnId, text));
  }
  function removeInterviewAnnotation(id: string) {
    setProductState(removeAnnotation(productState, id));
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
    setPodcastEditingScript("");
    setCorpusMediaType("text");
    setCorpusSourceUrl("");
    setCorpusAudioBase64("");
    setCorpusAudioFileName("");
    // F-03:文案由上方分流决定——只有服务端确认全部清空才是成功文案。
    setNotice(notice);
    setView("home");
  }

  async function toggleRealtimeRecording() {
    if (recording) {
      closeRealtimeVoiceSession();
      return;
    }
    // P3-19:连接建立窗口内的二次触发直接短路(停止路径在上方,幂等 close,无需守卫)。
    if (togglingRef.current) return;
    togglingRef.current = true;

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
            const baseWsUrl = realtimeApiWsBaseUrl();
            const asrWsUrl = withAuthTokenQuery(`${baseWsUrl}/api/realtime-voice/ws/${voiceSession.sessionId}`);
            const ttsWsUrl = withAuthTokenQuery(`${baseWsUrl}/api/realtime-voice/ws/tts/${voiceSession.sessionId}`);
            const interviewId = session?.id ?? "";

            const asr = createBrowserAsrSource({
              asrWsUrl,
              instructions: voiceSession.sessionUpdate.session.instructions,
              // 审计修复(P2-22):中途断连如实上报并收尾——此前 UI 停在"聆听"假象,用户
              // 继续说话被静默丢帧,只能自己困惑几十秒后手动重开。
              onConnectionLost: () => {
                setNotice(buildNotice("warning", "语音连接已断开", "语音识别中断,请重新点击录音继续。文字输入不受影响。"));
                closeRealtimeVoiceSession();
              },
              // Tee the live mic into a whole-session recorder. Best-effort: guard
              // construction so a recorder failure never breaks ASR start. The
              // recording is uploaded at /end (see finishInterview).
              onMicStream: (stream) => {
                try {
                  const recorder = createSessionAudioRecorder(stream);
                  recorder.start();
                  audioRecorderRef.current = recorder;
                } catch (err) {
                  audioRecorderRef.current = null;
                  console.warn(JSON.stringify({
                    event: "session_recorder_start_failed",
                    error: err instanceof Error ? err.message : String(err),
                  }));
                }
              }
            });
            const tts = createBrowserTtsSink(ttsWsUrl, productState.systemConfig.voice.defaultVoice);
            // Hold the sink so finishInterview() can drain its host-audio PCM tap.
            ttsSinkRef.current = tts;

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
              adoptServerState(r.state);
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
            // 走 productApi 的 authedFetch（getLivekitToken）：production bearer 鉴权下
            // 裸 fetch 不带 Authorization 恒 401。失败仍抛错 → 下方 catch 提示连接失败。
            const { token, serverUrl } = await productApiClient.getLivekitToken(sessionId, interviewId);

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
                    .catch((err) => recordTurnFailedFallback(text, err));
                  // Phase 8: regenerate pre_signals — failures are observable (parity with omni).
                  if (interviewId) {
                    productApiClient
                      .generateInterviewPreSignals(interviewId)
                      .then((res) => {
                        voiceRecallRefreshSucceeded();
                        setSession((prev) => (prev ? { ...prev, interactionPreSignals: res.preSignals } : prev));
                      })
                      .catch((err) => voiceRecallRefreshFailed("pre_signals", err));
                  }
                  // LiveKit agent re-fetches agent-context server-side each turn; client
                  // still records user turns authoritatively via record-turn above.
                },
                onAssistantTranscript: (text, isFinal) => {
                  if (!isFinal || !text.trim()) return;
                  setVoiceStatus("speaking");
                  // Authoritative assistant trail on the server (not only local UI).
                  if (interviewId) {
                    productApiClient
                      .recordInterviewTurn(interviewId, { role: "assistant", content: text })
                      .then((r) => setSession(r.session))
                      .catch(() => {
                        setSession((prev) =>
                          prev ? appendAssistantTranscriptFinal(prev, text, assistantTranscriptTurnRef) : prev
                        );
                      });
                  } else {
                    setSession((prev) =>
                      prev ? appendAssistantTranscriptFinal(prev, text, assistantTranscriptTurnRef) : prev
                    );
                  }
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
                productApiBaseUrl: realtimeApiWsBaseUrl(),
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
                      .catch((err) => recordTurnFailedFallback(text, err));
                  } else {
                    setSession((prev) => (prev ? receiveUserTurn(prev, text) : prev));
                  }
                  // Phase 8: regenerate pre_signals for the next turn and push
                  // them into the live connection (the voice model can't emit them).
                  if (voiceSid) {
                    productApiClient
                      .generateInterviewPreSignals(voiceSid)
                      .then((res) => {
                        voiceRecallRefreshSucceeded();
                        setSession((prev) => (prev ? { ...prev, interactionPreSignals: res.preSignals } : prev));
                        if ("updatePreSignals" in connection) connection.updatePreSignals(res.preSignals);
                      })
                      .catch((err) => voiceRecallRefreshFailed("pre_signals", err));
                    // 🔴-1: recompute the omni voice model's instructions against THIS
                    // turn's utterance so its memory recall tracks the conversation
                    // (the realtime session set instructions only once at open — an
                    // opening-time snapshot). Push the refreshed string via
                    // session.update. Non-blocking（实时策略）但失败可观测,
                    // 连续失败会向用户提示（见 voiceRecallRefreshFailed）。
                    productApiClient
                      .refreshVoiceInstructions(voiceSid, text)
                      .then((res) => {
                        voiceRecallRefreshSucceeded();
                        if ("updateInstructions" in connection) connection.updateInstructions(res.instructions);
                        // C-P1-04: server now persists refreshed guide; adopt so UI/state
                        // match the model context (no silent fork after voice turns).
                        if (res.state) adoptServerState(res.state);
                        if (res.session) setSession(res.session);
                      })
                      .catch((err) => voiceRecallRefreshFailed("voice_instructions", err));
                  }
                },
                onAssistantTranscript: (text, isFinal) => {
                  if (!isFinal || !text.trim()) return;
                  // Omni: persist assistant turn server-side so session trail is not empty.
                  const assistantSid = session?.id ?? "";
                  if (assistantSid) {
                    productApiClient
                      .recordInterviewTurn(assistantSid, { role: "assistant", content: text })
                      .then((r) => setSession(r.session))
                      .catch(() => {
                        setSession((prev) =>
                          prev ? appendAssistantTranscriptFinal(prev, text, assistantTranscriptTurnRef) : prev
                        );
                      });
                  } else {
                    setSession((prev) =>
                      prev ? appendAssistantTranscriptFinal(prev, text, assistantTranscriptTurnRef) : prev
                    );
                  }
                },
                // 重连过程对用户可见（此前 3 次重连期间 UI 仍显示"聆听中"，用户不知连接已断）。
                onReconnecting: (attempt, maxAttempts) => {
                  setVoiceStatus("connecting");
                  setNotice(buildNotice("warning", "语音连接中断", `正在重连（第 ${attempt}/${maxAttempts} 次）…`));
                },
                onReconnected: () => {
                  setVoiceStatus("listening");
                  setNotice(buildNotice("success", "语音连接已恢复", "可以继续对话。"));
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
    } finally {
      // P3-19:连接流程 settle(成功就绪 / 失败 / 早返回)后复位,让后续开关正常工作。
      togglingRef.current = false;
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
        {view === "notes" && (
          <NotesView
            state={productState}
            onStart={launchInterview}
            onSaveQuestion={saveNoteQuestion}
            onAddAnnotation={addInterviewAnnotation}
            onRemoveAnnotation={removeInterviewAnnotation}
            getRawMaterial={(sessionId) => productApiClient.getRawMaterial(sessionId)}
            getAudioMeta={(sessionId, role) => productApiClient.getSessionAudioMeta(sessionId, role)}
            audioUrl={(sessionId) => productApiClient.sessionAudioUrl(sessionId)}
            getAudioBlob={(sessionId, role) => productApiClient.fetchSessionAudioBlob(sessionId, role)}
            focus={notesFocus}
          />
        )}
        {view === "material" && (
          <MaterialLibraryView
            state={productState}
            onImport={importMemoryDocument}
            onRebuildIndex={() => productApiClient.rebuildKnowledgeIndex()}
            onDeleteSource={(id) => {
              // 素材删除会连带清其知识索引块(经包装的 PUT autosave 触发 reindex),不可撤销 → 二次确认。
              if (typeof window !== "undefined" && !window.confirm("确定删除这份素材吗？它在知识库/资产对话中的索引也会一并移除，无法撤销。")) {
                return;
              }
              setProductState(deleteImportSource(productState, id));
            }}
          />
        )}
        {view === "asset-chat" && (
          <AssetChatView
            state={productState}
            selectedSessionId={chatSessionId}
            onSelectChat={setChatSessionId}
            onNewChat={() => setChatSessionId(null)}
            onSend={async (sid, msg) => {
              const result = await productApiClient.sendChatMessage(sid, msg);
              adoptServerState(result.state);
              setApiPersistenceEnabled(true);
              setChatSessionId(result.sessionId);
            }}
            onDeleteChat={(id) => {
              // 删除整条对话历史不可撤销 → 二次确认(与全站删除约定一致)。
              if (typeof window !== "undefined" && !window.confirm("确定删除这条对话吗？整段对话历史将被移除，无法撤销。")) {
                return;
              }
              setProductState(deleteChatSession(productState, id));
              if (chatSessionId === id) {
                setChatSessionId(null);
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
        {view === "themes" && <ThemesView state={productState} review={monthlyReview} yearlyReview={yearlyReview} radar={radar} reviewsError={reviewsError} onStart={launchInterview} onOpenTrack={openTrack} />}
        {view === "track" && (
          <TrackWorkspaceView
            workspace={buildTrackWorkspace(productState, selectedTrackId ?? "")}
            onBack={() => setView("home")}
            onContinue={() => {
              const themeName = buildTrackWorkspace(productState, selectedTrackId ?? "").theme?.name;
              void launchInterview("long-term", undefined, themeName);
            }}
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
            onImport={importMemoryDocument}
            onApprove={approveCandidate}
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
            onSaveProfilePersist={async (next) => {
              setProductState(next);
              const { state: server, conflicted } = await productApiClient.saveState(next);
              if (conflicted) {
                await synchronizeOfflineOutbox(
                  upsertOfflineOutbox({ baseState: server, localState: next }),
                  server
                );
              } else {
                acceptAuthoritativeState(server);
              }
              setApiPersistenceEnabled(true);
            }}
          />
        )}
      </main>
    </div>
    </>
  );
}

/** Re-export domain helper for existing tests that import from App. */
export { appendAssistantTranscriptFinal } from "./domain/session-transcript";

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
