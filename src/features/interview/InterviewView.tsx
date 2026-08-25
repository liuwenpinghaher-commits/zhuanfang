import type { FormEvent, KeyboardEvent } from "react";
import { useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronRight, Flag, Lightbulb, Mic, MicOff, Pause, Play, Settings2, Sparkles } from "lucide-react";
import { HeaderBlock } from "../../components/HeaderBlock";
import type { buildInterviewCard, buildRealtimeTurnState } from "../../domain/engine";
import { INTERVIEW_STRATEGY_LABELS, PLAYBOOK_DRIVEN_STRATEGIES } from "../../domain/engine";
import type { InterviewControlAction, InterviewMode, InterviewSession } from "../../domain/types";
import type { TranscriptReviewItem } from "../../realtime/cascadedPipeline";
import type { VoiceUiStatus } from "../../realtime/voiceTransportLifecycle";
import { formatRealtimePhase, interviewControlGroups } from "../../ui";

interface InterviewViewProps {
  card: ReturnType<typeof buildInterviewCard>;
  session: InterviewSession | null;
  pendingMode: InterviewMode;
  input: string;
  recording: boolean;
  realtimeState: ReturnType<typeof buildRealtimeTurnState> | null;
  audioLevel: number;
  voiceStatus: VoiceUiStatus;
  liveUserTranscript: string;
  voiceReviewItem?: TranscriptReviewItem | null;
  voiceTransport: "webrtc" | "websocket" | "livekit" | null;
  onInput: (value: string) => void;
  onStart: (mode?: InterviewMode, searchBriefId?: string, topicHint?: string, relatedThemeIds?: string[]) => void;
  /** 无场时回到今日台开场，避免第二开场台。 */
  onGoHome?: () => void;
  launchSearchBriefId?: string;
  launchTopicHint?: string;
  launchRelatedThemeIds?: string[];
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onFinish: () => void;
  onControl: (action: InterviewControlAction) => void;
  onToggleRecording: () => void | Promise<void>;
  onInterrupt: () => void;
  onVoiceReviewText?: (text: string) => void;
  onConfirmVoiceReview?: () => void;
  onDiscardVoiceReview?: () => void;
  /** Phase C: suppress decision/debt revisit for this session only. */
  onSuppressRevisit?: (kind: "decision" | "debt", label: string) => void;
  submitting?: boolean;
  retryAvailable?: boolean;
  starting?: boolean;
  finishing?: boolean;
  guidanceState?: {
    active: boolean;
    kind: string | null;
    text: string | null;
    countThisTurn: number;
  };
}

const MODE_LABEL: Record<InterviewMode, string> = {
  daily: "日常复盘",
  decision: "决策专访",
  point: "观点专访",
  learning: "学习专访",
  organization: "组织/关系",
  "long-term": "长期主题"
};

/** Avoid "决策专访：继续追问：控制感" stacking. */
export function formatInterviewHeaderTitle(session: InterviewSession): string {
  const mode = MODE_LABEL[session.mode] ?? session.mode;
  let topic = (session.title || "").trim();
  const modePrefix = new RegExp(`^${mode.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[：:]\s*`, "u");
  topic = topic.replace(modePrefix, "");
  topic = topic.replace(/^继续追问[：:]\s*/u, "");
  topic = topic.replace(modePrefix, "");
  if (!topic || topic === mode) return mode;
  return `${mode} · ${topic}`;
}

export function InterviewView({
  card,
  session,
  pendingMode,
  input,
  recording,
  realtimeState,
  audioLevel,
  voiceStatus,
  liveUserTranscript,
  voiceReviewItem,
  voiceTransport,
  onInput,
  onStart,
  onGoHome,
  launchSearchBriefId,
  launchTopicHint,
  launchRelatedThemeIds,
  onSubmit,
  onFinish,
  onControl,
  onToggleRecording,
  onInterrupt,
  onVoiceReviewText,
  onConfirmVoiceReview,
  onDiscardVoiceReview,
  onSuppressRevisit,
  submitting,
  retryAvailable,
  starting,
  finishing,
  guidanceState
}: InterviewViewProps) {
  const turnListRef = useRef<HTMLDivElement>(null);
  const [controlsOpen, setControlsOpen] = useState(false);

  useEffect(() => {
    if (turnListRef.current) {
      turnListRef.current.scrollTop = turnListRef.current.scrollHeight;
    }
  }, [session?.turns.length]);

  useEffect(() => {
    if (!recording) return;
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        void onToggleRecording();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [recording, onToggleRecording]);

  // Open controls when user is mid-conversation and may need them; keep collapsed on empty first paint.
  useEffect(() => {
    if (session && session.turns.length > 0) {
      setControlsOpen(false);
    }
  }, [session?.id]);

  if (!session) {
    return (
      <section className="interview-launch">
        <div className="launch-inner">
          <span className="eyebrow">实时专访</span>
          <h1>还没有正在进行的专访</h1>
          <p>这里只谈已经开起来的一场。选题、继续未完成、带简报，都在今日访谈台。</p>
          <div className="launch-prompt">
            <span>当前推荐</span>
            <strong>{card.title}</strong>
          </div>
          <button
            className="launch-action"
            type="button"
            onClick={() => (onGoHome ? onGoHome() : onStart(pendingMode, launchSearchBriefId, launchTopicHint, launchRelatedThemeIds))}
            disabled={starting}
            aria-busy={starting}
          >
            <Play size={18} />回今日台开场
          </button>
        </div>
      </section>
    );
  }

  const phaseLabel = formatRealtimePhase(realtimeState?.phase ?? "holding");
  const confidence = Math.round((realtimeState?.confidence ?? 0.72) * 100);
  const strengthLabel = {
    gentle: "温和",
    standard: "标准",
    sharp: "直接"
  }[session.strength];
  const liveRelevantMemories = (session.guide.relevantMemories ?? []).filter((m) => m.trim());
  const openingHistoryReferences = session.card.historyReferences.filter((m) => m.trim());
  const memoryListForSidebar =
    liveRelevantMemories.length > 0
      ? liveRelevantMemories
      : openingHistoryReferences.length > 0
        ? openingHistoryReferences
        : ["暂无明确可引用记忆"];
  const appliedTechniques = (session.enginePolicy?.appliedPlaybookRules ?? []).filter((rule) => rule.trim());
  const sessionCard = session.card;
  const suppressed = session.suppressedRevisitIds ?? [];
  const lastStrategy = session.strategyTrace?.at(-1);
  const openDebts = (session.guide.openDebts ?? []).filter(
    (d) => !suppressed.includes(`debt:${d.concept.trim()}`)
  );
  const decisionsToReview = (session.guide.decisionsToReview ?? []).filter(
    (d) => !suppressed.includes(`decision:${d.title.trim()}`)
  );
  const busy = Boolean(submitting || finishing);
  const controlsDisabled = busy;
  const userTurnCount = session.turns.filter((t) => t.role === "user").length;
  const headerTitle = formatInterviewHeaderTitle(session);
  const statusLine =
    realtimeState?.nextAction ??
    (session.turns.length === 0
      ? "先回答下方开场问题（也可开语音）"
      : recording
        ? "语音对话进行中"
        : "围绕锚点继续追问");

  function handleComposerKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
      event.preventDefault();
      const form = event.currentTarget.form;
      if (form && input.trim() && !busy) {
        form.requestSubmit();
      }
    }
  }

  function handleControl(action: InterviewControlAction) {
    if (controlsDisabled) return;
    onControl(action);
  }

  return (
    <section className="view-stack">
      <HeaderBlock
        eyebrow="实时专访"
        title={headerTitle}
        subtitle={
          voiceTransport
            ? `${voiceTransport === "websocket" ? "WebSocket 实时语音" : voiceTransport === "livekit" ? "LiveKit 级联语音" : "实时语音"} · 与文本写入同一份记录`
            : "默认文本追问；需要时再点「语音」。会话与已提交回合会保留。"
        }
      />

      <section className="interview-layout">
        <div className="conversation-panel">
          <div className="conversation-header">
            <div>
              <span className="label">当前状态</span>
              <strong>{statusLine}</strong>
              <div className="interview-status-chips" aria-label="本场标记">
                <span className="status-pill">{strengthLabel}强度</span>
                <span className={`status-pill${session.doNotSave ? " is-stale" : " is-tracked"}`}>
                  {session.doNotSave ? "本场不保存资产" : "可写入资产"}
                </span>
                {session.pendingControl && (
                  <span className="status-pill is-emphasis">下轮：{controlActionLabel(session.pendingControl)}</span>
                )}
              </div>
            </div>
            <div className="voice-controls">
              {recording && voiceStatus === "speaking" && (
                <button className="interrupt-button" type="button" onClick={onInterrupt} title="打断 AI" disabled={finishing}>
                  <Pause size={16} />打断
                </button>
              )}
              <button
                className={`record-button ${recording ? "active" : ""} ${voiceStatus}`}
                type="button"
                onClick={onToggleRecording}
                disabled={finishing}
                aria-label={recording ? "停止录音" : "开始录音"}
              >
                <span className="record-icon">
                  {recording ? <MicOff size={18} /> : <Mic size={18} />}
                </span>
                <span className="record-label">{recording ? "停止" : "语音"}</span>
                {voiceTransport && (
                  <span className="transport-badge">
                    {voiceTransport === "websocket" ? "WS" : voiceTransport === "livekit" ? "LK" : "RTC"}
                  </span>
                )}
              </button>
            </div>
          </div>

          {recording && (
            <div className="voice-panel" aria-live="polite">
              <div className="waveform-container">
                <div className={`waveform ${voiceStatus}`}>
                  {Array.from({ length: 16 }).map((_, i) => (
                    <span
                      key={i}
                      className="waveform-bar"
                      style={{
                        animationDelay: `${i * 0.06}s`,
                        height:
                          voiceStatus === "idle"
                            ? "4px"
                            : `${4 + audioLevel * 36 * (0.4 + 0.6 * Math.sin((i / 16) * Math.PI))}px`
                      }}
                    />
                  ))}
                </div>
                <div className="voice-status-label">
                  {voiceStatus === "connecting" && <><span className="status-dot connecting" />正在连接…</>}
                  {voiceStatus === "thinking" && <><span className="status-dot connecting" />正在想下一问</>}
                  {voiceStatus === "listening" && <><span className="status-dot listening" />聆听中 · 说完稍等片刻</>}
                  {voiceStatus === "speaking" && <><span className="status-dot speaking" />AI 正在回应</>}
                  {voiceStatus === "interrupted" && <><span className="status-dot interrupted" />已打断</>}
                  {voiceStatus === "reconnecting" && <><span className="status-dot connecting" />语音连接恢复中，请稍候</>}
                  {voiceStatus === "degraded" && <><span className="status-dot interrupted" />语音兼容模式 · 可继续专访</>}
                  {voiceStatus === "idle" && <><span className="status-dot idle" />等待语音</>}
                </div>
              </div>
            </div>
          )}

          {voiceStatus === "exhausted" && (
            <div className="voice-review" role="status" aria-live="polite">
              <div className="voice-review-heading">
                <strong>语音连接未恢复，已保留本场文字专访</strong>
                <span>可直接打字继续，或重新点击「语音」建立新连接。</span>
              </div>
            </div>
          )}

          {liveUserTranscript && (
            <div className="live-transcript">
              <span className="live-transcript-label">实时转写</span>
              <p>{liveUserTranscript}</p>
            </div>
          )}
          {voiceReviewItem && (
            <div className="voice-review" data-testid="voice-review" role="alert">
              <div className="voice-review-heading">
                <strong>等待确认的转写</strong>
                <span>
                  {voiceReviewItem.source === "recovery"
                    ? "连接中断前的尾段尚未确认，尚未写入专访"
                    : "可能混入刚才的 AI 语音，尚未写入专访"}
                </span>
              </div>
              <textarea
                aria-label="等待确认的语音转写"
                value={voiceReviewItem.text}
                onChange={(event) => onVoiceReviewText?.(event.target.value)}
              />
              <small>{voiceReviewItem.reason}</small>
              <div className="voice-review-actions">
                <button type="button" data-action="discard" onClick={onDiscardVoiceReview}>丢弃</button>
                <button type="button" data-action="confirm" onClick={onConfirmVoiceReview} disabled={!voiceReviewItem.text.trim()}>
                  确认并提交
                </button>
              </div>
            </div>
          )}
          {guidanceState?.active && guidanceState.text && (
            <div className="guidance-indicator" aria-live="polite">
              <span className="guidance-badge">
                {guidanceState.kind === "anchor_probe"
                  ? "追问锚点"
                  : guidanceState.kind === "emotion_label"
                    ? "情感标记"
                    : guidanceState.kind === "contradiction"
                      ? "发现矛盾"
                      : guidanceState.kind === "nudge"
                        ? "轻推"
                        : guidanceState.kind === "echo"
                          ? "回音"
                          : "引导"}
              </span>
              <p className="guidance-text">{guidanceState.text}</p>
            </div>
          )}

          {recording && (
            <div className="interview-rhythm" aria-live="polite">
              <div className="rhythm-main">
                <span className="label">会中节奏</span>
                <strong>{phaseLabel}</strong>
                <p>{realtimeState?.nextAction ?? "先让表达完整出现，再决定是否追问。"}</p>
              </div>
              <div className="rhythm-side">
                <div className="rhythm-meter" aria-label={`系统把握 ${confidence}%`}>
                  <span style={{ width: `${confidence}%` }} />
                </div>
                <div className="rhythm-meta">
                  <span>追问强度：{strengthLabel}</span>
                  <span>{session.doNotSave ? "不写入长期资产" : "可写入资产"}</span>
                </div>
              </div>
            </div>
          )}

          {/* 对话流：优先于控制条 */}
          <div className="turn-list" ref={turnListRef}>
            {session.turns.length === 0 && (
              <div className="opening-hero" data-testid="opening-hero">
                <span className="label">开场问题</span>
                <p className="opening-hero-question">{session.card.suggestedOpening}</p>
                {session.card.whyNow && <p className="opening-hero-why">{session.card.whyNow}</p>}
                <p className="field-help">在下方直接写回答，或点右上角「语音」口述。</p>
              </div>
            )}
            {session.turns.map((turn) => {
              const isControl = turn.intent === "控制反馈";
              const showTechniqueBadge =
                turn.role === "assistant" &&
                !isControl &&
                turn.strategy !== undefined &&
                PLAYBOOK_DRIVEN_STRATEGIES.has(turn.strategy);
              return (
                <article className={`turn ${turn.role}${isControl ? " turn-control" : ""}`} key={turn.id}>
                  <div className="turn-meta">
                    <span>{isControl ? "系统" : turn.role === "user" ? "你" : "专访编辑"}</span>
                    <span>{turn.intent}</span>
                    {showTechniqueBadge && (
                      <span className="technique-badge" title="本句应用了从语料学到的提问技法">
                        <Sparkles size={11} />应用技法：{INTERVIEW_STRATEGY_LABELS[turn.strategy!]}
                      </span>
                    )}
                  </div>
                  <p>{turn.content}</p>
                  {turn.references && turn.references.length > 0 ? (
                    <div className="turn-references" aria-label="本轮引用">
                      {turn.references.map((reference) => (
                        <small key={reference.id}>
                          引用 · {reference.sourceLabel}：{reference.text}
                        </small>
                      ))}
                    </div>
                  ) : turn.referencedMemory ? (
                    <small>引用：未提供结构化引用</small>
                  ) : null}
                </article>
              );
            })}
          </div>

          {/* 表达区紧贴对话 */}
          <form className="composer composer-priority" onSubmit={onSubmit}>
            <label className="field-stack" htmlFor="interview-input">
              <span className="field-label">你的回答</span>
              <textarea
                id="interview-input"
                value={input}
                disabled={finishing}
                onChange={(event) => onInput(event.target.value)}
                onKeyDown={handleComposerKeyDown}
                placeholder={
                  session.turns.length === 0
                    ? "直接回应开场问题。例：我不想每次都替团队兜底，但又怕放手之后项目失控。"
                    : "继续补充具体场景、代价或你的真实判断…"
                }
              />
              <span className="field-help">⌘/Ctrl + Enter 提交；录音中 Esc 停止语音。可以先写片段，系统会围绕锚点追问。</span>
            </label>
            <div className="composer-actions">
              <button
                className="secondary-action"
                type="button"
                onClick={() => {
                  if (userTurnCount === 0 || busy) return;
                  const ok =
                    typeof window === "undefined" ||
                    window.confirm(
                      session.doNotSave
                        ? "确认结束本场？本场已标记不保存，不会写入长期资产。"
                        : "确认结束并生成档案？结束后将归档双轨笔记与相关资产。"
                    );
                  if (ok) onFinish();
                }}
                disabled={userTurnCount === 0 || busy}
                aria-busy={finishing}
              >
                {finishing ? "正在生成档案…" : "结束并生成档案"}
              </button>
              <button className="primary-action" type="submit" disabled={submitting || finishing || !input.trim()} aria-busy={submitting}>
                <ChevronRight size={18} />
                {submitting ? "思考中…" : retryAvailable ? "重试本轮" : "提交表达"}
              </button>
            </div>
          </form>

          {/* 控制：默认折叠，不抢首屏 */}
          <div className="control-drawer">
            <button
              type="button"
              className="control-drawer-toggle"
              aria-expanded={controlsOpen}
              onClick={() => setControlsOpen((v) => !v)}
            >
              <Settings2 size={16} />
              <span>访谈调节</span>
              <small>节奏 · 方向 · 边界</small>
              <ChevronDown size={16} className={controlsOpen ? "is-open" : undefined} />
            </button>
            {controlsOpen && (
              <div className="control-groups" aria-label="访谈控制">
                {userTurnCount === 0 && (
                  <p className="field-help control-empty-hint">调节会在你首轮回答后的追问中生效；也可先写回答再调。</p>
                )}
                {interviewControlGroups.map((group, groupIdx) => (
                  <section className="control-group" key={`group-${groupIdx}`} aria-label={group.description}>
                    <div className="control-group-heading">
                      <span>{group.label}</span>
                      <small>{group.description}</small>
                    </div>
                    <div className="control-group-actions">
                      {group.actions.map((action) => {
                        const pressed =
                          (action.id === "do-not-save" && Boolean(session.doNotSave)) ||
                          session.pendingControl === action.id;
                        return (
                          <button
                            key={action.id}
                            title={action.description}
                            type="button"
                            className={pressed ? "is-pressed" : undefined}
                            aria-pressed={pressed || undefined}
                            disabled={controlsDisabled}
                            onClick={() => handleControl(action.id)}
                          >
                            {action.id === "do-not-save" && session.doNotSave ? "取消不保存" : action.label}
                          </button>
                        );
                      })}
                    </div>
                  </section>
                ))}
              </div>
            )}
          </div>
        </div>

        <aside className="side-panel context-panel" aria-label="本次专访上下文">
          <div className="panel-title">
            <Flag size={18} />
            <h2>本次准备</h2>
          </div>

          {/* Phase C: 本场回访清单 + 策略可见 */}
          <details className="context-block revisit-panel" data-testid="interview-revisit-panel">
            <summary>
              <Lightbulb size={14} aria-hidden />
              本场回访
              {(decisionsToReview.length > 0 || openDebts.length > 0) && (
                <span className="status-pill">
                  {decisionsToReview.length + openDebts.length}
                </span>
              )}
            </summary>
            {lastStrategy && (
              <p className="field-help">
                最近策略：
                <strong>
                  {INTERVIEW_STRATEGY_LABELS[lastStrategy.strategy] ?? lastStrategy.label}
                </strong>
                {lastStrategy.reason ? ` · ${lastStrategy.reason}` : ""}
              </p>
            )}
            {decisionsToReview.length === 0 && openDebts.length === 0 ? (
              <p className="empty-hint">本场暂无到期决策或开放知识债；可自由展开。</p>
            ) : (
              <ul className="revisit-session-list">
                {decisionsToReview.map((d) => (
                  <li key={`dec-${d.title}`}>
                    <div>
                      <strong>决策 · {d.title}</strong>
                      <small>
                        已 {d.daysOpen} 天 · 选「{d.choice}」
                      </small>
                    </div>
                    {onSuppressRevisit && (
                      <button
                        type="button"
                        className="text-button"
                        disabled={controlsDisabled}
                        onClick={() => onSuppressRevisit("decision", d.title)}
                      >
                        本场不追
                      </button>
                    )}
                  </li>
                ))}
                {openDebts.map((d) => (
                  <li key={`debt-${d.concept}`}>
                    <div>
                      <strong>知识债 · {d.concept}</strong>
                      <small>
                        已 {d.daysOpen} 天 · {d.nextQuestion || d.context}
                      </small>
                    </div>
                    {onSuppressRevisit && (
                      <button
                        type="button"
                        className="text-button"
                        disabled={controlsDisabled}
                        onClick={() => onSuppressRevisit("debt", d.concept)}
                      >
                        本场不追
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            )}
            {suppressed.length > 0 && (
              <p className="field-help">已跳过本场回访 {suppressed.length} 项（不改写资产）。</p>
            )}
          </details>

          {appliedTechniques.length > 0 && (
            <div className="context-block applied-techniques">
              <span>
                <Sparkles size={12} />
                本场已应用的学习技法
              </span>
              <ul>
                {appliedTechniques.slice(0, 3).map((rule, ruleIdx) => (
                  <li key={`technique-${ruleIdx}`}>{rule}</li>
                ))}
              </ul>
              <p className="applied-techniques-note">来自已采纳的语料样本，已注入本场追问引擎。</p>
            </div>
          )}
          <div className="context-block">
            <span>{liveRelevantMemories.length > 0 ? "本轮可引用记忆" : "历史引用"}</span>
            <ul>
              {memoryListForSidebar.slice(0, 3).map((reference, refIdx) => (
                <li key={`ref-${refIdx}`}>{reference}</li>
              ))}
            </ul>
            {liveRelevantMemories.length > 0 && openingHistoryReferences.length > 0 && (
              <>
                <span className="context-sublabel">开场历史原话</span>
                <ul>
                  {openingHistoryReferences.slice(0, 2).map((reference, refIdx) => (
                    <li key={`open-ref-${refIdx}`}>{reference}</li>
                  ))}
                </ul>
              </>
            )}
          </div>
          {sessionCard.opinionEvolution && sessionCard.opinionEvolution.length > 0 && (
            <div className="context-block opinion-evolution">
              <span>
                <Sparkles size={12} />
                观点演化
              </span>
              <ul>
                {sessionCard.opinionEvolution.slice(0, 3).map((evo, evoIdx) => (
                  <li key={`evo-${evoIdx}`}>
                    <strong>{evo.topic}</strong>：{evo.oldView} → {evo.newView}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {sessionCard.contradictions && sessionCard.contradictions.length > 0 && (
            <div className="context-block contradictions">
              <span>
                <Flag size={12} />
                发现的对立观点
              </span>
              <ul>
                {sessionCard.contradictions.slice(0, 3).map((contra, contraIdx) => (
                  <li key={`contra-${contraIdx}`}>
                    「{contra.a}」⇄「{contra.b}」
                  </li>
                ))}
              </ul>
            </div>
          )}
          {sessionCard.sourceHighlights && sessionCard.sourceHighlights.length > 0 && (
            <div className="context-block">
              <span>联网素材</span>
              <ul>
                {sessionCard.sourceHighlights.map((source) => (
                  <li key={source.id}>{source.title}</li>
                ))}
              </ul>
            </div>
          )}
          <div className="context-block">
            <span>建议视角</span>
            <p>{sessionCard.suggestedPerspectives.join(" / ") || "—"}</p>
          </div>
          <div className="context-block">
            <span>可能产出</span>
            <p>{sessionCard.likelyOutputs.join("；") || "—"}</p>
          </div>
          <div className="context-block compact">
            <span>本次边界</span>
            <p>
              {strengthLabel}
              {session.doNotSave ? " · 不写入长期资产" : " · 可写入资产"}
            </p>
          </div>
        </aside>
      </section>
    </section>
  );
}

function controlActionLabel(action: InterviewControlAction): string {
  for (const group of interviewControlGroups) {
    const hit = group.actions.find((a) => a.id === action);
    if (hit) return hit.label;
  }
  return action;
}
