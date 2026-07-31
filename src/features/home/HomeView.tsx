import { BookOpen, Clock, Plus, Play, Sparkles, Target, TrendingUp } from "lucide-react";
import { useState } from "react";
import { HeaderBlock } from "../../components/HeaderBlock";
import { buildTimeline } from "../../domain/timeline";
import type { buildInterviewCard } from "../../domain/engine";
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

interface HomeViewProps {
  state: ProductState;
  card: ReturnType<typeof buildInterviewCard>;
  suggestedTopicHint?: string;
  recommendedMode?: InterviewMode;
  recommendationReason?: string;
  // P3-08:曾有 monthlyReview prop 但组件从不消费(死 prop),已移除。复盘在 ThemesView 呈现。
  onStart: (mode?: InterviewMode, topicHint?: string) => void;
  onOpenTrack?: (themeId: string) => void;
  onNavigate?: (view: string) => void;
}

export function HomeView({
  state,
  card,
  suggestedTopicHint = card.title,
  recommendedMode = "daily",
  recommendationReason = "先从最近发生的一件具体事情开始",
  onStart,
  onOpenTrack,
  onNavigate
}: HomeViewProps) {
  const timelineEvents = buildTimeline(state, 20);
  const [topicInput, setTopicInput] = useState("");
  const selectedTopic = topicInput.trim() || suggestedTopicHint;
  const recommendedModeLabel = modeOptions.find((item) => item.id === recommendedMode)?.label ?? recommendedMode;

  function handleEventClick(ev: (typeof timelineEvents)[number]) {
    if (ev.href.view === "track" && ev.href.trackId) {
      onOpenTrack?.(ev.href.trackId);
    } else {
      onNavigate?.(ev.href.view);
    }
  }

  return (
    <section className="view-stack">

      {/* ① Hero */}
      <HeaderBlock
        eyebrow="今日访谈台"
        title={card.title}
        subtitle={card.whyNow}
        action={
          <button
            className="primary-action"
            type="button"
            onClick={() => onStart(recommendedMode, selectedTopic)}>
            <Play size={18} />
            一键开始 · {recommendedModeLabel}
          </button>
        } />

      <section className="panel interview-topic-launch" aria-label="专访启动设置">
        <div className="panel-title">
          <Sparkles size={18} />
          <h2>这次想深入什么？</h2>
        </div>
        <p className="field-help">
          推荐模式：<strong>{recommendedModeLabel}</strong> · {recommendationReason}
        </p>
        <label className="field-stack" htmlFor="home-interview-topic">
          <span className="field-label">具体专访主题</span>
          <input
            id="home-interview-topic"
            value={topicInput}
            maxLength={160}
            placeholder="输入具体专访主题，例如：企业如何进行 AI Native 转型"
            onChange={(event) => setTopicInput(event.target.value)} />
          <span className="field-help">留空则沿用当前推荐主题：{suggestedTopicHint}</span>
        </label>
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
          <p className="empty-hint">
            还没有主题线，完成专访后会自动浮现。
          </p>
        ) : (
          <div className="track-chip-row">
            {state.themes.map((theme) => {
              const dotColor = MATURITY_DOT_COLOR[theme.maturity] ?? "var(--text-muted)";
              return (
                <button
                  key={theme.id}
                  className="track-chip"
                  type="button"
                  role="button"
                  tabIndex={0}
                  onClick={() => onOpenTrack?.(theme.id)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      onOpenTrack?.(theme.id);
                    }
                  }}
>
                  <span
                    className="track-chip-dot"
                    style={{ background: dotColor }}
                    aria-hidden="true" />
                  <span className="track-chip-name">{theme.name}</span>
                  <span className="track-chip-badge">{theme.maturity}</span>
                  <span className="track-chip-count">{theme.appearances}次</span>
                </button>
              );
            })}
            <button
              className="track-chip track-chip-add"
              type="button"
              onClick={() => onStart("long-term")}>
              <Plus size={16} />
              新建主题线
            </button>
          </div>
        )}
      </section>

      {/* ③ 时间轴叙事流 */}
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
              <button className="primary-action compact-action mt-3"
                type="button"
                onClick={() => onStart()}>
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
              return (
                <li
                  key={ev.id}
                  className={`timeline-item${isLast ? " timeline-item-last" : ""}`}
>
                  <div className="timeline-spine">
                    <span
                      className="timeline-dot"
                      style={{ background: dotColor, boxShadow: `0 0 0 3px rgba(0,0,0,0.4), 0 0 6px ${dotColor}55` }}
                      aria-hidden="true" />
                    {!isLast && <span className="timeline-line" aria-hidden="true" />}
                  </div>
                  <div
                    className="timeline-content"
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
                    {ev.summary && (
                      <p className="timeline-summary">{ev.summary}</p>
                    )}
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
                </li>
              );
            })}
          </ol>
        )}
      </section>

      {/* 底部：选择访谈模式（次级入口） */}
      <section className="panel">
        <div className="panel-title">
          <Target size={18} />
          <h2>选择访谈模式</h2>
        </div>
        <div className="mode-grid">
          {modeOptions.map((mode) => (
            <button
              className="mode-option"
              key={mode.id}
              type="button"
              onClick={() => onStart(mode.id, selectedTopic)}>
              <strong>{mode.label}</strong>
              <span>{mode.detail}</span>
            </button>
          ))}
        </div>
      </section>
    </section>
  );
}
