import { CheckCircle2, ClipboardList, FileAudio2, LoaderCircle, Sparkles, Trash2, Upload } from "lucide-react";
import { HeaderBlock } from "../../components/HeaderBlock";
import type { CorpusImportInput, ProductState } from "../../domain/types";

interface CorpusLearningViewProps {
  state: ProductState;
  mediaType: CorpusImportInput["mediaType"];
  title: string;
  sourceUrl: string;
  content: string;
  transcribing: boolean;
  onMediaType: (value: CorpusImportInput["mediaType"]) => void;
  onTitle: (value: string) => void;
  onSourceUrl: (value: string) => void;
  onContent: (value: string) => void;
  onTranscribeAudio: () => void;
  onAnalyze: () => void;
  onApprovePatch: (patchId: string) => void;
  onDeleteInsight: (insightId: string) => void;
}

export function CorpusLearningView({
  state,
  mediaType,
  title,
  sourceUrl,
  content,
  transcribing,
  onMediaType,
  onTitle,
  onSourceUrl,
  onContent,
  onTranscribeAudio,
  onAnalyze,
  onApprovePatch,
  onDeleteInsight
}: CorpusLearningViewProps) {
  const importById = new Map(state.corpusImports.map((item) => [item.id, item]));
  const contentLabel = mediaType === "audio" ? "音频转写稿或摘要" : "专访文本或转写稿";

  return (
    <section className="view-stack">
      <HeaderBlock
        eyebrow="语料学习"
        title="从外部专访中学习提问逻辑"
        subtitle="导入文本或转写稿后，系统分析追问动作、节奏控制和可应用的 PlaybookPatch。"
      />
      <section className="panel action-panel">
        <div className="panel-title"><Upload size={18} /><h2>导入专访样本</h2></div>
        <div className="stacked-form">
          <label className="field-stack" htmlFor="corpus-media-type">
            <span className="field-label">样本类型</span>
            <select
              id="corpus-media-type"
              value={mediaType}
              onChange={(event) => onMediaType(event.target.value === "audio" ? "audio" : "text")}
            >
              <option value="text">文本 / 转写稿</option>
              <option value="audio">音频 / 转写稿</option>
            </select>
          </label>
          <label className="field-stack" htmlFor="corpus-title">
            <span className="field-label">样本标题</span>
            <input id="corpus-title" value={title} onChange={(event) => onTitle(event.target.value)} placeholder="样本标题" />
          </label>
          {mediaType === "audio" && (
            <div className="field-stack">
              <label className="field-label" htmlFor="corpus-source-url">音频来源 URL</label>
              <input
                id="corpus-source-url"
                value={sourceUrl}
                onChange={(event) => onSourceUrl(event.target.value)}
                placeholder="https://example.com/interview-audio.mp3"
              />
              <span className="field-help">公网音频 URL 可先生成转写稿，再进入语料分析。</span>
              <button
                className="secondary-action compact-action"
                type="button"
                onClick={onTranscribeAudio}
                disabled={!sourceUrl.trim() || transcribing}
              >
                {transcribing ? <LoaderCircle size={16} /> : <FileAudio2 size={16} />}
                {transcribing ? "正在转写" : "生成转写稿"}
              </button>
            </div>
          )}
          <label className="field-stack" htmlFor="corpus-content">
            <span className="field-label">{contentLabel}</span>
            <textarea id="corpus-content" value={content} onChange={(event) => onContent(event.target.value)} />
            <span className="field-help">建议使用“主持人：问题 / 被访者：回答”的格式，系统会据此识别追问动作。</span>
          </label>
          <button className="primary-action" type="button" onClick={onAnalyze}>
            <Sparkles size={18} />分析并生成建议
          </button>
        </div>
      </section>

      <div className="record-list">
        {state.corpusInsights.length === 0 && (
          <section className="panel empty-module">
            <ClipboardList size={22} />
            <p>还没有语料分析。导入一段专访文本后，会生成可解释的改进建议。</p>
          </section>
        )}
        {state.corpusInsights.map((insight) => {
          const sourceImport = importById.get(insight.importId);
          return (
          <article className="record-row feature-row" key={insight.id}>
            <div>
              <span className="status-pill">{sourceImport?.mediaType ?? "text"} · 已分析</span>
              <h2>{insight.title}</h2>
              {sourceImport?.sourceUrl && <p className="source-url">{sourceImport.sourceUrl}</p>}
              <span className="label">{new Date(insight.createdAt).toLocaleDateString("zh-CN")}</span>
              <div className="record-actions">
                <button className="danger-button" type="button" onClick={() => onDeleteInsight(insight.id)}>
                  <Trash2 size={16} />删除分析
                </button>
              </div>
              <div className="dimension-list">
                {insight.dimensions.map((dimension) => (
                  <div key={dimension.name}>
                    <strong>{dimension.name} · {dimension.score}/5</strong>
                    <p>{dimension.finding}</p>
                    <small>{dimension.recommendedAction}</small>
                  </div>
                ))}
              </div>
            </div>
            <div className="patch-list">
              {insight.recommendedPatches.map((patch) => (
                <div className="patch-card" key={patch.id}>
                  <span className="status-pill">{patch.status}</span>
                  <h3>{patch.title}</h3>
                  <p>{patch.description}</p>
                  <ul>{patch.rules.map((rule) => <li key={rule}>{rule}</li>)}</ul>
                  <button className="secondary-action" type="button" onClick={() => onApprovePatch(patch.id)} disabled={patch.status === "applied"}>
                    <CheckCircle2 size={16} />确认影响引擎
                  </button>
                </div>
              ))}
            </div>
          </article>
          );
        })}
      </div>
    </section>
  );
}
