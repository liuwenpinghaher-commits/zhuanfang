import { BookmarkCheck, FileText, FileSearch, Play } from "lucide-react";
import { useEffect, useState } from "react";
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
  // 引用跳源:外部(如资产对话的逐字稿引用)指定要展开的会话与高亮的轮次。nonce 每次点击自增,用于连点重触发。
  focus?: { sessionId: string; turnId?: string; nonce?: number } | null;
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
  getAudioBlob,
  focus
}: NotesViewProps) {
  const [openSessionId, setOpenSessionId] = useState<string | null>(null);

  // 收到跳源 focus → 自动展开对应会话的原始材料(RawMaterialViewer 再按 focusTurnId 滚动高亮该轮)。
  // 依赖含 nonce:连点同一引用(sessionId/turnId 不变)时也重新触发,避免"第二次点击无反应"。
  useEffect(() => {
    if (focus?.sessionId) {
      setOpenSessionId(focus.sessionId);
    }
  }, [focus?.sessionId, focus?.turnId, focus?.nonce]);

  // 跳源目标会话可能没有对应的双轨笔记(transcript 引用指向无 note 的会话)。此时上面的 notes.map
  // 不会渲染任何 RawMaterialViewer → 跳源静默失败。这里为"无 note 的 focus 会话"补一个独立查看器,
  // 使任意会话的逐字稿引用都能真正展开定位。
  const focusSessionHasNote = focus?.sessionId
    ? state.notes.some((note) => note.sessionId === focus.sessionId)
    : true;
  const orphanFocusSessionId = !focusSessionHasNote && focus?.sessionId ? focus.sessionId : null;
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
                  focusTurnId={focus?.sessionId === note.sessionId ? focus?.turnId : undefined}
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
        {orphanFocusSessionId && (
          // 无对应双轨笔记的跳源会话:独立渲染原始材料查看器,保证逐字稿引用不静默失败。
          <article className="record-row" key={`orphan-focus-${orphanFocusSessionId}`}>
            <div className="record-main">
              <span className="label">引用定位</span>
              <h2>原始材料</h2>
              <p>该会话尚无双轨笔记，以下为被引用的原始逐字稿。</p>
            </div>
            <div style={{ gridColumn: "1 / -1" }}>
              <RawMaterialViewer
                sessionId={orphanFocusSessionId}
                state={state}
                focusTurnId={focus?.turnId}
                onAddAnnotation={onAddAnnotation}
                onRemoveAnnotation={onRemoveAnnotation}
                getRawMaterial={getRawMaterial}
                getAudioMeta={getAudioMeta}
                audioUrl={audioUrl}
                getAudioBlob={getAudioBlob}
              />
            </div>
          </article>
        )}
      </div>
    </section>
  );
}
