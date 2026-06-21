import { MessagesSquare, Plus, Quote, SendHorizontal, Trash2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { HeaderBlock } from "../../components/HeaderBlock";
import type { ChatCitation, ChatSession, KnowledgeSourceType, ProductState } from "../../domain/types";

interface AssetChatViewProps {
  state: ProductState;
  onSend: (sessionId: string | null, message: string) => Promise<void>;
  onNewChat: () => void;
  onDeleteChat: (sessionId: string) => void;
  onSelectChat: (sessionId: string) => void;
  selectedSessionId: string | null;
  onCitationClick: (c: ChatCitation) => void;
}

const SOURCE_TYPE_LABEL: Record<KnowledgeSourceType, string> = {
  note: "笔记",
  memory: "记忆",
  theme: "主题",
  point: "观点",
  decision: "决策",
  debt: "知识债",
  transcript: "逐字稿",
  material: "素材"
};

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
            <Plus size={16} style={{ marginRight: "0.4rem" }} />
            新对话
          </button>
        }
      />

      <div className="asset-chat-grid">
        {/* 左列：会话列表 */}
        <section className="panel" style={{ minWidth: 0 }}>
          <div className="panel-title">
            <MessagesSquare size={18} />
            <h2>会话（{sessions.length}）</h2>
          </div>
          {sessions.length === 0 ? (
            <p className="field-help">还没有对话。点右上角「新对话」，问点关于你认知资产的问题。</p>
          ) : (
            <ul className="clean-list">
              {sessions.map((session) => {
                const selected = session.id === activeSession?.id;
                return (
                  <li
                    key={session.id}
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                      gap: "0.5rem",
                      borderRadius: "0.5rem",
                      padding: "0.35rem 0.5rem",
                      background: selected ? "var(--color-surface-active, rgba(99,102,241,0.12))" : "transparent"
                    }}
                  >
                    <button
                      type="button"
                      onClick={() => onSelectChat(session.id)}
                      aria-current={selected ? "true" : undefined}
                      style={{
                        flex: 1,
                        minWidth: 0,
                        textAlign: "left",
                        background: "transparent",
                        border: "none",
                        cursor: "pointer",
                        padding: 0,
                        color: "inherit",
                        fontWeight: selected ? 600 : 400,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap"
                      }}
                    >
                      {session.title || "未命名对话"}
                    </button>
                    <button
                      className="icon-button"
                      type="button"
                      aria-label={"删除对话：" + (session.title || "未命名对话")}
                      onClick={() => onDeleteChat(session.id)}
                    >
                      <Trash2 size={16} />
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        {/* 右列：消息流 + 输入 */}
        <section className="panel" style={{ minWidth: 0, display: "flex", flexDirection: "column", gap: "0.85rem" }}>
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: "0.75rem",
              maxHeight: "60vh",
              overflowY: "auto"
            }}
          >
            {!activeSession || activeSession.messages.length === 0 ? (
              <p className="field-help">问点什么吧——比如「我对 X 的判断有哪些」「最近一次专访留下了哪些问题」。</p>
            ) : (
              activeSession.messages.map((msg) => {
                const isUser = msg.role === "user";
                return (
                  <div
                    key={msg.id}
                    style={{
                      display: "flex",
                      flexDirection: "column",
                      alignItems: isUser ? "flex-end" : "flex-start",
                      gap: "0.4rem"
                    }}
                  >
                    <div
                      style={{
                        maxWidth: "80%",
                        borderRadius: "0.85rem",
                        padding: "0.6rem 0.85rem",
                        whiteSpace: "pre-wrap",
                        wordBreak: "break-word",
                        background: isUser
                          ? "var(--color-accent, #6366f1)"
                          : "var(--color-surface-muted, rgba(148,163,184,0.16))",
                        color: isUser ? "var(--color-on-accent, #fff)" : "inherit"
                      }}
                    >
                      {msg.content}
                    </div>
                    {!isUser && msg.citations && msg.citations.length > 0 && (
                      <ul
                        className="clean-list"
                        style={{ maxWidth: "80%", display: "flex", flexDirection: "column", gap: "0.3rem" }}
                      >
                        {msg.citations.map((citation, index) => (
                          <li key={citation.sourceType + ":" + citation.sourceId + ":" + index}>
                            <button
                              type="button"
                              className="secondary-action"
                              onClick={() => onCitationClick(citation)}
                              title={citation.snippet}
                              style={{
                                display: "inline-flex",
                                alignItems: "center",
                                gap: "0.35rem",
                                fontSize: "0.8rem",
                                maxWidth: "100%"
                              }}
                            >
                              <Quote size={14} />
                              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                                [{index + 1}] ({SOURCE_TYPE_LABEL[citation.sourceType] ?? citation.sourceType}) {citation.title}
                              </span>
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                );
              })
            )}
            <div ref={messagesEndRef} />
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
            <label className="field-stack">
              <span className="field-label">提问</span>
              <textarea
                value={draft}
                rows={3}
                placeholder="向你的认知资产提问…（Enter 发送，Shift+Enter 换行）"
                disabled={sending}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={handleKeyDown}
              />
            </label>
            <div style={{ display: "flex", alignItems: "center", gap: "0.75rem" }}>
              <button className="primary-action" type="button" onClick={handleSend} disabled={!canSend}>
                <SendHorizontal size={16} style={{ marginRight: "0.4rem" }} />
                {sending ? "发送中…" : "发送"}
              </button>
              {error && <span style={{ color: "var(--color-danger, #ef4444)", fontSize: "0.85rem" }}>{error}</span>}
            </div>
          </div>
        </section>
      </div>
    </section>
  );
}
