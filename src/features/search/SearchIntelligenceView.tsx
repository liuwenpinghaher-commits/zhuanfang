import { useState } from "react";
import { Database, Globe2, Mic, RefreshCw, Search, Sparkles, Trash2, Wand2, Bookmark, BookmarkCheck, Play, X, AlertTriangle } from "lucide-react";
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
  refreshingBriefId?: string | null;
  trackingBriefId?: string | null;
  usingBriefId?: string | null;
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
  refreshingBriefId,
  trackingBriefId,
  usingBriefId
}: SearchIntelligenceViewProps) {
  const isRunning = task.status === "running";
  const now = new Date().toISOString();

  // Auto-run state (local to view)
  const [autoRunning, setAutoRunning] = useState(false);
  const [autoRunResult, setAutoRunResult] = useState<AutoRunSummary | null>(null);
  const [autoRunError, setAutoRunError] = useState<string | null>(null);
  const [autoRunDismissed, setAutoRunDismissed] = useState(false);

  const providerActions: Array<{ id: SearchProviderId; label: string; icon: "sparkles" | "search" | "database" }> = [
    { id: "bailian", label: "百炼联网", icon: "sparkles" },
    { id: "anysearch", label: "AnySearch", icon: "search" },
    { id: "local-demo", label: "本地演示", icon: "database" }
  ];

  const allProviders = searchProviderIds;

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
        subtitle="外部调研结果可标记为「持续追踪」并随时刷新；研究成果可带入专访作为外部参照。"
      />

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
          <div style={{ display: "flex", gap: "12px", alignItems: "center", flexWrap: "wrap" }}>
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
                  盯梢中…
                </>
              ) : (
                <>
                  <Play size={16} />
                  ▶ 自动盯梢
                </>
              )}
            </button>
            {showAutoRunFeedback && (
              <div
                role="status"
                aria-live="polite"
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "8px",
                  fontSize: "0.875rem",
                  color: autoRunError ? "var(--status-failed)" : "var(--status-success, #22c55e)",
                  flex: 1
                }}
              >
                {autoRunError ? (
                  <>
                    <AlertTriangle size={15} />
                    <span>{autoRunError}</span>
                    <button
                      type="button"
                      className="secondary-action"
                      style={{ padding: "2px 10px", fontSize: "0.8rem" }}
                      onClick={handleAutoRun}
                    >
                      重试
                    </button>
                  </>
                ) : autoRunResult !== null ? (
                  <>
                    <span>
                      本次新增 {autoRunResult.generated} 条 · 刷新 {autoRunResult.refreshed} 条
                      {autoRunResult.dedupedSources > 0 ? ` · 去重 ${autoRunResult.dedupedSources} 来源` : ""}
                    </span>
                  </>
                ) : null}
                <button
                  type="button"
                  aria-label="关闭提示"
                  style={{ background: "none", border: "none", cursor: "pointer", padding: "2px", color: "inherit", opacity: 0.6, lineHeight: 1 }}
                  onClick={() => setAutoRunDismissed(true)}
                >
                  <X size={14} />
                </button>
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
          <div className="provider-action-group" aria-label="选择搜索 provider">
            {providerActions.map((provider) => (
              <button
                className={provider.id === state.systemConfig.search.activeProvider ? "primary-action" : "secondary-action"}
                type="button"
                key={provider.id}
                onClick={() => onCreate(provider.id)}
                disabled={isRunning}
              >
                {provider.icon === "sparkles" && <Sparkles size={18} />}
                {provider.icon === "search" && <Globe2 size={18} />}
                {provider.icon === "database" && <Database size={18} />}
                {isRunning && task.providerId === provider.id ? "搜集中" : provider.label}
              </button>
            ))}
          </div>
        </div>
        <div className="config-hint">
          <span>当前默认 provider：{state.systemConfig.search.activeProvider}</span>
          <span>会中引用：{state.systemConfig.search.allowWebInInterview ? "开启" : "关闭"}</span>
          <span>最大来源：{state.systemConfig.search.maxSources}</span>
          <div className="provider-default-actions">
            {providerActions.map((provider) => (
              <button
                className="secondary-action"
                type="button"
                key={`default-${provider.id}`}
                onClick={() => onSetDefaultProvider(provider.id)}
                disabled={state.systemConfig.search.activeProvider === provider.id}
              >
                设为默认：{provider.label}
              </button>
            ))}
          </div>
        </div>
        <div className="auto-brief-section">
          <div className="field-stack">
            <span className="field-label">搜索提供商</span>
            <select
              id="search-provider"
              value={state.systemConfig.search.activeProvider}
              onChange={(event) => onSetDefaultProvider(event.target.value as SearchProviderId)}
            >
              {allProviders.map((provider) => (
                <option key={provider} value={provider}>
                  {searchProviderLabels[provider]}
                </option>
              ))}
            </select>
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
                      盯梢中…
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
            const isUsing = usingBriefId === brief.id;
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
                  <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap", marginBottom: "4px" }}>
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
                      className={isUsing ? "secondary-action btn-loading" : "secondary-action"}
                      type="button"
                      disabled={isUsing}
                      onClick={() => onUseBrief(brief.id)}
                    >
                      {isUsing ? <span className="spinner" aria-hidden="true" /> : <Mic size={17} />}
                      带入专访
                    </button>
                    {onTrackBrief && (
                      <button
                        className={isTracking ? "secondary-action btn-loading" : brief.tracked ? "primary-action" : "secondary-action"}
                        type="button"
                        title={brief.tracked ? "已标记为持续追踪，点击取消" : "标记为持续追踪"}
                        disabled={isTracking}
                        onClick={() => onTrackBrief(brief.id, !brief.tracked)}
                      >
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
                        onClick={() => onRefreshBrief(brief.id)}
                      >
                        {isRefreshing ? <span className="spinner" aria-hidden="true" /> : <RefreshCw size={16} />}
                        重新调研
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
                      href={source.url}
                      key={source.id}
                      target="_blank"
                      rel="noreferrer"
                      onClick={(e) => e.stopPropagation()}
                    >
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
