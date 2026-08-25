import {
  Database,
  FileText,
  MessageSquare,
  Play,
  RefreshCw,
  Search,
  SendHorizontal,
  Trash2,
  Upload
} from "lucide-react";
import { useEffect, useMemo, useState, type ChangeEvent, type KeyboardEvent } from "react";
import type { RagCitation, RagQueryResponse } from "../../api/productApi.types";
import { HeaderBlock } from "../../components/HeaderBlock";
import type { ImportSource, InterviewMode, ProductState } from "../../domain/types";

export interface MaterialImportResult {
  sourceId: string;
  candidateCount: number;
  chunkCount?: number;
  embeddedChunkCount?: number;
  embeddingReady?: boolean;
  warning?: string;
}

interface MaterialLibraryViewProps {
  state: ProductState;
  onImport: (title: string, content: string) => Promise<MaterialImportResult>;
  onRebuildIndex: () => Promise<{ chunkCount: number }>;
  onDeleteSource: (sourceId: string) => void;
  /**
   * 就导入资料提问：走 POST /api/rag/query（仅 ragChunks），与资产对话 /api/chat 分离。
   * 未接线时不展示提问面板。
   */
  onAskMaterials?: (question: string) => Promise<RagQueryResponse>;
  onReviewMemory?: (sourceId?: string) => void;
  onStartInterview?: (mode?: InterviewMode, topicHint?: string, relatedThemeIds?: string[]) => void;
  onOpenAssetChat?: (sourceTitle?: string) => void;
  onOpenTrack?: (themeId: string) => void;
  /** 从资产对话 citation 跳入时展开对应素材。 */
  focusSourceId?: string | null;
  /** 嵌在「资料」容器里时隐藏页头。 */
  embedded?: boolean;
}

const SOURCE_TYPE_LABEL: Record<ImportSource["sourceType"], string> = {
  text: "文本",
  webpage: "网页"
};

const SENSITIVITY_LABEL: Record<ImportSource["sensitivity"], string> = {
  normal: "常规",
  sensitive: "敏感"
};

const IMPORT_CONTENT_SOFT_MAX = 256 * 1024;

function formatDate(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString("zh-CN");
}

function errMessage(err: unknown, fallback: string): string {
  if (err instanceof Error && err.message.trim()) return err.message.trim();
  return fallback;
}

export function MaterialLibraryView({
  state,
  onImport,
  onRebuildIndex,
  onDeleteSource,
  onAskMaterials,
  onReviewMemory,
  onStartInterview,
  onOpenAssetChat,
  onOpenTrack,
  focusSourceId = null,
  embedded = false
}: MaterialLibraryViewProps) {
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [importing, setImporting] = useState(false);
  const [importHint, setImportHint] = useState<string | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const [lastImport, setLastImport] = useState<MaterialImportResult | null>(null);
  const [rebuilding, setRebuilding] = useState(false);
  const [rebuildHint, setRebuildHint] = useState<string | null>(null);
  const [rebuildError, setRebuildError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [deleteHint, setDeleteHint] = useState<string | null>(null);
  const [askQuestion, setAskQuestion] = useState("");
  const [asking, setAsking] = useState(false);
  const [askError, setAskError] = useState<string | null>(null);
  const [askAnswer, setAskAnswer] = useState<string | null>(null);
  const [askCitations, setAskCitations] = useState<RagCitation[]>([]);

  useEffect(() => {
    if (!focusSourceId) return;
    setExpandedId(focusSourceId);
    requestAnimationFrame(() => {
      document
        .querySelector(`[data-material-source="${focusSourceId}"]`)
        ?.scrollIntoView({ behavior: "smooth", block: "center" });
    });
  }, [focusSourceId]);

  const sources = useMemo(
    () => [...state.importSources].sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    [state.importSources]
  );
  const visibleSources = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return sources;
    return sources.filter((source) => {
      const themeNames = (source.relatedThemeIds ?? [])
        .map((id) => state.themes.find((t) => t.id === id)?.name ?? "")
        .join(" ");
      return `${source.title} ${source.content} ${themeNames}`.toLowerCase().includes(q);
    });
  }, [sources, query, state.themes]);

  const materialChunks = state.ragChunks.filter((c) => c.usage === "interview-context");
  const embeddedChunks = materialChunks.filter((c) => Array.isArray(c.embedding) && c.embedding.length > 0).length;
  const pendingFromImports = state.memoryCandidates.filter(
    (c) => c.status === "pending" && c.sourceType === "import_source"
  ).length;

  const contentLen = content.length;
  const canImport = content.trim().length > 0 && !importing && contentLen <= IMPORT_CONTENT_SOFT_MAX;

  async function handleFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    const text = typeof file.text === "function" ? await file.text() : await readAsText(file);
    setContent(text);
    if (!title.trim()) {
      setTitle(file.name.replace(/\.[^.]+$/, ""));
    }
    event.target.value = "";
  }

  async function handleImport() {
    if (!content.trim() || contentLen > IMPORT_CONTENT_SOFT_MAX) return;
    setImporting(true);
    setImportHint(null);
    setImportError(null);
    setLastImport(null);
    setDeleteHint(null);
    try {
      const result = await onImport(title.trim() || "未命名导入资料", content);
      setTitle("");
      setContent("");
      setLastImport(result);
      const chunks = typeof result.chunkCount === "number" ? result.chunkCount : undefined;
      const embedded = typeof result.embeddedChunkCount === "number" ? result.embeddedChunkCount : undefined;
      const vectorPart =
        chunks != null && embedded != null ? ` · 向量 ${embedded}/${chunks}` : chunks != null ? ` · ${chunks} 块` : "";
      const warn = result.warning || result.embeddingReady === false ? "（向量未完全就绪）" : "";
      setImportHint(`导入完成：已抽 ${result.candidateCount} 条候选记忆${vectorPart}${warn}`);
      setExpandedId(result.sourceId);
    } catch (err) {
      setImportError(errMessage(err, "导入失败：请检查后端与配置后重试。"));
    } finally {
      setImporting(false);
    }
  }

  async function handleRebuild() {
    setRebuilding(true);
    setRebuildHint(null);
    setRebuildError(null);
    const before = materialChunks.length;
    try {
      const { chunkCount } = await onRebuildIndex();
      setRebuildHint(`重建完成：${before} → ${chunkCount} 块。`);
    } catch (err) {
      setRebuildError(errMessage(err, "重建失败：知识索引需要后端在线。"));
    } finally {
      setRebuilding(false);
    }
  }

  function handleDelete(sourceId: string, sourceTitle: string) {
    onDeleteSource(sourceId);
    setDeleteHint(`已删除「${sourceTitle}」。列表与知识索引将随后更新。`);
    if (expandedId === sourceId) setExpandedId(null);
    if (lastImport?.sourceId === sourceId) setLastImport(null);
  }

  async function handleAsk() {
    if (!onAskMaterials || asking) return;
    const question = askQuestion.trim();
    if (!question) return;
    setAsking(true);
    setAskError(null);
    setAskAnswer(null);
    setAskCitations([]);
    try {
      const result = await onAskMaterials(question);
      setAskAnswer(result.answer ?? "");
      setAskCitations(Array.isArray(result.citations) ? result.citations : []);
    } catch (err) {
      setAskError(formatRagAskError(err));
    } finally {
      setAsking(false);
    }
  }

  function handleAskKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void handleAsk();
    }
  }

  const canAsk = Boolean(onAskMaterials) && askQuestion.trim().length > 0 && !asking;

  return (
    <section className="view-stack">
      {!embedded && (
      <HeaderBlock
        eyebrow="资料 · 导入与索引"
        title="导入资料与知识索引"
        subtitle="原料车间：导入文本 → 切块索引 → 只问这份资料 → 抽取待审记忆。审核在「记忆」，全书问答走资料·问全书。"
        action={
          <div className="header-actions material-header-actions">
            <button
              className="secondary-action"
              type="button"
              onClick={handleRebuild}
              disabled={rebuilding}
              aria-busy={rebuilding}
            >
              <RefreshCw size={16} aria-hidden />
              {rebuilding ? "重建中…" : "重建知识索引"}
            </button>
            {rebuildHint && <span className="field-status is-success">{rebuildHint}</span>}
            {rebuildError && <span className="field-status is-danger">{rebuildError}</span>}
          </div>
        }
      />
      )}
      {embedded && (
        <div className="header-actions material-header-actions">
          <button
            className="secondary-action"
            type="button"
            onClick={handleRebuild}
            disabled={rebuilding}
            aria-busy={rebuilding}
          >
            <RefreshCw size={16} aria-hidden />
            {rebuilding ? "重建中…" : "重建知识索引"}
          </button>
          {rebuildHint && <span className="field-status is-success">{rebuildHint}</span>}
          {rebuildError && <span className="field-status is-danger">{rebuildError}</span>}
        </div>
      )}

      <section className="panel material-index-health" aria-label="索引健康">
        <div className="panel-title">
          <Database size={18} aria-hidden />
          <h2>索引概览</h2>
        </div>
        <p className="field-help">
          素材 {sources.length} 份 · 访谈上下文块 {materialChunks.length} · 已向量化 {embeddedChunks}
          {pendingFromImports > 0 ? ` · 待审导入候选 ${pendingFromImports}` : ""}
        </p>
        {pendingFromImports > 0 && onReviewMemory && (
          <div className="form-actions">
            <button className="secondary-action" type="button" onClick={() => onReviewMemory()}>
              去记忆审核候选（{pendingFromImports}）
            </button>
          </div>
        )}
      </section>

      <section className="panel">
        <div className="panel-title">
          <Upload size={18} aria-hidden />
          <h2>导入资料</h2>
        </div>
        <p className="field-help">
          可直接粘贴正文，或上传 .txt / .md。导入后会抽取候选记忆，请到「记忆」审核后才会进入长期召回。
        </p>
        <div className="field-grid">
          <label className="field-stack" htmlFor="material-import-title">
            <span className="field-label">标题</span>
            <input
              id="material-import-title"
              value={title}
              maxLength={120}
              placeholder="如：某篇文章 / 一段访谈逐字稿"
              onChange={(e) => setTitle(e.target.value)}
            />
          </label>
          <label className="field-stack" htmlFor="material-import-body">
            <span className="field-label">正文</span>
            <textarea
              id="material-import-body"
              value={content}
              rows={8}
              placeholder="在此粘贴资料正文…"
              onChange={(e) => setContent(e.target.value)}
            />
            <span className={`field-help${contentLen > IMPORT_CONTENT_SOFT_MAX ? " is-danger" : ""}`}>
              {contentLen.toLocaleString()} / {IMPORT_CONTENT_SOFT_MAX.toLocaleString()} 字符
              {contentLen > IMPORT_CONTENT_SOFT_MAX ? " · 超出上限，请删减后再导入" : ""}
            </span>
          </label>
          <div className="form-actions">
            <label className="secondary-action file-button">
              <FileText size={16} aria-hidden />
              选择文件
              <input type="file" accept=".txt,.md" onChange={handleFile} />
            </label>
            <button
              className="primary-action"
              type="button"
              onClick={handleImport}
              disabled={!canImport}
              aria-busy={importing}
            >
              {importing ? "导入中…" : "导入"}
            </button>
          </div>
          {importHint && <p className="field-status is-success">{importHint}</p>}
          {importError && (
            <p className="field-status is-danger" role="alert">
              {importError}
            </p>
          )}
          {lastImport && (
            <div className="material-import-result" role="status">
              <strong>本轮导入结果</strong>
              <p>
                候选记忆 {lastImport.candidateCount} 条
                {typeof lastImport.chunkCount === "number" ? ` · 切块 ${lastImport.chunkCount}` : ""}
                {typeof lastImport.embeddedChunkCount === "number" && typeof lastImport.chunkCount === "number"
                  ? ` · 向量 ${lastImport.embeddedChunkCount}/${lastImport.chunkCount}`
                  : ""}
              </p>
              {lastImport.warning && <p className="field-help">{lastImport.warning}</p>}
              <div className="form-actions">
                {onReviewMemory && (
                  <button
                    className="primary-action"
                    type="button"
                    onClick={() => onReviewMemory(lastImport.sourceId)}
                  >
                    去审核候选记忆
                    {lastImport.candidateCount > 0 ? `（${lastImport.candidateCount}）` : ""}
                  </button>
                )}
                <button
                  className="secondary-action"
                  type="button"
                  onClick={() => {
                    setLastImport(null);
                    setImportHint(null);
                  }}
                >
                  再导一份
                </button>
              </div>
            </div>
          )}
        </div>
      </section>

      {onAskMaterials && (
        <section className="panel material-ask-panel" aria-label="只问这份资料">
          <div className="panel-title">
            <MessageSquare size={18} aria-hidden />
            <h2>只问这份资料</h2>
          </div>
          <p className="field-help">
            仅检索已导入的参考文献块（ragChunks），不混入记忆 / 笔记 / 主题。需要跨源综合请切到「问全书」。
            {materialChunks.length === 0 ? " · 当前尚无访谈上下文块，可先导入资料。" : ""}
          </p>
          <div className="field-grid">
            <label className="field-stack" htmlFor="material-ask-question">
              <span className="field-label">问题</span>
              <textarea
                id="material-ask-question"
                value={askQuestion}
                rows={3}
                maxLength={2000}
                placeholder="例如：这份资料里关于授权的关键结论是什么？"
                disabled={asking}
                onChange={(e) => setAskQuestion(e.target.value)}
                onKeyDown={handleAskKeyDown}
              />
            </label>
            <div className="form-actions">
              <button
                className="primary-action"
                type="button"
                onClick={() => void handleAsk()}
                disabled={!canAsk}
                aria-busy={asking}
              >
                <SendHorizontal size={16} aria-hidden />
                {asking ? "检索中…" : "提问"}
              </button>
            </div>
            {askError && (
              <p className="field-status is-danger" role="alert">
                {askError}
              </p>
            )}
            {askAnswer != null && !askError && (
              <div className="material-ask-result" role="status">
                <strong>回答</strong>
                <p className="material-ask-answer">{askAnswer}</p>
                {askCitations.length > 0 && (
                  <ul className="clean-list material-ask-citations" aria-label="引用">
                    {askCitations.map((c) => (
                      <li key={c.id}>
                        <span className="material-ask-cite-index">
                          [{typeof c.citationIndex === "number" ? c.citationIndex : "?"}]
                        </span>{" "}
                        {c.title}
                        {c.sourceUrl ? (
                          <>
                            {" · "}
                            <a href={c.sourceUrl} target="_blank" rel="noreferrer">
                              来源
                            </a>
                          </>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </div>
        </section>
      )}

      <section className="panel">
        <div className="panel-title row-between">
          <div className="row">
            <Database size={18} aria-hidden />
            <h2>素材列表（{sources.length}）</h2>
          </div>
        </div>
        {sources.length > 0 && (
          <label className="field-stack material-search-field" htmlFor="material-search">
            <span className="field-label row">
              <Search size={14} aria-hidden />
              搜索素材
            </span>
            <input
              id="material-search"
              value={query}
              maxLength={120}
              placeholder="标题、正文或主题"
              onChange={(e) => setQuery(e.target.value)}
            />
          </label>
        )}
        {deleteHint && <p className="field-status is-success">{deleteHint}</p>}
        {sources.length === 0 ? (
          <div className="empty-module">
            <Upload size={28} aria-hidden />
            <p className="empty-hint">还没有导入任何素材。从上方导入第一份资料，它会成为专访可调用的认知素材。</p>
          </div>
        ) : visibleSources.length === 0 ? (
          <div className="empty-module">
            <Search size={28} aria-hidden />
            <p className="empty-hint">没有符合搜索的素材。</p>
            <button className="secondary-action" type="button" onClick={() => setQuery("")}>
              清除搜索
            </button>
          </div>
        ) : (
          <ul className="clean-list material-source-list">
            {visibleSources.map((source) => {
              const themes = (source.relatedThemeIds ?? [])
                .map((id) => state.themes.find((t) => t.id === id))
                .filter((t): t is NonNullable<typeof t> => Boolean(t));
              const expanded = expandedId === source.id;
              const preview = source.content.trim().slice(0, 280);
              return (
                <li key={source.id} className="list-row material-source-row" data-material-source={source.id}>
                  <div className="list-row-main">
                    <strong>{source.title}</strong>
                    <span className="list-row-meta">
                      {SOURCE_TYPE_LABEL[source.sourceType]} · {source.chunkIds.length} 块 ·{" "}
                      {SENSITIVITY_LABEL[source.sensitivity]} · {formatDate(source.createdAt)}
                    </span>
                    {themes.length > 0 && (
                      <div className="inline-list material-theme-chips">
                        {themes.map((theme) => (
                          <button
                            key={theme.id}
                            type="button"
                            className="status-pill material-theme-chip"
                            disabled={!onOpenTrack}
                            onClick={() => onOpenTrack?.(theme.id)}
                          >
                            主题线：{theme.name}
                          </button>
                        ))}
                      </div>
                    )}
                    {expanded && (
                      <div className="material-source-preview">
                        <p>{preview}{source.content.trim().length > 280 ? "…" : ""}</p>
                      </div>
                    )}
                    <div className="form-actions material-row-actions">
                      <button
                        className="text-button"
                        type="button"
                        onClick={() => setExpandedId(expanded ? null : source.id)}
                      >
                        {expanded ? "收起预览" : "预览"}
                      </button>
                      {onStartInterview && (
                        <button
                          className="secondary-action"
                          type="button"
                          onClick={() =>
                            onStartInterview("learning", source.title, source.relatedThemeIds)
                          }
                        >
                          <Play size={14} />
                          用此素材开场
                        </button>
                      )}
                      {onOpenAssetChat && (
                        <button
                          className="secondary-action"
                          type="button"
                          onClick={() => onOpenAssetChat(source.title)}
                        >
                          <MessageSquare size={14} />
                          去问全书
                        </button>
                      )}
                      {onReviewMemory && (
                        <button
                          className="secondary-action"
                          type="button"
                          onClick={() => onReviewMemory(source.id)}
                        >
                          相关记忆
                        </button>
                      )}
                    </div>
                  </div>
                  <button
                    className="icon-button"
                    type="button"
                    aria-label={"删除素材：" + source.title}
                    onClick={() => handleDelete(source.id, source.title)}
                  >
                    <Trash2 size={16} aria-hidden />
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </section>
  );
}

/** jsdom Blob may lack `.text()`; fall back to FileReader. */
function readAsText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : "");
    reader.onerror = () => reject(reader.error);
    reader.readAsText(file);
  });
}

/** 资料问答错误 → 可行动中文文案（对齐 AssetChatView.formatChatSendError 口径）。 */
export function formatRagAskError(err: unknown): string {
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
    if (status === 429) return "本时段 LLM 预算已用尽，资料问答暂不可用，请稍后重试。";
    if (status === 503) return "资料问答 LLM 未配置或不可用（常见于缺少 DASHSCOPE_API_KEY）。";
    if (status === 502) return "资料召回或生成失败，请重试。";
    if (status === 422) return "问题不能为空。";
    if (status >= 500) return `服务端资料问答失败（${status}）。`;
  }
  if (err instanceof Error && err.message.trim()) {
    if (/failed to fetch|network|load failed|econnrefused/i.test(err.message)) {
      return "后端不可达，资料问答需要在线。";
    }
    return err.message.trim();
  }
  return "提问失败：资料问答需要后端在线。";
}
