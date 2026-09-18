import { BookOpen, Brain, Clock, Plus, Play, Sparkles, Target, TrendingUp, X } from "lucide-react";
import { useEffect, useState } from "react";
import { HeaderBlock } from "../../components/HeaderBlock";
import { buildTimeline } from "../../domain/timeline";
import type { buildInterviewCard, buildInterviewResumeCards } from "../../domain/engine";
import type { RevisitItem } from "../../domain/revisit-queue";
import type { InterviewMode, ProductState } from "../../domain/types";

const modeOptions: Array<{ id: InterviewMode; label: string; detail: string }> = [
  { id: "daily", label: "日常复盘", detail: "把事件推进到机制和模式" },
  { id: "decision", label: "决策专访", detail: "拆选项、代价、假设和复盘点" },
  { id: "point", label: "观点专访", detail: "找前提、反例和适用边界" },
  { id: "learning", label: "学习专访", detail: "把输入知识变成自己的理解" },
  { id: "organization", label: "组织/关系", detail: "看见角色、权力和隐性规则" },
  { id: "long-term", label: "长期主题", detail: "回访一个反复出现的问题" }
];

const MATURITY_DOT_COLOR: Record<string, string> = {
  "萌芽": "var(--accent-teal)",
  "重复": "var(--accent-amber)",
  "聚焦": "var(--action-primary)",
  "成型": "var(--accent-green)",
  "变化": "var(--accent-rose)",
  "关闭": "var(--text-muted)",
};

const KIND_LABEL: Record<string, string> = {
  session: "专访",
  note: "笔记",
  theme: "主题线",
};

const KIND_COLOR: Record<string, string> = {
  session: "var(--action-primary)",
  note: "var(--accent-teal)",
  theme: "var(--accent-amber)",
};

function formatAt(iso: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

function modeLabel(id: InterviewMode): string {
  return modeOptions.find((item) => item.id === id)?.label ?? id;
}

interface HomeViewProps {
  state: ProductState;
  card: ReturnType<typeof buildInterviewCard>;
  suggestedTopicHint?: string;
  recommendedMode?: InterviewMode;
  recommendationReason?: string;
  recommendedRelatedThemeIds?: string[];
  resumeCards?: ReturnType<typeof buildInterviewResumeCards>;
  activeBriefId?: string;
  starting?: boolean;
  lastInterviewSummary?: null | {
    noteTitle: string;
    pendingMemory: number;
    destination: "notes" | "memory";
    doNotSave: boolean;
    finishedAt: string;
  };
  /** Cognitive revisit queue (shared ranking with card/launch). */
  revisitQueue?: RevisitItem[];
  pendingMemoryCount?: number;
  onStart: (mode?: InterviewMode, topicHint?: string, relatedThemeIds?: string[]) => void;
  onContinue?: (sessionId: string) => void;
  onDiscardEmpty?: (sessionId: string) => void;
  onClearBrief?: () => void;
  onDismissLastSummary?: () => void;
  onOpenTrack?: (themeId: string) => void;
  onNavigate?: (view: string) => void;
  /** Prefill topic input from parent (end summary / sticky). */
  prefillTopic?: string | null;
  prefillMode?: InterviewMode | null;
}

export function HomeView({
  state,
  card,
  suggestedTopicHint = card.title,
  recommendedMode = "daily",
  recommendationReason = "先从最近发生的一件具体事情开始",
  recommendedRelatedThemeIds,
  resumeCards = [],
  activeBriefId,
  starting = false,
  lastInterviewSummary = null,
  revisitQueue = [],
  pendingMemoryCount = 0,
  onStart,
  onContinue,
  onDiscardEmpty,
  onClearBrief,
  onDismissLastSummary,
  onOpenTrack,
  onNavigate,
  prefillTopic = null,
  prefillMode = null
}: HomeViewProps) {
  const timelineEvents = buildTimeline(state, 20);
  const [topicInput, setTopicInput] = useState("");
  const [selectedMode, setSelectedMode] = useState<InterviewMode>(recommendedMode);
  // Display queue: skip resume (shown above); show HITL + next launchables.
  const deskQueue = revisitQueue
    .filter((item) => item.kind !== "resume_session" && item.kind !== "cold_start")
    .slice(0, 3);

  useEffect(() => {
    setSelectedMode(recommendedMode);
  }, [recommendedMode]);

  useEffect(() => {
    if (prefillTopic) setTopicInput(prefillTopic);
  }, [prefillTopic]);

  useEffect(() => {
    if (prefillMode) setSelectedMode(prefillMode);
  }, [prefillMode]);

  const selectedTopic = topicInput.trim() || suggestedTopicHint;
  const usingRecommendedTopic =
    !topicInput.trim() || topicInput.trim() === (suggestedTopicHint || "").trim();
  const launchThemeIds =
    usingRecommendedTopic && recommendedRelatedThemeIds?.length ? recommendedRelatedThemeIds : undefined;
  const launchThemes = (launchThemeIds ?? [])
    .map((id) => state.themes.find((theme) => theme.id === id))
    .filter((theme): theme is NonNullable<typeof theme> => Boolean(theme));
  const selectedModeLabel = modeLabel(selectedMode);
  const primaryResume = resumeCards[0];
  const hasResume = resumeCards.length > 0;
  const activeBrief = activeBriefId
    ? state.searchBriefs.find((b) => b.id === activeBriefId)
    : undefined;

  function handleEventClick(ev: (typeof timelineEvents)[number]) {
    if (ev.href.view === "track" && ev.href.trackId) {
      onOpenTrack?.(ev.href.trackId);
    } else {
      onNavigate?.(ev.href.view);
    }
  }

  function startWithCurrent(mode: InterviewMode = selectedMode) {
    if (starting) return;
    onStart(mode, selectedTopic, launchThemeIds);
  }

  return (
    <section className="view-stack">
      {/* 有未完成：继续优先主卡 */}
      {hasResume && primaryResume && (
        <section className="panel resume-home-card" aria-label="继续未完成的专访">
          <div className="panel-title row-between">
            <div className="row">
              <Play size={18} aria-hidden="true" />
              <h2>继续未完成的专访</h2>
            </div>
            <span className="status-pill">{resumeCards.length} 场进行中</span>
          </div>
          <p className="field-help mb-2">
            优先接上未完成的对话，避免并行开多场空会话。
          </p>
          <div className="resume-session-list">
            {resumeCards.map((item) => {
              const empty = item.turnCount === 0;
              return (
                <article className="resume-session-option is-static" key={item.sessionId}>
                  <div>
                    <strong>
                      {modeLabel(item.mode)}：{item.title}
                      {empty ? " · 尚未开始对话" : ` · ${item.turnCount} 轮`}
                    </strong>
                    <small>{item.pendingQuestion}</small>
                  </div>
                  <div className="form-actions">
                    <button
                      className="primary-action"
                      type="button"
                      onClick={() => onContinue?.(item.sessionId)}
                    >
                      <Play size={16} />
                      继续
                    </button>
                    {empty && onDiscardEmpty && (
                      <button
                        className="secondary-action"
                        type="button"
                        onClick={() => onDiscardEmpty(item.sessionId)}
                      >
                        <X size={16} />
                        移除空场
                      </button>
                    )}
                  </div>
                </article>
              );
            })}
          </div>
        </section>
      )}

      {lastInterviewSummary && (
        <section className="panel last-interview-summary" aria-label="上场专访摘要">
          <div className="panel-title row-between">
            <div className="row">
              <BookOpen size={18} aria-hidden="true" />
              <h2>上场专访已结束</h2>
            </div>
            {onDismissLastSummary && (
              <button type="button" className="text-button" onClick={onDismissLastSummary}>
                关闭
              </button>
            )}
          </div>
          <p>
            {lastInterviewSummary.doNotSave
              ? "本场按「不保存」结束，未写入长期资产。"
              : lastInterviewSummary.pendingMemory > 0
                ? `笔记「${lastInterviewSummary.noteTitle}」已写下。另有 ${lastInterviewSummary.pendingMemory} 条记忆待你确认后才会进入下次召回——现在还不能说档案已生成。`
                : `笔记「${lastInterviewSummary.noteTitle}」已生成。`}
          </p>
          <div className="form-actions">
            {!lastInterviewSummary.doNotSave && (
              <button
                type="button"
                className="primary-action"
                onClick={() => {
                  onNavigate?.(lastInterviewSummary.destination);
                  onDismissLastSummary?.();
                }}
              >
                {lastInterviewSummary.destination === "memory" ? "去记忆" : "查看本场笔记"}
              </button>
            )}
            <button
              type="button"
              className="secondary-action"
              onClick={() => {
                onNavigate?.("my-assets");
                onDismissLastSummary?.();
              }}
            >
              本场记录
            </button>
            {deskQueue[0]?.canLaunchInterview && deskQueue[0].topicHint && (
              <button
                type="button"
                className="secondary-action"
                onClick={() => {
                  setTopicInput(deskQueue[0]!.topicHint!);
                  if (deskQueue[0]!.mode) setSelectedMode(deskQueue[0]!.mode);
                  onDismissLastSummary?.();
                }}
              >
                把这题填进来：{deskQueue[0].title.slice(0, 18)}
              </button>
            )}
          </div>
        </section>
      )}

      {/* 关上场摘要后仍可见 pending 记忆与回访线索 */}
      {(pendingMemoryCount > 0 || deskQueue.length > 0) && (
        <section className="panel revisit-desk" aria-label="今天该回访的线索" data-testid="revisit-desk">
          <div className="panel-title row-between">
            <div className="row">
              <Target size={18} aria-hidden="true" />
              <h2>今天该回访的线索</h2>
            </div>
            {pendingMemoryCount > 0 && (
              <span className="status-pill is-emphasis">{pendingMemoryCount} 条记忆待确认</span>
            )}
          </div>
          <p className="field-help mb-2">
            今天值得聊的不是待办清单。按这条排：待审记忆 → 到期决策 → 知识债 → 主题下一问。未确认记忆不会进入下次召回。
          </p>
          <ul className="revisit-desk-list">
            {deskQueue.map((item) => (
              <li key={item.id} className="revisit-desk-item" data-revisit-kind={item.kind}>
                <div>
                  <strong>{item.title}</strong>
                  <small>{item.reason}</small>
                </div>
                <div className="form-actions">
                  {item.kind === "memory_hitl" ? (
                    <button
                      type="button"
                      className="primary-action"
                      onClick={() => onNavigate?.("memory")}
                    >
                      <Brain size={16} />
                      去记忆
                    </button>
                  ) : item.canLaunchInterview ? (
                    <button
                      type="button"
                      className="primary-action"
                      disabled={starting}
                      onClick={() => {
                        if (item.mode) setSelectedMode(item.mode);
                        if (item.topicHint) setTopicInput(item.topicHint);
                        onStart(item.mode, item.topicHint, item.relatedThemeIds);
                      }}
                    >
                      <Play size={16} />
                      开始回访
                    </button>
                  ) : null}
                  {item.href?.view === "track" && item.href.focusId && (
                    <button
                      type="button"
                      className="secondary-action"
                      onClick={() => onOpenTrack?.(item.href!.focusId!)}
                    >
                      主题工作区
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* ① Hero / 今日推荐 */}
      <HeaderBlock
        eyebrow="今日访谈台"
        title={card.title}
        subtitle={card.whyNow}
        action={
          <button
            className={`primary-action${starting ? " btn-loading" : ""}`}
            type="button"
            disabled={starting}
            aria-busy={starting}
            onClick={() => startWithCurrent()}
          >
            {starting && <span className="spinner" aria-hidden="true" />}
            <Play size={18} />
            {starting
              ? "准备中…"
              : hasResume
                ? `另开一场 · ${selectedModeLabel}`
                : `一键开始 · ${selectedModeLabel}`}
          </button>
        }
      />

      <section className="panel interview-topic-launch" aria-label="专访启动设置">
        <div className="panel-title">
          <Sparkles size={18} />
          <h2>这次想深入什么？</h2>
        </div>
        <p className="field-help">
          当前模式：<strong>{selectedModeLabel}</strong>
          {selectedMode === recommendedMode ? ` · ${recommendationReason}` : " · 已手动切换模式"}
        </p>
        <label className="field-stack" htmlFor="home-interview-topic">
          <span className="field-label">具体专访主题</span>
          <input
            id="home-interview-topic"
            value={topicInput}
            maxLength={160}
            disabled={starting}
            placeholder="输入具体专访主题，例如：企业如何进行 AI Native 转型"
            onChange={(event) => setTopicInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                startWithCurrent();
              }
            }}
          />
          <span className="field-help">留空则沿用当前推荐主题：{suggestedTopicHint}</span>
        </label>

        {(activeBrief || launchThemes.length > 0) && (
          <div className="inline-list context-chip-row" aria-label="将带入的上下文">
            <span className="field-label">将带入</span>
            {activeBrief && (
              <span className="status-pill is-tracked">
                简报：{activeBrief.topic}
                {onClearBrief && (
                  <button type="button" className="text-button" onClick={onClearBrief} aria-label="清除简报">
                    清除
                  </button>
                )}
              </span>
            )}
            {launchThemes.map((theme) => (
              <span className="status-pill" key={theme.id}>主题线：{theme.name}</span>
            ))}
          </div>
        )}
      </section>

      {card.historyReferences[0] && (
        <div className="quote-line hero-quote">
          &ldquo;{card.historyReferences[0]}&rdquo;
        </div>
      )}

      {card.suggestedPerspectives.length > 0 && (
        <div className="inline-list">
          {card.suggestedPerspectives.map((p, i) => (
            <span key={`perspective-${i}`}>{p}</span>
          ))}
        </div>
      )}

      {/* ② 主题线横排 */}
      <section className="panel">
        <div className="panel-title">
          <TrendingUp size={18} />
          <h2>主题线</h2>
        </div>

        {state.themes.length === 0 ? (
          <p className="empty-hint">还没有主题线，完成专访后会自动浮现。</p>
        ) : (
          <div className="track-chip-row">
            {state.themes.map((theme) => {
              const dotColor = MATURITY_DOT_COLOR[theme.maturity] ?? "var(--text-muted)";
              return (
                <div className="track-chip-wrap" key={theme.id}>
                  <button
                    className="track-chip"
                    type="button"
                    onClick={() => onOpenTrack?.(theme.id)}
                  >
                    <span className="track-chip-dot" style={{ background: dotColor }} aria-hidden="true" />
                    <span className="track-chip-name">{theme.name}</span>
                    <span className="track-chip-badge">{theme.maturity}</span>
                    <span className="track-chip-count">{theme.appearances}次</span>
                  </button>
                  <button
                    className="text-button"
                    type="button"
                    disabled={starting}
                    onClick={() => onStart("long-term", theme.nextQuestion?.trim() || theme.name, [theme.id])}
                  >
                    用此主题开始
                  </button>
                </div>
              );
            })}
            <button
              className="track-chip track-chip-add"
              type="button"
              disabled={starting}
              onClick={() => onStart("long-term", selectedTopic)}
            >
              <Plus size={16} />
              用长期主题开一场
            </button>
          </div>
        )}
      </section>

      {/* ③ 时间轴 */}
      <section className="panel">
        <div className="panel-title">
          <Clock size={18} />
          <h2>时间轴</h2>
        </div>

        {timelineEvents.length === 0 ? (
          <div className="timeline-empty">
            <BookOpen size={28} />
            <div>
              <p>开始第一次专访，你的记录会在这里形成时间轴。</p>
              <button
                className="primary-action compact-action mt-3"
                type="button"
                disabled={starting}
                onClick={() => startWithCurrent()}
              >
                <Play size={16} />
                开始第一次专访
              </button>
            </div>
          </div>
        ) : (
          <ol className="timeline" aria-label="时间轴">
            {timelineEvents.map((ev, idx) => {
              const dotColor = KIND_COLOR[ev.kind] ?? "var(--text-muted)";
              const kindLabel = KIND_LABEL[ev.kind] ?? ev.kind;
              const dateStr = formatAt(ev.at);
              const isLast = idx === timelineEvents.length - 1;
              const topicForEvent =
                ev.kind === "theme" && ev.href.trackId
                  ? state.themes.find((t) => t.id === ev.href.trackId)?.name
                  : undefined;
              return (
                <li key={ev.id} className={`timeline-item${isLast ? " timeline-item-last" : ""}`}>
                  <div className="timeline-spine">
                    <span
                      className="timeline-dot"
                      style={{
                        background: dotColor,
                        boxShadow: `0 0 0 3px rgba(0,0,0,0.4), 0 0 6px ${dotColor}55`
                      }}
                      aria-hidden="true"
                    />
                    {!isLast && <span className="timeline-line" aria-hidden="true" />}
                  </div>
                  <div className="timeline-content">
                    <div
                      role="button"
                      tabIndex={0}
                      onClick={() => handleEventClick(ev)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          handleEventClick(ev);
                        }
                      }}
                    >
                      <div className="timeline-meta">
                        {dateStr && <span className="timeline-date">{dateStr}</span>}
                        <span
                          className="timeline-kind-badge"
                          style={{ background: `${dotColor}20`, color: dotColor }}
                        >
                          {kindLabel}
                        </span>
                      </div>
                      <p className="timeline-title">{ev.title}</p>
                      {ev.summary && <p className="timeline-summary">{ev.summary}</p>}
                      {ev.outputs.length > 0 && (
                        <div className="timeline-outputs">
                          {ev.outputs.map((o) => (
                            <span key={`${ev.id}-${o.label}`} className="timeline-output-chip">
                              &rarr; {o.count} {o.label}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                    {topicForEvent && (
                      <button
                        className="text-button"
                        type="button"
                        disabled={starting}
                        onClick={() => onStart("long-term", topicForEvent)}
                      >
                        接着聊
                      </button>
                    )}
                  </div>
                </li>
              );
            })}
          </ol>
        )}
      </section>

      {/* 底部：选择访谈模式 */}
      <section className="panel">
        <div className="panel-title">
          <Target size={18} />
          <h2>选择访谈模式</h2>
        </div>
        <div className="mode-grid">
          {modeOptions.map((mode) => (
            <button
              className={`mode-option${selectedMode === mode.id ? " is-selected" : ""}`}
              key={mode.id}
              type="button"
              disabled={starting}
              onClick={() => {
                setSelectedMode(mode.id);
                // 与一键开始同源：附带可选 relatedThemeIds（自定义主题时为空）
                startWithCurrent(mode.id);
              }}
            >
              <strong>{mode.label}</strong>
              <span>{mode.detail}</span>
            </button>
          ))}
        </div>
      </section>
    </section>
  );
}
