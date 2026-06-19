import { Archive, CheckCircle, Flag, Search } from "lucide-react";
import { HeaderBlock } from "../../components/HeaderBlock";
import { StatusButtons } from "../../components/StatusButtons";
import type { searchProductAssets } from "../../domain/engine";
import type { AssetStatus } from "../../domain/types";
import { assetFilterOptions, type AssetFilter } from "../../ui";

interface AssetsViewProps {
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
}

export function AssetsView({
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
  onDecisionConfirm
}: AssetsViewProps) {
  const allAssets = buildUnifiedAssets(results);
  const assets = allAssets.filter((asset) => filter === "all" || asset.type === filter);
  const selectedAsset = assets.find((asset) => asset.key === selectedAssetKey) ?? assets[0];
  const counts: Record<AssetFilter, number> = {
    all: allAssets.length,
    points: results.points.length,
    questions: results.questions.length,
    decisions: results.decisions.length,
    debts: results.debts.length
  };

  return (
    <section className="view-stack">
      <HeaderBlock
        eyebrow="资产库"
        title="观点、问题、决策和知识债"
        subtitle="用筛选、列表和详情面板管理认知资产，避免在多个卡片列之间来回跳。"
      />
      <section className="panel search-panel">
        <Search size={18} />
        <label htmlFor="asset-search">
          <span>搜索原话、观点、问题、决策、知识债或长期主题</span>
          <input id="asset-search" value={query} onChange={(event) => onQuery(event.target.value)} placeholder="输入关键词，例如：救火、授权、控制感" />
        </label>
        <span>{allAssets.length} 个资产结果</span>
      </section>
      <div className="asset-workbench">
        <aside className="asset-filter-panel" aria-label="资产筛选">
          {assetFilterOptions.map((option) => (
            <button
              className={filter === option.id ? "asset-filter active" : "asset-filter"}
              type="button"
              key={option.id}
              onClick={() => onFilter(option.id)}
            >
              <span>{option.label}</span>
              <strong>{counts[option.id]}</strong>
              <small>{option.description}</small>
            </button>
          ))}
        </aside>
        <section className="asset-list-panel" aria-label="资产列表">
          {assets.length === 0 && (
            <div className="empty-module">
              <Archive size={18} />
              <p>当前筛选下没有资产。可以调整关键词或切换资产类型。</p>
            </div>
          )}
          {assets.map((asset) => (
            <button
              className={selectedAsset?.key === asset.key ? "asset-row active" : "asset-row"}
              type="button"
              key={asset.key}
              onClick={() => onSelectAsset(asset.key)}
            >
              <span className="status-pill">{asset.typeLabel} · {asset.status}</span>
              <strong>{asset.title}</strong>
              <p>{asset.summary}</p>
            </button>
          ))}
        </section>
        <aside className="asset-detail-panel" aria-label="资产详情">
          {selectedAsset ? (
            <AssetDetail
              asset={selectedAsset}
              onToggleImportant={onToggleImportant}
              onPointStatus={onPointStatus}
              onQuestionStatus={onQuestionStatus}
              onDebtStatus={onDebtStatus}
              onDecisionConfirm={onDecisionConfirm}
            />
          ) : (
            <div className="empty-module">
              <Archive size={18} />
              <p>选择一条资产查看详情。</p>
            </div>
          )}
        </aside>
      </div>
    </section>
  );
}

type UnifiedAsset = {
  key: string;
  id: string;
  type: Exclude<AssetFilter, "all">;
  typeLabel: string;
  title: string;
  summary: string;
  detail: string;
  status: string;
  important: boolean;
  evidence: string[];
  confirmationStatus?: string;
};

function buildUnifiedAssets(results: ReturnType<typeof searchProductAssets>): UnifiedAsset[] {
  return [
    ...results.points.map((point): UnifiedAsset => ({
      key: `points:${point.id}`,
      id: point.id,
      type: "points",
      typeLabel: "观点",
      title: point.title,
      summary: point.content,
      detail: `置信度：${point.confidence}`,
      status: point.status,
      important: point.important,
      evidence: point.evidence
    })),
    ...results.questions.map((question): UnifiedAsset => ({
      key: `questions:${question.id}`,
      id: question.id,
      type: "questions",
      typeLabel: "问题",
      title: question.question,
      summary: question.whyImportant,
      detail: question.nextPrompt,
      status: question.status,
      important: question.important,
      evidence: [`出现次数：${question.appearances}`]
    })),
    ...results.decisions.map((decision): UnifiedAsset => ({
      key: `decisions:${decision.id}`,
      id: decision.id,
      type: "decisions",
      typeLabel: "决策",
      title: decision.title,
      summary: decision.tradeOff,
      detail: `选择：${decision.choice}。风险假设：${decision.riskHypothesis}`,
      status: decision.status,
      important: decision.status === "待复盘",
      evidence: [`复盘时间：${decision.reviewAt}`],
      confirmationStatus: decision.confirmationStatus
    })),
    ...results.debts.map((debt): UnifiedAsset => ({
      key: `debts:${debt.id}`,
      id: debt.id,
      type: "debts",
      typeLabel: "知识债",
      title: debt.concept,
      summary: debt.whyImportant,
      detail: `${debt.context} 下一问：${debt.nextQuestion}`,
      status: debt.status,
      important: debt.status === "待了解",
      evidence: [debt.nextQuestion]
    }))
  ];
}

interface AssetDetailProps {
  asset: UnifiedAsset;
  onToggleImportant: (assetId: string) => void;
  onPointStatus: (assetId: string, status: Extract<AssetStatus, "临时想法" | "稳定观点" | "被挑战中" | "已修正" | "已放弃">) => void;
  onQuestionStatus: (assetId: string, status: Extract<AssetStatus, "开放" | "反复出现" | "正在聚焦" | "阶段性回答">) => void;
  onDebtStatus: (assetId: string, status: Extract<AssetStatus, "待了解" | "能复述" | "已应用" | "不相关">) => void;
  onDecisionConfirm: (assetId: string) => void;
}

function AssetDetail({ asset, onToggleImportant, onPointStatus, onQuestionStatus, onDebtStatus, onDecisionConfirm }: AssetDetailProps) {
  return (
    <article className="asset-detail">
      <span className="status-pill">{asset.typeLabel} · {asset.status}</span>
      <h2>{asset.title}</h2>
      <p>{asset.summary}</p>
      <div className="asset-detail-block">
        <span className="label">详情</span>
        <p>{asset.detail}</p>
      </div>
      {asset.evidence.length > 0 && (
        <div className="asset-detail-block">
          <span className="label">证据/线索</span>
          <ul>
            {asset.evidence.map((item, evIdx) => <li key={`${asset.id}-ev-${evIdx}`}>{item}</li>)}
          </ul>
        </div>
      )}
      {(asset.type === "points" || asset.type === "questions") && (
        <button className="secondary-action" type="button" onClick={() => onToggleImportant(asset.id)}>
          <Flag size={16} />{asset.important ? "取消重要" : "标记重要"}
        </button>
      )}
      {asset.type === "decisions" && asset.confirmationStatus === "待用户确认" && (
        <button className="secondary-action" type="button" onClick={() => onDecisionConfirm(asset.id)}>
          <CheckCircle size={16} />确认决策
        </button>
      )}
      {asset.type === "decisions" && asset.confirmationStatus === "用户确认" && (
        <span className="status-pill">已用户确认</span>
      )}
      {asset.type === "points" && (
        <StatusButtons
          label="观点状态"
          options={["稳定观点", "被挑战中", "已修正", "已放弃"]}
          onSelect={(status) => onPointStatus(asset.id, status as Extract<AssetStatus, "临时想法" | "稳定观点" | "被挑战中" | "已修正" | "已放弃">)}
        />
      )}
      {asset.type === "questions" && (
        <StatusButtons
          label="问题状态"
          options={["开放", "反复出现", "正在聚焦", "阶段性回答"]}
          onSelect={(status) => onQuestionStatus(asset.id, status as Extract<AssetStatus, "开放" | "反复出现" | "正在聚焦" | "阶段性回答">)}
        />
      )}
      {asset.type === "debts" && (
        <StatusButtons
          label="知识债状态"
          options={["待了解", "能复述", "已应用", "不相关"]}
          onSelect={(status) => onDebtStatus(asset.id, status as Extract<AssetStatus, "待了解" | "能复述" | "已应用" | "不相关">)}
        />
      )}
    </article>
  );
}
