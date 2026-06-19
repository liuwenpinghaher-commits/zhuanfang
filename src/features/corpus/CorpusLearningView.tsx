import { CheckCircle2, ChevronDown, ClipboardList, FileAudio2, Info, LoaderCircle, Sparkles, Trash2, Upload } from "lucide-react";
import { useState } from "react";
import { HeaderBlock } from "../../components/HeaderBlock";
import type { CorpusImportInput, ProductState } from "../../domain/types";
import { ANALYSIS_DIMENSIONS, ANALYSIS_OUTPUTS, ANALYSIS_PATHS, ANALYSIS_PRINCIPLES } from "./analysisMethod";

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
  const [methodOpen, setMethodOpen] = useState(false);

  return (
    <section className="view-stack">
      <HeaderBlock
        eyebrow="语料学习"
        title="从外部专访中学习提问逻辑"
        subtitle="导入文本或转写稿后，系统分析追问动作、节奏控制和可应用的 PlaybookPatch。"
      />

      {/* 分析方法透明化 — 可折叠披露区 */}
      <section className="panel corpus-method-panel">
        <button
          className="corpus-method-toggle"
          type="button"
          aria-expanded={methodOpen}
          onClick={() => setMethodOpen((prev) => !prev)}
        >
          <span className="corpus-method-toggle-label">
            <Info size={16} />
            分析方法：它如何读你的样本
          </span>
          <ChevronDown size={16} className={methodOpen ? "corpus-method-chevron open" : "corpus-method-chevron"} />
        </button>

        {methodOpen && (
          <div className="corpus-method-body">
            <section className="corpus-method-section">
              <h3 className="corpus-method-heading">分析什么</h3>
              <p className="corpus-method-desc">系统从样本中识别以下五个提问技法维度，每个维度给出 1-5 分评分：</p>
              <ul className="corpus-method-list">
                {ANALYSIS_DIMENSIONS.map((dim) => (
                  <li key={dim.name}>
                    <strong>{dim.name}</strong>
                    <span>{dim.description}</span>
                  </li>
                ))}
              </ul>
            </section>

            <section className="corpus-method-section">
              <h3 className="corpus-method-heading">产出什么</h3>
              <ul className="corpus-method-list corpus-method-list-outputs">
                {ANALYSIS_OUTPUTS.map((output) => (
                  <li key={output.key}>
                    <strong>{output.label}</strong>
                    <span>{output.detail}</span>
                  </li>
                ))}
              </ul>
            </section>

            <section className="corpus-method-section">
              <h3 className="corpus-method-heading">分析原则</h3>
              <ul className="corpus-method-list corpus-method-list-principles">
                {ANALYSIS_PRINCIPLES.map((principle) => (
                  <li key={principle}>{principle}</li>
                ))}
              </ul>
            </section>

            <section className="corpus-method-section corpus-method-paths">
              <h3 className="corpus-method-heading">两条分析路径</h3>
              <div className="corpus-method-path-grid">
                <div className="corpus-method-path">
                  <span className="corpus-method-path-badge corpus-method-path-badge-llm">{ANALYSIS_PATHS.llm.label}</span>
                  <span className="corpus-method-path-cond">条件：{ANALYSIS_PATHS.llm.condition}</span>
                  <p>{ANALYSIS_PATHS.llm.description}</p>
                </div>
                <div className="corpus-method-path">
                  <span className="corpus-method-path-badge corpus-method-path-badge-det">{ANALYSIS_PATHS.deterministic.label}</span>
                  <span className="corpus-method-path-cond">条件：{ANALYSIS_PATHS.deterministic.condition}</span>
                  <p>{ANALYSIS_PATHS.deterministic.description}</p>
                </div>
              </div>
            </section>
          </div>
        )}
      </section>

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
            <textarea id="corpus-content" rows={10} value={content} onChange={(event) => onContent(event.target.value)} />
            <span className="field-help">建议使用"主持人：问题 / 被访者：回答"的格式，系统会据此识别追问动作。</span>
          </label>
          <button className="primary-action" type="button" onClick={onAnalyze}>
            <Sparkles size={18} />分析并生成建议
          </button>
        </div>
      </section>

      <div className="record-list">
        {state.corpusInsights.length === 0 && (
          <section className="panel empty-module">
            <ClipboardList size={18} />
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
                {insight.dimensions.map((dimension, dimIdx) => (
                  <div key={`${insight.id}-dim-${dimIdx}`}>
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
                  <ul>{patch.rules.map((rule, ruleIdx) => <li key={`${patch.id}-rule-${ruleIdx}`}>{rule}</li>)}</ul>
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
