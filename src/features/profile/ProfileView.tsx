import { Brain, Download, FileText, PenLine, Settings, ShieldCheck, Trash2, Upload } from "lucide-react";
import { useEffect, useRef, useState, type ChangeEvent } from "react";
import { HeaderBlock } from "../../components/HeaderBlock";
import type { PrivacyReport } from "../../domain/privacy";
import type { StateExportBundle } from "../../domain/backup";
import { ApiError, type ColdLayerMode, type ImportReceipt, type StateImportResult } from "../../api/productApi";
import type { InterviewStrength, ProductState } from "../../domain/types";
import { updateProfile, addExplicitBoundary, removeExplicitBoundary, approveProfileSuggestion, rejectProfileSuggestion } from "../../domain/profile";

interface ProfileViewProps {
  state: ProductState;
  correctionText: string;
  onCorrectionText: (value: string) => void;
  onAddCorrection: () => void;
  onReset: () => void;
  onExport: () => Promise<StateExportBundle>;
  onImport: (payload: unknown, coldLayerMode?: ColdLayerMode) => Promise<StateImportResult>;
  onPrivacyReport: () => Promise<PrivacyReport>;
  onPurge: () => Promise<ProductState>;
  onSetProductState: (state: ProductState) => void;
  onSaveProfile: (state: ProductState) => Promise<ProductState>;
  /** 跳转记忆治理（审批候选 / 编辑长期记忆）。 */
  onOpenMemory?: () => void;
}

type GovernanceAction = "export" | "import" | "privacy" | "purge";

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// B2#6/C2#2:import/purge 失败时优先透出服务端写的中文 body.error(coldLayerMode 缺失/半截包/
// 非法条目等),而不是只显示 ApiError 的英文状态码 message("Product API request failed: 422 …")。
// import 422 还可能携带 invalidRawMaterials / invalidAudios 逐条清单——摘要展示前 3 条 + 总数,
// 让用户知道具体哪些条目坏了,而不是笼统的"导入失败"。
function describeGovernanceError(err: unknown, fallback: string): string {
  if (err instanceof ApiError && err.body && typeof err.body === "object") {
    const body = err.body as { error?: unknown; detail?: unknown; invalidRawMaterials?: unknown; invalidAudios?: unknown };
    if (typeof body.error === "string" && body.error.length > 0) {
      const details: string[] = [];
      for (const [label, list] of [
        ["逐字稿", body.invalidRawMaterials],
        ["录音", body.invalidAudios]
      ] as const) {
        if (Array.isArray(list) && list.length > 0) {
          const sample = list
            .slice(0, 3)
            .map((item) => {
              const entry = item as { index?: unknown; error?: unknown };
              return `#${typeof entry.index === "number" ? entry.index : "?"} ${typeof entry.error === "string" ? entry.error : "未知错误"}`;
            })
            .join("；");
          details.push(`非法${label}条目：${sample}${list.length > 3 ? `（共 ${list.length} 条）` : ""}`);
        }
      }
      // N-11:治理 500 的原始报文已被服务端门控进 body.detail(仅非生产存在;生产 body 无 detail)。
      // 存在即附上便于本地调试;生产下只显示 generic 中文 body.error(绝不泄漏 SurrealDB 字段值片段)。
      if (typeof body.detail === "string" && body.detail.length > 0) {
        details.push(body.detail);
      }
      return details.length > 0 ? `${body.error} ${details.join("；")}` : body.error;
    }
  }
  return err instanceof Error && err.message ? err.message : fallback;
}

export function ProfileView({
  state,
  correctionText,
  onCorrectionText,
  onAddCorrection,
  onReset,
  onImport,
  onExport,
  onPrivacyReport,
  onPurge,
  onSetProductState,
  onSaveProfile,
  onOpenMemory
}: ProfileViewProps) {
  const [form, setForm] = useState({
    name: state.profile.name,
    role: state.profile.role,
    industry: state.profile.industry,
    currentFocus: state.profile.currentFocus,
    longTermGoal: state.profile.longTermGoal,
    preferredStrength: state.profile.preferredStrength
  });
  const [profileDirty, setProfileDirty] = useState(false);
  const [profileSaved, setProfileSaved] = useState(false);
  const [profileSaving, setProfileSaving] = useState(false);
  const [profileSaveError, setProfileSaveError] = useState<string | null>(null);
  const [boundaryText, setBoundaryText] = useState("");
  const [boundaryNotice, setBoundaryNotice] = useState<string | null>(null);
  const profileDirtyRef = useRef(false);
  profileDirtyRef.current = profileDirty;

  // 远端/他处更新 profile 时：非 dirty 才同步表单，避免冲掉未保存编辑。
  useEffect(() => {
    if (profileDirtyRef.current) return;
    setForm({
      name: state.profile.name,
      role: state.profile.role,
      industry: state.profile.industry,
      currentFocus: state.profile.currentFocus,
      longTermGoal: state.profile.longTermGoal,
      preferredStrength: state.profile.preferredStrength
    });
  }, [
    state.profile.name,
    state.profile.role,
    state.profile.industry,
    state.profile.currentFocus,
    state.profile.longTermGoal,
    state.profile.preferredStrength
  ]);

  function touchForm(next: typeof form) {
    setForm(next);
    setProfileDirty(true);
    setProfileSaved(false);
    setProfileSaveError(null);
  }

  async function handleSaveProfile() {
    if (profileSaving) return;
    setProfileSaving(true);
    setProfileSaved(false);
    setProfileSaveError(null);
    try {
      await onSaveProfile(updateProfile(state, form));
      setProfileSaved(true);
      setProfileDirty(false);
    } catch (error) {
      setProfileSaveError(error instanceof Error && error.message ? error.message : "档案保存失败，请重试。");
    } finally {
      setProfileSaving(false);
    }
  }
  function handleAddBoundary() {
    const text = boundaryText.trim();
    if (!text) {
      return;
    }
    onSetProductState(addExplicitBoundary(state, text));
    setBoundaryText("");
    setBoundaryNotice("边界已写入档案，将随同步进入后续专访指令。");
  }
  function handleRemoveBoundary(boundary: string) {
    onSetProductState(removeExplicitBoundary(state, boundary));
  }
  function handleApproveSuggestion(id: string) {
    onSetProductState(approveProfileSuggestion(state, id));
  }
  function handleRejectSuggestion(id: string) {
    onSetProductState(rejectProfileSuggestion(state, id));
  }
  const FIELD_LABEL: Record<string, string> = { currentFocus: "当前关注", longTermGoal: "长期目标" };
  const pendingSuggestions = state.profileSuggestions.filter((s) => s.status === "pending");

  const [loadingAction, setLoadingAction] = useState<GovernanceAction | null>(null);
  const [exportSuccess, setExportSuccess] = useState(false);
  const [exportBundle, setExportBundle] = useState<StateExportBundle | null>(null);
  const [purgeSuccess, setPurgeSuccess] = useState(false);
  const [privacyReport, setPrivacyReport] = useState<PrivacyReport | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);
  // C2#8:用户主动取消下载不是错误,走中性提示通道,不落危险红的 exportError。
  const [exportNotice, setExportNotice] = useState<string | null>(null);
  const [importSuccess, setImportSuccess] = useState(false);
  const [importReceipt, setImportReceipt] = useState<ImportReceipt | null>(null);
  const [legacyColdLayerMode, setLegacyColdLayerMode] = useState<ColdLayerMode>("preserve-cold");
  const [importError, setImportError] = useState<string | null>(null);
  const [privacyError, setPrivacyError] = useState<string | null>(null);
  const [purgeError, setPurgeError] = useState<string | null>(null);

  async function handleExport() {
    setLoadingAction("export");
    setExportSuccess(false);
    setExportBundle(null);
    setExportError(null);
    setExportNotice(null);
    try {
      const bundle = await onExport();
      setExportBundle(bundle);
      if (!bundle.completeness.complete) {
        const confirmed = window.confirm(
          `${bundle.completeness.status === "not-directly-importable" ? "此备份无法通过当前接口直接导入。" : "此备份不完整。"}\n` +
          `${bundle.completeness.reasons.join("\n")}\n\n仍要下载吗？下载后请勿把它作为清空数据前的唯一恢复保障。`
        );
        if (!confirmed) {
          // C2#8:主动取消是用户决定,不是失败——中性提示(且不带尾随空格)。
          setExportNotice("已取消下载；完整性检查结果保留在下方，请先处理遗漏项。");
          return;
        }
      }
      // 使用紧凑 JSON，确保下载文件字节数与服务端 importCompatibility.bytes 的口径一致；
      // pretty-print 会把大包膨胀到导入上限之外，制造“页面说可导入、实际 413”的新假象。
      const blob = new Blob([JSON.stringify(bundle)], { type: "application/json" });
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

  async function handleImportFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = ""; // allow re-selecting the same file later
    if (!file) return;
    const confirmed = window.confirm("导入将用所选备份覆盖当前全部数据，且无法撤销。确定吗？");
    if (!confirmed) return;
    setLoadingAction("import");
    setImportSuccess(false);
    setImportReceipt(null);
    setImportError(null);
    try {
      const payload = JSON.parse(await file.text());
      const record = payload && typeof payload === "object" ? payload as Record<string, unknown> : null;
      const isFullBundle = Boolean(record && Array.isArray(record.rawMaterials) && Array.isArray(record.audios));
      const result = await onImport(payload, isFullBundle ? undefined : legacyColdLayerMode);
      onSetProductState(result.state);
      setImportReceipt(result.receipt);
      setImportSuccess(true);
    } catch (err) {
      // B2#6/C2#2:优先透出服务端中文 body.error(含非法条目清单摘要),不再只给英文状态码。
      setImportError(describeGovernanceError(err, "导入失败，请确认文件是有效的导出包。"));
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
      // B2#6/C2#2:优先透出服务端中文 body.error;部分失败时 App.purgeData 已采纳热态并抛出
      // 中文说明(哪些库未删除、请重试),这里如实显示,绝不显示"个人数据已彻底清空"。
      setPurgeError(describeGovernanceError(err, "清空失败"));
    } finally {
      setLoadingAction(null);
    }
  }

  return (
    <section className="view-stack">
      <HeaderBlock
        eyebrow="个人档案与控制"
        title={state.profile.role + " · " + state.profile.industry}
        subtitle="长期记忆必须可见、可修正、可删除。AI 推断不能直接等同于事实。" />
      <div className="dashboard-grid">
        <section className="panel">
          <div className="panel-title"><Settings size={18} /><h2>显性档案</h2></div>
          <p className="field-help mb-4">
            当前关注 / 长期目标 / 追问强度会直接影响每次专访的选题与提问方式。
          </p>
          <div className="stack">
            <label className="field-stack">
              <span className="field-label">称呼</span>
              <input value={form.name} maxLength={40} placeholder="你希望被怎么称呼"
                onChange={(e) => touchForm({ ...form, name: e.target.value })} />
            </label>
            <div className="row">
              <label className="field-stack flex-1">
                <span className="field-label">身份</span>
                <input value={form.role} maxLength={40} placeholder="如：产品负责人"
                  onChange={(e) => touchForm({ ...form, role: e.target.value })} />
              </label>
              <label className="field-stack flex-1">
                <span className="field-label">行业</span>
                <input value={form.industry} maxLength={40} placeholder="如：AI 产品 / 创业"
                  onChange={(e) => touchForm({ ...form, industry: e.target.value })} />
              </label>
            </div>
            <label className="field-stack">
              <span className="field-label">当前关注</span>
              <input value={form.currentFocus} maxLength={120} placeholder="这段时间你最想推进/想清楚的事"
                onChange={(e) => touchForm({ ...form, currentFocus: e.target.value })} />
            </label>
            <label className="field-stack">
              <span className="field-label">长期目标</span>
              <input value={form.longTermGoal} maxLength={120} placeholder="你想长期追踪/抵达的方向"
                onChange={(e) => touchForm({ ...form, longTermGoal: e.target.value })} />
            </label>
            <label className="field-stack">
              <span className="field-label">追问强度</span>
              <select value={form.preferredStrength}
                onChange={(e) => touchForm({ ...form, preferredStrength: e.target.value as InterviewStrength })}>
                <option value="gentle">温和（gentle）</option>
                <option value="standard">标准（standard）</option>
                <option value="sharp">犀利（sharp）</option>
              </select>
            </label>
            <div className="row">
              <button className="primary-action" type="button" onClick={handleSaveProfile} disabled={profileSaving || !profileDirty} aria-busy={profileSaving}>
                {profileSaving ? "保存中…" : "保存档案"}
              </button>
              {profileDirty && !profileSaving && <span className="field-status">有未保存更改</span>}
              {profileSaved && !profileDirty && <span className="field-status is-success">已保存</span>}
            </div>
            {profileSaveError && <p className="field-error" role="alert">{profileSaveError}</p>}
          </div>
        </section>
        <section className="panel">
          <div className="panel-title"><ShieldCheck size={18} /><h2>用户边界</h2></div>
          <p className="field-help mb-4">
            这里设定的边界是「绝不触碰」的硬约束，会写进每次专访的提问指令，主持人必须遵守。
          </p>
          <div className={state.profile.explicitBoundaries.length ? "correction-row mb-4" : "correction-row"}>
            <label className="field-stack flex-1">
              <input value={boundaryText} maxLength={120}
                placeholder="例：不要追问家庭关系"
                onChange={(e) => setBoundaryText(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); handleAddBoundary(); } }} />
            </label>
            <button className="secondary-action" type="button" onClick={handleAddBoundary} disabled={!boundaryText.trim()}>添加边界</button>
          </div>
          {boundaryNotice && <p className="field-status is-success">{boundaryNotice}</p>}
          <ul className="clean-list">
            {state.profile.explicitBoundaries.map((boundary, idx) => (
              <li key={"boundary-" + idx} className="row-between">
                <span>{boundary}</span>
                <button className="icon-button" type="button" aria-label={"删除边界：" + boundary}
                  onClick={() => handleRemoveBoundary(boundary)}>
                  <Trash2 size={14} />
                </button>
              </li>
            ))}
            {state.profile.explicitBoundaries.length === 0 && (
              <li className="empty-hint">还没有设定边界。AI 默认不会越界，但你可以在这里明确写下不希望被触碰的话题。</li>
            )}
          </ul>
        </section>
      </div>

      {pendingSuggestions.length > 0 && (
        <section className="panel">
          <div className="panel-title"><PenLine size={18} /><h2>档案更新建议（{pendingSuggestions.length}）</h2></div>
          <p className="field-help mb-4">
            最近的专访显示你的关注/目标可能变了。AI 不会自动改你的档案——确认后才会生效。
          </p>
          <ul className="clean-list">
            {pendingSuggestions.map((s) => (
              <li key={s.id} className="stack-sm list-row">
                <span className="field-label">{FIELD_LABEL[s.field] ?? s.field}</span>
                <div className="text-sm">
                  {s.currentValue
                    ? <><span className="text-secondary line-through text-secondary">{s.currentValue}</span>{" → "}<strong>{s.suggestedValue}</strong></>
                    : <><span className="text-secondary">（原为空）→ </span><strong>{s.suggestedValue}</strong></>}
                </div>
                {s.reason && <span className="field-help">理由：{s.reason}</span>}
                {s.evidenceQuote && <span className="field-help">原话：「{s.evidenceQuote}」</span>}
                <div className="form-actions mt-2">
                  <button className="primary-action" type="button" onClick={() => handleApproveSuggestion(s.id)}>采纳</button>
                  <button className="secondary-action" type="button" onClick={() => handleRejectSuggestion(s.id)}>忽略</button>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="panel">
        <div className="panel-title row-between">
          <div className="row">
            <Brain size={18} />
            <h2>系统记忆</h2>
          </div>
          {onOpenMemory && (
            <button className="secondary-action compact-action" type="button" onClick={onOpenMemory}>
              去记忆治理
            </button>
          )}
        </div>
        <div className="memory-grid">
          <div>
            <span className="label">已确认记忆</span>
            {(() => {
              const confirmed = state.memoryRecords.filter((r) => r.status === "confirmed");
              return confirmed.length > 0
                ? <ul>{confirmed.slice(0, 5).map((r) => <li key={r.id}>{r.text}</li>)}</ul>
                : <p className="empty-hint">暂无已确认记忆。对话结束后 AI 提取的记忆经审批后将显示在此。</p>;
            })()}
          </div>
          <div>
            <span className="label">待审批候选</span>
            {(() => {
              const pending = state.memoryCandidates.filter((c) => c.status === "pending");
              return pending.length > 0
                ? (
                  <>
                    <ul>{pending.slice(0, 5).map((c) => <li key={c.id}>{c.text}</li>)}</ul>
                    {onOpenMemory && (
                      <button className="text-button" type="button" onClick={onOpenMemory}>
                        审批 {pending.length} 条候选
                      </button>
                    )}
                  </>
                )
                : <p className="empty-hint">暂无待审批记忆候选。</p>;
            })()}
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
              maxLength={500}
              onChange={(event) => onCorrectionText(event.target.value)}
              placeholder="例：不要把我对项目的不满写成对团队成员的否定。" />
            <div className="field-row-foot">
              <span className="field-help">这会作为长期边界保留，不会直接覆盖用户确认记忆。</span>
              <span className="char-count">{correctionText.length}/500</span>
            </div>
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
        <p className="field-help mb-4">
          导出个人数据备份、查看隐私库存摘要，或彻底清空个人数据。
        </p>
        <div className="stack">

          {/* Export */}
          <div className="row-wrap">
            <button
              className={"secondary-action" + (loadingAction === "export" ? " btn-loading" : "")}
              type="button"
              disabled={loadingAction !== null}
              onClick={handleExport}>
              {loadingAction === "export" ? <span className="spinner" aria-hidden="true" /> : <Download size={16} />}
              导出数据
            </button>
            {exportSuccess && exportBundle?.completeness.complete && (
              <span className="field-status is-success">已下载完整 JSON 备份包</span>
            )}
            {exportSuccess && exportBundle && !exportBundle.completeness.complete && (
              /* C2#9:琥珀色走设计系统 token(--accent-amber),不再硬编码 #b45309。 */
              <span className="field-status text-warning">已下载，但该备份不是完整恢复保障</span>
            )}
            {exportError && <span className="field-status is-danger">{exportError}</span>}
            {exportNotice && <span className="text-sm text-secondary">{exportNotice}</span>}
            <label
              className={
                "secondary-action" +
                (loadingAction === "import" ? " btn-loading" : "") +
                (loadingAction !== null && loadingAction !== "import" ? " is-busy-pointer" : " pointer")
              }
>
              {loadingAction === "import" ? <span className="spinner" aria-hidden="true" /> : <Upload size={16} />}
              导入数据
              <input type="file" accept="application/json,.json" hidden disabled={loadingAction !== null} onChange={handleImportFile} />
            </label>
            {importSuccess && importReceipt && !importReceipt.partial && (
              <span className="field-status is-success">已完整恢复并核对清单</span>
            )}
            {importSuccess && (!importReceipt || importReceipt.partial) && (
              /* C2#9:同上,琥珀色统一引用 --accent-amber token。 */
              <span className="field-status text-warning">
                {importReceipt ? "已部分恢复，请核对缺失项" : "已恢复，但服务端未返回完整性清单"}
              </span>
            )}
            {importError && <span className="field-status is-danger">{importError}</span>}
          </div>

          <label className="backup-mode-control">
            <span>
              <strong>旧格式备份的冷层处理</strong>
              <small>仅在文件不含 rawMaterials / audios 清单时生效</small>
            </span>
            <select
              value={legacyColdLayerMode}
              disabled={loadingAction !== null}
              onChange={(event) => setLegacyColdLayerMode(event.target.value as ColdLayerMode)}
>
              <option value="preserve-cold">保留现有逐字稿与录音</option>
              <option value="replace-all">同时清空现有逐字稿与录音</option>
            </select>
          </label>

          {exportBundle && (
            <section
              className={`backup-integrity-card ${exportBundle.completeness.status}`}
              aria-live="polite"
              aria-label="导出备份完整性"
>
              <div className="backup-integrity-head">
                <strong>
                  {exportBundle.completeness.status === "complete"
                    ? "完整备份"
                    : exportBundle.completeness.status === "partial"
                      ? "部分备份"
                      : "不可直接导入"}
                </strong>
                <span>{formatBytes(exportBundle.importCompatibility.bytes)}</span>
              </div>
              <div className="backup-integrity-metrics">
                <span>逐字稿 {exportBundle.rawMaterials.length} 份</span>
                <span>录音 {exportBundle.completeness.includedAudioSessions}/{exportBundle.completeness.audioSessions} 个会话</span>
                <span>摘要 {exportBundle.bundleDigest}</span>
              </div>
              {exportBundle.completeness.reasons.length > 0 ? (
                <ul>
                  {exportBundle.completeness.reasons.map((reason) => <li key={reason}>{reason}</li>)}
                </ul>
              ) : (
                <p>热态、逐字稿与已登记录音均已纳入，包体可通过当前导入接口直接恢复。</p>
              )}
            </section>
          )}

          {importSuccess && (
            <section
              className={`backup-integrity-card ${importReceipt?.partial === false ? "complete" : "partial"}`}
              aria-live="polite"
              aria-label="导入恢复清单"
>
              <div className="backup-integrity-head">
                <strong>{importReceipt?.partial === false ? "恢复清单已核对" : "恢复清单需要处理"}</strong>
                <span>{importReceipt ? (importReceipt.partial ? "部分恢复" : "完整恢复") : "完整性未知"}</span>
              </div>
              {importReceipt ? (
                <>
                  <div className="backup-integrity-metrics">
                    <span>逐字稿 {importReceipt.restored.rawMaterials} 份</span>
                    <span>录音 {importReceipt.restored.audios} 段</span>
                    <span>知识索引 {importReceipt.knowledgeIndex}</span>
                  </div>
                  {(importReceipt.missing.audioSessions.length > 0 || importReceipt.skipped.rawMaterials.length > 0 || importReceipt.skipped.audios.length > 0) && (
                    <ul>
                      {importReceipt.missing.audioSessions.length > 0 && (
                        <li>缺少录音会话：{importReceipt.missing.audioSessions.join("、")}</li>
                      )}
                      {importReceipt.skipped.rawMaterials.length > 0 && <li>跳过逐字稿 {importReceipt.skipped.rawMaterials.length} 项</li>}
                      {importReceipt.skipped.audios.length > 0 && <li>跳过录音 {importReceipt.skipped.audios.length} 项</li>}
                    </ul>
                  )}
                </>
              ) : (
                <p>当前服务端没有返回 restored / skipped / missing 清单，请勿据此直接执行永久清空。</p>
              )}
            </section>
          )}

          {/* Privacy Report */}
          <div className="row-wrap">
            <button
              className={"secondary-action" + (loadingAction === "privacy" ? " btn-loading" : "")}
              type="button"
              disabled={loadingAction !== null}
              onClick={handlePrivacyReport}>
              {loadingAction === "privacy" ? <span className="spinner" aria-hidden="true" /> : <ShieldCheck size={16} />}
              隐私报告
            </button>
            {privacyError && <span className="field-status is-danger">{privacyError}</span>}
          </div>

          {privacyReport && (
            <div className="panel mt-2">
              <p className="privacy-meta">
                共 {privacyReport.totalRecords} 条记录 &nbsp;&middot;&nbsp; {privacyReport.generatedAt.slice(0, 10)} 生成
              </p>
              {privacyReport.inventory.length === 0 ? (
                <div className="empty-state"><p>暂无隐私库存数据。</p></div>
              ) : (
                <ul className="clean-list stack-sm">
                  {privacyReport.inventory.map((item) => (
                    <li key={item.id} className="privacy-inventory-row">
                      <span className="text-secondary">{item.label}</span>
                      <span className="tabular-nums">{item.count}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}

          {/* Purge */}
          <div className="row">
            <button
              className={"danger-button" + (loadingAction === "purge" ? " btn-loading" : "")}
              type="button"
              disabled={loadingAction !== null}
              onClick={handlePurge}>
              {loadingAction === "purge" ? <span className="spinner" aria-hidden="true" /> : <Trash2 size={16} />}
              清空个人数据
            </button>
            {purgeSuccess && <span className="field-status is-success">个人数据已彻底清空</span>}
            {purgeError && <span className="field-status is-danger">{purgeError}</span>}
          </div>
          <p className="help-tight">
            将删除专访、笔记、资产、记忆等所有个人数据，且无法撤销。Provider 运行配置保留。
          </p>
        </div>
      </section>

      <section className="danger-zone">
        <div>
          <strong>清空全部数据，从头开始</strong>
          <p>移除当前全部访谈、资产、记忆与逐字稿（包括你自己的真实记录，不只是示例），从空白状态重新开始，且无法撤销。</p>
        </div>
        <button className="danger-button" type="button" onClick={onReset}><Trash2 size={16} />清空全部数据，从头开始</button>
      </section>
    </section>
  );
}
