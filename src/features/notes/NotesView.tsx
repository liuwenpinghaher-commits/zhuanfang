import {
  BookmarkCheck,
  ChevronDown,
  ChevronUp,
  ExternalLink,
  FileSearch,
  FileText,
  Headphones,
  Play,
  Search,
  Trash2
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { HeaderBlock } from "../../components/HeaderBlock";
import { describeForgetImpact } from "../../domain/lifecycle";
import type {
  DualTrackNote,
  InterviewMode,
  InterviewRawMaterial,
  ProductState
} from "../../domain/types";
import type { SessionAudioMeta } from "../../api/productApi";
import { RawMaterialViewer } from "./RawMaterialViewer";

interface NotesViewProps {
  state: ProductState;
  /**
   * 开始专访。topicHint / relatedThemeIds 用于「用此问题开场」闭环。
   */
  onStart: (mode?: InterviewMode, topicHint?: string, relatedThemeIds?: string[]) => void;
  onSaveQuestion: (noteId: string, index: number) => void;
  onAddAnnotation: (sessionId: string, turnId: string, text: string) => void;
  onRemoveAnnotation: (id: string) => void;
  getRawMaterial: (sessionId: string) => Promise<InterviewRawMaterial | null>;
  getAudioMeta?: (sessionId: string, role?: "interviewee" | "interviewer") => Promise<SessionAudioMeta>;
  audioUrl?: (sessionId: string) => string;
  getAudioBlob?: (sessionId: string, role?: "interviewee" | "interviewer") => Promise<Blob | null>;
  // 引用跳源:外部(如资产对话的逐字稿引用)指定要展开的会话与高亮的轮次。nonce 每次点击自增,用于连点重触发。
  focus?: { sessionId: string; turnId?: string; nonce?: number } | null;
  onOpenTrack?: (themeId: string) => void;
  onGeneratePodcast?: (noteId: string) => void;
  onOpenArchive?: (sessionId: string) => void;
  onForgetNote?: (
    noteId: string,
    options: { exclusiveAssets: boolean; confirmedMemory: boolean }
  ) => Promise<void>;
}

function isLightNote(note: DualTrackNote): boolean {
  return (
    note.summary.includes("轻量记录") ||
    note.learnedTrack.some((line) => line.includes("轻量记录") || line.includes("AI 综合暂不可用"))
  );
}

function normalizeQuestionText(text: string): string {
  return text.trim().replace(/[\s。，、；：！？·.,;:!?]/g, "");
}

function questionAlreadySaved(state: ProductState, question: string): boolean {
  const key = normalizeQuestionText(question);
  if (!key) return false;
  return state.questions.some((item) => normalizeQuestionText(item.question) === key);
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
  focus,
  onOpenTrack,
  onGeneratePodcast,
  onOpenArchive,
  onForgetNote
}: NotesViewProps) {
  const [openSessionId, setOpenSessionId] = useState<string | null>(null);
  const [expandedNoteIds, setExpandedNoteIds] = useState<Record<string, boolean>>({});
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<"all" | "with-questions" | "light">("all");
  const [forgetNoteId, setForgetNoteId] = useState<string | null>(null);
  const [forgetExclusive, setForgetExclusive] = useState(false);
  const [forgetMemory, setForgetMemory] = useState(false);
  const [forgetBusy, setForgetBusy] = useState(false);
  const [forgetError, setForgetError] = useState("");

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

  const sortedNotes = useMemo(
    () => [...state.notes].sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    [state.notes]
  );

  const visibleNotes = useMemo(() => {
    const q = query.trim().toLowerCase();
    return sortedNotes.filter((note) => {
      if (filter === "with-questions" && note.nextQuestions.length === 0) return false;
      if (filter === "light" && !isLightNote(note)) return false;
      if (!q) return true;
      const hay = [note.title, note.summary, note.keyQuote, ...note.saidTrack, ...note.learnedTrack, ...note.nextQuestions]
        .join("\n")
        .toLowerCase();
      return hay.includes(q);
    });
  }, [sortedNotes, query, filter]);

  const latestActionable = sortedNotes.find((note) => note.nextQuestions.some((q) => q.trim())) ?? sortedNotes[0];
  const heroQuestion = latestActionable?.nextQuestions.find((q) => q.trim()) ?? "";

  function toggleExpanded(noteId: string) {
    setExpandedNoteIds((prev) => ({ ...prev, [noteId]: !prev[noteId] }));
  }

  function startWithQuestion(note: DualTrackNote, question?: string) {
    const hint = (question ?? note.nextQuestions[0] ?? note.keyQuote ?? note.title).trim();
    onStart("daily", hint || undefined, note.relatedThemeIds);
  }

  function handleHeroPrimary() {
    if (latestActionable && heroQuestion) {
      startWithQuestion(latestActionable, heroQuestion);
      return;
    }
    onStart("daily");
  }

  function openForget(noteId: string) {
    setForgetNoteId(noteId);
    setForgetExclusive(false);
    setForgetMemory(false);
    setForgetError("");
  }

  async function confirmForget(noteId: string) {
    if (!onForgetNote || forgetBusy) return;
    setForgetBusy(true);
    setForgetError("");
    try {
      await onForgetNote(noteId, {
        exclusiveAssets: forgetExclusive,
        confirmedMemory: forgetMemory
      });
      setForgetNoteId(null);
    } catch (err) {
      setForgetError(err instanceof Error && err.message ? err.message : "这场没能拿走，请再试一次。");
    } finally {
      setForgetBusy(false);
    }
  }

  function countList(parts: Array<[number, string]>): string {
    const bits = parts.filter(([n]) => n > 0).map(([n, label]) => `${n} 条${label}`);
    return bits.length ? bits.join("、") : "";
  }

  return (
    <section className="view-stack">
      <HeaderBlock
        eyebrow="双轨笔记"
        title="从访谈沉淀认知资产"
        subtitle="这里用来阅读与回访：区分「我说了什么」和「我学到了什么」。状态确认与筛选请去「我的资产」。"
        action={
          <div className="form-actions">
            <button className="primary-action" type="button" onClick={handleHeroPrimary}>
              <Play size={18} />
              {heroQuestion ? "用下个问题开场" : "再做一次复盘"}
            </button>
            {heroQuestion && (
              <button className="secondary-action" type="button" onClick={() => onStart("daily")}>
                新开日常复盘
              </button>
            )}
          </div>
        }
      />

      {state.notes.length > 0 && (
        <section className="panel notes-toolbar" aria-label="笔记筛选">
          <label className="field-stack notes-search-field" htmlFor="notes-search">
            <span className="field-label row">
              <Search size={14} aria-hidden="true" />
              搜索笔记
            </span>
            <input
              id="notes-search"
              value={query}
              maxLength={120}
              placeholder="标题、摘要、原话或回访问题"
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
          <div className="form-actions row-wrap" role="group" aria-label="筛选">
            {(
              [
                ["all", "全部"],
                ["with-questions", "有回访问题"],
                ["light", "轻量记录"]
              ] as const
            ).map(([id, label]) => (
              <button
                key={id}
                type="button"
                className={filter === id ? "secondary-action is-pressed" : "secondary-action"}
                onClick={() => setFilter(id)}
              >
                {label}
              </button>
            ))}
          </div>
        </section>
      )}

      <div className="record-list">
        {state.notes.length === 0 && (
          <section className="panel empty-module">
            <FileText size={18} />
            <p>还没有专访笔记，完成一次专访后这里会出现双轨笔记。</p>
            <button className="primary-action" type="button" onClick={() => onStart("daily")}>
              <Play size={16} />
              开始一场专访
            </button>
          </section>
        )}

        {state.notes.length > 0 && visibleNotes.length === 0 && (
          <section className="panel empty-module">
            <Search size={18} />
            <p>没有符合当前筛选的笔记。</p>
            <button className="secondary-action" type="button" onClick={() => { setQuery(""); setFilter("all"); }}>
              清除筛选
            </button>
          </section>
        )}

        {visibleNotes.map((note) => {
          const light = isLightNote(note);
          const expanded = Boolean(expandedNoteIds[note.id]);
          const said = expanded ? note.saidTrack : note.saidTrack.slice(0, 3);
          const learned = expanded ? note.learnedTrack : note.learnedTrack.slice(0, 3);
          const questions = expanded ? note.nextQuestions : note.nextQuestions.slice(0, 2);
          const canExpandTracks =
            note.saidTrack.length > 3 || note.learnedTrack.length > 3 || note.nextQuestions.length > 2;
          const session = state.sessions.find((item) => item.id === note.sessionId);
          const themes = (note.relatedThemeIds ?? [])
            .map((id) => state.themes.find((theme) => theme.id === id))
            .filter((theme): theme is NonNullable<typeof theme> => Boolean(theme));

          return (
            <article className="record-row note-card" key={note.id}>
              <div className="record-main">
                <div className="row notes-card-meta">
                  <span className="label">{new Date(note.createdAt).toLocaleDateString("zh-CN")}</span>
                  {session?.mode && <span className="status-pill">{session.mode}</span>}
                  {light ? (
                    <span className="status-pill notes-light-pill">轻量记录</span>
                  ) : (
                    <span className="status-pill">完整沉淀</span>
                  )}
                </div>
                <h2>{note.title}</h2>
                <p>{note.summary}</p>
                {note.keyQuote?.trim() && (
                  <div className="notes-quote-block">
                    <div className="quote-line">“{note.keyQuote}”</div>
                    {note.keyQuoteAnchor && (
                      <button
                        className="text-button"
                        type="button"
                        onClick={() => {
                          setOpenSessionId(note.sessionId);
                        }}
                      >
                        <ExternalLink size={14} />
                        查看来源原文
                      </button>
                    )}
                  </div>
                )}
                {themes.length > 0 && (
                  <div className="inline-list notes-theme-chips" aria-label="关联主题线">
                    {themes.map((theme) => (
                      <button
                        key={theme.id}
                        type="button"
                        className="status-pill notes-theme-chip"
                        onClick={() => onOpenTrack?.(theme.id)}
                        disabled={!onOpenTrack}
                      >
                        主题线：{theme.name}
                      </button>
                    ))}
                  </div>
                )}
              </div>

              <div className="dual-track">
                <div>
                  <strong>我说了什么</strong>
                  {said.length === 0 ? (
                    <p className="field-help">暂无提炼条目</p>
                  ) : (
                    <ul>
                      {said.map((item, itemIdx) => (
                        <li key={`${note.id}-said-${itemIdx}`}>{item}</li>
                      ))}
                    </ul>
                  )}
                </div>
                <div>
                  <strong>我学到了什么</strong>
                  {learned.length === 0 ? (
                    <p className="field-help">{light ? "轻量记录未做深度提炼。" : "暂无提炼条目"}</p>
                  ) : (
                    <ul>
                      {learned.map((item, itemIdx) => (
                        <li key={`${note.id}-learned-${itemIdx}`}>{item}</li>
                      ))}
                    </ul>
                  )}
                </div>
              </div>

              {canExpandTracks && (
                <div className="span-all">
                  <button className="text-button" type="button" onClick={() => toggleExpanded(note.id)}>
                    {expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                    {expanded ? "收起全部" : "展开全部双轨与问题"}
                  </button>
                </div>
              )}

              <div className="note-actions span-all">
                {questions.length === 0 ? (
                  <p className="field-help">
                    {light ? "轻量记录没有下次回访问题（AI 未完整沉淀）。" : "本场暂无下次回访问题。"}
                  </p>
                ) : (
                  questions.map((question, index) => {
                    // index 必须对应 nextQuestions 原下标（截断时仍用真实 index）
                    const realIndex = note.nextQuestions.indexOf(question);
                    const saved = questionAlreadySaved(state, question);
                    return (
                      <div className="notes-question-row" key={`${note.id}-q-${realIndex}`}>
                        <p className="notes-question-text">{question}</p>
                        <div className="form-actions">
                          <button
                            className="secondary-action"
                            type="button"
                            disabled={saved}
                            onClick={() => onSaveQuestion(note.id, realIndex >= 0 ? realIndex : index)}
                          >
                            <BookmarkCheck size={16} aria-hidden="true" />
                            {saved ? "已保存到资产" : "保存到资产库"}
                          </button>
                          <button
                            className="primary-action"
                            type="button"
                            onClick={() => startWithQuestion(note, question)}
                          >
                            <Play size={16} />
                            用此问题开场
                          </button>
                        </div>
                      </div>
                    );
                  })
                )}

                <div className="form-actions notes-secondary-actions">
                  <button
                    className="secondary-action"
                    type="button"
                    aria-expanded={openSessionId === note.sessionId}
                    onClick={() => setOpenSessionId((prev) => (prev === note.sessionId ? null : note.sessionId))}
                  >
                    <FileSearch size={16} aria-hidden="true" />
                    {openSessionId === note.sessionId ? "收起原始材料" : "查看原始材料"}
                  </button>
                  {onGeneratePodcast && !light && (
                    <button className="secondary-action" type="button" onClick={() => onGeneratePodcast(note.id)}>
                      <Headphones size={16} />
                      生成播客
                    </button>
                  )}
                  {onOpenArchive && (
                    <button className="secondary-action" type="button" onClick={() => onOpenArchive(note.sessionId)}>
                      打开专访档案
                    </button>
                  )}
                  {onForgetNote && (
                    <button
                      className="danger-button"
                      type="button"
                      disabled={forgetBusy}
                      onClick={() => openForget(note.id)}
                    >
                      <Trash2 size={16} />
                      删除这场
                    </button>
                  )}
                </div>

                {forgetNoteId === note.id && (
                  <ForgetConfirmPanel
                    state={state}
                    noteId={note.id}
                    exclusive={forgetExclusive}
                    memory={forgetMemory}
                    busy={forgetBusy}
                    error={forgetError}
                    countList={countList}
                    onExclusive={setForgetExclusive}
                    onMemory={setForgetMemory}
                    onCancel={() => {
                      if (forgetBusy) return;
                      setForgetNoteId(null);
                      setForgetError("");
                    }}
                    onConfirm={() => void confirmForget(note.id)}
                  />
                )}
              </div>

              {openSessionId === note.sessionId && (
                // record-row 是两列网格；让原始材料查看器横跨两列用满宽度，否则会被挤在左列、右侧留大片空白。
                <div className="span-all">
                  <RawMaterialViewer
                    sessionId={note.sessionId}
                    state={state}
                    focusTurnId={
                      focus?.sessionId === note.sessionId
                        ? focus?.turnId
                        : note.keyQuoteAnchor?.sessionId === note.sessionId
                          ? note.keyQuoteAnchor.turnId
                          : undefined
                    }
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
          );
        })}

        {orphanFocusSessionId && (
          // 无对应双轨笔记的跳源会话:独立渲染原始材料查看器,保证逐字稿引用不静默失败。
          <article className="record-row" key={`orphan-focus-${orphanFocusSessionId}`}>
            <div className="record-main">
              <span className="label">引用定位</span>
              <h2>原始材料</h2>
              <p>该会话尚无双轨笔记，以下为被引用的原始逐字稿。</p>
            </div>
            <div className="span-all">
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

function ForgetConfirmPanel({
  state,
  noteId,
  exclusive,
  memory,
  busy,
  error,
  countList,
  onExclusive,
  onMemory,
  onCancel,
  onConfirm
}: {
  state: ProductState;
  noteId: string;
  exclusive: boolean;
  memory: boolean;
  busy: boolean;
  error: string;
  countList: (parts: Array<[number, string]>) => string;
  onExclusive: (value: boolean) => void;
  onMemory: (value: boolean) => void;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const impact = describeForgetImpact(state, noteId);
  const exclusiveCopy = impact
    ? countList([
        [impact.exclusive.points, "观点"],
        [impact.exclusive.questions, "问题"],
        [impact.exclusive.decisions, "决策"],
        [impact.exclusive.debts, "债"]
      ])
    : "";
  const sharedCopy = impact
    ? countList([
        [impact.shared.points, "观点"],
        [impact.shared.questions, "问题"],
        [impact.shared.decisions, "决策"],
        [impact.shared.debts, "债"]
      ])
    : "";

  return (
    <section className="danger-zone notes-forget-panel span-all" aria-label="确认删除这场">
      <strong>确定拿走这场？</strong>
      <p>
        会拿走这篇笔记、这场专访、逐字稿和录音
        {impact && impact.pendingMemories > 0 ? `、还没点头的 ${impact.pendingMemories} 条待审记忆` : ""}
        {impact && impact.podcasts > 0 ? `、用这篇笔记做的 ${impact.podcasts} 条播客` : ""}
        。主题线和别的场的笔记不动。
      </p>
      {sharedCopy ? <p className="field-help">已经并进别的场的 {sharedCopy} 会留下，只从这场档案里摘掉。</p> : null}
      <label className="field-inline">
        <input
          type="checkbox"
          checked={exclusive}
          disabled={busy}
          onChange={(event) => onExclusive(event.target.checked)}
        />
        <span>
          同时拿走只属于这场的抽出物
          {exclusiveCopy ? `（${exclusiveCopy}）` : "（这场没有只属于它的抽出物）"}
        </span>
      </label>
      <label className="field-inline">
        <input
          type="checkbox"
          checked={memory}
          disabled={busy}
          onChange={(event) => onMemory(event.target.checked)}
        />
        <span>
          同时拿走只来自这场的已点头记忆
          {impact && impact.exclusive.confirmedMemories
            ? `（${impact.exclusive.confirmedMemories} 条）`
            : "（这场没有只属于它的已点头记忆）"}
        </span>
      </label>
      {error ? <p className="field-status is-danger" role="alert">{error}</p> : null}
      <div className="form-actions">
        <button className="secondary-action" type="button" disabled={busy} onClick={onCancel}>
          取消
        </button>
        <button
          className={`danger-button${busy ? " btn-loading" : ""}`}
          type="button"
          disabled={busy}
          aria-busy={busy}
          onClick={onConfirm}
        >
          {busy && <span className="spinner" aria-hidden="true" />}
          <Trash2 size={16} />
          确定删除这场
        </button>
      </div>
    </section>
  );
}
