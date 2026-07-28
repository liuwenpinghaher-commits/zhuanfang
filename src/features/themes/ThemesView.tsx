import { Brain, ChartNoAxesCombined, ChevronRight, History, Layers, TimerReset } from "lucide-react";
import { HeaderBlock } from "../../components/HeaderBlock";
import type { buildCognitiveRadar, buildMonthlyReview, buildYearlyReview } from "../../domain/engine";
import type { InterviewMode, ProductState } from "../../domain/types";

interface ThemesViewProps {
  state: ProductState;
  /** LLM 综述（服务端）。null = 尚未加载或不可用（见 reviewsError）——绝不用本地模板顶替。 */
  review: ReturnType<typeof buildMonthlyReview> | null;
  yearlyReview: ReturnType<typeof buildYearlyReview> | null;
  /** 认知雷达是本地确定性真实计数（非 LLM 叙事），始终可渲染。 */
  radar: ReturnType<typeof buildCognitiveRadar>;
  /** LLM 复盘不可用时的真实原因（服务端错误信息）——如实展示，不能用就暴露。 */
  reviewsError?: string | null;
  onStart: (mode?: InterviewMode) => void;
  onOpenTrack?: (id: string) => void;
}

export function ThemesView({ state, review, yearlyReview, radar, reviewsError, onStart, onOpenTrack }: ThemesViewProps) {
  return (
    <section className="view-stack">
      <HeaderBlock
        eyebrow="长期追踪"
        title="看见反复主题和观点变化"
        subtitle="长期价值来自下次更精准的回访，而不是更漂亮的统计图。"
        action={<button className="secondary-action" type="button" onClick={() => onStart("long-term")}><TimerReset size={18} />继续主题</button>}
      />
      <section className="panel">
        <div className="panel-title"><Brain size={18} /><h2>本月回顾</h2></div>
        {review ? (
          <div className="review-grid">
            <ReviewItem label="一直在谈" value={review.topTheme} />
            <ReviewItem label="正在变化" value={review.changedView} />
            <ReviewItem label="仍在回避" value={review.avoidedQuestion} />
            <ReviewItem label="下次建议" value={review.recommendedNextInterview} />
          </div>
        ) : (
          <p className="review-degraded-hint" role="status">
            {reviewsError ? `复盘不可用：${reviewsError}` : "复盘生成中…"}
          </p>
        )}
      </section>
      <section className="panel">
        <div className="panel-title"><ChartNoAxesCombined size={18} /><h2>认知雷达</h2></div>
        <div className="radar-grid">
          <RadarGroup title="深度" items={radar.depth} />
          <RadarGroup title="视角" items={radar.perspectives} />
          <RadarGroup title="资产" items={radar.assets} />
          <RadarGroup title="状态" items={radar.statuses} />
        </div>
      </section>
      <section className="panel">
        <div className="panel-title"><History size={18} /><h2>年度回顾草稿</h2></div>
        {yearlyReview ? (
          <>
            <div className="yearly-grid">
              <ReviewList title="核心问题" items={yearlyReview.coreQuestions} />
              <ReviewList title="变化中的观点" items={yearlyReview.changedViews} />
              <ReviewList title="未解决模式" items={yearlyReview.unresolvedPatterns} />
              <ReviewList title="重要决策" items={yearlyReview.importantDecisions} />
            </div>
            <div className="quote-line">下一年焦点：{yearlyReview.nextYearFocus}</div>
          </>
        ) : (
          <p className="review-degraded-hint" role="status">
            {reviewsError ? `复盘不可用：${reviewsError}` : "复盘生成中…"}
          </p>
        )}
      </section>
      <div className="record-list">
        {state.themes.length === 0 && (
          <section className="panel empty-module">
            <Layers size={18} />
            <p>还没有主题线，随着专访推进会自动聚合出反复出现的主题。</p>
          </section>
        )}
        {state.themes.map((theme) => (
          <article
            className={["record-row compact", onOpenTrack ? "record-row-clickable" : ""].filter(Boolean).join(" ")}
            key={theme.id}
            onClick={onOpenTrack ? () => onOpenTrack(theme.id) : undefined}
            role={onOpenTrack ? "button" : undefined}
            tabIndex={onOpenTrack ? 0 : undefined}
            onKeyDown={onOpenTrack ? (e) => {
              if (e.key === "Enter" || e.key === " ") onOpenTrack(theme.id);
            } : undefined}
          >
            <div>
              <span className="status-pill">{theme.maturity}</span>
              <h2>{theme.name}</h2>
              <p>{theme.summary}</p>
              <div className="quote-line">&ldquo;{theme.representativeQuote}&rdquo;</div>
            </div>
            <div className="theme-next">
              <span className="label">下次追问</span>
              <p>{theme.nextQuestion}</p>
            </div>
            {onOpenTrack && (
              <div className="record-row-arrow" aria-hidden="true">
                <ChevronRight size={16} />
              </div>
            )}
          </article>
        ))}
      </div>
    </section>
  );
}

function RadarGroup({ title, items }: { title: string; items: Array<{ label: string; value: number; max: number }> }) {
  return (
    <div className="radar-group">
      <strong>{title}</strong>
      {items.map((item) => (
        <div className="radar-row" key={`${title}-${item.label}`}>
          <span>{item.label}</span>
          <div className="radar-bar"><i style={{ width: `${Math.min(100, (item.value / item.max) * 100)}%` }} /></div>
          <em>{item.value}</em>
        </div>
      ))}
    </div>
  );
}

function ReviewList({ title, items }: { title: string; items: string[] }) {
  return (
    <div className="review-list">
      <strong>{title}</strong>
      <ul>{items.map((item, itemIdx) => <li key={`${title}-item-${itemIdx}`}>{item}</li>)}</ul>
    </div>
  );
}

function ReviewItem({ label, value }: { label: string; value: string }) {
  return (
    <div className="review-item">
      <span className="label">{label}</span>
      <p>{value}</p>
    </div>
  );
}
