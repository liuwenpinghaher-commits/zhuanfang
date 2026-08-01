import { Brain, ChartNoAxesCombined, ChevronRight, History, Layers, Play, RefreshCw, TimerReset } from "lucide-react";
import { HeaderBlock } from "../../components/HeaderBlock";
import type { buildCognitiveRadar, buildMonthlyReview, buildYearlyReview } from "../../domain/engine";
import type { InterviewMode, LongTermTheme, ProductState } from "../../domain/types";

interface ThemesViewProps {
  state: ProductState;
  /** LLM 综述（服务端）。null = 尚未就绪——绝不用本地模板顶替。 */
  review: ReturnType<typeof buildMonthlyReview> | null;
  yearlyReview: ReturnType<typeof buildYearlyReview> | null;
  /** 认知雷达是本地确定性真实计数（非 LLM 叙事），始终可渲染。 */
  radar: ReturnType<typeof buildCognitiveRadar>;
  /** LLM 复盘不可用时的真实原因（服务端错误信息）——如实展示，不能用就暴露。 */
  reviewsError?: string | null;
  /** 复盘请求进行中（可与 stale review 并存 = SWR 刷新）。 */
  reviewsLoading?: boolean;
  onRetryReviews?: () => void;
  /**
   * 开始/继续长期主题。
   * topicHint / relatedThemeIds 有值时表示绑定具体主题线，而不是裸 long-term 模式。
   */
  onStart: (mode?: InterviewMode, topicHint?: string, relatedThemeIds?: string[]) => void;
  onOpenTrack?: (id: string) => void;
}

function pickTopTheme(themes: LongTermTheme[]): LongTermTheme | undefined {
  return [...themes]
    .filter((theme) => theme.maturity !== "关闭")
    .sort((a, b) => {
      if (b.appearances !== a.appearances) return b.appearances - a.appearances;
      return (b.updatedAt || "").localeCompare(a.updatedAt || "");
    })[0] ?? [...themes].sort((a, b) => b.appearances - a.appearances)[0];
}

function sortThemes(themes: LongTermTheme[]): LongTermTheme[] {
  return [...themes].sort((a, b) => {
    const aClosed = a.maturity === "关闭" ? 1 : 0;
    const bClosed = b.maturity === "关闭" ? 1 : 0;
    if (aClosed !== bClosed) return aClosed - bClosed;
    if (b.appearances !== a.appearances) return b.appearances - a.appearances;
    return (b.updatedAt || "").localeCompare(a.updatedAt || "");
  });
}

function isSparseReview(review: ReturnType<typeof buildMonthlyReview>): boolean {
  const fields = [review.topTheme, review.changedView, review.avoidedQuestion, review.recommendedNextInterview];
  return fields.every((value) => !String(value ?? "").trim());
}

function isSparseYearly(review: ReturnType<typeof buildYearlyReview>): boolean {
  return (
    review.coreQuestions.length === 0 &&
    review.changedViews.length === 0 &&
    review.unresolvedPatterns.length === 0 &&
    review.importantDecisions.length === 0 &&
    !String(review.nextYearFocus ?? "").trim()
  );
}

function themeLaunchHint(theme: LongTermTheme): string {
  return theme.nextQuestion?.trim() || theme.name;
}

export function ThemesView({
  state,
  review,
  yearlyReview,
  radar,
  reviewsError,
  reviewsLoading = false,
  onRetryReviews,
  onStart,
  onOpenTrack
}: ThemesViewProps) {
  const topTheme = pickTopTheme(state.themes);
  const orderedThemes = sortThemes(state.themes);
  const nextAction =
    review?.recommendedNextInterview?.trim() ||
    topTheme?.nextQuestion?.trim() ||
    "";
  const radarEmpty = isRadarEmpty(radar);

  function continueTheme(theme: LongTermTheme) {
    onStart("long-term", themeLaunchHint(theme), [theme.id]);
  }

  function handleHeroContinue() {
    if (!topTheme) {
      onStart("long-term");
      return;
    }
    continueTheme(topTheme);
  }

  return (
    <section className="view-stack">
      <HeaderBlock
        eyebrow="主题线"
        title="看见反复主题和观点变化"
        subtitle="长期价值来自下次更精准的回访，而不是更漂亮的统计图。"
        action={
          topTheme ? (
            <button className="primary-action" type="button" onClick={handleHeroContinue}>
              <TimerReset size={18} />
              继续：{topTheme.name}
            </button>
          ) : (
            <button className="secondary-action" type="button" onClick={() => onStart("daily")}>
              <Play size={18} />
              去完成一场专访
            </button>
          )
        }
      />

      {topTheme && nextAction && (
        <section className="panel themes-next-action" aria-label="下次行动">
          <div className="panel-title row-between">
            <div className="row">
              <Play size={18} aria-hidden="true" />
              <h2>下次最值得继续</h2>
            </div>
            <span className="status-pill">{topTheme.name}</span>
          </div>
          <p className="themes-next-action-copy">{nextAction}</p>
          <div className="form-actions">
            <button className="primary-action" type="button" onClick={() => continueTheme(topTheme)}>
              <Play size={16} />
              用这个问题开场
            </button>
            {onOpenTrack && (
              <button className="secondary-action" type="button" onClick={() => onOpenTrack(topTheme.id)}>
                查看这条线
              </button>
            )}
          </div>
        </section>
      )}

      <section className="panel">
        <div className="panel-title row-between">
          <div className="row">
            <Brain size={18} />
            <h2>本月回顾</h2>
          </div>
          {reviewsLoading && <span className="status-pill">刷新中…</span>}
        </div>
        <ReviewPanel
          kind="monthly"
          review={review}
          yearlyReview={null}
          loading={reviewsLoading}
          error={reviewsError}
          onRetry={onRetryReviews}
          sparse={review ? isSparseReview(review) : false}
          onGoInterview={() =>
            onStart(
              topTheme ? "long-term" : "daily",
              topTheme ? themeLaunchHint(topTheme) : undefined,
              topTheme ? [topTheme.id] : undefined
            )
          }
        />
        {review && !isSparseReview(review) && (
          <div className="review-grid">
            <ReviewItem label="一直在谈" value={review.topTheme} />
            <ReviewItem label="正在变化" value={review.changedView} />
            <ReviewItem label="仍在回避" value={review.avoidedQuestion} />
            <ReviewItem label="下次建议" value={review.recommendedNextInterview} />
          </div>
        )}
        {review?.metrics && (
          <p className="field-help themes-metrics-line" aria-label="本月资产计数">
            笔记 {review.metrics.notes} · 观点 {review.metrics.points} · 问题 {review.metrics.questions} · 知识债{" "}
            {review.metrics.knowledgeDebts} · 主题 {review.metrics.themes}
          </p>
        )}
      </section>

      <section className="panel">
        <div className="panel-title">
          <Layers size={18} />
          <h2>主题线列表</h2>
        </div>
        <div className="record-list">
          {orderedThemes.length === 0 && (
            <section className="panel empty-module">
              <Layers size={18} />
              <p>还没有主题线，随着专访推进会自动聚合出反复出现的主题。</p>
              <button className="primary-action" type="button" onClick={() => onStart("daily")}>
                <Play size={16} />
                开始一场专访
              </button>
            </section>
          )}
          {orderedThemes.map((theme) => (
            <article
              className={["record-row compact", onOpenTrack ? "record-row-clickable" : ""].filter(Boolean).join(" ")}
              key={theme.id}
              onClick={onOpenTrack ? () => onOpenTrack(theme.id) : undefined}
              role={onOpenTrack ? "button" : undefined}
              tabIndex={onOpenTrack ? 0 : undefined}
              onKeyDown={
                onOpenTrack
                  ? (e) => {
                      if (e.key === "Enter" || e.key === " ") onOpenTrack(theme.id);
                    }
                  : undefined
              }
            >
              <div>
                <div className="row themes-row-meta">
                  <span className="status-pill">{theme.maturity}</span>
                  <span className="label">{theme.appearances} 次</span>
                </div>
                <h2>{theme.name}</h2>
                <p>{theme.summary}</p>
                <div className="quote-line">&ldquo;{theme.representativeQuote}&rdquo;</div>
              </div>
              <div className="theme-next">
                <span className="label">下次追问</span>
                <p>{theme.nextQuestion}</p>
                <button
                  className="secondary-action"
                  type="button"
                  onClick={(event) => {
                    event.stopPropagation();
                    continueTheme(theme);
                  }}
                >
                  <Play size={14} />
                  继续这条线
                </button>
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

      <section className="panel">
        <div className="panel-title">
          <ChartNoAxesCombined size={18} />
          <h2>认知雷达</h2>
        </div>
        <p className="field-help">基于资产的真实计数，不是 LLM 叙事。</p>
        {radarEmpty ? (
          <p className="review-degraded-hint" role="status">
            还没有足够资产形成雷达信号。完成几场专访并沉淀观点后，这里会显示真实计数。
          </p>
        ) : (
          <div className="radar-grid">
            <RadarGroup title="深度" items={radar.depth} />
            <RadarGroup title="视角" items={radar.perspectives} />
            <RadarGroup title="资产" items={radar.assets} />
            <RadarGroup title="状态" items={radar.statuses} />
          </div>
        )}
      </section>

      <section className="panel">
        <div className="panel-title row-between">
          <div className="row">
            <History size={18} />
            <h2>年度回顾草稿</h2>
          </div>
          {reviewsLoading && <span className="status-pill">刷新中…</span>}
        </div>
        <ReviewPanel
          kind="yearly"
          review={null}
          yearlyReview={yearlyReview}
          loading={reviewsLoading}
          error={reviewsError}
          onRetry={onRetryReviews}
          sparse={yearlyReview ? isSparseYearly(yearlyReview) : false}
          onGoInterview={() =>
            onStart(
              topTheme ? "long-term" : "daily",
              topTheme ? themeLaunchHint(topTheme) : undefined,
              topTheme ? [topTheme.id] : undefined
            )
          }
        />
        {yearlyReview && !isSparseYearly(yearlyReview) && (
          <>
            <div className="yearly-grid">
              <ReviewList title="核心问题" items={yearlyReview.coreQuestions} />
              <ReviewList title="变化中的观点" items={yearlyReview.changedViews} />
              <ReviewList title="未解决模式" items={yearlyReview.unresolvedPatterns} />
              <ReviewList title="重要决策" items={yearlyReview.importantDecisions} />
            </div>
            <div className="quote-line">下一年焦点：{yearlyReview.nextYearFocus}</div>
          </>
        )}
      </section>
    </section>
  );
}

function ReviewPanel({
  kind,
  review,
  yearlyReview,
  loading,
  error,
  onRetry,
  sparse,
  onGoInterview
}: {
  kind: "monthly" | "yearly";
  review: ReturnType<typeof buildMonthlyReview> | null;
  yearlyReview: ReturnType<typeof buildYearlyReview> | null;
  loading: boolean;
  error?: string | null;
  onRetry?: () => void;
  sparse: boolean;
  onGoInterview: () => void;
}) {
  const hasContent = kind === "monthly" ? Boolean(review) : Boolean(yearlyReview);

  if (hasContent && !sparse && !error) {
    return null;
  }

  if (loading && !hasContent) {
    return (
      <p className="review-degraded-hint" role="status">
        复盘生成中…
      </p>
    );
  }

  if (error && !hasContent) {
    return (
      <div className="themes-review-status" role="alert">
        <p className="review-degraded-hint">复盘不可用：{error}</p>
        {onRetry && (
          <button className="secondary-action" type="button" onClick={onRetry}>
            <RefreshCw size={14} />
            重试
          </button>
        )}
      </div>
    );
  }

  if (sparse) {
    return (
      <div className="themes-review-status" role="status">
        <p className="review-degraded-hint">素材不足，先完成几场专访再看综述。</p>
        <button className="secondary-action" type="button" onClick={onGoInterview}>
          <Play size={14} />
          去访谈台
        </button>
      </div>
    );
  }

  if (error && hasContent) {
    return (
      <div className="themes-review-status" role="status">
        <p className="review-degraded-hint">复盘刷新失败：{error}（仍显示上次结果）</p>
        {onRetry && (
          <button className="secondary-action" type="button" onClick={onRetry}>
            <RefreshCw size={14} />
            重试
          </button>
        )}
      </div>
    );
  }

  if (!hasContent && !loading && !error) {
    return (
      <p className="review-degraded-hint" role="status">
        复盘尚未加载。
      </p>
    );
  }

  return null;
}

function isRadarEmpty(radar: ReturnType<typeof buildCognitiveRadar>): boolean {
  const all = [...radar.depth, ...radar.perspectives, ...radar.assets, ...radar.statuses];
  return all.every((item) => item.value <= 0);
}

function RadarGroup({ title, items }: { title: string; items: Array<{ label: string; value: number; max: number }> }) {
  return (
    <div className="radar-group">
      <strong>{title}</strong>
      {items.map((item) => (
        <div className="radar-row" key={`${title}-${item.label}`}>
          <span>{item.label}</span>
          <div className="radar-bar">
            <i style={{ width: `${Math.min(100, item.max > 0 ? (item.value / item.max) * 100 : 0)}%` }} />
          </div>
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
      <ul>
        {items.map((item, itemIdx) => (
          <li key={`${title}-item-${itemIdx}`}>{item}</li>
        ))}
      </ul>
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
