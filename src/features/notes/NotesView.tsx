import { BookmarkCheck, FileText, FileSearch, Play } from "lucide-react";
import { useState } from "react";
import { HeaderBlock } from "../../components/HeaderBlock";
import type { InterviewMode, InterviewRawMaterial, ProductState } from "../../domain/types";
import type { SessionAudioMeta } from "../../api/productApi";
import { RawMaterialViewer } from "./RawMaterialViewer";

interface NotesViewProps {
  state: ProductState;
  onStart: (mode?: InterviewMode) => void;
  onSaveQuestion: (noteId: string, index: number) => void;
  onAddAnnotation: (sessionId: string, turnId: string, text: string) => void;
  onRemoveAnnotation: (id: string) => void;
  getRawMaterial: (sessionId: string) => Promise<InterviewRawMaterial | null>;
  getAudioMeta?: (sessionId: string, role?: "interviewee" | "interviewer") => Promise<SessionAudioMeta>;
  audioUrl?: (sessionId: string) => string;
  getAudioBlob?: (sessionId: string, role?: "interviewee" | "interviewer") => Promise<Blob | null>;
}

export function NotesView({
  state,
  onStart,
  onSaveQuestion,
  onAddAnnotation,
  onRemoveAnnotation,
  getRawMaterial,
  getAudioMeta,
  audioUrl,
  getAudioBlob
}: NotesViewProps) {
  const [openSessionId, setOpenSessionId] = useState<string | null>(null);
  return (
    <section className="view-stack">
      <HeaderBlock
        eyebrow="双轨笔记"
        title="从访谈沉淀认知资产"
        subtitle="每份档案都区分“我说了什么”和“我学到了什么”，并保留下次回访问题。"
        action={<button className="secondary-action" type="button" onClick={() => onStart("daily")}><Play size={18} />再做一次复盘</button>}
      />
      <div className="record-list">
        {state.notes.length === 0 && (
          <section className="panel empty-module">
            <FileText size={18} />
            <p>还没有专访笔记，完成一次专访后这里会出现双轨笔记。</p>
          </section>
        )}
        {state.notes.map((note) => (
          <article className="record-row" key={note.id}>
            <div className="record-main">
              <span className="label">{new Date(note.createdAt).toLocaleDateString("zh-CN")}</span>
              <h2>{note.title}</h2>
              <p>{note.summary}</p>
              <div className="quote-line">“{note.keyQuote}”</div>
            </div>
            <div className="dual-track">
              <div>
                <strong>我说了什么</strong>
                <ul>{note.saidTrack.slice(0, 3).map((item, itemIdx) => <li key={`${note.id}-said-${itemIdx}`}>{item}</li>)}</ul>
              </div>
              <div>
                <strong>我学到了什么</strong>
                <ul>{note.learnedTrack.slice(0, 3).map((item, itemIdx) => <li key={`${note.id}-learned-${itemIdx}`}>{item}</li>)}</ul>
              </div>
            </div>
            <div className="note-actions">
              {note.nextQuestions.slice(0, 2).map((question, index) => (
                <button className="secondary-action" type="button" key={`${note.id}-q-${index}`} onClick={() => onSaveQuestion(note.id, index)}>
                  <BookmarkCheck size={16} aria-hidden="true" />保存问题：{question}
                </button>
              ))}
              <button
                className="secondary-action"
                type="button"
                aria-expanded={openSessionId === note.sessionId}
                onClick={() => setOpenSessionId((prev) => (prev === note.sessionId ? null : note.sessionId))}
              >
                <FileSearch size={16} aria-hidden="true" />
                {openSessionId === note.sessionId ? "收起原始材料" : "查看原始材料"}
              </button>
            </div>
            {openSessionId === note.sessionId && (
              // record-row 是两列网格；让原始材料查看器横跨两列用满宽度，否则会被挤在左列、右侧留大片空白。
              <div style={{ gridColumn: "1 / -1" }}>
                <RawMaterialViewer
                  sessionId={note.sessionId}
                  state={state}
                  onAddAnnotation={onAddAnnotation}
                  onRemoveAnnotation={onRemoveAnnotation}
                  getRawMaterial={getRawMaterial}
                  getAudioMeta={getAudioMeta}
                  audioUrl={audioUrl}
                  getAudioBlob={getAudioBlob}
                />
              </div>
            )}
          </article>
        ))}
      </div>
    </section>
  );
}
