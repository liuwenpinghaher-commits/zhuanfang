import { useState } from "react";
import { Check, FileUp, Pencil, Trash2, X } from "lucide-react";
import { HeaderBlock } from "../../components/HeaderBlock";
import type { ProductState } from "../../domain/types";

interface MemoryGovernanceViewProps {
  state: ProductState;
  importing: boolean;
  onImport: (title: string, content: string) => void;
  onApprove: (candidateId: string) => void;
  onReject: (candidateId: string) => void;
  onEditCandidate: (candidateId: string, text: string) => void;
  onDeprecate: (recordId: string) => void;
  onDeleteRecord: (recordId: string) => void;
}

export function MemoryGovernanceView({
  state,
  importing,
  onImport,
  onApprove,
  onReject,
  onEditCandidate,
  onDeprecate,
  onDeleteRecord
}: MemoryGovernanceViewProps) {
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");

  const pending = state.memoryCandidates.filter((candidate) => candidate.status === "pending");
  const confirmed = state.memoryRecords.filter((record) => record.status === "confirmed");

  function handleImport() {
    if (!content.trim()) return;
    onImport(title.trim() || "未命名导入资料", content.trim());
    setTitle("");
    setContent("");
  }

  function handleEdit(candidateId: string, currentText: string) {
    const next = window.prompt("修正这条候选记忆（AI 理解错了就改这里）：", currentText);
    if (next && next.trim() && next.trim() !== currentText) {
      onEditCandidate(candidateId, next.trim());
    }
  }

  return (
    <section className="view-stack">
      <HeaderBlock
        eyebrow="记忆治理"
        title="导入资料，审核长期记忆"
        subtitle="导入的资料会抽取成候选记忆；只有你确认后才进入长期记忆。敏感内容默认不写入上下文。"
      />

      <article className="record-row">
        <div className="record-main">
          <label className="label" htmlFor="memory-import-title">资料标题</label>
          <input
            id="memory-import-title"
            type="text"
            value={title}
            placeholder="例如：我的产品笔记 / 一篇访谈稿"
            onChange={(event) => setTitle(event.target.value)}
          />
          <label className="label" htmlFor="memory-import-content">资料内容（粘贴文本，或读取 .txt/.md 文件）</label>
          <textarea
            id="memory-import-content"
            rows={6}
            value={content}
            placeholder="把要导入的资料粘贴到这里…"
            onChange={(event) => setContent(event.target.value)}
          />
          <div className="note-actions">
            <label className="secondary-action" style={{ cursor: "pointer" }}>
              <FileUp size={16} />选择 .txt/.md 文件
              <input
                type="file"
                accept=".txt,.md,.markdown,text/plain"
                style={{ display: "none" }}
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (!file) return;
                  if (!title.trim()) setTitle(file.name.replace(/\.[^.]+$/, ""));
                  file.text().then((text) => setContent(text));
                }}
              />
            </label>
            <button className="primary-action" type="button" disabled={importing || !content.trim()} onClick={handleImport}>
              <FileUp size={16} />{importing ? "抽取中…" : "导入并抽取候选记忆"}
            </button>
          </div>
        </div>
      </article>

      <div className="record-list">
        <h2>待审候选记忆（{pending.length}）</h2>
        {pending.length === 0 && <p className="label">暂无待审候选。导入资料或完成一次专访后会产生候选记忆。</p>}
        {pending.map((candidate) => (
          <article className="record-row" key={candidate.id}>
            <div className="record-main">
              <span className="label">
                评分 {candidate.reviewScore} ·{" "}
                {candidate.sensitivity === "sensitive" ? "🔒 敏感（默认不入上下文）" : "普通"} · 来源 {candidate.sourceType}
              </span>
              <p>{candidate.text}</p>
              {candidate.evidenceQuote && <div className="quote-line">“{candidate.evidenceQuote}”</div>}
              {candidate.reviewSignals?.length > 0 && (
                <span className="label">{candidate.reviewSignals.join(" · ")}</span>
              )}
            </div>
            <div className="note-actions">
              <button className="primary-action" type="button" onClick={() => onApprove(candidate.id)}>
                <Check size={16} />确认记住
              </button>
              <button className="secondary-action" type="button" onClick={() => handleEdit(candidate.id, candidate.text)}>
                <Pencil size={16} />修正
              </button>
              <button className="secondary-action" type="button" onClick={() => onReject(candidate.id)}>
                <X size={16} />不要记
              </button>
            </div>
          </article>
        ))}
      </div>

      <div className="record-list">
        <h2>已确认的长期记忆（{confirmed.length}）</h2>
        {confirmed.length === 0 && <p className="label">还没有确认的长期记忆。</p>}
        {confirmed.map((record) => (
          <article className="record-row" key={record.id}>
            <div className="record-main">
              <span className="label">
                {record.sensitivity === "sensitive" ? "🔒 敏感 · " : ""}来源 {record.sourceType}
              </span>
              <p>{record.text}</p>
              {record.evidenceQuote && <div className="quote-line">“{record.evidenceQuote}”</div>}
            </div>
            <div className="note-actions">
              <button className="secondary-action" type="button" onClick={() => onDeprecate(record.id)}>
                撤销（停止引用）
              </button>
              <button className="secondary-action" type="button" onClick={() => onDeleteRecord(record.id)}>
                <Trash2 size={16} />删除
              </button>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}
