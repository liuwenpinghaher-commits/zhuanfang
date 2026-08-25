import { Archive, CheckCircle, ExternalLink, Flag, Search } from "lucide-react";
import { HeaderBlock } from "../../components/HeaderBlock";
import { StatusButtons } from "../../components/StatusButtons";
import type { CognitiveAssetActionTarget, searchProductAssets } from "../../domain/engine";
import { assetAppearedInSession } from "../../domain/session-archive";
import type { AssetStatus, DecisionAsset } from "../../domain/types";
import { assetFilterOptions, type AssetFilter } from "../../ui";

interface AssetsViewProps {
  query: string;
  results: ReturnType<typeof searchProductAssets>;
  filter: AssetFilter;
  selectedAssetKey?: string;
  /** When true, hide the standalone page header (embedded under MyAssets). */
  embedded?: boolean;
  /** Limit list to assets from one interview session. */
  sessionScopeId?: string | null;
  /** Show only important points/questions (and confirmed decisions). */
  importantOnly?: boolean;
  /** List sort mode. */
  sortMode?: "updated-desc" | "important-first";
  onQuery: (query: string) => void;
  onFilter: (filter: AssetFilter) => void;
  onImportantOnly?: (value: boolean) => void;
  onSortMode?: (value: "updated-desc" | "important-first") => void;
  onSelectAsset: (key: string) => void;
  onClearSessionScope?: () => void;
  onOpenSourceSession?: (sessionId: string) => void;
  onBringIntoInterview?: (asset: CognitiveAssetActionTarget) => void;
  onAskAsset?: (asset: CognitiveAssetActionTarget) => void;
  onToggleImportant: (assetId: string) => void;
  onPointStatus: (assetId: string, status: Extract<AssetStatus, "临时想法" | "稳定观点" | "被挑战中" | "已修正" | "已放弃">) => void;
  onQuestionStatus: (assetId: string, status: Extract<AssetStatus, "开放" | "反复出现" | "正在聚焦" | "阶段性回答">) => void;
  onDebtStatus: (assetId: string, status: Extract<AssetStatus, "待了解" | "能复述" | "已应用" | "不相关">) => void;
  onDecisionStatus: (assetId: string, status: DecisionAsset["status"]) => void;
  onDecisionConfirm: (assetId: string) => void;
  confirmingDecisionId?: string;
}

export function AssetsView({
  query,
  results,
  filter,
  selectedAssetKey,
  embedded = false,
  sessionScopeId = null,
  importantOnly = false,
  sortMode = "updated-desc",
  onQuery,
  onFilter,
  onImportantOnly,
  onSortMode,
  onSelectAsset,
  onClearSessionScope,
  onOpenSourceSession,
  onBringIntoInterview,
  onAskAsset,
  onToggleImportant,
  onPointStatus,
  onQuestionStatus,
  onDebtStatus,
  onDecisionStatus,
  onDecisionConfirm,
  confirmingDecisionId
}: AssetsViewProps) {
  const scopedResults = applySessionScope(results, sessionScopeId);
  const allAssets = sortUnifiedAssets(
    buildUnifiedAssets(scopedResults).filter((asset) => {
      if (filter !== "all" && asset.type !== filter) return false;
      if (!importantOnly) return true;
      if (asset.type === "points" || asset.type === "questions") return asset.important;
      if (asset.type === "decisions") return asset.confirmationStatus === "用户确认";
      return false;
    }),
    sortMode
  );
  const assets = allAssets;
  const selectedAsset = assets.find((asset) => asset.key === selectedAssetKey) ?? assets[0];
  // Tab counts stay session-scoped but ignore important-only so users can switch types.
  const counts: Record<AssetFilter, number> = {
    all:
      scopedResults.points.length +
      scopedResults.questions.length +
      scopedResults.decisions.length +
      scopedResults.debts.length,
    points: scopedResults.points.length,
    questions: scopedResults.questions.length,
    decisions: scopedResults.decisions.length,
    debts: scopedResults.debts.length
  };

  return (
    <section className={embedded ? "assets-embedded" : "view-stack"}>
      {!embedded && (
        <HeaderBlock
          eyebrow="资产库"
          title="观点、问题、决策和知识债"
          subtitle="用筛选、列表和详情面板管理认知资产，避免在多个卡片列之间来回跳。"
        />
      )}
      <section className="panel search-panel">
        <Search size={18} />
        <label htmlFor="asset-search">
          <span>搜索原话、观点、问题、决策或知识债</span>
          <input
            id="asset-search"
            value={query}
            onChange={(event) => onQuery(event.target.value)}
            placeholder="输入关键词，例如：救火、授权、控制感"
          />
        </label>
        <span>{allAssets.length} 个资产结果</span>
      </section>

      {sessionScopeId && (
        <div className="config-hint row-wrap" aria-label="场次范围">
          <span className="is-emphasis">仅看本场资产</span>
          {onClearSessionScope && (
            <button type="button" className="text-button" onClick={onClearSessionScope}>
              查看全部场次
            </button>
          )}
        </div>
      )}

      <div className="form-actions row-wrap asset-toolbar" aria-label="列表选项">
        <label className="field-inline">
          <input
            type="checkbox"
            checked={importantOnly}
            onChange={(e) => onImportantOnly?.(e.target.checked)}
          />
          <span>仅重要 / 已确认</span>
        </label>
        <label className="field-inline" htmlFor="asset-sort">
          <span className="field-label">排序</span>
          <select
            id="asset-sort"
            value={sortMode}
            onChange={(e) => onSortMode?.((e.target.value as "updated-desc" | "important-first") || "updated-desc")}
          >
            <option value="updated-desc">最近更新</option>
            <option value="important-first">重要优先</option>
          </select>
        </label>
      </div>

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
              <p>
                {sessionScopeId
                  ? "本场在当前筛选下没有资产。可切换类型，或查看全部场次。"
                  : "当前筛选下没有资产。可以调整关键词或切换资产类型。"}
              </p>
            </div>
          )}
          {assets.map((asset) => (
            <button
              className={selectedAsset?.key === asset.key ? "asset-row active" : "asset-row"}
              type="button"
              key={asset.key}
              onClick={() => onSelectAsset(asset.key)}
            >
              <span className="status-pill">
                {asset.typeLabel} · {asset.status}
                {asset.important ? " · 重要" : ""}
                {asset.type === "decisions" && asset.confirmationStatus === "用户确认" ? " · 已确认" : ""}
              </span>
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
              onDecisionStatus={onDecisionStatus}
              onDecisionConfirm={onDecisionConfirm}
              onOpenSourceSession={onOpenSourceSession}
              onBringIntoInterview={onBringIntoInterview}
              onAskAsset={onAskAsset}
              confirmingDecisionId={confirmingDecisionId}
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
  sourceSessionId?: string;
  updatedAt?: string;
  nextPrompt?: string;
  relatedThemeIds?: string[];
};

function toAssetActionTarget(asset: UnifiedAsset): CognitiveAssetActionTarget {
  return {
    kind: asset.type,
    id: asset.id,
    title: asset.title,
    summary: asset.summary,
    ...(asset.nextPrompt ? { nextPrompt: asset.nextPrompt } : {}),
    ...(asset.relatedThemeIds?.length ? { relatedThemeIds: asset.relatedThemeIds } : {})
  };
}

function sortUnifiedAssets(
  items: UnifiedAsset[],
  mode: "updated-desc" | "important-first"
): UnifiedAsset[] {
  const rankImportant = (a: UnifiedAsset) => {
    if (a.important) return 2;
    if (a.type === "decisions" && a.confirmationStatus === "用户确认") return 1;
    return 0;
  };
  return [...items].sort((a, b) => {
    if (mode === "important-first") {
      const d = rankImportant(b) - rankImportant(a);
      if (d !== 0) return d;
    }
    const ta = Date.parse(a.updatedAt ?? "") || 0;
    const tb = Date.parse(b.updatedAt ?? "") || 0;
    return tb - ta;
  });
}

function applySessionScope(
  results: ReturnType<typeof searchProductAssets>,
  sessionScopeId?: string | null
): ReturnType<typeof searchProductAssets> {
  if (!sessionScopeId) return results;
  const match = <T extends Parameters<typeof assetAppearedInSession>[0]>(items: T[]) =>
    items.filter((item) => assetAppearedInSession(item, sessionScopeId));
  const points = match(results.points);
  const questions = match(results.questions);
  const decisions = match(results.decisions);
  const debts = match(results.debts);
  return {
    ...results,
    points,
    questions,
    decisions,
    debts,
    // Keep notes/themes empty under session scope for list alignment (P0: four asset types only in UI).
    notes: [],
    themes: [],
    total: points.length + questions.length + decisions.length + debts.length
  };
}

function buildUnifiedAssets(results: ReturnType<typeof searchProductAssets>): UnifiedAsset[] {
  return [
    ...results.points.map(
      (point): UnifiedAsset => ({
        key: `points:${point.id}`,
        id: point.id,
        type: "points",
        typeLabel: "观点",
        title: point.title,
        summary: point.content,
        detail: `置信度：${point.confidence}`,
        status: point.status,
        important: point.important,
        evidence: point.evidence,
        sourceSessionId: point.sourceSessionId,
        updatedAt: point.updatedAt,
        relatedThemeIds: point.relatedThemeIds
      })
    ),
    ...results.questions.map(
      (question): UnifiedAsset => ({
        key: `questions:${question.id}`,
        id: question.id,
        type: "questions",
        typeLabel: "问题",
        title: question.question,
        summary: question.whyImportant,
        detail: question.nextPrompt,
        status: question.status,
        important: question.important,
        evidence: [`出现次数：${question.appearances}`],
        sourceSessionId: question.sourceSessionId,
        updatedAt: question.updatedAt,
        nextPrompt: question.nextPrompt,
        relatedThemeIds: question.relatedThemeIds
      })
    ),
    ...results.decisions.map(
      (decision): UnifiedAsset => ({
        key: `decisions:${decision.id}`,
        id: decision.id,
        type: "decisions",
        typeLabel: "决策",
        title: decision.title,
        summary: decision.tradeOff,
        detail: `选择：${decision.choice}。风险假设：${decision.riskHypothesis}`,
        status: decision.status,
        important: false,
        evidence: [`复盘时间：${decision.reviewAt}`],
        confirmationStatus: decision.confirmationStatus,
        sourceSessionId: decision.sourceSessionId,
        updatedAt: decision.updatedAt,
        relatedThemeIds: decision.relatedThemeIds
      })
    ),
    ...results.debts.map(
      (debt): UnifiedAsset => ({
        key: `debts:${debt.id}`,
        id: debt.id,
        type: "debts",
        typeLabel: "知识债",
        title: debt.concept,
        summary: debt.whyImportant,
        detail: `${debt.context} 下一问：${debt.nextQuestion}`,
        status: debt.status,
        important: false,
        evidence: [debt.nextQuestion],
        sourceSessionId: debt.sourceSessionId,
        updatedAt: debt.updatedAt,
        nextPrompt: debt.nextQuestion,
        relatedThemeIds: debt.relatedThemeIds
      })
    )
  ];
}

interface AssetDetailProps {
  asset: UnifiedAsset;
  onToggleImportant: (assetId: string) => void;
  onPointStatus: (assetId: string, status: Extract<AssetStatus, "临时想法" | "稳定观点" | "被挑战中" | "已修正" | "已放弃">) => void;
  onQuestionStatus: (assetId: string, status: Extract<AssetStatus, "开放" | "反复出现" | "正在聚焦" | "阶段性回答">) => void;
  onDebtStatus: (assetId: string, status: Extract<AssetStatus, "待了解" | "能复述" | "已应用" | "不相关">) => void;
  onDecisionStatus: (assetId: string, status: DecisionAsset["status"]) => void;
  onDecisionConfirm: (assetId: string) => void;
  onOpenSourceSession?: (sessionId: string) => void;
  onBringIntoInterview?: (asset: CognitiveAssetActionTarget) => void;
  onAskAsset?: (asset: CognitiveAssetActionTarget) => void;
  confirmingDecisionId?: string;
}

function AssetDetail({
  asset,
  onToggleImportant,
  onPointStatus,
  onQuestionStatus,
  onDebtStatus,
  onDecisionStatus,
  onDecisionConfirm,
  onOpenSourceSession,
  onBringIntoInterview,
  onAskAsset,
  confirmingDecisionId
}: AssetDetailProps) {
  const isConfirming = confirmingDecisionId === asset.id;
  return (
    <article className="asset-detail">
      <span className="status-pill">
        {asset.typeLabel} · {asset.status}
      </span>
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
            {asset.evidence.map((item, evIdx) => (
              <li key={`${asset.id}-ev-${evIdx}`}>{item}</li>
            ))}
          </ul>
        </div>
      )}
      <div className="form-actions asset-detail-actions">
        {asset.type === "decisions" && asset.confirmationStatus === "待用户确认" && (
          <button
            className={`primary-action${isConfirming ? " btn-loading" : ""}`}
            type="button"
            disabled={isConfirming}
            aria-busy={isConfirming}
            onClick={() => onDecisionConfirm(asset.id)}
          >
            {isConfirming && <span className="spinner" aria-hidden="true" />}
            <CheckCircle size={16} />
            {isConfirming ? "确认中…" : "确认决策"}
          </button>
        )}
        {asset.type === "decisions" && asset.confirmationStatus === "用户确认" && (
          <span className="status-pill is-tracked">已用户确认</span>
        )}
        {(asset.type === "points" || asset.type === "questions") && (
          <button className="secondary-action" type="button" onClick={() => onToggleImportant(asset.id)}>
            <Flag size={16} />
            {asset.important ? "取消重要" : "标记重要"}
          </button>
        )}
        {asset.sourceSessionId && onOpenSourceSession && (
          <button
            className="secondary-action"
            type="button"
            onClick={() => onOpenSourceSession(asset.sourceSessionId!)}
          >
            <ExternalLink size={16} />
            查看来源场次
          </button>
        )}
        {onBringIntoInterview && (
          <button
            className="secondary-action"
            type="button"
            onClick={() => onBringIntoInterview(toAssetActionTarget(asset))}
          >
            <Flag size={16} />
            就这条开场
          </button>
        )}
        {onAskAsset && (
          <button
            className="secondary-action"
            type="button"
            onClick={() => onAskAsset(toAssetActionTarget(asset))}
          >
            <Search size={16} />
            问资产
          </button>
        )}
      </div>
      {asset.type === "decisions" && (
        <StatusButtons
          label="复盘状态"
          options={["待复盘", "已复盘"]}
          active={asset.status}
          onSelect={(status) => onDecisionStatus(asset.id, status as DecisionAsset["status"])}
        />
      )}
      {asset.type === "points" && (
        <StatusButtons
          label="观点状态"
          options={["稳定观点", "被挑战中", "已修正", "已放弃"]}
          active={asset.status}
          onSelect={(status) =>
            onPointStatus(asset.id, status as Extract<AssetStatus, "临时想法" | "稳定观点" | "被挑战中" | "已修正" | "已放弃">)
          }
        />
      )}
      {asset.type === "questions" && (
        <StatusButtons
          label="问题状态"
          options={["开放", "反复出现", "正在聚焦", "阶段性回答"]}
          active={asset.status}
          onSelect={(status) =>
            onQuestionStatus(asset.id, status as Extract<AssetStatus, "开放" | "反复出现" | "正在聚焦" | "阶段性回答">)
          }
        />
      )}
      {asset.type === "debts" && (
        <StatusButtons
          label="知识债状态"
          options={["待了解", "能复述", "已应用", "不相关"]}
          active={asset.status}
          onSelect={(status) =>
            onDebtStatus(asset.id, status as Extract<AssetStatus, "待了解" | "能复述" | "已应用" | "不相关">)
          }
        />
      )}
    </article>
  );
}
