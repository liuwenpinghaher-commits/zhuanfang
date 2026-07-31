import { useState } from "react";
import { Database, Mic, RefreshCw, Search, Trash2, Wand2, Bookmark, BookmarkCheck, Play, X, AlertTriangle, Star, BookOpen, Lightbulb, HelpCircle } from "lucide-react";
import { searchProviderIds, searchProviderLabels } from "../../capabilities/contracts";
import type { CapabilityTask } from "../../capabilities/task";
import { HeaderBlock } from "../../components/HeaderBlock";
import type { ProductState, SearchBriefInput, SearchProviderId } from "../../domain/types";
import { isSearchBriefStale } from "../../domain/research-automation";
import { formatCapabilityTaskStatus } from "../../ui";

interface AutoRunSummary {
  generated: number;
  refreshed: number;
  dedupedSources: number;
}

interface SearchIntelligenceViewProps {
  state: ProductState;
  topic: string;
  activeBriefId?: string;
  task: CapabilityTask<SearchBriefInput>;
  onTopic: (value: string) => void;
  onCreate: (provider?: SearchProviderId) => void | Promise<void>;
  onRetry: () => void | Promise<void>;
  onUseBrief: (briefId: string) => void;
  onDeleteBrief: (briefId: string) => void;
  onSetDefaultProvider: (provider: SearchProviderId) => void;
  onAutoBrief: (themeId?: string, debtId?: string) => void | Promise<void>;
  onRefreshBrief?: (briefId: string) => void | Promise<void>;
  onTrackBrief?: (briefId: string, tracked: boolean) => void | Promise<void>;
  onAutoRun?: () => Promise<AutoRunSummary | null>;
  onConvertToDebt?: (briefId: string) => void;
  onConvertToPoint?: (briefId: string) => void;
  onConvertToQuestion?: (briefId: string) => void;
  refreshingBriefId?: string | null;
  trackingBriefId?: string | null;
}

export function SearchIntelligenceView({
  state,
  topic,
  activeBriefId,
  task,
  onTopic,
  onCreate,
  onRetry,
  onUseBrief,
  onDeleteBrief,
  onSetDefaultProvider,
  onAutoBrief,
  onRefreshBrief,
  onTrackBrief,
  onAutoRun,
  onConvertToDebt,
  onConvertToPoint,
  onConvertToQuestion,
  refreshingBriefId,
  trackingBriefId
}: SearchIntelligenceViewProps) {
  const isRunning = task.status === "running";
  const now = new Date().toISOString();

  const activeProvider = state.systemConfig.search.activeProvider;

  // Locally selected provider for this run. Defaults to the configured default.
  // The dropdown picks "which provider to use"; the actions below either generate
  // with it (onCreate) or commit it as the new default (onSetDefaultProvider).
  const [selectedProvider, setSelectedProvider] = useState<SearchProviderId>(activeProvider);
  const isSelectedDefault = selectedProvider === activeProvider;

  // Auto-run state (local to view)
  const [autoRunning, setAutoRunning] = useState(false);
  const [autoRunResult, setAutoRunResult] = useState<AutoRunSummary | null>(null);
  const [autoRunError, setAutoRunError] = useState<string | null>(null);
  const [autoRunDismissed, setAutoRunDismissed] = useState(false);

  async function handleAutoRun() {
    if (!onAutoRun) return;
    setAutoRunning(true);
    setAutoRunResult(null);
    setAutoRunError(null);
    setAutoRunDismissed(false);
    try {
      const summary = await onAutoRun();
      setAutoRunResult(summary);
    } catch (err) {
      setAutoRunError(err instanceof Error ? err.message : "运行失败，请重试");
    } finally {
      setAutoRunning(false);
    }
  }

  const showAutoRunFeedback = !autoRunDismissed && (autoRunResult !== null || autoRunError !== null);

  return (
    <section className="view-stack">
      <HeaderBlock
        eyebrow="外部调研"
        title="主动搜集热点、素材和可讨论主题"
        subtitle="外部调研结果可标记为「持续追踪」并随时刷新；研究成果可带入专访作为外部参照。" />

      {/* Auto-watch primary action */}
      {onAutoRun && (
        <section className="panel action-panel" style={{ borderColor: autoRunning ? "var(--action-primary)" : undefined }}>
          <div className="panel-title">
            <Play size={18} />
            <h2>自动盯梢</h2>
          </div>
          <p style={{ margin: "0 0 12px", color: "var(--text-muted)", fontSize: "0.875rem", lineHeight: 1.6 }}>
            一键扫描主题和知识债，自动采集情报并刷新已过期的持续追踪简报。
          </p>
          <div className="row-wrap">
            <button
              className={autoRunning ? "primary-action btn-loading" : "primary-action"}
              type="button"
              onClick={handleAutoRun}
              disabled={autoRunning}
              aria-busy={autoRunning}
>
              {autoRunning ? (
                <>
                  <span className="spinner" aria-hidden="true" />
                  检查中…
                </>
              ) : (
                <>
                  <Play size={16} />
                  自动盯梢
                </>
              )}
            </button>
            {showAutoRunFeedback && (
              <div
                role="status"
                aria-live="polite"
                className="row"
>
                {autoRunError ? (
                  <>
                    <AlertTriangle size={16} />
                    <span>{autoRunError}</span>
                    <button
                      type="button"
                      className="primary-action"
                      style={{ padding: "2px 12px", fontSize: "0.8rem" }}
                      onClick={handleAutoRun}>
                      重试
                    </button>
                  </>
                ) : autoRunResult !== null ? (
                  <>
                    <span>
                      本次新增 {autoRunResult.generated} 条 · 刷新 {autoRunResult.refreshed} 条
                      {autoRunResult.dedupedSources > 0 ? ` · 去重 ${autoRunResult.dedupedSources} 来源` : ""}
                    </span>
                    <button
                      type="button"
                      aria-label="关闭提示"
                      style={{ background: "none", border: "none", cursor: "pointer", padding: "2px", color: "inherit", opacity: 0.6, lineHeight: 1 }}
                      onClick={() => setAutoRunDismissed(true)}>
                      <X size={16} />
                    </button>
                  </>
                ) : null}
              </div>
            )}
          </div>
        </section>
      )}

      <section className="panel action-panel">
        <div className="panel-title"><Search size={18} /><h2>生成搜索简报</h2></div>
        <div className="input-row">
          <label className="field-stack" htmlFor="search-topic">
            <span className="field-label">追踪主题</span>
            <input id="search-topic" value={topic} onChange={(event) => onTopic(event.target.value)} placeholder="输入想追踪的热点或主题" />
            <span className="field-help">用于生成素材来源、讨论主题和会中引用摘要。</span>
          </label>
        </div>

        <div className="provider-control">
          <label className="field-stack" htmlFor="search-provider">
            <span className="field-label">搜索提供商</span>
            <select
              id="search-provider"
              value={selectedProvider}
              onChange={(event) => setSelectedProvider(event.target.value as SearchProviderId)}
              disabled={isRunning}
>
              {searchProviderIds.map((provider) => (
                <option key={provider} value={provider}>
                  {searchProviderLabels[provider]}
                  {provider === activeProvider ? "（默认）" : ""}
                </option>
              ))}
            </select>
            <span className="field-help">选择本次生成所用的搜索 provider。</span>
          </label>
          <div className="provider-control-actions">
            <button
              className={isRunning ? "primary-action btn-loading" : "primary-action"}
              type="button"
              onClick={() => onCreate(selectedProvider)}
              disabled={isRunning}
              aria-busy={isRunning}
>
              {isRunning ? (
                <>
                  <span className="spinner" aria-hidden="true" />
                  搜集中…
                </>
              ) : (
                <>
                  <Search size={16} />
                  生成简报
                </>
              )}
            </button>
            <button
              className="secondary-action"
              type="button"
              title={isSelectedDefault ? "该 provider 已是默认" : `把「${searchProviderLabels[selectedProvider]}」设为默认 provider`}
              onClick={() => onSetDefaultProvider(selectedProvider)}
              disabled={isSelectedDefault}
>
              <Star size={16} />
              设为默认
            </button>
          </div>
        </div>

        <div className="config-hint" aria-label="当前搜索配置">
          <span>当前默认 provider：{searchProviderLabels[activeProvider]}</span>
          <span>会中引用：{state.systemConfig.search.allowWebInInterview ? "开启" : "关闭"}</span>
          <span>最大来源：{state.systemConfig.search.maxSources}</span>
        </div>

        <div className="auto-brief-actions">
          <button
            className="secondary-action"
            type="button"
            onClick={() => onAutoBrief()}
            disabled={isRunning}
>
            <Wand2 size={16} />自动生成
          </button>
          {state.themes.length > 0 && (
            <button
              className="secondary-action"
              type="button"
              onClick={() => onAutoBrief(state.themes[0].id, undefined)}
              disabled={isRunning}
>
              <Wand2 size={16} />从主题：{state.themes[0].name}
            </button>
          )}
          {state.debts.length > 0 && (
            <button
              className="secondary-action"
              type="button"
              onClick={() => onAutoBrief(undefined, state.debts[0].id)}
              disabled={isRunning}
>
              <Wand2 size={16} />从知识债：{state.debts[0].concept}
            </button>
          )}
        </div>

        {task.status !== "idle" && (
          <div className={`task-status ${task.status}`} aria-live="polite">
            <div>
              <strong>{task.label} · {formatCapabilityTaskStatus(task.status)}</strong>
              <span>{task.providerId ? `Provider：${task.providerId}` : "等待选择 provider"}</span>
            </div>
            {task.degradedReason && <p>{task.degradedReason}</p>}
            {task.error && <p>{task.error}</p>}
            {task.canRetry && task.status !== "running" && (
              <button className="secondary-action" type="button" onClick={onRetry}>
                重试
              </button>
            )}
          </div>
        )}
      </section>

      <div className="record-list">
        {state.searchBriefs.length === 0 ? (
          <section className="panel empty-state">
            <Database size={32} className="empty-icon" aria-hidden="true" />
            <p>还没有搜索简报。点「自动盯梢」，从你的主题和知识债自动采集情报。</p>
            {onAutoRun && (
              <div className="empty-cta">
                <button
                  className={autoRunning ? "primary-action btn-loading" : "primary-action"}
                  type="button"
                  onClick={handleAutoRun}
                  disabled={autoRunning}
>
                  {autoRunning ? (
                    <>
                      <span className="spinner" aria-hidden="true" />
                      检查中…
                    </>
                  ) : (
                    <>
                      <Play size={16} />
                      自动盯梢
                    </>
                  )}
                </button>
              </div>
            )}
          </section>
        ) : (
          state.searchBriefs.map((brief) => {
            const isStale = isSearchBriefStale(brief, now);
            const isRefreshing = refreshingBriefId === brief.id;
            const isTracking = trackingBriefId === brief.id;
            const isActive = brief.id === activeBriefId;

            return (
              <article
                key={brief.id}
                className={`record-row feature-row row-clickable${isActive ? " active" : ""}`}
                tabIndex={0}
                role="button"
                aria-pressed={isActive}
                onClick={() => onUseBrief(brief.id)}
                onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onUseBrief(brief.id); } }}
>
                <div>
                  <div className="row">
                    <span className="status-pill">{brief.provider} · {brief.status === "ready" ? "可用" : "需复核"}</span>
                    {isStale && (
                      <span
                        className="status-pill"
                        style={{ borderColor: "var(--accent-amber)", color: "var(--accent-amber)", display: "inline-flex", alignItems: "center", gap: "4px" }}
                        title="该简报超过 14 天未刷新，建议重新调研"
>
                        <AlertTriangle size={12} aria-hidden="true" />
                        已过期·建议刷新
                      </span>
                    )}
                    {brief.tracked && (
                      <span
                        className="status-pill"
                        style={{ borderColor: "var(--action-primary)", color: "var(--action-primary)" }}
>
                        持续追踪中
                      </span>
                    )}
                  </div>
                  <h2>{brief.topic}</h2>
                  <p>{brief.summary}</p>
                  <div className="brief-material-grid" aria-label="结构化搜索素材">
                    <MaterialList title="事实" items={brief.facts} />
                    <MaterialList title="争议" items={brief.controversies} />
                    <MaterialList title="反方" items={brief.opposingViews} />
                    <MaterialList title="专访角度" items={brief.interviewAngles} />
                  </div>
                  <div className="topic-list">
                    {brief.discussionTopics.map((item, topicIdx) => <span key={`${brief.id}-topic-${topicIdx}`}>{item}</span>)}
                  </div>
                  <div className="record-actions" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()} role="presentation">
                    <button
                      className="secondary-action"
                      type="button"
                      onClick={() => onUseBrief(brief.id)}>
                      <Mic size={16} />
                      带入专访
                    </button>
                    {onTrackBrief && (
                      <button
                        className={isTracking ? "secondary-action btn-loading" : brief.tracked ? "primary-action" : "secondary-action"}
                        type="button"
                        title={brief.tracked ? "已标记为持续追踪，点击取消" : "标记为持续追踪"}
                        disabled={isTracking}
                        onClick={() => onTrackBrief(brief.id, !brief.tracked)}>
                        {isTracking ? (
                          <span className="spinner" aria-hidden="true" />
                        ) : brief.tracked ? (
                          <BookmarkCheck size={16} />
                        ) : (
                          <Bookmark size={16} />
                        )}
                        {isTracking ? "处理中…" : brief.tracked ? "持续追踪中" : "持续追踪"}
                      </button>
                    )}
                    {onRefreshBrief && (
                      <button
                        className={isRefreshing ? "secondary-action btn-loading" : "secondary-action"}
                        type="button"
                        title="重新调研该主题并刷新内容"
                        disabled={isRefreshing}
                        onClick={() => onRefreshBrief(brief.id)}>
                        {isRefreshing ? <span className="spinner" aria-hidden="true" /> : <RefreshCw size={16} />}
                        重新调研
                      </button>
                    )}
                    {onConvertToDebt && (
                      <button
                        className="secondary-action"
                        type="button"
                        title="把这份调研转成一条待验证知识债，进入资产库"
                        onClick={() => onConvertToDebt(brief.id)}>
                        <BookOpen size={16} />转知识债
                      </button>
                    )}
                    {onConvertToPoint && (
                      <button
                        className="secondary-action"
                        type="button"
                        title="把这份调研转成一条观点草稿，进入资产库"
                        onClick={() => onConvertToPoint(brief.id)}>
                        <Lightbulb size={16} />转观点
                      </button>
                    )}
                    {onConvertToQuestion && (
                      <button
                        className="secondary-action"
                        type="button"
                        title="把这份调研转成一条专访问题，可带入下一次专访"
                        onClick={() => onConvertToQuestion(brief.id)}>
                        <HelpCircle size={16} />转问题
                      </button>
                    )}
                    <button
                      className="danger-button"
                      type="button"
                      onClick={() => {
                        if (window.confirm("确认删除该搜索简报？")) {
                          onDeleteBrief(brief.id);
                        }
                      }}
>
                      <Trash2 size={16} />删除简报
                    </button>
                  </div>
                </div>
                <div className="source-list">
                  {brief.sources.slice(0, 4).map((source) => (
                    <a
                      // source.url 来自联网搜索结果（不可信外部数据）：只放行 http/https，
                      // 拦掉 javascript: 等危险 scheme（点击即执行的 XSS 注入面）。
                      href={/^https?:\/\//i.test(source.url) ? source.url : undefined}
                      key={source.id}
                      target="_blank"
                      rel="noreferrer"
                      onClick={(e) => e.stopPropagation()}>
                      <strong>{source.title}</strong>
                      <span>{source.publisher} · 相关度 {Math.round(source.relevanceScore * 100)}%</span>
                      <p>{source.snippet}</p>
                    </a>
                  ))}
                </div>
              </article>
            );
          })
        )}
      </div>
    </section>
  );
}

function MaterialList({ title, items }: { title: string; items: string[] }) {
  return (
    <section className="brief-material-block">
      <strong>{title}</strong>
      <ul>
        {items.slice(0, 3).map((item, itemIdx) => (
          <li key={`${title}-${itemIdx}`}>{item}</li>
        ))}
      </ul>
    </section>
  );
}
