import { ArrowLeft, BookOpen, ChevronRight, Clock, FileQuestion, Lightbulb, Milestone, Play, Unlink } from "lucide-react";
import type { TrackWorkspace } from "../../domain/timeline";

interface TrackWorkspaceViewProps {
  workspace: TrackWorkspace;
  onBack: () => void;
  onContinue: () => void;
}

const MATURITY_COLOR: Record<string, string> = {
  萌芽: "maturity-sprout",
  重复: "maturity-repeat",
  聚焦: "maturity-focus",
  成型: "maturity-formed",
  变化: "maturity-change",
  关闭: "maturity-closed",
};

export function TrackWorkspaceView({ workspace, onBack, onContinue }: TrackWorkspaceViewProps) {
  if (!workspace.theme) {
    return (
      <section className="view-stack">
        <div className="track-workspace-missing">
          <Unlink size={36} />
          <h2>主题线不存在</h2>
          <p>请返回后重新选择一条主题线。</p>
          <button className="secondary-action" type="button" onClick={onBack}>
            <ArrowLeft size={16} />
            返回
          </button>
        </div>
      </section>
    );
  }

  const { theme, sources, sessions, outputs } = workspace;
  const maturityClass = MATURITY_COLOR[theme.maturity] ?? "maturity-sprout";

  return (
    <section className="view-stack">
      {/* ── 头部 ── */}
      <header className="track-workspace-header">
        <button className="text-button track-back-btn" type="button" onClick={onBack}>
          <ArrowLeft size={16} />
          返回
        </button>

        <div className="track-hero">
          <div className="track-hero-meta">
            <span className={`status-pill track-maturity ${maturityClass}`}>{theme.maturity}</span>
            <span className="track-appearances">
              <Clock size={13} />
              出现 {theme.appearances} 次
            </span>
          </div>

          <h1 className="track-title">{theme.name}</h1>
          <p className="track-summary">{theme.summary}</p>

          {theme.representativeQuote && (
            <blockquote className="quote-line track-quote">
              "{theme.representativeQuote}"
            </blockquote>
          )}
        </div>

        <div className="track-hero-action">
          <button className="primary-action track-continue-btn" type="button" onClick={onContinue}>
            <Play size={15} />
            继续这条线
          </button>
        </div>
      </header>

      {/* ── 三列输出 ── */}
      <div className="dashboard-grid track-workspace-grid">
        {/* 列 1: 资料来源 */}
        <section className="panel">
          <div className="panel-title">
            <BookOpen size={16} />
            <h2>资料来源</h2>
            {sources.length > 0 && (
              <span className="track-count">{sources.length}</span>
            )}
          </div>
          {sources.length === 0 ? (
            <div className="empty-module">
              <Unlink size={18} />
              <p>资料尚未按主题线归类</p>
            </div>
          ) : (
            <ul className="track-item-list">
              {sources.map((s) => (
                <li key={s.id} className="track-item">
                  <span className="track-item-title">{s.title}</span>
                  <span className="label">{s.sourceType}</span>
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* 列 2: 历次专访 */}
        <section className="panel">
          <div className="panel-title">
            <Milestone size={16} />
            <h2>历次专访</h2>
            {sessions.length > 0 && (
              <span className="track-count">{sessions.length}</span>
            )}
          </div>
          {sessions.length === 0 ? (
            <div className="empty-module">
              <Milestone size={18} />
              <p>这条线还没有专访</p>
            </div>
          ) : (
            <ul className="track-item-list">
              {sessions.map((s) => (
                <li key={s.id} className="track-item track-session-item">
                  <div className="track-item-title">{s.title || "(无标题)"}</div>
                  <div className="track-session-meta">
                    <span className="status-pill track-mode-pill">{s.mode}</span>
                    <span className="label">
                      {new Date(s.startedAt).toLocaleDateString("zh-CN", {
                        year: "numeric",
                        month: "short",
                        day: "numeric",
                      })}
                    </span>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* 列 3: 沉淀产出 */}
        <section className="panel">
          <div className="panel-title">
            <Lightbulb size={16} />
            <h2>沉淀产出</h2>
            {(outputs.points.length + outputs.questions.length + outputs.decisions.length + outputs.debts.length) > 0 && (
              <span className="track-count">
                {outputs.points.length + outputs.questions.length + outputs.decisions.length + outputs.debts.length}
              </span>
            )}
          </div>

          {outputs.points.length === 0 &&
            outputs.questions.length === 0 &&
            outputs.decisions.length === 0 &&
            outputs.debts.length === 0 ? (
            <div className="empty-module">
              <Lightbulb size={18} />
              <p>还没有沉淀产出</p>
            </div>
          ) : (
            <div className="track-outputs">
              {outputs.points.length > 0 && (
                <div className="track-output-group">
                  <div className="track-output-label">
                    <ChevronRight size={12} />
                    观点 <span className="track-count">{outputs.points.length}</span>
                  </div>
                  <ul className="track-item-list">
                    {outputs.points.map((p) => (
                      <li key={p.id} className="track-item">{p.title}</li>
                    ))}
                  </ul>
                </div>
              )}
              {outputs.questions.length > 0 && (
                <div className="track-output-group">
                  <div className="track-output-label">
                    <FileQuestion size={12} />
                    问题 <span className="track-count">{outputs.questions.length}</span>
                  </div>
                  <ul className="track-item-list">
                    {outputs.questions.map((q) => (
                      <li key={q.id} className="track-item">{q.question}</li>
                    ))}
                  </ul>
                </div>
              )}
              {outputs.decisions.length > 0 && (
                <div className="track-output-group">
                  <div className="track-output-label">
                    <ChevronRight size={12} />
                    决策 <span className="track-count">{outputs.decisions.length}</span>
                  </div>
                  <ul className="track-item-list">
                    {outputs.decisions.map((d) => (
                      <li key={d.id} className="track-item">{d.title}</li>
                    ))}
                  </ul>
                </div>
              )}
              {outputs.debts.length > 0 && (
                <div className="track-output-group">
                  <div className="track-output-label">
                    <ChevronRight size={12} />
                    知识债 <span className="track-count">{outputs.debts.length}</span>
                  </div>
                  <ul className="track-item-list">
                    {outputs.debts.map((d) => (
                      <li key={d.id} className="track-item">{d.concept}</li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}
        </section>
      </div>
    </section>
  );
}
