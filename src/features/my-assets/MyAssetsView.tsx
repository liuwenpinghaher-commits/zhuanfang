import { FileText, Headphones, Mic } from "lucide-react";
import { useState } from "react";
import { HeaderBlock } from "../../components/HeaderBlock";
import { buildSessionArchive } from "../../domain/session-archive";
import type { ProductState } from "../../domain/types";
import { AssetsView } from "../assets/AssetsView";
import type { searchProductAssets } from "../../domain/engine";
import type { AssetStatus } from "../../domain/types";
import type { AssetFilter } from "../../ui";

type Tab = "archive" | "assets";

interface MyAssetsViewProps {
  state: ProductState;
  initialTab?: Tab;
  // AssetsView props
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
  onDecisionConfirm: (assetId: string) => void;
  onGeneratePodcast: (noteId: string) => void;
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
  onDecisionConfirm,
  onGeneratePodcast
}: MyAssetsViewProps) {
  const [activeTab, setActiveTab] = useState<Tab>(initialTab);
  const entries = buildSessionArchive(state);
  const totalAssets =
    results.points.length +
    results.questions.length +
    results.decisions.length +
    results.debts.length;

  return (
    <section className="view-stack">
      <HeaderBlock
        eyebrow="我的资产"
        title="专访档案与认知资产库"
        subtitle="档案按场次归档每次专访的产出；资产库跨场次搜索全部观点、问题、决策和知识债。"
      />

      {/* Tab nav — uses reusable .seg-tabs / .seg-tab / .seg-tab-count */}
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
              const badgeItems = [
                { label: "观点", count: entry.points.length },
                { label: "问题", count: entry.questions.length },
                { label: "决策", count: entry.decisions.length },
                { label: "债", count: entry.debts.length }
              ];
              return (
                <article
                  className="record-row archive-card row-clickable"
                  key={entry.note.id}
                  tabIndex={0}
                  role="group"
                  aria-label={title}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      onGeneratePodcast(entry.note.id);
                    }
                  }}
                >
                  <div className="record-main">
                    <span className="label">{dateStr}</span>
                    <h2>{title}</h2>
                    {entry.note.summary && (
                      <p className="archive-summary">{entry.note.summary}</p>
                    )}
                    {entry.note.keyQuote && (
                      <div className="quote-line">"{entry.note.keyQuote}"</div>
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
                    <div className="archive-output-badges">
                      {badgeItems.map((b) => (
                        <span
                          key={b.label}
                          className={
                            b.count > 0
                              ? "output-badge output-badge--active"
                              : "output-badge"
                          }
                        >
                          {b.count} {b.label}
                        </span>
                      ))}
                    </div>
                    <button
                      type="button"
                      className="secondary-action"
                      onClick={(e) => {
                        e.stopPropagation();
                        onGeneratePodcast(entry.note.id);
                      }}
                    >
                      <Headphones size={16} aria-hidden="true" />
                      生成播客
                    </button>
                  </div>
                </article>
              );
            })
          )}
        </div>
      )}

      {activeTab === "assets" && (
        <AssetsView
          query={query}
          results={results}
          filter={filter}
          selectedAssetKey={selectedAssetKey}
          onQuery={onQuery}
          onFilter={onFilter}
          onSelectAsset={onSelectAsset}
          onToggleImportant={onToggleImportant}
          onPointStatus={onPointStatus}
          onQuestionStatus={onQuestionStatus}
          onDebtStatus={onDebtStatus}
          onDecisionConfirm={onDecisionConfirm}
        />
      )}
    </section>
  );
}
