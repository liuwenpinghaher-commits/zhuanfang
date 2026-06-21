import { Database, FileText, RefreshCw, Trash2, Upload } from "lucide-react";
import { useState, type ChangeEvent } from "react";
import { HeaderBlock } from "../../components/HeaderBlock";
import type { ImportSource, ProductState } from "../../domain/types";

interface MaterialLibraryViewProps {
  state: ProductState;
  onImport: (title: string, content: string) => Promise<void>;
  onRebuildIndex: () => Promise<{ chunkCount: number }>;
  onDeleteSource: (sourceId: string) => void;
}

const SOURCE_TYPE_LABEL: Record<ImportSource["sourceType"], string> = {
  text: "文本",
  webpage: "网页"
};

const SENSITIVITY_LABEL: Record<ImportSource["sensitivity"], string> = {
  normal: "常规",
  sensitive: "敏感"
};

function formatDate(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString("zh-CN");
}

export function MaterialLibraryView({
  state,
  onImport,
  onRebuildIndex,
  onDeleteSource
}: MaterialLibraryViewProps) {
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [importing, setImporting] = useState(false);
  const [importHint, setImportHint] = useState<string | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const [rebuilding, setRebuilding] = useState(false);
  const [rebuildHint, setRebuildHint] = useState<string | null>(null);
  const [rebuildError, setRebuildError] = useState<string | null>(null);

  const sources = state.importSources;
  const canImport = content.trim().length > 0 && !importing;

  async function handleFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) {
      return;
    }
    const text = typeof file.text === "function" ? await file.text() : await readAsText(file);
    setContent(text);
    if (!title.trim()) {
      setTitle(file.name.replace(/\.[^.]+$/, ""));
    }
    // Allow re-selecting the same file later.
    event.target.value = "";
  }

  async function handleImport() {
    if (!content.trim()) {
      return;
    }
    setImporting(true);
    setImportHint(null);
    setImportError(null);
    try {
      await onImport(title.trim() || "未命名导入资料", content);
      setTitle("");
      setContent("");
      setImportHint("导入完成，已加入素材库。");
    } catch {
      setImportError("导入失败：需要后端在线且配置 DASHSCOPE_API_KEY 才能抽取候选记忆。");
    } finally {
      setImporting(false);
    }
  }

  async function handleRebuild() {
    setRebuilding(true);
    setRebuildHint(null);
    setRebuildError(null);
    try {
      const { chunkCount } = await onRebuildIndex();
      setRebuildHint(`已索引 ${chunkCount} 块。`);
    } catch {
      setRebuildError("重建失败：知识索引需要后端在线。");
    } finally {
      setRebuilding(false);
    }
  }

  return (
    <section className="view-stack">
      <HeaderBlock
        eyebrow="认知资产 · 素材库"
        title="导入资料与知识索引"
        subtitle="粘贴或上传文本资料，抽取为可在专访中召回的素材。重建索引后即可用于检索接地。"
        action={
          <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: "0.4rem" }}>
            <button className="secondary-action" type="button" onClick={handleRebuild} disabled={rebuilding}>
              <RefreshCw size={16} style={{ marginRight: "0.4rem" }} />
              {rebuilding ? "重建中…" : "重建知识索引"}
            </button>
            {rebuildHint && (
              <span style={{ color: "var(--color-success, #22c55e)", fontSize: "0.8rem" }}>{rebuildHint}</span>
            )}
            {rebuildError && <span style={{ color: "var(--color-danger, #ef4444)", fontSize: "0.8rem" }}>{rebuildError}</span>}
          </div>
        }
      />

      <section className="panel">
        <div className="panel-title">
          <Upload size={18} />
          <h2>导入资料</h2>
        </div>
        <p className="field-help" style={{ marginBottom: "1rem" }}>
          可直接粘贴正文，或上传 .txt / .md 文件。导入后会抽取候选记忆，请在「记忆」中审核。
        </p>
        <div style={{ display: "flex", flexDirection: "column", gap: "0.85rem" }}>
          <label className="field-stack">
            <span className="field-label">标题</span>
            <input
              value={title}
              maxLength={120}
              placeholder="如：某篇文章 / 一段访谈逐字稿"
              onChange={(e) => setTitle(e.target.value)}
            />
          </label>
          <label className="field-stack">
            <span className="field-label">正文</span>
            <textarea
              value={content}
              rows={8}
              placeholder="在此粘贴资料正文…"
              onChange={(e) => setContent(e.target.value)}
            />
          </label>
          <div style={{ display: "flex", alignItems: "center", gap: "0.75rem", flexWrap: "wrap" }}>
            <label className="secondary-action" style={{ cursor: "pointer", display: "inline-flex", alignItems: "center" }}>
              <FileText size={16} style={{ marginRight: "0.4rem" }} />
              选择文件
              <input type="file" accept=".txt,.md" style={{ display: "none" }} onChange={handleFile} />
            </label>
            <button className="primary-action" type="button" onClick={handleImport} disabled={!canImport}>
              {importing ? "导入中…" : "导入"}
            </button>
            {importHint && <span style={{ color: "var(--color-success, #22c55e)", fontSize: "0.875rem" }}>{importHint}</span>}
            {importError && <span style={{ color: "var(--color-danger, #ef4444)", fontSize: "0.875rem" }}>{importError}</span>}
          </div>
        </div>
      </section>

      <section className="panel">
        <div className="panel-title">
          <Database size={18} />
          <h2>素材列表（{sources.length}）</h2>
        </div>
        {sources.length === 0 ? (
          <p className="field-help">还没有导入任何素材。从上方导入第一份资料，它会成为专访可调用的认知素材。</p>
        ) : (
          <ul className="clean-list">
            {sources.map((source) => (
              <li
                key={source.id}
                style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: "0.75rem" }}
              >
                <div style={{ display: "flex", flexDirection: "column", gap: "0.25rem", minWidth: 0 }}>
                  <strong style={{ wordBreak: "break-word" }}>{source.title}</strong>
                  <span className="field-help" style={{ fontSize: "0.8rem" }}>
                    {SOURCE_TYPE_LABEL[source.sourceType]} · {source.chunkIds.length} 块 ·{" "}
                    {SENSITIVITY_LABEL[source.sensitivity]} · {formatDate(source.createdAt)}
                  </span>
                </div>
                <button
                  className="icon-button"
                  type="button"
                  aria-label={"删除素材：" + source.title}
                  onClick={() => onDeleteSource(source.id)}
                >
                  <Trash2 size={16} />
                </button>
              </li>
            ))}
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
