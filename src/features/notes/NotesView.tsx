import { BookmarkCheck, FileText, Play } from "lucide-react";
import { HeaderBlock } from "../../components/HeaderBlock";
import type { InterviewMode, ProductState } from "../../domain/types";

interface NotesViewProps {
  state: ProductState;
  onStart: (mode?: InterviewMode) => void;
  onSaveQuestion: (noteId: string, index: number) => void;
}

export function NotesView({ state, onStart, onSaveQuestion }: NotesViewProps) {
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
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}
