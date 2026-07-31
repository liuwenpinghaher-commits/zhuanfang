import { useEffect, useRef, useState } from "react";
import { Check, ExternalLink, FileUp, GitMerge, Inbox, Lock, Pencil, ShieldAlert, Trash2, X } from "lucide-react";
import { HeaderBlock } from "../../components/HeaderBlock";
import { RawMaterialViewer } from "../notes/RawMaterialViewer";
import type { InterviewRawMaterial, ProductState } from "../../domain/types";
import type { SessionAudioMeta } from "../../api/productApi";

interface MemoryGovernanceViewProps {
  state: ProductState;
  importing: boolean;
  onImport: (title: string, content: string) => void;
onApprove: (candidateId: string, mode?: "merge" | "add") => void;
  onReject: (candidateId: string) => void;
  onEditCandidate: (candidateId: string, text: string) => void;
  onDeprecate: (recordId: string) => void;
  onDeleteRecord: (recordId: string) => void;
  onEditRecord: (recordId: string, text: string) => void;
  onConsolidate: () => void | Promise<void>;
  // 透传给 RawMaterialViewer 的原文出处能力（Task 12 跳转）。
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
}

const MAX_IMPORT_CHARS = 20000;
// 回归审查 R7-F2:对齐后端 memory-records MEMORY_TEXT_MAX_CHARS(16KB)。前端 textarea 硬限 maxLength +
// 字数提示,避免用户写超长文本、提交后才被后端 422 拒(白写一大段)。
const MEMORY_TEXT_MAX_CHARS = 16 * 1024;

function SensitiveIcon() {
  return (
    <ShieldAlert
      size={16}
      aria-label="敏感内容，默认不写入上下文"
      style={{ display: "inline", verticalAlign: "text-bottom", marginRight: 3 }} />
  );
}

export function MemoryGovernanceView({
  state,
  importing,
  onImport,
  onApprove,
  onReject,
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

  // per-candidate inline edit: id -> draft text (null = not editing)
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draftText, setDraftText] = useState("");

  // per-record inline edit (confirmed long-term memory): id -> draft text (null = not editing)
  const [editingRecordId, setEditingRecordId] = useState<string | null>(null);
  const [draftRecordText, setDraftRecordText] = useState("");

  // brief "已保存" feedback after save
  const [savedId, setSavedId] = useState<string | null>(null);

  // per-candidate action states
  const [candidateOps, setCandidateOps] = useState<Record<string, CandidateOp>>({});

  // Task 12: "查看原文出处" overlay — 渲染 RawMaterialViewer 并定位到锚点轮。
  const [sourceOverlay, setSourceOverlay] = useState<{ sessionId: string; turnId: string } | null>(null);

  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const recordTextareaRef = useRef<HTMLTextAreaElement | null>(null);

  // Auto-focus textarea when entering edit mode
  useEffect(() => {
    if (editingId && textareaRef.current) {
      textareaRef.current.focus();
      // place cursor at end
      const len = textareaRef.current.value.length;
      textareaRef.current.setSelectionRange(len, len);
    }
  }, [editingId]);

  // Auto-focus record textarea when entering record edit mode
  useEffect(() => {
    if (editingRecordId && recordTextareaRef.current) {
      recordTextareaRef.current.focus();
      const len = recordTextareaRef.current.value.length;
      recordTextareaRef.current.setSelectionRange(len, len);
    }
  }, [editingRecordId]);

  // Auto-clear "已保存" feedback after 1.5s
  useEffect(() => {
    if (!savedId) return;
    const t = setTimeout(() => setSavedId(null), 1500);
    return () => clearTimeout(t);
  }, [savedId]);

  const pending = state.memoryCandidates.filter((c) => c.status === "pending");
  const confirmed = state.memoryRecords.filter((r) => r.status === "confirmed");

  // M2 (Task 6): resolve a candidate's dedup hint to the confirmed record it
  // resembles, so the reviewer can decide to merge or still add it as new.
  const recordTextById = new Map(confirmed.map((r) => [r.id, r.text] as const));
  function dedupHint(candidate: (typeof pending)[number]): string | null {
    if (candidate.suggestedUpdate !== "update" || !candidate.similarToRecordId) return null;
    const text = recordTextById.get(candidate.similarToRecordId);
    if (!text) return null;
    return text.length > 40 ? text.slice(0, 40) + "…" : text;
  }

  function getOp(id: string): CandidateOp {
    return candidateOps[id] ?? { approve: "idle", reject: "idle", save: "idle" };
  }

  function setOp(id: string, patch: Partial<CandidateOp>) {
    setCandidateOps((prev) => ({
      ...prev,
      [id]: { ...getOp(id), ...patch }
    }));
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
      // Always close edit mode regardless of outcome
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
    // 回归审查 R7-F3:await 保存并吞掉 rejection(onEditRecord 在 App 层已 surface 成败 notice),
    // 避免未处理的 promise rejection;无论成败都关闭编辑态(对齐 handleSave 的 try/finally)。
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

  return (
    <section className="view-stack">
      <HeaderBlock
        eyebrow="记忆治理"
        title="导入资料，审核长期记忆"
        subtitle="导入的资料会抽取成候选记忆；只有你确认后才进入长期记忆。敏感内容默认不写入上下文。" />

      {/* Import card — 单列 form-card，修复 record-row 双列重叠问题 */}
      <div className="form-card">
        <div className="form-row">
          <label className="field-label" htmlFor="memory-import-title">资料标题</label>
          <input
            id="memory-import-title"
            type="text"
            value={title}
            placeholder="例如：我的产品笔记 / 一篇访谈稿"
            onChange={(e) => setTitle(e.target.value)} />
        </div>
        <div className="form-row">
          <label className="field-label" htmlFor="memory-import-content">
            资料内容（粘贴文本，或读取 .txt/.md 文件）
          </label>
          <textarea
            id="memory-import-content"
            rows={6}
            value={content}
            placeholder="把要导入的资料粘贴到这里…"
            onChange={(e) => handleContentChange(e.target.value)}
            aria-describedby={contentError ? "import-content-error" : undefined} />
          {content.length > 0 && (
            <span className="char-count">{content.length.toLocaleString()} / {MAX_IMPORT_CHARS.toLocaleString()} 字</span>
          )}
          {contentError && (
            <p id="import-content-error" className="form-error">
              {contentError}
            </p>
          )}
        </div>
        <div className="form-actions">
          <label className="secondary-action file-button">
            <FileUp size={16} />选择 .txt/.md 文件
            <input
              type="file"
              accept=".txt,.md,.markdown,text/plain"
              className="sr-only"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (!file) return;
                if (!title.trim()) setTitle(file.name.replace(/\.[^.]+$/, ""));
                file.text().then((text) => handleContentChange(text));
              }} />
          </label>
          <button
            className={`primary-action${importing ? " btn-loading" : ""}`}
            type="button"
            disabled={importing || !content.trim() || content.length > MAX_IMPORT_CHARS}
            onClick={handleImport}
            aria-busy={importing}
>
            {importing && <span className="spinner" aria-hidden="true" />}
            <FileUp size={16} />
            {importing ? "抽取中…" : "导入并抽取候选记忆"}
          </button>
        </div>
      </div>

      {/* Pending candidates */}
      <div className="record-list">
        <h2>待审候选记忆（{pending.length}）</h2>
        {pending.length === 0 ? (
          <div className="empty-state">
            <span className="empty-icon"><Inbox size={32} /></span>
            <p>暂无待审候选。导入资料或完成一次专访后会产生候选记忆。</p>
          </div>
        ) : (
          pending.map((candidate) => {
            const op = getOp(candidate.id);
            const isEditing = editingId === candidate.id;
            const isApproving = op.approve === "loading";
            const isRejecting = op.reject === "loading";
            const isSaving = op.save === "loading";
            const anyLoading = isApproving || isRejecting || isSaving;
            const justSaved = savedId === candidate.id;
            const hint = dedupHint(candidate);

            return (
              <article
                className={`record-row${isEditing ? " edit-active" : ""}`}
                key={candidate.id}
>
                <div className="record-main">
                  <span className="label">
                    评分 {candidate.reviewScore} &middot;{" "}
                    {candidate.sensitivity === "sensitive" ? (
                      <>
                        <SensitiveIcon />
                        敏感（默认不入上下文）
                      </>
                    ) : (
                      "普通"
                    )}
                    {" "}&middot; 来源 {candidate.sourceType}
                  </span>
                  <p>{candidate.text}</p>
                  {candidate.evidenceQuote && (
                    <div className="quote-line">"{candidate.evidenceQuote}"</div>
                  )}
                  {candidate.reviewSignals?.length > 0 && (
                    <span className="label">{candidate.reviewSignals.join(" · ")}</span>
                  )}
                  {hint && (
                    <div
                      className="dedup-hint"
                      style={{
                        marginTop: 8,
                        display: "flex",
                        alignItems: "flex-start",
                        gap: 6,
                        padding: "6px 10px",
                        borderRadius: 8,
                        background: "var(--surface-muted, rgba(120,120,140,0.08))",
                        fontSize: "0.85em",
                        lineHeight: 1.45,
                        color: "var(--text-secondary, #555)"
                      }}
>
                      <GitMerge size={14} aria-hidden="true" style={{ flexShrink: 0, marginTop: 2 }} />
                      <span>
                        似已有记忆：<span style={{ fontStyle: "italic" }}>{hint}</span> —— 可合并或仍新增。
                      </span>
                    </div>
                  )}
                  {justSaved && (
                    <span className="label" style={{ color: "var(--accent-green)" }}>已保存</span>
                  )}

                  {/* Inline edit area */}
                  {isEditing && (
                    <div className="stack-sm mt-3">
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
                        aria-label="修正候选记忆内容" />
                      <div className="note-actions">
                        <button
                          className={`primary-action${isSaving ? " btn-loading" : ""}`}
                          type="button"
                          disabled={isSaving || !draftText.trim()}
                          onClick={() => handleSave(candidate.id, candidate.text)}
                          aria-busy={isSaving}
>
                          {isSaving && <span className="spinner" aria-hidden="true" />}
                          <Check size={16} />保存修正
                        </button>
                        <button
                          className="secondary-action"
                          type="button"
                          disabled={isSaving}
                          onClick={cancelEdit}>
                          <X size={16} />取消
                        </button>
                      </div>
                    </div>
                  )}
                </div>

{!isEditing && (
                  <div className="note-actions">
                    <button
                      className={`primary-action${isApproving ? " btn-loading" : ""}`}
                      type="button"
                      disabled={anyLoading}
                      onClick={() => handleApprove(candidate.id, hint ? "merge" : "add")}
                      aria-busy={isApproving}
                      title={hint ? "合并到近重复的既有记忆（保留本条文案）" : "新增一条已确认记忆"}
>
                      {isApproving && <span className="spinner" aria-hidden="true" />}
                      <Check size={16} />{hint ? "合并记住" : "确认记住"}
                    </button>
                    {hint && (
                      <button
                        className="secondary-action"
                        type="button"
                        disabled={anyLoading}
                        onClick={() => handleApprove(candidate.id, "add")}
                        title="不合并，作为新的独立记忆写入"
>
                        <GitMerge size={16} />仍新增
                      </button>
                    )}
                    <button
                      className="secondary-action"
                      type="button"
                      disabled={anyLoading}
                      onClick={() => startEdit(candidate.id, candidate.text)}>
                      <Pencil size={16} />修正
                    </button>
                    <button
                      className={`secondary-action${isRejecting ? " btn-loading" : ""}`}
                      type="button"
                      disabled={anyLoading}
                      onClick={() => handleReject(candidate.id)}
                      aria-busy={isRejecting}
>
                      {isRejecting && <span className="spinner" aria-hidden="true" />}
                      <X size={16} />不要记
                    </button>
                  </div>
                )}
              </article>
            );
          })
        )}
      </div>

      {/* Confirmed records — 真双列布局（左内容右操作），保留 record-row */}
      <div className="record-list">
        <div className="row-between">
          <h2>已确认的长期记忆（{confirmed.length}）</h2>
          {confirmed.length >= 2 && (
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
              {consolidating ? <span className="spinner" /> : <GitMerge size={16} aria-hidden="true" />}
              {consolidating ? "整理中…" : "整理记忆"}
            </button>
          )}
        </div>
        {confirmed.length === 0 ? (
          <div className="empty-state">
            <span className="empty-icon"><Lock size={32} /></span>
            <p>还没有确认的长期记忆。审批候选记忆后，它们会出现在这里。</p>
          </div>
        ) : (
          confirmed.map((record) => {
            const isEditingRecord = editingRecordId === record.id;
            return (
            <article className={`record-row${isEditingRecord ? " edit-active" : ""}`} key={record.id}>
              <div className="record-main">
                <span className="label">
                  {record.sensitivity === "sensitive" && (
                    <>
                      <SensitiveIcon />
                      敏感 &middot;{" "}
                    </>
                  )}
                  来源 {record.sourceType}
                </span>
                <p>{record.text}</p>
                {record.evidenceQuote && (
                  <div className="quote-line">"{record.evidenceQuote}"</div>
                )}

                {/* Inline edit area — 复用候选记忆同款 textarea + 保存/取消模式 */}
                {isEditingRecord && (
                  <div className="stack-sm mt-3">
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
                      aria-label="修正长期记忆内容" />
                    <div className="note-actions">
                      <button
                        className="primary-action"
                        type="button"
                        disabled={!draftRecordText.trim()}
                        onClick={() => handleSaveRecord(record.id, record.text)}>
                        <Check size={16} />保存修正
                      </button>
                      <button className="secondary-action" type="button" onClick={cancelEditRecord}>
                        <X size={16} />取消
                      </button>
                    </div>
                  </div>
                )}
              </div>
              {!isEditingRecord && (
                <div className="note-actions">
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
                      <ExternalLink size={16} />查看原文出处
                    </button>
                  )}
                  <button className="secondary-action" type="button" onClick={() => startEditRecord(record.id, record.text)}>
                    <Pencil size={16} />编辑
                  </button>
                  <button className="secondary-action" type="button" onClick={() => onDeprecate(record.id)}>
                    撤销（停止引用）
                  </button>
                  <button className="secondary-action" type="button" onClick={() => onDeleteRecord(record.id)}>
                    <Trash2 size={16} />删除
                  </button>
                </div>
              )}
            </article>
            );
          })
        )}
      </div>

      {/* Task 12: 原文出处弹层 */}
      {sourceOverlay && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="原文出处"
          onClick={() => setSourceOverlay(null)}
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 1000,
            background: "rgba(0,0,0,0.55)",
            display: "flex",
            alignItems: "flex-start",
            justifyContent: "center",
            padding: "5vh 1rem",
            overflowY: "auto"
          }}
>
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              width: "min(820px, 100%)",
              background: "var(--surface, #1b1d22)",
              borderRadius: "0.75rem",
              padding: "1rem 1.1rem 1.4rem",
              boxShadow: "0 18px 48px rgba(0,0,0,0.5)"
            }}
>
            <div className="row-between">
              <h2 className="panel-subhead">原文出处</h2>
              <button
                className="icon-button"
                type="button"
                aria-label="关闭原文出处"
                onClick={() => setSourceOverlay(null)}>
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
              getAudioBlob={getAudioBlob} />
          </div>
        </div>
      )}
    </section>
  );
}
