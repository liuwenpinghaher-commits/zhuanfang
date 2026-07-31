import { useEffect, useRef, useState } from "react";
import { Bot, Headphones, MessageSquare, Mic, PenLine, Play, Trash2 } from "lucide-react";
import type {
  EvidenceAnchor,
  InterviewRawMaterial,
  InterviewStrategyDecision,
  ProductState
} from "../../domain/types";

interface SessionAudioMeta {
  exists: boolean;
  mime?: string;
  byteSize?: number;
  durationMs?: number | null;
  /** ISO wall-clock of when recording started; used to align turns to seek offsets. */
  recordingStartedAt?: string | null;
}

interface RawMaterialViewerProps {
  sessionId: string;
  state: ProductState;
  onAddAnnotation: (sessionId: string, turnId: string, text: string) => void;
  onRemoveAnnotation: (id: string) => void;
  getRawMaterial: (sessionId: string) => Promise<InterviewRawMaterial | null>;
  /** 若提供，加载完成后滚动到该轮并临时高亮（用于"查看原文出处"跳转）。 */
  focusTurnId?: string;
  /**
   * 若提供，拉取整场录音元数据；exists 时渲染录音播放器。失败静默。
   * role 区分受访者(默认/麦克风录音)与主持人(interviewer，TTS 合成音)两路；
   * 不传 role 兼容旧调用(=受访者)。
   */
  getAudioMeta?: (sessionId: string, role?: AudioRole) => Promise<SessionAudioMeta>;
  /** 若提供，给 <audio src> 用的整场录音流 URL（fetch-blob 回退路径，仅受访者路）。 */
  audioUrl?: (sessionId: string) => string;
  /**
   * 若提供，用 fetch 拉录音为 Blob（带上 client 配置的鉴权头），再用
   * URL.createObjectURL 回放——修复生产 bearer 鉴权下原生 <audio src> 取不到头会 401。
   * 优先于 audioUrl；返回 null（无录音）或失败时静默退回 audioUrl。
   * role 同上，区分受访者/主持人两路。
   */
  getAudioBlob?: (sessionId: string, role?: AudioRole) => Promise<Blob | null>;
}

type AudioRole = "interviewee" | "interviewer";

type LoadStatus = "loading" | "ready" | "empty" | "error";

function anchorHits(anchors: EvidenceAnchor[] | undefined, sessionId: string, turnId: string): boolean {
  return (anchors ?? []).some((anchor) => anchor.sessionId === sessionId && anchor.turnId === turnId);
}

function shorten(text: string, max = 80): string {
  const clean = text.trim();
  return clean.length > max ? clean.slice(0, max) + "…" : clean;
}

function describeAudio(meta: SessionAudioMeta): string | null {
  const parts: string[] = [];
  if (typeof meta.durationMs === "number" && meta.durationMs > 0) {
    const minutes = meta.durationMs / 60000;
    parts.push(minutes >= 1 ? `约 ${minutes.toFixed(1)} 分钟` : `约 ${Math.round(meta.durationMs / 1000)} 秒`);
  }
  if (typeof meta.byteSize === "number" && meta.byteSize > 0) {
    parts.push(`${(meta.byteSize / (1024 * 1024)).toFixed(1)} MB`);
  }
  return parts.length > 0 ? parts.join(" / ") : null;
}

export function RawMaterialViewer({
  sessionId,
  state,
  onAddAnnotation,
  onRemoveAnnotation,
  getRawMaterial,
  focusTurnId,
  getAudioMeta,
  audioUrl,
  getAudioBlob
}: RawMaterialViewerProps) {
  const [status, setStatus] = useState<LoadStatus>("loading");
  const [material, setMaterial] = useState<InterviewRawMaterial | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [highlightTurnId, setHighlightTurnId] = useState<string | null>(null);
  const [audioMeta, setAudioMeta] = useState<SessionAudioMeta | null>(null);
  const [audioBlobUrl, setAudioBlobUrl] = useState<string | null>(null);
  // 音频元数据/回放拉取的真实错误（404=确实无音频 → null 不算错误;5xx/网络错误必须暴露,
  // 不能把"有录音但读不到"掩盖成"无音频"的空态）。
  const [audioLoadError, setAudioLoadError] = useState<string | null>(null);
  // 主持人(interviewer)录音独立一路：单独的 meta + blob URL。
  const [hostAudioMeta, setHostAudioMeta] = useState<SessionAudioMeta | null>(null);
  const [hostAudioBlobUrl, setHostAudioBlobUrl] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);

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

  // 并行拉取整场录音元数据。404（确实无音频）由 API 层归一为 exists:false/null；
  // 这里的 catch 是真实错误（5xx/网络）——如实置错误态，不掩盖成"无音频"。
  useEffect(() => {
    if (!getAudioMeta) {
      return;
    }
    let cancelled = false;
    setAudioMeta(null);
    setAudioLoadError(null);
    getAudioMeta(sessionId)
      .then((meta) => {
        if (!cancelled) {
          setAudioMeta(meta);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setAudioMeta(null);
          setAudioLoadError(err instanceof Error && err.message ? err.message : "录音信息读取失败");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId, getAudioMeta]);

  // fetch-blob 回放：录音存在且提供了 getAudioBlob 时，用 fetch（带鉴权头）拉 Blob 并
  // 转成 object URL 回放。修复生产 bearer 鉴权下原生 <audio src> 取不到头会 401。
  // 切换 session / 卸载时 revokeObjectURL 释放，避免内存泄漏。失败一律静默退回 audioUrl。
  useEffect(() => {
    if (!getAudioBlob || !audioMeta?.exists) {
      return;
    }
    let cancelled = false;
    let createdUrl: string | null = null;
    getAudioBlob(sessionId)
      .then((blob) => {
        if (cancelled || !blob) {
          return;
        }
        createdUrl = URL.createObjectURL(blob);
        setAudioBlobUrl(createdUrl);
      })
      .catch(() => {
        /* 静默：退回 audioUrl 整段播放 */
      });
    return () => {
      cancelled = true;
      if (createdUrl) {
        URL.revokeObjectURL(createdUrl);
      }
      setAudioBlobUrl(null);
    };
  }, [sessionId, getAudioBlob, audioMeta?.exists]);

  // 并行拉取主持人(interviewer)录音元数据。多数会话(文本路 / 语音但未截到流)没有这一路，
  // exists:false 时不渲染。best-effort，失败静默。
  useEffect(() => {
    if (!getAudioMeta) {
      return;
    }
    let cancelled = false;
    setHostAudioMeta(null);
    getAudioMeta(sessionId, "interviewer")
      .then((meta) => {
        if (!cancelled) {
          setHostAudioMeta(meta);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setHostAudioMeta(null);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId, getAudioMeta]);

  // 主持人录音 fetch-blob 回放：存在且提供 getAudioBlob 时拉 Blob 转 object URL。
  // 切换 session / 卸载时 revokeObjectURL 释放。失败静默(无回退 URL，主持人路无 audioUrl)。
  useEffect(() => {
    if (!getAudioBlob || !hostAudioMeta?.exists) {
      return;
    }
    let cancelled = false;
    let createdUrl: string | null = null;
    getAudioBlob(sessionId, "interviewer")
      .then((blob) => {
        if (cancelled || !blob) {
          return;
        }
        createdUrl = URL.createObjectURL(blob);
        setHostAudioBlobUrl(createdUrl);
      })
      .catch(() => {
        /* 静默：无主持人回放 */
      });
    return () => {
      cancelled = true;
      if (createdUrl) {
        URL.revokeObjectURL(createdUrl);
      }
      setHostAudioBlobUrl(null);
    };
  }, [sessionId, getAudioBlob, hostAudioMeta?.exists]);

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
        <span className="text-sm text-secondary">正在加载原始材料…</span>
      </div>
    );
  }

  if (status === "empty") {
    return (
      <div className="panel mt-3">
        <p className="empty-hint">原始材料未找到 / 该会话尚未降冷。</p>
      </div>
    );
  }

  if (status === "error" || !material) {
    return (
      <div className="panel mt-3">
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

  // 回放源：优先 fetch-blob 的 object URL（带鉴权头，生产安全），未拿到则退回 audioUrl（本地/dev）。
  const playbackSrc = audioBlobUrl ?? (audioUrl ? audioUrl(sessionId) : null);
  const showAudio = Boolean(audioMeta?.exists && playbackSrc);
  const audioCaption = audioMeta ? describeAudio(audioMeta) : null;

  // 主持人(interviewer)录音回放：只走 fetch-blob(无 audioUrl 回退)。无逐轮 seek——
  // 主持人音频是拼接的 AI 话、无连续时间线，整段播放即可。
  const showHostAudio = Boolean(hostAudioMeta?.exists && hostAudioBlobUrl);
  const hostAudioCaption = hostAudioMeta ? describeAudio(hostAudioMeta) : null;

  // 逐轮 seek 的起始墙钟：有它才算偏移、渲染"▶ 播这一段"。
  const recordingStartedAt = audioMeta?.recordingStartedAt ?? null;
  const recordingStartedMs = recordingStartedAt ? Date.parse(recordingStartedAt) : NaN;
  const durationMs = typeof audioMeta?.durationMs === "number" ? audioMeta.durationMs : null;

  /** 该轮相对录音起点的偏移（秒）；越界 / 无起点 / 无播放器时返回 null（不渲染该轮按钮）。 */
  function turnOffsetSec(turnTimestamp: string): number | null {
    if (!showAudio || Number.isNaN(recordingStartedMs)) {
      return null;
    }
    const turnMs = Date.parse(turnTimestamp);
    if (Number.isNaN(turnMs)) {
      return null;
    }
    const offsetSec = (turnMs - recordingStartedMs) / 1000;
    if (offsetSec < 0) {
      return null;
    }
    // durationMs 未知则不卡上界；已知则越界丢弃（防止 seek 到录音之外）。
    if (durationMs !== null && offsetSec * 1000 > durationMs) {
      return null;
    }
    return offsetSec;
  }

  function playFromOffset(offsetSec: number) {
    const el = audioRef.current;
    if (!el) {
      return;
    }
    el.currentTime = offsetSec;
    void el.play().catch(() => {
      /* 浏览器可能因未交互拒绝自动播放；用户可手动用整段播放器 */
    });
  }

  return (
    <div ref={containerRef} className="panel" style={{ marginTop: "0.75rem", display: "flex", flexDirection: "column", gap: "0.85rem" }}>
      {audioLoadError && (
        <p className="field-help" role="alert" style={{ color: "var(--danger, #e5484d)" }}>
          录音读取失败：{audioLoadError}（这不代表本场没有录音，请稍后重试。）
        </p>
      )}
      {showAudio && playbackSrc && (
        <section
          className="field-stack"
          style={{
            gap: "0.5rem",
            paddingBottom: "0.85rem",
            borderBottom: "1px solid var(--border-subtle, rgba(255,255,255,0.06))"
          }}
>
          <div className="row">
            <span className="field-label row">
              <Headphones size={14} aria-hidden="true" />
              受访者录音
            </span>
            {audioCaption && <span className="field-help tabular-nums">{audioCaption}</span>}
          </div>
          <audio ref={audioRef} controls preload="metadata" src={playbackSrc} className="w-full" />
        </section>
      )}
      {showHostAudio && hostAudioBlobUrl && (
        <section
          className="field-stack"
          style={{
            gap: "0.5rem",
            paddingBottom: "0.85rem",
            borderBottom: "1px solid var(--border-subtle, rgba(255,255,255,0.06))"
          }}
>
          <div className="row">
            <span className="field-label row">
              <Mic size={14} aria-hidden="true" />
              主持人录音
            </span>
            {hostAudioCaption && <span className="field-help tabular-nums">{hostAudioCaption}</span>}
          </div>
          {/* 主持人音频无逐轮 seek：整段连续播放即可。 */}
          <audio controls preload="metadata" src={hostAudioBlobUrl} className="w-full" />
        </section>
      )}
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
            <div className="row">
              <span className="field-label row">
                {turn.role === "assistant" ? <Bot size={14} aria-hidden="true" /> : <MessageSquare size={14} aria-hidden="true" />}
                {turn.role === "assistant" ? "主持人" : "我"}
              </span>
              <span className="field-help tabular-nums">
                {new Date(turn.timestamp).toLocaleString("zh-CN")}
              </span>
              {(() => {
                // 仅当能算出有效偏移（有起始墙钟、不越界、有播放器）才渲染"▶ 播这一段"。
                // 无录音 / 无 recordingStartedAt / 越界则降级：整段播放器仍可用。
                const offsetSec = turnOffsetSec(turn.timestamp);
                if (offsetSec === null) {
                  return null;
                }
                return (
                  <button
                    className="icon-button"
                    type="button"
                    aria-label="从这一轮开始播放录音"
                    title="播这一段"
                    onClick={() => playFromOffset(offsetSec)}
                    style={{ display: "inline-flex", alignItems: "center", gap: "0.25rem", marginLeft: "auto", fontSize: "0.78rem" }}
>
                    <Play size={13} aria-hidden="true" />
                    播这一段
                  </button>
                );
              })()}
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
                <strong className="text-sm">AI 为何这么问：</strong>
                {trace.label && <span>「{trace.label}」</span>}
                {trace.reason && <span> {trace.reason}</span>}
              </div>
            )}

            {sources.length > 0 && (
              <ul className="clean-list" >
                {sources.map((sourceText, idx) => (
                  <li key={turn.id + "-src-" + idx} className="field-help mb-3">
                    → 由此产生：{sourceText}
                  </li>
                ))}
              </ul>
            )}

            {annotations.length > 0 && (
              <ul className="clean-list" >
                {annotations.map((annotation) => (
                  <li
                    key={annotation.id}
                    className="row-between"
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
              <label className="field-stack flex-1">
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
                  }} />
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
