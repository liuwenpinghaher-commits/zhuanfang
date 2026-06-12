import { Database, Globe2, Mic, Search, Sparkles, Trash2, Wand2 } from "lucide-react";
import type { CapabilityTask } from "../../capabilities/task";
import { HeaderBlock } from "../../components/HeaderBlock";
import type { ProductState, SearchBriefInput, SearchProviderId } from "../../domain/types";
import { formatCapabilityTaskStatus } from "../../ui";

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
  onAutoBrief
}: SearchIntelligenceViewProps) {
  const isRunning = task.status === "running";
  const providerActions: Array<{ id: SearchProviderId; label: string; icon: "sparkles" | "search" | "database" }> = [
    { id: "bailian", label: "百炼联网", icon: "sparkles" },
    { id: "anysearch", label: "AnySearch", icon: "search" },
    { id: "local-demo", label: "本地演示", icon: "database" }
  ];

  const allProviders: SearchProviderId[] = ["local-demo", "bailian", "anysearch", "tavily", "exa", "brave"];

  return (
    <section className="view-stack">
      <HeaderBlock
        eyebrow="联网素材"
        title="主动搜集热点、素材和可讨论主题"
        subtitle="当前搜索走 SearchProvider 能力层；真实 provider 可在系统配置中替换。"
      />
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
                  {provider}
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
        {state.searchBriefs.length === 0 && (
          <section className="panel empty-module">
            <Database size={22} />
            <p>还没有搜索简报。先生成一个主题素材包，再把它带入专访。</p>
          </section>
        )}
        {state.searchBriefs.map((brief) => (
          <article className={brief.id === activeBriefId ? "record-row feature-row active" : "record-row feature-row"} key={brief.id}>
            <div>
              <span className="status-pill">{brief.provider} · {brief.status === "ready" ? "可用" : "需复核"}</span>
              <h2>{brief.topic}</h2>
              <p>{brief.summary}</p>
              <div className="brief-material-grid" aria-label="结构化搜索素材">
                <MaterialList title="事实" items={brief.facts} />
                <MaterialList title="争议" items={brief.controversies} />
                <MaterialList title="反方" items={brief.opposingViews} />
                <MaterialList title="专访角度" items={brief.interviewAngles} />
              </div>
              <div className="topic-list">
                {brief.discussionTopics.map((item) => <span key={item}>{item}</span>)}
              </div>
              <div className="record-actions">
                <button className="secondary-action" type="button" onClick={() => onUseBrief(brief.id)}>
                  <Mic size={17} />带入专访
                </button>
                <button className="danger-button" type="button" onClick={() => onDeleteBrief(brief.id)}>
                  <Trash2 size={16} />删除简报
                </button>
              </div>
            </div>
            <div className="source-list">
              {brief.sources.slice(0, 4).map((source) => (
                <a href={source.url} key={source.id} target="_blank" rel="noreferrer">
                  <strong>{source.title}</strong>
                  <span>{source.publisher} · 相关度 {Math.round(source.relevanceScore * 100)}%</span>
                  <p>{source.snippet}</p>
                </a>
              ))}
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}

function MaterialList({ title, items }: { title: string; items: string[] }) {
  return (
    <section className="brief-material-block">
      <strong>{title}</strong>
      <ul>
        {items.slice(0, 3).map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
    </section>
  );
}
