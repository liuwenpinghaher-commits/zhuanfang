import { useEffect, useRef, useState } from "react";
import {
  Check,
  ExternalLink,
  FileUp,
  GitMerge,
  Inbox,
  Lock,
  Pencil,
  ShieldAlert,
  Sparkles,
  Trash2,
  X
} from "lucide-react";
import { HeaderBlock } from "../../components/HeaderBlock";
import { RawMaterialViewer } from "../notes/RawMaterialViewer";
import { findConflictPairRecords } from "../../domain/memory-consolidation";
import type { InterviewRawMaterial, MemoryCandidate, ProductState } from "../../domain/types";
import type { SessionAudioMeta } from "../../api/productApi";

interface MemoryGovernanceViewProps {
  state: ProductState;
  importing: boolean;
  /** 从素材库跳入时，优先展示该 import source 的待审候选。 */
  focusSourceId?: string | null;
  /** 从资产对话 citation 跳入时高亮已确认记忆。 */
  focusRecordId?: string | null;
  onImport: (title: string, content: string) => void;
  onApprove: (candidateId: string, mode?: "merge" | "add") => void;
  onReject: (candidateId: string) => void;
  /**
   * B5: 矛盾候选裁决。keepSide a|b 由服务端/域 findConflictPairRecords 解析为 keep/demote。
   * 也可传显式 record id 对。
   */
  onResolveConflict?: (
    candidateId: string,
    body: { keepSide: "a" | "b" } | { keepRecordId: string; demoteRecordId: string }
  ) => void | Promise<void>;
  onEditCandidate: (candidateId: string, text: string) => void;
  onDeprecate: (recordId: string) => void;
  onDeleteRecord: (recordId: string) => void;
  onEditRecord: (recordId: string, text: string) => void;
  onConsolidate: () => void | Promise<void>;
  onAddAnnotation: (sessionId: string, turnId: string, text: string) => void;
  onRemoveAnnotation: (id: string) => void;
  getRawMaterial: (sessionId: string) => Promise<InterviewRawMaterial | null>;
  getAudioMeta?: (sessionId: string, role?: "interviewee" | "interviewer") => Promise<SessionAudioMeta>;
  audioUrl?: (sessionId: string) => string;
  getAudioBlob?: (sessionId: string, role?: "interviewee" | "interviewer") => Promise<Blob | null>;
}

type ActionState = "idle" | "loading" | "done" | "error";

interface CandidateOp {
  approve: ActionState;
  reject: ActionState;
  save: ActionState;
  resolve: ActionState;
}

/** B5: 待裁决矛盾候选（suggestedUpdate=conflict 或文案前缀）。 */
function isConflictCandidate(candidate: MemoryCandidate): boolean {
  return candidate.suggestedUpdate === "conflict" || candidate.text.startsWith("【待裁决矛盾】");
}

function conflictSideLabels(candidate: MemoryCandidate): { a: string; b: string } {
  const body = candidate.text.replace(/^【待裁决矛盾】/, "");
  const parts = body.split(/｜|\|/);
  const a = (parts[0] ?? "").replace(/^A：/, "").trim();
  const b = (parts[1] ?? "").replace(/^B：/, "").trim();
  return {
    a: a.length > 48 ? a.slice(0, 48) + "…" : a || "侧 A",
    b: b.length > 48 ? b.slice(0, 48) + "…" : b || "侧 B"
  };
}

const MAX_IMPORT_CHARS = 20000;
const MEMORY_TEXT_MAX_CHARS = 16 * 1024;

function SensitiveIcon() {
  return (
    <ShieldAlert
      size={16}
      aria-label="敏感内容，默认不写入上下文"
      className="icon-sensitive"
    />
  );
}

export function MemoryGovernanceView({
  state,
  importing,
  focusSourceId = null,
  focusRecordId = null,
  onImport,
  onApprove,
  onReject,
  onResolveConflict,
  onEditCandidate,
  onDeprecate,
  onDeleteRecord,
  onEditRecord,
  onConsolidate,
  onAddAnnotation,
  onRemoveAnnotation,
  getRawMaterial,
  getAudioMeta,
  audioUrl,
  getAudioBlob
}: MemoryGovernanceViewProps) {
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [contentError, setContentError] = useState("");
  const [consolidating, setConsolidating] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draftText, setDraftText] = useState("");
  const [editingRecordId, setEditingRecordId] = useState<string | null>(null);
  const [draftRecordText, setDraftRecordText] = useState("");
  const [savedId, setSavedId] = useState<string | null>(null);
  const [candidateOps, setCandidateOps] = useState<Record<string, CandidateOp>>({});
  const [sourceOverlay, setSourceOverlay] = useState<{ sessionId: string; turnId: string } | null>(null);
  const [importExpanded, setImportExpanded] = useState(true);

  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const recordTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  const importSectionRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (editingId && textareaRef.current) {
      textareaRef.current.focus();
      const len = textareaRef.current.value.length;
      textareaRef.current.setSelectionRange(len, len);
    }
  }, [editingId]);

  useEffect(() => {
    if (editingRecordId && recordTextareaRef.current) {
      recordTextareaRef.current.focus();
      const len = recordTextareaRef.current.value.length;
      recordTextareaRef.current.setSelectionRange(len, len);
    }
  }, [editingRecordId]);

  useEffect(() => {
    if (!savedId) return;
    const t = setTimeout(() => setSavedId(null), 1500);
    return () => clearTimeout(t);
  }, [savedId]);

  useEffect(() => {
    if (!focusRecordId) return;
    requestAnimationFrame(() => {
      document
        .querySelector(`[data-memory-record="${focusRecordId}"]`)
        ?.scrollIntoView({ behavior: "smooth", block: "center" });
    });
  }, [focusRecordId]);

  const allPending = state.memoryCandidates.filter((c) => c.status === "pending");
  const focusedPending =
    focusSourceId
      ? allPending.filter((c) => c.sourceType === "import_source" && c.sourceId === focusSourceId)
      : [];
  // 有焦点源且命中候选时置顶展示；否则展示全部待审。
  const pending = focusedPending.length > 0 ? focusedPending : allPending;
  const focusFilterActive = Boolean(focusSourceId && focusedPending.length > 0);
  const confirmed = state.memoryRecords.filter((r) => r.status === "confirmed");
  const sensitiveCount =
    pending.filter((c) => c.sensitivity === "sensitive").length +
    confirmed.filter((r) => r.sensitivity === "sensitive").length;
  const bothEmpty = pending.length === 0 && confirmed.length === 0;
  const canImport = Boolean(content.trim()) && content.length <= MAX_IMPORT_CHARS && !importing;

  const recordTextById = new Map(confirmed.map((r) => [r.id, r.text] as const));
  function dedupHint(candidate: (typeof pending)[number]): string | null {
    if (candidate.suggestedUpdate !== "update" || !candidate.similarToRecordId) return null;
    const text = recordTextById.get(candidate.similarToRecordId);
    if (!text) return null;
    return text.length > 40 ? text.slice(0, 40) + "…" : text;
  }

  const defaultCandidateOp = (): CandidateOp => ({
    approve: "idle",
    reject: "idle",
    save: "idle",
    resolve: "idle"
  });

  function getOp(id: string): CandidateOp {
    return candidateOps[id] ?? defaultCandidateOp();
  }

  function setOp(id: string, patch: Partial<CandidateOp>) {
    // 基于 prev[id] 合并，避免快速连续 set 时 getOp 闭包丢中间字段（Issue 8）。
    setCandidateOps((prev) => ({
      ...prev,
      [id]: { ...defaultCandidateOp(), ...prev[id], ...patch }
    }));
  }

  function focusImport() {
    setImportExpanded(true);
    requestAnimationFrame(() => {
      importSectionRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
      const el = document.getElementById("memory-import-content") as HTMLTextAreaElement | null;
      el?.focus();
    });
  }

  function handleImport() {
    if (!content.trim()) return;
    if (content.length > MAX_IMPORT_CHARS) {
      setContentError(`内容超过 ${MAX_IMPORT_CHARS.toLocaleString()} 字，请裁减后再导入。`);
      return;
    }
    setContentError("");
    onImport(title.trim() || "未命名导入资料", content.trim());
    setTitle("");
    setContent("");
  }

  function handleContentChange(value: string) {
    setContent(value);
    if (value.length > MAX_IMPORT_CHARS) {
      setContentError(`内容超过 ${MAX_IMPORT_CHARS.toLocaleString()} 字，请裁减后再导入。`);
    } else {
      setContentError("");
    }
  }

  function startEdit(candidateId: string, currentText: string) {
    setEditingId(candidateId);
    setDraftText(currentText);
  }

  function cancelEdit() {
    setEditingId(null);
    setDraftText("");
  }

  async function handleSave(candidateId: string, originalText: string) {
    const next = draftText.trim();
    if (!next || next === originalText) {
      cancelEdit();
      return;
    }
    setOp(candidateId, { save: "loading" });
    try {
      await Promise.resolve(onEditCandidate(candidateId, next));
      setOp(candidateId, { save: "done" });
      setSavedId(candidateId);
    } catch {
      setOp(candidateId, { save: "error" });
    } finally {
      setEditingId(null);
      setDraftText("");
    }
  }

  function startEditRecord(recordId: string, currentText: string) {
    setEditingRecordId(recordId);
    setDraftRecordText(currentText);
  }

  function cancelEditRecord() {
    setEditingRecordId(null);
    setDraftRecordText("");
  }

  async function handleSaveRecord(recordId: string, originalText: string) {
    const next = draftRecordText.trim();
    if (!next || next === originalText) {
      cancelEditRecord();
      return;
    }
    try {
      await Promise.resolve(onEditRecord(recordId, next));
    } finally {
      setEditingRecordId(null);
      setDraftRecordText("");
    }
  }

  async function handleApprove(candidateId: string, mode: "merge" | "add" = "merge") {
    setOp(candidateId, { approve: "loading" });
    try {
      await Promise.resolve(onApprove(candidateId, mode));
      setOp(candidateId, { approve: "done" });
    } catch {
      setOp(candidateId, { approve: "error" });
    }
  }

  async function handleReject(candidateId: string) {
    setOp(candidateId, { reject: "loading" });
    try {
      await Promise.resolve(onReject(candidateId));
      setOp(candidateId, { reject: "done" });
    } catch {
      setOp(candidateId, { reject: "error" });
    }
  }

  async function handleResolveConflict(candidateId: string, keepSide: "a" | "b") {
    if (!onResolveConflict) return;
    setOp(candidateId, { resolve: "loading" });
    try {
      await Promise.resolve(onResolveConflict(candidateId, { keepSide }));
      setOp(candidateId, { resolve: "done" });
    } catch {
      setOp(candidateId, { resolve: "error" });
    }
  }

  const consolidateButton =
    confirmed.length >= 2 ? (
      <button
        type="button"
        className={consolidating ? "secondary-action btn-loading" : "secondary-action"}
        disabled={consolidating}
        title="合并近重复的记忆，保留更重要的一条"
        onClick={async () => {
          setConsolidating(true);
          try {
            await onConsolidate();
          } finally {
            setConsolidating(false);
          }
        }}
      >
        {consolidating ? <span className="spinner" aria-hidden="true" /> : <GitMerge size={16} aria-hidden="true" />}
        {consolidating ? "整理中…" : "整理记忆"}
      </button>
    ) : null;

  return (
    <section className="view-stack memory-view">
      <HeaderBlock
        eyebrow="记忆治理"
        title="导入资料，审核长期记忆"
        subtitle={
          focusFilterActive
            ? `正在查看素材导入的 ${pending.length} 条待审候选；确认后才进入长期记忆。`
            : "导入或专访后产生候选；你确认后才进入长期记忆。敏感内容默认不写入上下文。"
        }
      />

      <div className="config-hint memory-stats" aria-label="记忆库存">
        <span className={pending.length > 0 ? "is-emphasis" : undefined}>待审 {pending.length}</span>
        <span>已确认 {confirmed.length}</span>
        {sensitiveCount > 0 && <span className="is-warning">敏感 {sensitiveCount}</span>}
      </div>

      <section
        ref={importSectionRef}
        className={`panel memory-import${importExpanded ? " is-open" : ""}`}
      >
        <div className="panel-title row-between">
          <div className="row">
            <FileUp size={18} aria-hidden="true" />
            <h2>导入资料</h2>
          </div>
          <button
            type="button"
            className="text-button"
            onClick={() => setImportExpanded((v) => !v)}
            aria-expanded={importExpanded}
          >
            {importExpanded ? "收起" : "展开"}
          </button>
        </div>

        {importExpanded && (
          <div className="memory-import-body">
            <p className="field-help mb-3">
              粘贴笔记、访谈稿或上传 .txt/.md。系统会抽取候选记忆，供你逐条审核。
            </p>
            <div className="memory-import-grid">
              <label className="field-stack" htmlFor="memory-import-title">
                <span className="field-label">资料标题</span>
                <input
                  id="memory-import-title"
                  type="text"
                  value={title}
                  placeholder="例如：我的产品笔记 / 一篇访谈稿"
                  onChange={(e) => setTitle(e.target.value)}
                />
              </label>
              <label className="field-stack span-all" htmlFor="memory-import-content">
                <span className="field-label">资料内容</span>
                <textarea
                  id="memory-import-content"
                  rows={7}
                  value={content}
                  placeholder="把要导入的资料粘贴到这里…"
                  onChange={(e) => handleContentChange(e.target.value)}
                  aria-describedby={contentError ? "import-content-error" : undefined}
                />
                <div className="row-between">
                  <span className="field-help">支持粘贴文本，或读取 .txt / .md 文件</span>
                  {content.length > 0 && (
                    <span className={`char-count${content.length > MAX_IMPORT_CHARS ? " is-danger" : ""}`}>
                      {content.length.toLocaleString()} / {MAX_IMPORT_CHARS.toLocaleString()} 字
                    </span>
                  )}
                </div>
                {contentError && (
                  <p id="import-content-error" className="form-error field-error">
                    {contentError}
                  </p>
                )}
              </label>
            </div>
            <div className="form-actions">
              <label className="secondary-action file-button">
                <FileUp size={16} />
                选择 .txt/.md 文件
                <input
                  type="file"
                  accept=".txt,.md,.markdown,text/plain"
                  className="sr-only"
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (!file) return;
                    if (!title.trim()) setTitle(file.name.replace(/\.[^.]+$/, ""));
                    file.text().then((text) => handleContentChange(text));
                  }}
                />
              </label>
              <button
                className={`primary-action${importing ? " btn-loading" : ""}`}
                type="button"
                disabled={!canImport}
                onClick={handleImport}
                aria-busy={importing}
              >
                {importing && <span className="spinner" aria-hidden="true" />}
                <Sparkles size={16} />
                {importing ? "抽取中…" : "导入并抽取候选记忆"}
              </button>
            </div>
          </div>
        )}
      </section>

      {bothEmpty ? (
        <section className="panel empty-state memory-empty">
          <div className="memory-empty-icon" aria-hidden="true">
            <Inbox size={28} />
          </div>
          <h3 className="memory-empty-title">还没有记忆可治理</h3>
          <p>暂无待审候选。导入资料或完成一次专访后会产生候选记忆。</p>
          <p>还没有确认的长期记忆。审批候选记忆后，它们会出现在这里。</p>
          <div className="empty-cta">
            <button type="button" className="primary-action" onClick={focusImport}>
              <FileUp size={16} />
              去导入资料
            </button>
          </div>
          <p className="field-help">也可以先去做一场实时专访，结束后回来审核候选。</p>
        </section>
      ) : (
        <>
          <section className="memory-section">
            <div className="memory-section-head">
              <div>
                <h2>待审候选记忆（{pending.length}）</h2>
                <p className="field-help">优先处理这里。确认后进入长期记忆；不要记则丢弃。</p>
              </div>
              {pending.length > 0 && (
                <span className="status-pill is-tracked">需处理 {pending.length}</span>
              )}
            </div>

            {pending.length === 0 ? (
              <div className="panel empty-state memory-empty is-compact">
                <span className="empty-icon" aria-hidden="true">
                  <Inbox size={28} />
                </span>
                <p>暂无待审候选。导入资料或完成一次专访后会产生候选记忆。</p>
              </div>
            ) : (
              <div className="memory-card-list">
                {pending.map((candidate) => {
                  const op = getOp(candidate.id);
                  const isEditing = editingId === candidate.id;
                  const isApproving = op.approve === "loading";
                  const isRejecting = op.reject === "loading";
                  const isSaving = op.save === "loading";
                  const isResolving = op.resolve === "loading";
                  const anyLoading = isApproving || isRejecting || isSaving || isResolving;
                  const justSaved = savedId === candidate.id;
                  const hint = dedupHint(candidate);
                  const isConflict = isConflictCandidate(candidate);
                  const pair = isConflict ? findConflictPairRecords(state, candidate) : {};
                  const canResolve =
                    Boolean(onResolveConflict) && Boolean(pair.aId && pair.bId && pair.aId !== pair.bId);
                  const sideLabels = isConflict ? conflictSideLabels(candidate) : null;

                  return (
                    <article
                      className={`memory-card record-row${isEditing ? " edit-active" : ""}${isConflict ? " is-conflict" : ""}`}
                      key={candidate.id}
                    >
                      <div className="record-main memory-card-main">
                        <div className="memory-card-meta">
                          <span className="status-pill">评分 {candidate.reviewScore}</span>
                          {isConflict && (
                            <span className="status-pill is-warning" title="需人工裁决保留哪一侧">
                              <ShieldAlert size={14} aria-hidden="true" />
                              待裁决矛盾
                            </span>
                          )}
                          {candidate.sensitivity === "sensitive" ? (
                            <span className="status-pill is-stale">
                              <SensitiveIcon />
                              敏感 · 默认不入上下文
                            </span>
                          ) : (
                            <span className="status-pill">普通</span>
                          )}
                          <span className="status-pill">来源 {candidate.sourceType}</span>
                          {justSaved && <span className="label hint-saved">已保存</span>}
                        </div>
                        <p className="memory-card-text">{candidate.text}</p>
                        {candidate.evidenceQuote && (
                          <div className="quote-line">&quot;{candidate.evidenceQuote}&quot;</div>
                        )}
                        {candidate.reviewSignals?.length > 0 && (
                          <span className="label">{candidate.reviewSignals.join(" · ")}</span>
                        )}
                        {isConflict && (
                          <div className="dedup-hint" role="note">
                            <ShieldAlert size={14} aria-hidden="true" className="icon-inline" />
                            <span>
                              {canResolve
                                ? "请选择保留哪一侧（另一侧降级、不删除）。直接「确认」会被拦截——请用下方裁决按钮；也可修正文案后重新裁决。"
                                : "无法解析矛盾两侧已确认记忆，裁决按钮不可用。请刷新后重试，或点「不要记」丢弃本候选；也可修正文案。"}
                            </span>
                          </div>
                        )}
                        {hint && !isConflict && (
                          <div className="dedup-hint">
                            <GitMerge size={14} aria-hidden="true" className="icon-inline" />
                            <span>
                              似已有记忆：<em>{hint}</em> —— 可合并或仍新增。
                            </span>
                          </div>
                        )}

                        {isEditing && (
                          <div className="stack-sm mt-3 memory-edit-box">
                            <label className="field-label" htmlFor={`edit-candidate-${candidate.id}`}>
                              修正内容（{draftText.length} / {MEMORY_TEXT_MAX_CHARS} 字）
                            </label>
                            <textarea
                              id={`edit-candidate-${candidate.id}`}
                              ref={textareaRef}
                              rows={4}
                              maxLength={MEMORY_TEXT_MAX_CHARS}
                              value={draftText}
                              onChange={(e) => setDraftText(e.target.value)}
                              aria-label="修正候选记忆内容"
                            />
                            <div className="note-actions">
                              <button
                                className={`primary-action${isSaving ? " btn-loading" : ""}`}
                                type="button"
                                disabled={isSaving || !draftText.trim()}
                                onClick={() => handleSave(candidate.id, candidate.text)}
                                aria-busy={isSaving}
                              >
                                {isSaving && <span className="spinner" aria-hidden="true" />}
                                <Check size={16} />
                                保存修正
                              </button>
                              <button
                                className="secondary-action"
                                type="button"
                                disabled={isSaving}
                                onClick={cancelEdit}
                              >
                                <X size={16} />
                                取消
                              </button>
                            </div>
                          </div>
                        )}
                      </div>

                      {!isEditing && (
                        <div className="note-actions memory-card-actions">
                          {isConflict ? (
                            <>
                              <button
                                className={`primary-action${isResolving ? " btn-loading" : ""}`}
                                type="button"
                                disabled={anyLoading || !canResolve}
                                onClick={() => handleResolveConflict(candidate.id, "a")}
                                aria-busy={isResolving}
                                title={canResolve ? `保留 A：${sideLabels?.a ?? ""}` : "无法解析矛盾两侧记录，请刷新或丢弃"}
                              >
                                {isResolving && <span className="spinner" aria-hidden="true" />}
                                <Check size={16} />
                                保留 A
                              </button>
                              <button
                                className="secondary-action"
                                type="button"
                                disabled={anyLoading || !canResolve}
                                onClick={() => handleResolveConflict(candidate.id, "b")}
                                title={canResolve ? `保留 B：${sideLabels?.b ?? ""}` : "无法解析矛盾两侧记录，请刷新或丢弃"}
                              >
                                <GitMerge size={16} />
                                保留 B
                              </button>
                            </>
                          ) : (
                            <>
                              <button
                                className={`primary-action${isApproving ? " btn-loading" : ""}`}
                                type="button"
                                disabled={anyLoading}
                                onClick={() => handleApprove(candidate.id, hint ? "merge" : "add")}
                                aria-busy={isApproving}
                                title={hint ? "合并到近重复的既有记忆（保留本条文案）" : "新增一条已确认记忆"}
                              >
                                {isApproving && <span className="spinner" aria-hidden="true" />}
                                <Check size={16} />
                                {hint ? "合并记住" : "确认记住"}
                              </button>
                              {hint && (
                                <button
                                  className="secondary-action"
                                  type="button"
                                  disabled={anyLoading}
                                  onClick={() => handleApprove(candidate.id, "add")}
                                  title="不合并，作为新的独立记忆写入"
                                >
                                  <GitMerge size={16} />
                                  仍新增
                                </button>
                              )}
                            </>
                          )}
                          <button
                            className="secondary-action"
                            type="button"
                            disabled={anyLoading}
                            onClick={() => startEdit(candidate.id, candidate.text)}
                            title={isConflict ? "改写后可能清除矛盾标记，再裁决或确认" : undefined}
                          >
                            <Pencil size={16} />
                            修正
                          </button>
                          <button
                            className={`secondary-action${isRejecting ? " btn-loading" : ""}`}
                            type="button"
                            disabled={anyLoading}
                            onClick={() => handleReject(candidate.id)}
                            aria-busy={isRejecting}
                          >
                            {isRejecting && <span className="spinner" aria-hidden="true" />}
                            <X size={16} />
                            不要记
                          </button>
                        </div>
                      )}
                    </article>
                  );
                })}
              </div>
            )}
          </section>

          <section className="memory-section">
            <div className="memory-section-head">
              <div>
                <h2>已确认的长期记忆（{confirmed.length}）</h2>
                <p className="field-help">写入后可被专访召回。可编辑、撤销引用或删除。</p>
              </div>
              {consolidateButton}
            </div>

            {confirmed.length === 0 ? (
              <div className="panel empty-state memory-empty is-compact">
                <span className="empty-icon" aria-hidden="true">
                  <Lock size={28} />
                </span>
                <p>还没有确认的长期记忆。审批候选记忆后，它们会出现在这里。</p>
              </div>
            ) : (
              <div className="memory-card-list">
                {confirmed.map((record) => {
                  const isEditingRecord = editingRecordId === record.id;
                  const isFocus = focusRecordId === record.id;
                  return (
                    <article
                      className={`memory-card record-row${isEditingRecord ? " edit-active" : ""}${isFocus ? " is-highlight" : ""}`}
                      key={record.id}
                      data-memory-record={record.id}
                    >
                      <div className="record-main memory-card-main">
                        <div className="memory-card-meta">
                          {record.sensitivity === "sensitive" && (
                            <span className="status-pill is-stale">
                              <SensitiveIcon />
                              敏感
                            </span>
                          )}
                          <span className="status-pill">来源 {record.sourceType}</span>
                        </div>
                        <p className="memory-card-text">{record.text}</p>
                        {record.evidenceQuote && (
                          <div className="quote-line">&quot;{record.evidenceQuote}&quot;</div>
                        )}

                        {isEditingRecord && (
                          <div className="stack-sm mt-3 memory-edit-box">
                            <label className="field-label" htmlFor={`edit-record-${record.id}`}>
                              修正内容（{draftRecordText.length} / {MEMORY_TEXT_MAX_CHARS} 字）
                            </label>
                            <textarea
                              id={`edit-record-${record.id}`}
                              ref={recordTextareaRef}
                              rows={4}
                              maxLength={MEMORY_TEXT_MAX_CHARS}
                              value={draftRecordText}
                              onChange={(e) => setDraftRecordText(e.target.value)}
                              aria-label="修正长期记忆内容"
                            />
                            <div className="note-actions">
                              <button
                                className="primary-action"
                                type="button"
                                disabled={!draftRecordText.trim()}
                                onClick={() => handleSaveRecord(record.id, record.text)}
                              >
                                <Check size={16} />
                                保存修正
                              </button>
                              <button className="secondary-action" type="button" onClick={cancelEditRecord}>
                                <X size={16} />
                                取消
                              </button>
                            </div>
                          </div>
                        )}
                      </div>
                      {!isEditingRecord && (
                        <div className="note-actions memory-card-actions">
                          {record.evidenceAnchors && record.evidenceAnchors.length > 0 && (
                            <button
                              className="secondary-action"
                              type="button"
                              title="打开这条记忆所依据的原始对话"
                              onClick={() => {
                                const anchor = record.evidenceAnchors![0];
                                setSourceOverlay({ sessionId: anchor.sessionId, turnId: anchor.turnId });
                              }}
                            >
                              <ExternalLink size={16} />
                              查看原文出处
                            </button>
                          )}
                          <button
                            className="secondary-action"
                            type="button"
                            onClick={() => startEditRecord(record.id, record.text)}
                          >
                            <Pencil size={16} />
                            编辑
                          </button>
                          <button className="secondary-action" type="button" onClick={() => onDeprecate(record.id)}>
                            撤销（停止引用）
                          </button>
                          <button className="secondary-action" type="button" onClick={() => onDeleteRecord(record.id)}>
                            <Trash2 size={16} />
                            删除
                          </button>
                        </div>
                      )}
                    </article>
                  );
                })}
              </div>
            )}
          </section>
        </>
      )}

      {sourceOverlay && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="原文出处"
          className="modal-overlay"
          onClick={() => setSourceOverlay(null)}
        >
          <div className="modal-panel" onClick={(e) => e.stopPropagation()}>
            <div className="row-between">
              <h2 className="panel-subhead">原文出处</h2>
              <button
                className="icon-button"
                type="button"
                aria-label="关闭原文出处"
                onClick={() => setSourceOverlay(null)}
              >
                <X size={18} />
              </button>
            </div>
            <RawMaterialViewer
              sessionId={sourceOverlay.sessionId}
              focusTurnId={sourceOverlay.turnId}
              state={state}
              onAddAnnotation={onAddAnnotation}
              onRemoveAnnotation={onRemoveAnnotation}
              getRawMaterial={getRawMaterial}
              getAudioMeta={getAudioMeta}
              audioUrl={audioUrl}
              getAudioBlob={getAudioBlob}
            />
          </div>
        </div>
      )}
    </section>
  );
}
