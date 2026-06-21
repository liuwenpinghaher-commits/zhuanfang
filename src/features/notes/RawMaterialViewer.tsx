import { useEffect, useRef, useState } from "react";
import { Bot, MessageSquare, PenLine, Trash2 } from "lucide-react";
import type {
  EvidenceAnchor,
  InterviewRawMaterial,
  InterviewStrategyDecision,
  ProductState
} from "../../domain/types";

interface RawMaterialViewerProps {
  sessionId: string;
  state: ProductState;
  onAddAnnotation: (sessionId: string, turnId: string, text: string) => void;
  onRemoveAnnotation: (id: string) => void;
  getRawMaterial: (sessionId: string) => Promise<InterviewRawMaterial | null>;
  /** 若提供，加载完成后滚动到该轮并临时高亮（用于"查看原文出处"跳转）。 */
  focusTurnId?: string;
}

type LoadStatus = "loading" | "ready" | "empty" | "error";

function anchorHits(anchors: EvidenceAnchor[] | undefined, sessionId: string, turnId: string): boolean {
  return (anchors ?? []).some((anchor) => anchor.sessionId === sessionId && anchor.turnId === turnId);
}

function shorten(text: string, max = 80): string {
  const clean = text.trim();
  return clean.length > max ? clean.slice(0, max) + "…" : clean;
}

export function RawMaterialViewer({
  sessionId,
  state,
  onAddAnnotation,
  onRemoveAnnotation,
  getRawMaterial,
  focusTurnId
}: RawMaterialViewerProps) {
  const [status, setStatus] = useState<LoadStatus>("loading");
  const [material, setMaterial] = useState<InterviewRawMaterial | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [highlightTurnId, setHighlightTurnId] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    setStatus("loading");
    setMaterial(null);
    setErrorMessage(null);
    getRawMaterial(sessionId)
      .then((result) => {
        if (cancelled) {
          return;
        }
        if (!result) {
          setStatus("empty");
          return;
        }
        setMaterial(result);
        setStatus("ready");
      })
      .catch((err: unknown) => {
        if (cancelled) {
          return;
        }
        setErrorMessage(err instanceof Error ? err.message : "加载原始材料失败");
        setStatus("error");
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId, getRawMaterial]);

  // 加载完成后，若有 focusTurnId 则滚动到该轮并临时高亮。
  useEffect(() => {
    if (status !== "ready" || !focusTurnId || !containerRef.current) {
      return;
    }
    const el = containerRef.current.querySelector<HTMLElement>(`[data-turn-id="${focusTurnId}"]`);
    if (!el) {
      return;
    }
    el.scrollIntoView({ block: "center", behavior: "smooth" });
    setHighlightTurnId(focusTurnId);
    const timer = setTimeout(() => setHighlightTurnId(null), 3500);
    return () => clearTimeout(timer);
  }, [status, focusTurnId, material]);

  if (status === "loading") {
    return (
      <div className="panel" style={{ marginTop: "0.75rem", display: "flex", alignItems: "center", gap: "0.6rem" }}>
        <span className="spinner" aria-hidden="true" />
        <span style={{ color: "var(--text-secondary)", fontSize: "0.875rem" }}>正在加载原始材料…</span>
      </div>
    );
  }

  if (status === "empty") {
    return (
      <div className="panel" style={{ marginTop: "0.75rem" }}>
        <p className="empty-hint">原始材料未找到 / 该会话尚未降冷。</p>
      </div>
    );
  }

  if (status === "error" || !material) {
    return (
      <div className="panel" style={{ marginTop: "0.75rem" }}>
        <p className="empty-hint" style={{ color: "var(--action-danger)" }}>
          {errorMessage ?? "加载原始材料失败"}
        </p>
      </div>
    );
  }

  // strategyTrace 按 turnIndex 建索引；缺省回退到 assistant 轮的顺序匹配。
  const traceByIndex = new Map<number, InterviewStrategyDecision>();
  material.strategyTrace.forEach((decision) => {
    if (typeof decision.turnIndex === "number" && !traceByIndex.has(decision.turnIndex)) {
      traceByIndex.set(decision.turnIndex, decision);
    }
  });
  let assistantOrdinal = -1;

  return (
    <div ref={containerRef} className="panel" style={{ marginTop: "0.75rem", display: "flex", flexDirection: "column", gap: "0.85rem" }}>
      {material.turns.map((turn, turnIndex) => {
        let trace: InterviewStrategyDecision | undefined;
        if (turn.role === "assistant") {
          assistantOrdinal += 1;
          trace = traceByIndex.get(turnIndex) ?? material.strategyTrace[assistantOrdinal];
        }
        const annotations = state.interviewAnnotations.filter((a) => a.turnId === turn.id);
        const draft = drafts[turn.id] ?? "";

        // 反向溯源：扫 memoryRecords + points/decisions/debts 的 evidenceAnchors。
        const sources: string[] = [];
        state.memoryRecords.forEach((record) => {
          if (anchorHits(record.evidenceAnchors, sessionId, turn.id)) {
            sources.push(shorten(record.text));
          }
        });
        state.points.forEach((point) => {
          if (anchorHits(point.evidenceAnchors, sessionId, turn.id)) {
            sources.push(shorten(point.title));
          }
        });
        state.decisions.forEach((decision) => {
          if (anchorHits(decision.evidenceAnchors, sessionId, turn.id)) {
            sources.push(shorten(decision.title));
          }
        });
        state.debts.forEach((debt) => {
          if (anchorHits(debt.evidenceAnchors, sessionId, turn.id)) {
            sources.push(shorten(debt.concept));
          }
        });

        function submitAnnotation() {
          const text = draft.trim();
          if (!text) {
            return;
          }
          onAddAnnotation(sessionId, turn.id, text);
          setDrafts((prev) => ({ ...prev, [turn.id]: "" }));
        }

        return (
          <article
            key={turn.id}
            data-turn-id={turn.id}
            className="field-stack"
            style={{
              gap: "0.5rem",
              paddingBottom: "0.85rem",
              borderBottom: "1px solid var(--border-subtle, rgba(255,255,255,0.06))",
              ...(highlightTurnId === turn.id
                ? {
                    borderRadius: "0.5rem",
                    padding: "0.6rem",
                    background: "var(--surface-highlight, rgba(96,165,250,0.16))",
                    boxShadow: "0 0 0 2px var(--accent, rgba(96,165,250,0.55))",
                    transition: "background 0.3s ease, box-shadow 0.3s ease"
                  }
                : { transition: "background 0.3s ease, box-shadow 0.3s ease" })
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
              <span className="field-label" style={{ display: "flex", alignItems: "center", gap: "0.35rem" }}>
                {turn.role === "assistant" ? <Bot size={14} aria-hidden="true" /> : <MessageSquare size={14} aria-hidden="true" />}
                {turn.role === "assistant" ? "主持人" : "我"}
              </span>
              <span className="field-help" style={{ fontVariantNumeric: "tabular-nums" }}>
                {new Date(turn.timestamp).toLocaleString("zh-CN")}
              </span>
            </div>
            <p style={{ margin: 0, lineHeight: 1.6, whiteSpace: "pre-wrap" }}>{turn.content}</p>

            {turn.role === "assistant" && trace && (trace.reason || trace.label) && (
              <div
                style={{
                  fontSize: "0.8125rem",
                  color: "var(--text-secondary)",
                  background: "var(--surface-subtle, rgba(255,255,255,0.04))",
                  borderRadius: "0.5rem",
                  padding: "0.5rem 0.65rem"
                }}
              >
                <strong style={{ color: "var(--text-primary)" }}>AI 为何这么问：</strong>
                {trace.label && <span>「{trace.label}」</span>}
                {trace.reason && <span> {trace.reason}</span>}
              </div>
            )}

            {sources.length > 0 && (
              <ul className="clean-list" style={{ margin: 0 }}>
                {sources.map((sourceText, idx) => (
                  <li key={turn.id + "-src-" + idx} className="field-help" style={{ paddingBottom: "0.25rem" }}>
                    → 由此产生：{sourceText}
                  </li>
                ))}
              </ul>
            )}

            {annotations.length > 0 && (
              <ul className="clean-list" style={{ margin: 0 }}>
                {annotations.map((annotation) => (
                  <li
                    key={annotation.id}
                    style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "0.6rem" }}
                  >
                    <span style={{ fontSize: "0.875rem", display: "inline-flex", alignItems: "center", gap: "0.4rem" }}><PenLine size={13} /> {annotation.text}</span>
                    <button
                      className="icon-button"
                      type="button"
                      aria-label={"删除旁注：" + annotation.text}
                      onClick={() => onRemoveAnnotation(annotation.id)}
                      style={{ flexShrink: 0 }}
                    >
                      <Trash2 size={14} />
                    </button>
                  </li>
                ))}
              </ul>
            )}

            <div className="correction-row" style={{ gap: "0.5rem" }}>
              <label className="field-stack" style={{ flex: 1 }}>
                <input
                  value={draft}
                  maxLength={300}
                  placeholder="为这一轮加一条旁注…"
                  onChange={(e) => setDrafts((prev) => ({ ...prev, [turn.id]: e.target.value }))}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      submitAnnotation();
                    }
                  }}
                />
              </label>
              <button
                className="secondary-action"
                type="button"
                onClick={submitAnnotation}
                disabled={!draft.trim()}
              >
                加旁注
              </button>
            </div>
          </article>
        );
      })}
      {material.turns.length === 0 && <p className="empty-hint">这份原始材料没有任何对话轮次。</p>}
    </div>
  );
}
