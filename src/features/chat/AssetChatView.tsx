import { MessagesSquare, Plus, Quote, SendHorizontal, Trash2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { HeaderBlock } from "../../components/HeaderBlock";
import type { ChatCitation, ChatSession, ProductState } from "../../domain/types";

interface AssetChatViewProps {
  state: ProductState;
  onSend: (sessionId: string | null, message: string) => Promise<void>;
  onNewChat: () => void;
  onDeleteChat: (sessionId: string) => void;
  onSelectChat: (sessionId: string) => void;
  selectedSessionId: string | null;
  onCitationClick: (c: ChatCitation) => void;
}

function sortByUpdatedDesc(sessions: ChatSession[]): ChatSession[] {
  return [...sessions].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function AssetChatView({
  state,
  onSend,
  onNewChat,
  onDeleteChat,
  onSelectChat,
  selectedSessionId,
  onCitationClick
}: AssetChatViewProps) {
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const sessions = useMemo(() => sortByUpdatedDesc(state.chatSessions), [state.chatSessions]);

  // 选中会话：优先匹配 selectedSessionId，否则取最近一个（按 updatedAt 倒序的第一个）。
  const activeSession = useMemo(() => {
    if (selectedSessionId) {
      const matched = sessions.find((item) => item.id === selectedSessionId);
      if (matched) {
        return matched;
      }
    }
    return sessions[0] ?? null;
  }, [sessions, selectedSessionId]);

  const canSend = draft.trim().length > 0 && !sending;

  // 新消息后自动滚到底,避免长对话把输入框推出屏幕、需手动滚动才能继续。
  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [activeSession?.id, activeSession?.messages.length]);

  async function handleSend() {
    const message = draft.trim();
    if (!message || sending) {
      return;
    }
    setSending(true);
    setError(null);
    try {
      await onSend(activeSession?.id ?? null, message);
      setDraft("");
    } catch {
      setError("发送失败：资产对话需要后端在线（检索接地 + 引用）。");
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

  return (
    <section className="view-stack">
      <HeaderBlock
        eyebrow="认知资产 · 资产对话"
        title="与你的认知资产对话"
        subtitle="基于已沉淀的笔记、记忆、主题与素材回答问题，并给出可点击跳源的引用。"
        action={
          <button className="secondary-action" type="button" onClick={onNewChat}>
            <Plus size={16} className="icon-inline" />
            新对话
          </button>
        } />

      <div className="chat-layout">
        <section className="panel">
          <div className="panel-title">
            <MessagesSquare size={18} aria-hidden />
            <h2>会话（{sessions.length}）</h2>
          </div>
          {sessions.length === 0 ? (
            <p className="field-help">还没有对话。点右上角「新对话」，问点关于你认知资产的问题。</p>
          ) : (
            <div className="session-list">
              {sessions.map((session) => {
                const selected = session.id === activeSession?.id;
                return (
                  <div key={session.id} className="row">
                    <button
                      type="button"
                      className={selected ? "session-list-item is-active flex-1" : "session-list-item flex-1"}
                      onClick={() => onSelectChat(session.id)}
                      aria-current={selected ? "true" : undefined}
>
                      <strong>{session.title || "未命名对话"}</strong>
                    </button>
                    <button
                      className="icon-button"
                      type="button"
                      aria-label={"删除对话：" + (session.title || "未命名对话")}
                      onClick={() => onDeleteChat(session.id)}>
                      <Trash2 size={16} aria-hidden />
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </section>

        <section className="panel stack">
          <div className="chat-thread">
            {!activeSession || activeSession.messages.length === 0 ? (
              <p className="field-help">问点什么吧——比如「我对 X 的判断有哪些」「最近一次专访留下了哪些问题」。</p>
            ) : (
              activeSession.messages.map((msg) => {
                const isUser = msg.role === "user";
                return (
                  <div key={msg.id} className={isUser ? "chat-msg is-user" : "chat-msg is-assistant"}>
                    <div className="stack-xs">
                      <div className={isUser ? "chat-bubble is-user" : "chat-bubble"}>{msg.content}</div>
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
                                  [{citation.number ?? "?"}] ({citation.sourceLabel ?? "来源类型待确认"}) {citation.title}
                                </span>
                              </button>
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  </div>
                );
              })
            )}
            <div ref={messagesEndRef} />
          </div>

          <div className="stack-sm">
            <label className="field-stack" htmlFor="asset-chat-draft">
              <span className="field-label">提问</span>
              <textarea
                id="asset-chat-draft"
                value={draft}
                rows={3}
                placeholder="向你的认知资产提问…（Enter 发送，Shift+Enter 换行）"
                disabled={sending}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={handleKeyDown} />
            </label>
            <div className="form-actions">
              <button className="primary-action" type="button" onClick={handleSend} disabled={!canSend} aria-busy={sending}>
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
