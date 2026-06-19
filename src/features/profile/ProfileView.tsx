import { Brain, Download, FileText, PenLine, Settings, ShieldCheck, Trash2 } from "lucide-react";
import { useState } from "react";
import { HeaderBlock } from "../../components/HeaderBlock";
import type { PrivacyReport } from "../../domain/privacy";
import type { BackupRestoreRehearsalReport } from "../../domain/backup";
import type { ProductState } from "../../domain/types";

interface ProfileViewProps {
  state: ProductState;
  correctionText: string;
  onCorrectionText: (value: string) => void;
  onAddCorrection: () => void;
  onReset: () => void;
  onExport: () => Promise<BackupRestoreRehearsalReport>;
  onPrivacyReport: () => Promise<PrivacyReport>;
  onPurge: () => Promise<ProductState>;
  onSetProductState: (state: ProductState) => void;
}

type GovernanceAction = "export" | "privacy" | "purge";

export function ProfileView({
  state,
  correctionText,
  onCorrectionText,
  onAddCorrection,
  onReset,
  onExport,
  onPrivacyReport,
  onPurge,
  onSetProductState
}: ProfileViewProps) {
  const [loadingAction, setLoadingAction] = useState<GovernanceAction | null>(null);
  const [exportSuccess, setExportSuccess] = useState(false);
  const [purgeSuccess, setPurgeSuccess] = useState(false);
  const [privacyReport, setPrivacyReport] = useState<PrivacyReport | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);
  const [privacyError, setPrivacyError] = useState<string | null>(null);
  const [purgeError, setPurgeError] = useState<string | null>(null);

  async function handleExport() {
    setLoadingAction("export");
    setExportSuccess(false);
    setExportError(null);
    try {
      const report = await onExport();
      const blob = new Blob([JSON.stringify(report, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      const dateStr = new Date().toISOString().slice(0, 10);
      anchor.href = url;
      anchor.download = "专访数据导出-" + dateStr + ".json";
      document.body.appendChild(anchor);
      anchor.click();
      document.body.removeChild(anchor);
      URL.revokeObjectURL(url);
      setExportSuccess(true);
    } catch (err) {
      setExportError(err instanceof Error ? err.message : "导出失败");
    } finally {
      setLoadingAction(null);
    }
  }

  async function handlePrivacyReport() {
    setLoadingAction("privacy");
    setPrivacyReport(null);
    setPrivacyError(null);
    try {
      const report = await onPrivacyReport();
      setPrivacyReport(report);
    } catch (err) {
      setPrivacyError(err instanceof Error ? err.message : "获取隐私报告失败");
    } finally {
      setLoadingAction(null);
    }
  }

  async function handlePurge() {
    const confirmed = window.confirm(
      "将永久删除你的所有专访、笔记、资产、记忆等个人数据，且无法撤销。确定吗？"
    );
    if (!confirmed) return;
    setLoadingAction("purge");
    setPurgeSuccess(false);
    setPurgeError(null);
    try {
      const nextState = await onPurge();
      onSetProductState(nextState);
      setPurgeSuccess(true);
    } catch (err) {
      setPurgeError(err instanceof Error ? err.message : "清空失败");
    } finally {
      setLoadingAction(null);
    }
  }

  return (
    <section className="view-stack">
      <HeaderBlock
        eyebrow="个人档案与控制"
        title={state.profile.role + " · " + state.profile.industry}
        subtitle="长期记忆必须可见、可修正、可删除。AI 推断不能直接等同于事实。"
      />
      <div className="dashboard-grid">
        <section className="panel">
          <div className="panel-title"><Settings size={18} /><h2>显性档案</h2></div>
          <dl className="detail-list">
            <dt>当前关注</dt>
            <dd>{state.profile.currentFocus}</dd>
            <dt>长期目标</dt>
            <dd>{state.profile.longTermGoal}</dd>
            <dt>追问强度</dt>
            <dd>{state.profile.preferredStrength}</dd>
          </dl>
        </section>
        <section className="panel">
          <div className="panel-title"><ShieldCheck size={18} /><h2>用户边界</h2></div>
          <ul className="clean-list">
            {state.profile.explicitBoundaries.map((boundary, idx) => <li key={"boundary-" + idx}>{boundary}</li>)}
          </ul>
        </section>
      </div>

      <section className="panel">
        <div className="panel-title"><Brain size={18} /><h2>系统记忆</h2></div>
        <div className="memory-grid">
          <div>
            <span className="label">用户确认</span>
            <ul>{state.profile.confirmedMemories.map((memory, idx) => <li key={"confirmed-" + idx}>{memory}</li>)}</ul>
          </div>
          <div>
            <span className="label">AI 推断</span>
            <ul>{state.profile.inferredMemories.map((memory, idx) => <li key={"inferred-" + idx}>{memory}</li>)}</ul>
          </div>
        </div>
      </section>

      <section className="panel">
        <div className="panel-title"><PenLine size={18} /><h2>修正 AI 理解</h2></div>
        <div className="correction-row">
          <label className="field-stack" htmlFor="memory-correction">
            <span className="field-label">修正说明</span>
            <input
              id="memory-correction"
              value={correctionText}
              onChange={(event) => onCorrectionText(event.target.value)}
              placeholder="例：不要把我对项目的不满写成对团队成员的否定。"
            />
            <span className="field-help">这会作为长期边界保留，不会直接覆盖用户确认记忆。</span>
          </label>
          <button className="primary-action" type="button" onClick={onAddCorrection}>保存修正</button>
        </div>
        {state.memoryCorrections.length > 0 && (
          <ul className="clean-list">
            {state.memoryCorrections.map((correction) => <li key={correction.id}>{correction.text}</li>)}
          </ul>
        )}
      </section>

      <section className="panel">
        <div className="panel-title"><FileText size={18} /><h2>数据治理</h2></div>
        <p style={{ color: "var(--text-secondary)", marginBottom: "1.25rem", fontSize: "0.875rem" }}>
          导出个人数据备份、查看隐私库存摘要，或彻底清空个人数据。
        </p>
        <div style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>

          {/* Export */}
          <div style={{ display: "flex", alignItems: "center", gap: "1rem", flexWrap: "wrap" }}>
            <button
              className={"secondary-action" + (loadingAction === "export" ? " btn-loading" : "")}
              type="button"
              disabled={loadingAction !== null}
              onClick={handleExport}
            >
              {loadingAction === "export" ? <span className="spinner" aria-hidden="true" /> : <Download size={15} />}
              导出数据
            </button>
            {exportSuccess && <span style={{ color: "var(--color-success, #22c55e)", fontSize: "0.875rem" }}>已下载 JSON 备份包</span>}
            {exportError && <span style={{ color: "var(--action-danger)", fontSize: "0.875rem" }}>{exportError}</span>}
          </div>

          {/* Privacy Report */}
          <div style={{ display: "flex", alignItems: "flex-start", gap: "1rem", flexWrap: "wrap" }}>
            <button
              className={"secondary-action" + (loadingAction === "privacy" ? " btn-loading" : "")}
              type="button"
              disabled={loadingAction !== null}
              onClick={handlePrivacyReport}
            >
              {loadingAction === "privacy" ? <span className="spinner" aria-hidden="true" /> : <ShieldCheck size={15} />}
              隐私报告
            </button>
            {privacyError && <span style={{ color: "var(--action-danger)", fontSize: "0.875rem" }}>{privacyError}</span>}
          </div>

          {privacyReport && (
            <div className="panel" style={{ marginTop: "0.25rem" }}>
              <p style={{ fontSize: "0.8125rem", color: "var(--text-secondary)", marginBottom: "0.75rem" }}>
                共 {privacyReport.totalRecords} 条记录 &nbsp;&middot;&nbsp; {privacyReport.generatedAt.slice(0, 10)} 生成
              </p>
              {privacyReport.inventory.length === 0 ? (
                <div className="empty-state"><p>暂无隐私库存数据。</p></div>
              ) : (
                <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "flex", flexDirection: "column", gap: "0.5rem" }}>
                  {privacyReport.inventory.map((item) => (
                    <li key={item.id} style={{ display: "flex", justifyContent: "space-between", fontSize: "0.875rem", padding: "0.375rem 0", borderBottom: "1px solid var(--border-subtle, rgba(255,255,255,0.06))" }}>
                      <span style={{ color: "var(--text-secondary)" }}>{item.label}</span>
                      <span style={{ fontVariantNumeric: "tabular-nums", color: "var(--text-primary)" }}>{item.count}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}

          {/* Purge */}
          <div style={{ display: "flex", alignItems: "center", gap: "1rem", flexWrap: "wrap", marginTop: "0.5rem" }}>
            <button
              className={"danger-button" + (loadingAction === "purge" ? " btn-loading" : "")}
              type="button"
              disabled={loadingAction !== null}
              onClick={handlePurge}
            >
              {loadingAction === "purge" ? <span className="spinner" aria-hidden="true" /> : <Trash2 size={15} />}
              清空个人数据
            </button>
            {purgeSuccess && <span style={{ color: "var(--color-success, #22c55e)", fontSize: "0.875rem" }}>个人数据已彻底清空</span>}
            {purgeError && <span style={{ color: "var(--action-danger)", fontSize: "0.875rem" }}>{purgeError}</span>}
          </div>
          <p style={{ fontSize: "0.8125rem", color: "var(--text-secondary)", marginTop: "-0.25rem" }}>
            将删除专访、笔记、资产、记忆等所有个人数据，且无法撤销。Provider 运行配置保留。
          </p>
        </div>
      </section>

      <section className="danger-zone">
        <div>
          <strong>清空示例，开始我的记录</strong>
          <p>移除内置示例的访谈、资产和记忆，开始记录你自己的真实内容。</p>
        </div>
        <button className="danger-button" type="button" onClick={onReset}><Trash2 size={17} />清空示例，开始我的记录</button>
      </section>
    </section>
  );
}
