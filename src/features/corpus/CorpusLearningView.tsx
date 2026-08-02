import { CheckCircle2, ChevronDown, ClipboardList, FileAudio2, Info, LoaderCircle, Mic, Plus, Settings, Sparkles, Trash2, Undo2, Upload, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { HeaderBlock } from "../../components/HeaderBlock";
import type { CorpusImportInput, PlaybookPatch, ProductState } from "../../domain/types";
import { ANALYSIS_DIMENSIONS, ANALYSIS_OUTPUTS, ANALYSIS_PATHS, ANALYSIS_PRINCIPLES } from "./analysisMethod";

const FOCUS_MAX = 280;
// 本地音频文件上限：25 MB。与后端 /api/corpus/transcriptions 的 base64 护栏一致。
const MAX_AUDIO_FILE_BYTES = 25 * 1024 * 1024;

interface CorpusLearningViewProps {
  state: ProductState;
  mediaType: CorpusImportInput["mediaType"];
  title: string;
  sourceUrl: string;
  content: string;
  focus: string;
  transcribing: boolean;
  analyzing: boolean;
  audioFileName: string;
  onMediaType: (value: CorpusImportInput["mediaType"]) => void;
  onTitle: (value: string) => void;
  onSourceUrl: (value: string) => void;
  onContent: (value: string) => void;
  onFocus: (value: string) => void;
  onSelectAudioFile: (audioBase64: string, fileName: string) => void;
  onClearAudioFile: () => void;
  onTranscribeAudio: () => void;
  onAnalyze: () => void;
  onApprovePatch: (patchId: string, rules: string[]) => void;
  onRevertPatch: (patchId: string) => void;
  onDeleteInsight: (insightId: string) => void;
  /** 分析成功后高亮并滚动到对应 insight。 */
  focusInsightId?: string | null;
  onOpenConfig?: () => void;
  onGoInterview?: () => void;
}

export function CorpusLearningView({
  state,
  mediaType,
  title,
  sourceUrl,
  content,
  focus,
  transcribing,
  analyzing,
  audioFileName,
  onMediaType,
  onTitle,
  onSourceUrl,
  onContent,
  onFocus,
  onSelectAudioFile,
  onClearAudioFile,
  onTranscribeAudio,
  onAnalyze,
  onApprovePatch,
  onRevertPatch,
  onDeleteInsight,
  focusInsightId = null,
  onOpenConfig,
  onGoInterview
}: CorpusLearningViewProps) {
  const importById = new Map(state.corpusImports.map((item) => [item.id, item]));
  const contentLabel = mediaType === "audio" ? "音频转写稿或摘要" : "专访文本或转写稿";
  const [methodOpen, setMethodOpen] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const [fileSizeLabel, setFileSizeLabel] = useState("");
  const [fileError, setFileError] = useState("");
  const canAnalyze = content.trim().length > 0 && !analyzing && !transcribing;

  useEffect(() => {
    if (!focusInsightId) return;
    requestAnimationFrame(() => {
      document
        .querySelector(`[data-corpus-insight="${focusInsightId}"]`)
        ?.scrollIntoView({ behavior: "smooth", block: "center" });
    });
  }, [focusInsightId, state.corpusInsights.length]);

  function clearSelectedFile() {
    setFileError("");
    setFileSizeLabel("");
    if (fileRef.current) fileRef.current.value = "";
    onClearAudioFile();
  }

  async function handleFileChange(file: File | null) {
    setFileError("");
    if (!file) {
      clearSelectedFile();
      return;
    }
    if (file.size > MAX_AUDIO_FILE_BYTES) {
      // 不读取、不上传：超过 25 MB 直接拦截并提示。
      setFileSizeLabel("");
      if (fileRef.current) fileRef.current.value = "";
      onClearAudioFile();
      setFileError(`文件过大（${formatBytes(file.size)}），上限为 25 MB。请压缩后重试，或改用公网音频 URL。`);
      return;
    }
    try {
      const reader = new FileReader();
      const base64 = await new Promise<string>((resolve, reject) => {
        reader.onload = () => {
          const result = reader.result as string;
          const commaIdx = result.indexOf(",");
          resolve(commaIdx >= 0 ? result.slice(commaIdx + 1) : result);
        };
        reader.onerror = () => reject(new Error("文件读取失败"));
        reader.readAsDataURL(file);
      });
      setFileSizeLabel(formatBytes(file.size));
      onSelectAudioFile(base64, file.name);
    } catch (err) {
      setFileError(err instanceof Error ? err.message : "文件读取失败");
    }
  }

  return (
    <section className="view-stack">
      <HeaderBlock
        eyebrow="语料学习"
        title="从外部专访中学习提问逻辑"
        subtitle="导入文本或转写稿后，系统分析追问动作、节奏控制和可应用的 PlaybookPatch。" />

      {/* 分析方法透明化 — 可折叠披露区 */}
      <section className="panel corpus-method-panel">
        <button
          className="corpus-method-toggle"
          type="button"
          aria-expanded={methodOpen}
          onClick={() => setMethodOpen((prev) => !prev)}>
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
                  <span className="corpus-method-path-badge corpus-method-path-badge-det">{ANALYSIS_PATHS.unavailable.label}</span>
                  <span className="corpus-method-path-cond">条件：{ANALYSIS_PATHS.unavailable.condition}</span>
                  <p>{ANALYSIS_PATHS.unavailable.description}</p>
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
            <div className="field-stack corpus-audio-source">
              <span className="field-label">音频来源</span>
              <span className="field-help">两种方式任选其一：粘贴公网音频 URL，或从本地选择音频文件。</span>

              <div className="corpus-audio-block">
                <label className="corpus-audio-sublabel" htmlFor="corpus-source-url">公网音频 URL</label>
                <input
                  id="corpus-source-url"
                  value={sourceUrl}
                  onChange={(event) => onSourceUrl(event.target.value)}
                  placeholder="https://example.com/interview-audio.mp3" />
                <span className="field-help">公网音频 URL 可由百炼 SenseVoice 自动转写为转写稿。</span>
              </div>

              <div className="corpus-audio-divider"><span>或</span></div>

              <div className="corpus-audio-block">
                <span className="corpus-audio-sublabel">本地音频文件</span>
                <input
                  ref={fileRef}
                  className="corpus-audio-file-input"
                  type="file"
                  accept="audio/*,.wav,.mp3,.m4a,.aac,.ogg,.flac"
                  aria-label="选择本地音频文件"
                  onChange={(event) => handleFileChange(event.target.files?.[0] ?? null)} />
                {audioFileName && (
                  <div className="corpus-audio-file-chip">
                    <FileAudio2 size={14} />
                    <span className="corpus-audio-file-name">{audioFileName}</span>
                    {fileSizeLabel && <span className="corpus-audio-file-size">{fileSizeLabel}</span>}
                    <button
                      className="icon-button"
                      type="button"
                      onClick={clearSelectedFile}
                      aria-label="清除已选音频文件"
                      title="清除已选音频文件"
>
                      <X size={14} />
                    </button>
                  </div>
                )}
                <span className="field-help">
                  本地文件最大 25 MB。服务端会落盘；若配置了 CORPUS_AUDIO_PUBLIC_BASE_URL（SenseVoice 可拉取的公网基址）则可自动转写，否则请粘贴转写稿或改用公网 URL。
                </span>
                {fileError && <p className="form-error">{fileError}</p>}
              </div>

              <button
                className="secondary-action compact-action"
                type="button"
                onClick={onTranscribeAudio}
                disabled={(!sourceUrl.trim() && !audioFileName) || transcribing}
>
                {transcribing ? <LoaderCircle size={16} /> : <FileAudio2 size={16} />}
                {transcribing ? "正在转写…" : "生成转写稿"}
              </button>
              {transcribing && (
                <p className="corpus-stage-hint">
                  正在转写音频，可能需要 1-2 分钟……后端 SenseVoice 轮询中，请耐心等待。
                </p>
              )}
            </div>
          )}
          <label className="field-stack" htmlFor="corpus-content">
            <span className="field-label">{contentLabel}</span>
            <textarea id="corpus-content" rows={10} value={content} onChange={(event) => onContent(event.target.value)} />
            <span className="field-help">建议使用“主持人：问题 / 被访者：回答”的格式，系统会据此识别追问动作。</span>
          </label>
          <label className="field-stack" htmlFor="corpus-focus">
            <span className="field-label">分析侧重（可选）</span>
            <textarea
              id="corpus-focus"
              rows={3}
              value={focus}
              maxLength={FOCUS_MAX}
              onChange={(event) => onFocus(event.target.value)}
              placeholder="例如：重点学习如何追问失败经历 / 如何做机制反转" />
            <div className="field-row-foot">
              <span className="field-help">填写后，AI 分析会优先关注你指定的提问技法；留空则做全面分析。</span>
              <span className="char-count">{focus.length}/{FOCUS_MAX}</span>
            </div>
          </label>
          <button
            className={analyzing ? "primary-action btn-loading" : "primary-action"}
            type="button"
            onClick={onAnalyze}
            disabled={!canAnalyze}
            aria-busy={analyzing}
>
            {analyzing ? <span className="spinner" /> : <Sparkles size={18} />}
            {analyzing ? "分析中…" : "分析并生成建议"}
          </button>
          {!content.trim() && !analyzing && (
            <p className="field-help">请先粘贴专访文本或生成转写稿，再开始分析。</p>
          )}
          {analyzing && (
            <p className="corpus-stage-hint">
              正在提炼提问技法，通常需要 10-30 秒……
            </p>
          )}
        </div>
      </section>

      <div className="record-list">
        {state.corpusInsights.length === 0 && (
          <section className="panel empty-module">
            <ClipboardList size={18} />
            <p>还没有语料分析。导入一段专访文本后，会生成可解释的改进建议。</p>
            <button
              className="secondary-action"
              type="button"
              onClick={() => document.getElementById("corpus-content")?.focus()}
            >
              去填写样本
            </button>
          </section>
        )}
        {state.corpusInsights.map((insight) => {
          const sourceImport = importById.get(insight.importId);
          const isFocus = focusInsightId === insight.id;
          const appliedCount = insight.recommendedPatches.filter((p) => p.status === "applied").length;
          return (
          <article
            className={`record-row feature-row${isFocus ? " is-highlight" : ""}`}
            key={insight.id}
            data-corpus-insight={insight.id}
          >
            <div>
              <span className="status-pill">{sourceImport?.mediaType ?? "text"} · 已分析</span>
              {appliedCount > 0 && <span className="status-pill is-tracked">已应用 {appliedCount} 条补丁</span>}
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
                <EditablePatchCard
                  key={patch.id}
                  patch={patch}
                  onApprovePatch={onApprovePatch}
                  onRevertPatch={onRevertPatch}
                  onOpenConfig={onOpenConfig}
                  onGoInterview={onGoInterview}
                />
              ))}
            </div>
          </article>
          );
        })}
      </div>
    </section>
  );
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

interface EditablePatchCardProps {
  patch: PlaybookPatch;
  onApprovePatch: (patchId: string, rules: string[]) => void;
  onRevertPatch: (patchId: string) => void;
  onOpenConfig?: () => void;
  onGoInterview?: () => void;
}

function EditablePatchCard({ patch, onApprovePatch, onRevertPatch, onOpenConfig, onGoInterview }: EditablePatchCardProps) {
  const applied = patch.status === "applied";
  // 回归审查 R7-F1:只有 proposed(未处置)才可编辑+应用。applied/reverted 都是终态——此前只判
  // applied,导致撤销应用后(status='reverted')卡片落回编辑器分支且"确认影响引擎"按钮启用,但
  // approvePlaybookPatch 守卫 status!=='proposed' 直接 return(无变化)、前端却报成功+跳转=死循环+
  // 假成功。终态一律只读展示规则、隐藏编辑器与应用按钮;仅 applied 提供"撤销应用"。
  const editable = patch.status === "proposed";
  // Local draft rules — initialized from the recommended patch. The user can edit,
  // delete or add rules here, then "确认影响引擎" applies the EDITED set.
  const [draftRules, setDraftRules] = useState<string[]>(() => [...patch.rules]);

  function updateRule(index: number, value: string) {
    setDraftRules((prev) => prev.map((rule, idx) => (idx === index ? value : rule)));
  }

  function removeRule(index: number) {
    setDraftRules((prev) => prev.filter((_, idx) => idx !== index));
  }

  function addRule() {
    setDraftRules((prev) => [...prev, ""]);
  }

  const cleanedRules = draftRules.map((rule) => rule.trim()).filter(Boolean);
  const canApply = editable && cleanedRules.length > 0;

  return (
    <div className="patch-card">
      <span className="status-pill">{patch.status}</span>
      <h3>{patch.title}</h3>
      <p>{patch.description}</p>
      {!editable ? (
        <>
          <ul>
            {patch.rules.map((rule, ruleIdx) => (
              <li key={`${patch.id}-rule-${ruleIdx}`}>{rule}</li>
            ))}
          </ul>
          {/* 仅 applied 可撤销;reverted 是终态,无操作。 */}
          {applied && (
            <div className="form-actions">
              <button className="link-button" type="button" onClick={() => onRevertPatch(patch.id)}>
                <Undo2 size={14} />撤销应用
              </button>
              {onOpenConfig && (
                <button className="secondary-action compact-action" type="button" onClick={onOpenConfig}>
                  <Settings size={14} />查看系统配置
                </button>
              )}
              {onGoInterview && (
                <button className="secondary-action compact-action" type="button" onClick={onGoInterview}>
                  <Mic size={14} />去实时专访验证
                </button>
              )}
            </div>
          )}
        </>
      ) : (
        <div className="patch-rule-editor">
          <span className="patch-rule-editor-label">推荐规则（可编辑后再应用）</span>
          {draftRules.map((rule, ruleIdx) => (
            <div className="patch-rule-row" key={`${patch.id}-draft-${ruleIdx}`}>
              <input
                value={rule}
                onChange={(event) => updateRule(ruleIdx, event.target.value)}
                placeholder="一条可执行的追问规则"
                aria-label={`规则 ${ruleIdx + 1}`} />
              <button
                className="icon-button"
                type="button"
                onClick={() => removeRule(ruleIdx)}
                aria-label="删除这条规则"
                title="删除这条规则"
>
                <X size={14} />
              </button>
            </div>
          ))}
          <button className="link-button" type="button" onClick={addRule}>
            <Plus size={14} />加一条规则
          </button>
          {/* R7-F1:应用按钮仅在可编辑(proposed)时渲染,终态不再出现"确认影响引擎"→杜绝对 reverted 假成功。 */}
          <button
            className="secondary-action"
            type="button"
            onClick={() => onApprovePatch(patch.id, cleanedRules)}
            disabled={!canApply}
>
            <CheckCircle2 size={16} />确认影响引擎
          </button>
        </div>
      )}
    </div>
  );
}
