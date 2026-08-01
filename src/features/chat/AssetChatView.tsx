import { Library, MessagesSquare, Mic, Plus, Quote, SendHorizontal, Trash2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { HeaderBlock } from "../../components/HeaderBlock";
import type { ChatCitation, ChatMessage, ChatSession, ProductState } from "../../domain/types";

/** 草稿线程哨兵：selectedSessionId 为此值时强制空线程，不回落最近会话。 */
export const ASSET_CHAT_DRAFT_ID = "__new__";

interface AssetChatViewProps {
  state: ProductState;
  onSend: (sessionId: string | null, message: string) => Promise<void>;
  onNewChat: () => void;
  onDeleteChat: (sessionId: string) => void;
  onSelectChat: (sessionId: string) => void;
  selectedSessionId: string | null;
  onCitationClick: (c: ChatCitation) => void;
  /** 跨模块预填（素材/资产带入）；消费后由父级清空。 */
  prefill?: string | null;
  onPrefillConsumed?: () => void;
  /** 就当前问题 / 回答开一场专访。 */
  onStartInterview?: (topicHint: string) => void;
  /** 索引空时引导去素材库。 */
  onOpenMaterial?: () => void;
}

function sortByUpdatedDesc(sessions: ChatSession[]): ChatSession[] {
  return [...sessions].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

function formatShortTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function lastMessagePreview(session: ChatSession): string {
  const last = session.messages[session.messages.length - 1];
  if (!last) return "尚无消息";
  const prefix = last.role === "user" ? "我：" : "助：";
  const body = last.content.trim().replace(/\s+/g, " ");
  return prefix + (body.length > 42 ? `${body.slice(0, 42)}…` : body);
}

function groundingLabel(mode: ChatMessage["groundingMode"]): { text: string; className: string } | null {
  if (mode === "grounded") return { text: "已依据资料", className: "chat-grounding is-grounded" };
  if (mode === "partial") return { text: "部分依据 / 含推断", className: "chat-grounding is-partial" };
  if (mode === "refused") return { text: "无可靠资料（拒召）", className: "chat-grounding is-refused" };
  return null;
}

function buildSuggestedQuestions(state: ProductState): string[] {
  const out: string[] = [];
  const theme = [...state.themes].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
  if (theme?.name) out.push(`我对「${theme.name}」做过哪些判断？`);
  const note = [...state.notes].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  if (note?.title) out.push(`最近一场「${note.title}」留下了哪些问题？`);
  const debt = [...state.debts].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
  if (debt?.concept) out.push(`关于「${debt.concept}」我还欠什么？`);
  const defaults = [
    "我对控制感与放权有哪些判断？",
    "最近一次专访留下了哪些开放问题？",
    "用一句话说明什么是诚实失败暴露。"
  ];
  for (const d of defaults) {
    if (out.length >= 3) break;
    if (!out.includes(d)) out.push(d);
  }
  return out.slice(0, 3);
}

export function AssetChatView({
  state,
  onSend,
  onNewChat,
  onDeleteChat,
  onSelectChat,
  selectedSessionId,
  onCitationClick,
  prefill = null,
  onPrefillConsumed,
  onStartInterview,
  onOpenMaterial
}: AssetChatViewProps) {
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

  const sessions = useMemo(() => sortByUpdatedDesc(state.chatSessions), [state.chatSessions]);

  // 选中会话：草稿强制空；匹配 id；null 时回落最近（首次进页）；DRAFT_ID 永不回落。
  const activeSession = useMemo(() => {
    if (selectedSessionId === ASSET_CHAT_DRAFT_ID) return null;
    if (selectedSessionId) {
      const matched = sessions.find((item) => item.id === selectedSessionId);
      if (matched) return matched;
    }
    if (selectedSessionId === null) return sessions[0] ?? null;
    return null;
  }, [sessions, selectedSessionId]);

  const canSend = draft.trim().length > 0 && !sending;
  const suggestions = useMemo(() => buildSuggestedQuestions(state), [state]);
  const hasImportSources = state.importSources.length > 0;
  const hasConfirmedMemory = state.memoryRecords.some((r) => r.status === "confirmed");
  const indexHintEmpty =
    !hasImportSources && !hasConfirmedMemory && state.notes.length === 0 && state.themes.length === 0;

  useEffect(() => {
    if (prefill == null) return;
    const text = prefill.trim();
    if (text) setDraft(text);
    onPrefillConsumed?.();
    requestAnimationFrame(() => inputRef.current?.focus());
  }, [prefill, onPrefillConsumed]);

  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [activeSession?.id, activeSession?.messages.length, sending]);

  async function handleSend() {
    const message = draft.trim();
    if (!message || sending) return;
    setSending(true);
    setError(null);
    try {
      const sid =
        selectedSessionId === ASSET_CHAT_DRAFT_ID || !activeSession ? null : activeSession.id;
      await onSend(sid, message);
      setDraft("");
    } catch (err) {
      setError(formatChatSendError(err));
    } finally {
      setSending(false);
    }
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void handleSend();
    }
  }

  function handleNewChatClick() {
    if (draft.trim() && selectedSessionId === ASSET_CHAT_DRAFT_ID) {
      if (typeof window !== "undefined" && !window.confirm("放弃当前输入并重新开始空白对话？")) {
        return;
      }
      setDraft("");
    }
    setError(null);
    onNewChat();
    requestAnimationFrame(() => inputRef.current?.focus());
  }

  const showEmptyThread = !activeSession || activeSession.messages.length === 0;

  return (
    <section className="view-stack">
      <HeaderBlock
        eyebrow="认知资产 · 资产对话"
        title="与你的认知资产对话"
        subtitle="基于已沉淀的笔记、记忆、主题与素材回答问题，并给出可点击跳源的引用。回答可继续开专访。"
        action={
          <button className="secondary-action" type="button" onClick={handleNewChatClick}>
            <Plus size={16} className="icon-inline" />
            新对话
          </button>
        }
      />

      {indexHintEmpty && (
        <div className="hint-banner is-info chat-index-hint" role="status">
          <span>知识库几乎为空：导入素材或完成专访并确认记忆后，对话才能引用你的资料。</span>
          {onOpenMaterial && (
            <button className="secondary-action compact-action" type="button" onClick={onOpenMaterial}>
              <Library size={14} aria-hidden />
              去素材库
            </button>
          )}
        </div>
      )}

      <div className="chat-layout">
        <section className="panel">
          <div className="panel-title">
            <MessagesSquare size={18} aria-hidden />
            <h2>会话（{sessions.length}）</h2>
          </div>
          {sessions.length === 0 ? (
            <p className="field-help">还没有对话。在右侧提问，或点「新对话」开始。</p>
          ) : (
            <div className="session-list">
              {sessions.map((session) => {
                const selected =
                  activeSession?.id === session.id && selectedSessionId !== ASSET_CHAT_DRAFT_ID;
                return (
                  <div key={session.id} className="row">
                    <button
                      type="button"
                      className={selected ? "session-list-item is-active flex-1" : "session-list-item flex-1"}
                      onClick={() => onSelectChat(session.id)}
                      aria-current={selected ? "true" : undefined}
                    >
                      <strong>{session.title || "未命名对话"}</strong>
                      <span className="session-list-meta">{formatShortTime(session.updatedAt)}</span>
                      <span className="session-list-preview">{lastMessagePreview(session)}</span>
                    </button>
                    <button
                      className="icon-button"
                      type="button"
                      aria-label={"删除对话：" + (session.title || "未命名对话")}
                      onClick={() => onDeleteChat(session.id)}
                    >
                      <Trash2 size={16} aria-hidden />
                    </button>
                  </div>
                );
              })}
            </div>
          )}
          {selectedSessionId === ASSET_CHAT_DRAFT_ID && (
            <p className="field-status chat-draft-banner" role="status">
              草稿线程：发送后将创建新会话
            </p>
          )}
        </section>

        <section className="panel stack">
          <div className="chat-thread">
            {showEmptyThread ? (
              <div className="empty-module chat-empty-thread">
                <MessagesSquare size={28} aria-hidden />
                <p className="empty-hint">
                  {selectedSessionId === ASSET_CHAT_DRAFT_ID
                    ? "新对话已就绪。问点关于你认知资产的问题吧。"
                    : "问点什么吧——比如「我对 X 的判断有哪些」「最近一次专访留下了哪些问题」。"}
                </p>
                <div className="chat-suggestions" aria-label="推荐问法">
                  {suggestions.map((q) => (
                    <button
                      key={q}
                      type="button"
                      className="secondary-action compact-action"
                      disabled={sending}
                      onClick={() => {
                        setDraft(q);
                        inputRef.current?.focus();
                      }}
                    >
                      {q}
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              activeSession!.messages.map((msg) => {
                const isUser = msg.role === "user";
                const g = !isUser ? groundingLabel(msg.groundingMode) : null;
                return (
                  <div key={msg.id} className={isUser ? "chat-msg is-user" : "chat-msg is-assistant"}>
                    <div className="stack-xs">
                      <div className={isUser ? "chat-bubble is-user" : "chat-bubble"}>{msg.content}</div>
                      {g && <span className={g.className}>{g.text}</span>}
                      {!isUser && msg.citations && msg.citations.length > 0 && (
                        <ul className="clean-list stack-xs">
                          {msg.citations.map((citation, index) => (
                            <li key={citation.sourceType + ":" + citation.sourceId + ":" + index}>
                              <button
                                type="button"
                                className="secondary-action compact-action"
                                onClick={() => onCitationClick(citation)}
                                title={citation.snippet}
                              >
                                <Quote size={14} aria-hidden />
                                <span>
                                  [{citation.number ?? "?"}] ({citation.sourceLabel ?? "来源类型待确认"}){" "}
                                  {citation.title}
                                </span>
                              </button>
                            </li>
                          ))}
                        </ul>
                      )}
                      {!isUser && onStartInterview && (
                        <div className="form-actions">
                          <button
                            type="button"
                            className="text-button"
                            onClick={() => {
                              const lastUser = [...activeSession!.messages]
                                .reverse()
                                .find((m) => m.role === "user");
                              const hint = (lastUser?.content || msg.content).trim().slice(0, 80);
                              onStartInterview(hint);
                            }}
                          >
                            <Mic size={14} aria-hidden />
                            就这个开专访
                          </button>
                        </div>
                      )}
                    </div>
                  </div>
                );
              })
            )}
            {sending && (
              <div className="chat-msg is-assistant" aria-live="polite">
                <div className="chat-bubble chat-bubble-pending">正在检索资料并生成回答…</div>
              </div>
            )}
            <div ref={messagesEndRef} />
          </div>

          <div className="stack-sm">
            <label className="field-stack" htmlFor="asset-chat-draft">
              <span className="field-label">提问</span>
              <textarea
                id="asset-chat-draft"
                ref={inputRef}
                value={draft}
                rows={3}
                placeholder="向你的认知资产提问…（Enter 发送，Shift+Enter 换行）"
                disabled={sending}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={handleKeyDown}
              />
            </label>
            <div className="form-actions">
              <button
                className="primary-action"
                type="button"
                onClick={() => void handleSend()}
                disabled={!canSend}
                aria-busy={sending}
              >
                <SendHorizontal size={16} aria-hidden />
                {sending ? "发送中…" : "发送"}
              </button>
              {error && <span className="field-status is-danger">{error}</span>}
            </div>
          </div>
        </section>
      </div>
    </section>
  );
}

/** 供 App onSend catch 与单测复用：把 ApiError / Error 收成中文可行动文案。 */
export function formatChatSendError(err: unknown): string {
  if (err && typeof err === "object" && "status" in err) {
    const status = Number((err as { status: number }).status);
    const body = (err as { body?: unknown }).body;
    const apiMsg =
      body &&
      typeof body === "object" &&
      body !== null &&
      "error" in body &&
      typeof (body as { error: unknown }).error === "string"
        ? String((body as { error: string }).error).trim()
        : "";
    if (apiMsg) return apiMsg;
    if (status === 429) return "本时段 LLM 预算已用尽，请稍后重试。";
    if (status === 503) return "对话 LLM 未配置或不可用（常见于缺少 DASHSCOPE_API_KEY）。";
    if (status === 502) return "召回或生成失败，本轮未记录，请重试。";
    if (status === 422) return "消息不能为空。";
    if (status >= 500) return `服务端对话失败（${status}）。`;
  }
  if (err instanceof Error && err.message.trim()) {
    if (/failed to fetch|network|load failed|econnrefused/i.test(err.message)) {
      return "后端不可达，资产对话需要在线（检索接地 + 引用）。";
    }
    return err.message.trim();
  }
  return "发送失败：资产对话需要后端在线（检索接地 + 引用）。";
}
