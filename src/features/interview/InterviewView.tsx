import type { FormEvent } from "react";
import { useEffect, useRef } from "react";
import { ChevronRight, Flag, Lightbulb, Mic, MicOff, Pause, Play, Sparkles } from "lucide-react";
import { HeaderBlock } from "../../components/HeaderBlock";
import type { buildInterviewCard, buildRealtimeTurnState } from "../../domain/engine";
import { INTERVIEW_STRATEGY_LABELS, PLAYBOOK_DRIVEN_STRATEGIES } from "../../domain/engine";
import type { InterviewControlAction, InterviewMode, InterviewSession } from "../../domain/types";
import { formatRealtimePhase, interviewControlGroups } from "../../ui";

interface InterviewViewProps {
  card: ReturnType<typeof buildInterviewCard>;
  session: InterviewSession | null;
  pendingMode: InterviewMode;
  input: string;
  recording: boolean;
  realtimeState: ReturnType<typeof buildRealtimeTurnState> | null;
  audioLevel: number;
  voiceStatus: "idle" | "connecting" | "listening" | "speaking" | "interrupted";
  liveUserTranscript: string;
  voiceTransport: "webrtc" | "websocket" | "livekit" | null;
  onInput: (value: string) => void;
  onStart: (mode?: InterviewMode, searchBriefId?: string) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onFinish: () => void;
  onControl: (action: InterviewControlAction) => void;
  onToggleRecording: () => void | Promise<void>;
  onInterrupt: () => void;
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
  voiceTransport,
  onInput,
  onStart,
  onSubmit,
  onFinish,
  onControl,
  onToggleRecording,
  onInterrupt,
  submitting,
  retryAvailable,
  starting,
  finishing,
  guidanceState
}: InterviewViewProps) {
  // Hooks must run unconditionally on every render (Rules of Hooks). Keep them
  // ABOVE the `if (!session)` early return so the launch screen and the live
  // conversation render the same hook sequence — otherwise React throws
  // "Expected static flag was missing" and the view misrenders on start.
  const turnListRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (turnListRef.current) {
      turnListRef.current.scrollTop = turnListRef.current.scrollHeight;
    }
  }, [session?.turns.length]);

  if (!session) {
    return (
      <section className="interview-launch">
        <div className="launch-inner">
          <span className="eyebrow">专访启动</span>
          <h1>{card.title}</h1>
          <p>{card.whyNow}</p>
          <div className="launch-prompt">
            <span>开场问题</span>
            <strong>{card.suggestedOpening}</strong>
          </div>
          {card.sourceHighlights && card.sourceHighlights.length > 0 && (
            <div className="launch-sources">
              <span>素材摘要</span>
              <p>{card.sourceHighlights[0].snippet}</p>
            </div>
          )}
          <button className="launch-action" type="button" onClick={() => onStart(pendingMode)} disabled={starting} aria-busy={starting}>
            <Play size={18} />{starting ? "正在准备…" : "开始专访"}
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
  const historyReferences = session.card.historyReferences.length > 0 ? session.card.historyReferences : ["暂无明确历史引用"];
  // Corpus-learning techniques actually in scope for THIS session. These are the
  // applied PlaybookPatch rules that the server re-stamps onto session.enginePolicy
  // every turn and feeds into the interview prompt — so showing them here is honest,
  // not decorative. Empty => render nothing.
  const appliedTechniques = (session.enginePolicy?.appliedPlaybookRules ?? []).filter((rule) => rule.trim());

  return (
    <section className="view-stack">
      <HeaderBlock
        eyebrow="实时专访"
        title={session.title}
        subtitle={voiceTransport
          ? `${voiceTransport === "websocket" ? "WebSocket 实时语音" : voiceTransport === "livekit" ? "LiveKit 级联语音" : "实时语音"} · 语音回合与文本写入同一份专访记录`
          : "文本追问已接入策略引擎；点击语音按钮开始实时对话。"}
      />

      <section className="interview-layout">
        <div className="conversation-panel">
          <div className="conversation-header">
            <div>
              <span className="label">当前状态</span>
              <strong>{realtimeState?.nextAction ?? (session.turns.length === 0 ? "等待用户开口" : "正在追问锚点")}</strong>
            </div>
            <div className="voice-controls">
              {recording && voiceStatus === "speaking" && (
                <button className="interrupt-button" type="button" onClick={onInterrupt} title="打断 AI">
                  <Pause size={16} />打断
                </button>
              )}
              <button
                className={`record-button ${recording ? "active" : ""} ${voiceStatus}`}
                type="button"
                onClick={onToggleRecording}
                aria-label={recording ? "停止录音" : "开始录音"}
              >
                <span className="record-icon">
                  {recording ? <MicOff size={18} /> : <Mic size={18} />}
                </span>
                <span className="record-label">
                  {recording ? "停止" : "语音"}
                </span>
                {voiceTransport && (
                  <span className="transport-badge">{voiceTransport === "websocket" ? "WS" : voiceTransport === "livekit" ? "LK" : "RTC"}</span>
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
                        height: voiceStatus === "idle"
                          ? "4px"
                          : `${4 + audioLevel * 36 * (0.4 + 0.6 * Math.sin((i / 16) * Math.PI))}px`
                      }}
                    />
                  ))}
                </div>
                <div className="voice-status-label">
                  {voiceStatus === "connecting" && <><span className="status-dot connecting" />正在连接…</>}
                  {voiceStatus === "listening" && <><span className="status-dot listening" />聆听中</>}
                  {voiceStatus === "speaking" && <><span className="status-dot speaking" />AI 正在回应</>}
                  {voiceStatus === "interrupted" && <><span className="status-dot interrupted" />已打断</>}
                  {voiceStatus === "idle" && <><span className="status-dot idle" />等待语音</>}
                </div>
              </div>
            </div>
          )}

          {liveUserTranscript && (
            <div className="live-transcript">
              <span className="live-transcript-label">实时转写</span>
              <p>{liveUserTranscript}</p>
            </div>
          )}
          {guidanceState?.active && guidanceState.text && (
            <div className="guidance-indicator" aria-live="polite">
              <span className="guidance-badge">
                {guidanceState.kind === "anchor_probe" ? "追问锚点" :
                 guidanceState.kind === "emotion_label" ? "情感标记" :
                 guidanceState.kind === "contradiction" ? "发现矛盾" :
                 guidanceState.kind === "nudge" ? "轻推" :
                 guidanceState.kind === "echo" ? "回音" : "引导"}
              </span>
              <p className="guidance-text">{guidanceState.text}</p>
            </div>
          )}

          {/* 会中节奏/把握度由实时语音管线驱动；仅在录音(语音对话)时有意义。文字访谈下
              这些值是静态的(phase 恒 holding、confidence 恒 72%),会误导,故只在录音时显示。 */}
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
          <div className="control-groups" aria-label="访谈控制">
            {interviewControlGroups.map((group, groupIdx) => (
              <section className="control-group" key={`group-${groupIdx}`} aria-label={group.description}>
                <div className="control-group-heading">
                  <span>{group.label}</span>
                  <small>{group.description}</small>
                </div>
                <div className="control-group-actions">
                  {group.actions.map((action) => (
                    <button key={action.id} title={action.description} type="button" onClick={() => onControl(action.id)}>
                      {action.label}
                    </button>
                  ))}
                </div>
              </section>
            ))}
          </div>

          <div className="turn-list" ref={turnListRef}>
            {session.turns.length === 0 && (
              <div className="empty-state">
                <Lightbulb size={24} />
                <p>{session.card.suggestedOpening}</p>
              </div>
            )}
            {session.turns.map((turn) => {
              const showTechniqueBadge =
                turn.role === "assistant" &&
                turn.strategy !== undefined &&
                PLAYBOOK_DRIVEN_STRATEGIES.has(turn.strategy);
              return (
                <article className={`turn ${turn.role}`} key={turn.id}>
                  <div className="turn-meta">
                    <span>{turn.role === "user" ? "你" : "专访编辑"}</span>
                    <span>{turn.intent}</span>
                    {showTechniqueBadge && (
                      <span className="technique-badge" title="本句应用了从语料学到的提问技法">
                        <Sparkles size={11} />应用技法：{INTERVIEW_STRATEGY_LABELS[turn.strategy!]}
                      </span>
                    )}
                  </div>
                  <p>{turn.content}</p>
                  {turn.referencedMemory && <small>引用历史：{turn.referencedMemory}</small>}
                </article>
              );
            })}
          </div>

          <form className="composer" onSubmit={onSubmit}>
            <label className="field-stack" htmlFor="interview-input">
              <span className="field-label">你的回答</span>
              <textarea
                id="interview-input"
                value={input}
                onChange={(event) => onInput(event.target.value)}
                placeholder="把你现在想说的直接写下来。例：我不想每次都替团队兜底，但又怕放手之后项目失控。"
              />
              <span className="field-help">可以先写片段，系统会保留停顿，并围绕表达里的锚点继续追问。</span>
            </label>
            <div className="composer-actions">
              <button className="secondary-action" type="button" onClick={onFinish} disabled={session.turns.length === 0 || submitting || finishing} aria-busy={finishing}>
                {finishing ? "正在生成档案…" : "结束并生成档案"}
              </button>
              <button className="primary-action" type="submit" disabled={submitting || !input.trim()} aria-busy={submitting}>
                <ChevronRight size={18} />{submitting ? "思考中…" : retryAvailable ? "重试本轮" : "提交表达"}
              </button>
            </div>
          </form>
        </div>

        <aside className="side-panel context-panel" aria-label="本次专访上下文">
          <div className="panel-title"><Flag size={18} /><h2>本次准备</h2></div>
          {appliedTechniques.length > 0 && (
            <div className="context-block applied-techniques">
              <span><Sparkles size={12} />本场已应用的学习技法</span>
              <ul>
                {appliedTechniques.slice(0, 3).map((rule, ruleIdx) => (
                  <li key={`technique-${ruleIdx}`}>{rule}</li>
                ))}
              </ul>
              <p className="applied-techniques-note">来自已采纳的语料样本，已注入本场追问引擎。</p>
            </div>
          )}
          <div className="context-block">
            <span>历史引用</span>
            <ul>
              {historyReferences.slice(0, 2).map((reference, refIdx) => (
                <li key={`ref-${refIdx}`}>{reference}</li>
              ))}
            </ul>
          </div>
          {card.opinionEvolution && card.opinionEvolution.length > 0 && (
            <div className="context-block opinion-evolution">
              <span><Sparkles size={12} />观点演化</span>
              <ul>
                {card.opinionEvolution.slice(0, 3).map((evo, evoIdx) => (
                  <li key={`evo-${evoIdx}`}><strong>{evo.topic}</strong>：{evo.oldView} → {evo.newView}</li>
                ))}
              </ul>
            </div>
          )}
          {card.contradictions && card.contradictions.length > 0 && (
            <div className="context-block contradictions">
              <span><Flag size={12} />发现的对立观点</span>
              <ul>
                {card.contradictions.slice(0, 3).map((contra, contraIdx) => (
                  <li key={`contra-${contraIdx}`}>「{contra.a}」⇄「{contra.b}」</li>
                ))}
              </ul>
            </div>
          )}
          {session.card.sourceHighlights && session.card.sourceHighlights.length > 0 && (
            <div className="context-block">
              <span>联网素材</span>
              <ul>
                {session.card.sourceHighlights.map((source) => (
                  <li key={source.id}>{source.title}</li>
                ))}
              </ul>
            </div>
          )}
          <div className="context-block">
            <span>建议视角</span>
            <p>{session.card.suggestedPerspectives.join(" / ")}</p>
          </div>
          <div className="context-block">
            <span>可能产出</span>
            <p>{session.card.likelyOutputs.join("；")}</p>
          </div>
          <div className="context-block compact">
            <span>本次边界</span>
            <p>{strengthLabel}{session.doNotSave ? " · 不写入长期资产" : " · 可写入资产"}</p>
          </div>
        </aside>
      </section>
    </section>
  );
}
