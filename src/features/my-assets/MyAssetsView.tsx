import { BookOpen, FileText, Headphones, Mic } from "lucide-react";
import { useEffect, useState } from "react";
import { HeaderBlock } from "../../components/HeaderBlock";
import { buildSessionArchive } from "../../domain/session-archive";
import type { ProductState } from "../../domain/types";
import { AssetsView } from "../assets/AssetsView";
import type { searchProductAssets } from "../../domain/engine";
import type { AssetStatus, DecisionAsset } from "../../domain/types";
import type { AssetFilter } from "../../ui";

type Tab = "archive" | "assets";

interface MyAssetsViewProps {
  state: ProductState;
  initialTab?: Tab;
  query: string;
  results: ReturnType<typeof searchProductAssets>;
  filter: AssetFilter;
  selectedAssetKey?: string;
  onQuery: (query: string) => void;
  onFilter: (filter: AssetFilter) => void;
  onSelectAsset: (key: string) => void;
  onToggleImportant: (assetId: string) => void;
  onPointStatus: (assetId: string, status: Extract<AssetStatus, "临时想法" | "稳定观点" | "被挑战中" | "已修正" | "已放弃">) => void;
  onQuestionStatus: (assetId: string, status: Extract<AssetStatus, "开放" | "反复出现" | "正在聚焦" | "阶段性回答">) => void;
  onDebtStatus: (assetId: string, status: Extract<AssetStatus, "待了解" | "能复述" | "已应用" | "不相关">) => void;
  onDecisionStatus: (assetId: string, status: DecisionAsset["status"]) => void;
  onDecisionConfirm: (assetId: string) => void;
  confirmingDecisionId?: string;
  onGeneratePodcast: (noteId: string) => void;
  onOpenNote?: (sessionId: string) => void;
}

export function MyAssetsView({
  state,
  initialTab = "archive",
  query,
  results,
  filter,
  selectedAssetKey,
  onQuery,
  onFilter,
  onSelectAsset,
  onToggleImportant,
  onPointStatus,
  onQuestionStatus,
  onDebtStatus,
  onDecisionStatus,
  onDecisionConfirm,
  confirmingDecisionId,
  onGeneratePodcast,
  onOpenNote
}: MyAssetsViewProps) {
  const [activeTab, setActiveTab] = useState<Tab>(initialTab);
  const [sessionScopeId, setSessionScopeId] = useState<string | null>(null);
  const [highlightSessionId, setHighlightSessionId] = useState<string | null>(null);
  const entries = buildSessionArchive(state);
  const totalAssets =
    results.points.length + results.questions.length + results.decisions.length + results.debts.length;

  useEffect(() => {
    if (!highlightSessionId) return;
    const t = window.setTimeout(() => setHighlightSessionId(null), 3500);
    return () => window.clearTimeout(t);
  }, [highlightSessionId]);

  function openArchiveAssets(
    sessionId: string,
    nextFilter: AssetFilter = "all"
  ) {
    setSessionScopeId(sessionId);
    onFilter(nextFilter);
    setActiveTab("assets");
  }

  function openSourceSession(sessionId: string) {
    setActiveTab("archive");
    setSessionScopeId(null);
    setHighlightSessionId(sessionId);
    // Scroll after paint
    requestAnimationFrame(() => {
      const el = document.querySelector(`[data-archive-session="${sessionId}"]`);
      el?.scrollIntoView({ behavior: "smooth", block: "center" });
    });
  }

  return (
    <section className="view-stack">
      <HeaderBlock
        eyebrow="我的资产"
        title="专访档案与认知资产库"
        subtitle="档案按场次归档每次专访的产出；点产出徽章可进入本场资产库审核观点、问题、决策和知识债。"
      />

      <nav className="seg-tabs" aria-label="视图切换">
        <button
          type="button"
          className={activeTab === "archive" ? "seg-tab active" : "seg-tab"}
          onClick={() => setActiveTab("archive")}
          aria-current={activeTab === "archive" ? "true" : undefined}
        >
          <FileText size={16} aria-hidden="true" />
          <span>专访档案</span>
          <span className="seg-tab-count">{entries.length}</span>
        </button>
        <button
          type="button"
          className={activeTab === "assets" ? "seg-tab active" : "seg-tab"}
          onClick={() => setActiveTab("assets")}
          aria-current={activeTab === "assets" ? "true" : undefined}
        >
          <Mic size={16} aria-hidden="true" />
          <span>资产库</span>
          <span className="seg-tab-count">{totalAssets}</span>
        </button>
      </nav>

      {activeTab === "archive" && (
        <div className="record-list">
          {entries.length === 0 ? (
            <section className="empty-state">
              <FileText size={32} className="empty-icon" aria-hidden="true" />
              <p>还没有专访档案，完成一次专访后这里会出现。</p>
            </section>
          ) : (
            entries.map((entry) => {
              const title = entry.session?.title ?? entry.note.title;
              const dateStr = new Date(entry.note.createdAt).toLocaleDateString("zh-CN");
              const sessionId = entry.note.sessionId;
              const isHighlight = highlightSessionId === sessionId;
              const badgeItems: Array<{ label: string; count: number; filter: AssetFilter }> = [
                { label: "观点", count: entry.points.length, filter: "points" },
                { label: "问题", count: entry.questions.length, filter: "questions" },
                { label: "决策", count: entry.decisions.length, filter: "decisions" },
                { label: "债", count: entry.debts.length, filter: "debts" }
              ];
              const linkedTotal = badgeItems.reduce((n, b) => n + b.count, 0);

              return (
                <article
                  className={`record-row archive-card${isHighlight ? " is-highlight" : ""}`}
                  key={entry.note.id}
                  data-archive-session={sessionId}
                  aria-label={title}
                >
                  <div className="record-main">
                    <span className="label">{dateStr}</span>
                    <h2>{title}</h2>
                    {entry.note.summary && <p className="archive-summary">{entry.note.summary}</p>}
                    {entry.note.keyQuote && <div className="quote-line">&quot;{entry.note.keyQuote}&quot;</div>}
                    {linkedTotal === 0 && (
                      <p className="field-help archive-zero-hint">
                        本场尚未关联观点/问题/决策/知识债（双轨摘要仍来自笔记）。可稍后在资产库查看全局，或完成抽取后再回来。
                      </p>
                    )}
                  </div>

                  {(entry.note.saidTrack.length > 0 || entry.note.learnedTrack.length > 0) && (
                    <div className="dual-track">
                      {entry.note.saidTrack.length > 0 && (
                        <div>
                          <strong>我说了什么</strong>
                          <ul>
                            {entry.note.saidTrack.slice(0, 3).map((item, idx) => (
                              <li key={`said-${entry.note.id}-${idx}`}>{item}</li>
                            ))}
                          </ul>
                        </div>
                      )}
                      {entry.note.learnedTrack.length > 0 && (
                        <div>
                          <strong>我学到了什么</strong>
                          <ul>
                            {entry.note.learnedTrack.slice(0, 3).map((item, idx) => (
                              <li key={`learned-${entry.note.id}-${idx}`}>{item}</li>
                            ))}
                          </ul>
                        </div>
                      )}
                    </div>
                  )}

                  <div className="archive-card-footer">
                    <div className="archive-output-badges" role="group" aria-label="本场产出">
                      {badgeItems.map((b) => (
                        <button
                          key={b.label}
                          type="button"
                          className={
                            b.count > 0
                              ? "output-badge output-badge--active output-badge--button"
                              : "output-badge output-badge--button"
                          }
                          disabled={b.count === 0}
                          title={b.count > 0 ? `查看本场${b.label}` : `本场暂无${b.label}`}
                          onClick={() => openArchiveAssets(sessionId, b.filter)}
                        >
                          {b.count} {b.label}
                        </button>
                      ))}
                    </div>
                    <div className="archive-card-actions">
                      {onOpenNote && (
                        <button
                          type="button"
                          className="secondary-action"
                          onClick={() => onOpenNote(sessionId)}
                        >
                          <BookOpen size={16} aria-hidden="true" />
                          打开笔记
                        </button>
                      )}
                      <button
                        type="button"
                        className="secondary-action"
                        onClick={() => onGeneratePodcast(entry.note.id)}
                      >
                        <Headphones size={16} aria-hidden="true" />
                        生成播客
                      </button>
                    </div>
                  </div>
                </article>
              );
            })
          )}
        </div>
      )}

      {activeTab === "assets" && (
        <AssetsView
          embedded
          query={query}
          results={results}
          filter={filter}
          selectedAssetKey={selectedAssetKey}
          sessionScopeId={sessionScopeId}
          onQuery={onQuery}
          onFilter={onFilter}
          onSelectAsset={onSelectAsset}
          onClearSessionScope={() => setSessionScopeId(null)}
          onOpenSourceSession={openSourceSession}
          onToggleImportant={onToggleImportant}
          onPointStatus={onPointStatus}
          onQuestionStatus={onQuestionStatus}
          onDebtStatus={onDebtStatus}
          onDecisionStatus={onDecisionStatus}
          onDecisionConfirm={onDecisionConfirm}
          confirmingDecisionId={confirmingDecisionId}
        />
      )}
    </section>
  );
}
