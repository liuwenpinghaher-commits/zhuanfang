import { useMemo, useRef } from "react";
import { Check, ClipboardList, Headphones, Mic, Pencil, Trash2, Volume2 } from "lucide-react";
import { HeaderBlock } from "../../components/HeaderBlock";
import type { VoiceInfo } from "../../api/productApi";
import type { PodcastEpisode, PodcastSourceType, ProductState } from "../../domain/types";
import { formatPodcastTimestamp } from "../../ui";

interface PodcastStudioViewProps {
  state: ProductState;
  noteId: string;
  voice: string;
  sourceType: PodcastSourceType;
  sourceId: string;
  format: PodcastEpisode["format"];
  editingScript: string;
  activeEpisodeId: string | null;
  generating?: boolean;
  synthesizing?: boolean;
  confirming?: boolean;
  deletingEpisodeId?: string | null;
  voices?: VoiceInfo[];
  onNoteId: (value: string) => void;
  onVoice: (value: string) => void;
  onSourceType: (value: PodcastSourceType) => void;
  onSourceId: (value: string) => void;
  onFormat: (value: PodcastEpisode["format"]) => void;
  onEditingScript: (value: string) => void;
  onActiveEpisodeId: (value: string | null) => void;
  onGenerateScript: () => void;
  onConfirmScript: (episodeId: string) => void;
  onConfirmAndSynthesize: (episodeId: string) => void;
  onSynthesizeSpeech: (episodeId: string) => void;
  onDeleteEpisode: (episodeId: string) => void;
  onSaveDefaultVoice: () => void;
}

const formatLabel: Record<PodcastEpisode["format"], string> = {
  solo: "单人旁白",
  "host-guest": "主持对谈"
};

const sourceOptions: Array<{ value: PodcastSourceType; label: string }> = [
  { value: "note", label: "双轨笔记" },
  { value: "search-brief", label: "搜索简报" },
  { value: "theme", label: "长期主题" },
  { value: "knowledge-debt", label: "知识债" }
];

export function PodcastStudioView({
  state,
  noteId,
  voice,
  sourceType,
  sourceId,
  format,
  editingScript,
  activeEpisodeId,
  generating = false,
  synthesizing = false,
  confirming = false,
  deletingEpisodeId = null,
  voices = [],
  onNoteId,
  onVoice,
  onSourceType,
  onSourceId,
  onFormat,
  onEditingScript,
  onActiveEpisodeId,
  onGenerateScript,
  onConfirmScript,
  onConfirmAndSynthesize,
  onSynthesizeSpeech,
  onDeleteEpisode,
  onSaveDefaultVoice
}: PodcastStudioViewProps) {
  const selectedNoteId = noteId || state.notes[0]?.id || "";
  const selectedNote = state.notes.find((note) => note.id === selectedNoteId) ?? state.notes[0];

  const sourceItems = useMemo(() => {
    switch (sourceType) {
      case "search-brief":
        return state.searchBriefs.map((item) => ({ id: item.id, label: item.topic }));
      case "theme":
        return state.themes.map((item) => ({ id: item.id, label: item.name }));
      case "knowledge-debt":
        return state.debts.map((item) => ({ id: item.id, label: item.concept }));
      default:
        return state.notes.map((item) => ({ id: item.id, label: item.title }));
    }
  }, [sourceType, state.searchBriefs, state.themes, state.debts, state.notes]);

  const selectedSourceId = sourceId || sourceItems[0]?.id || "";
  const activeEpisode =
    state.podcastEpisodes.find((ep) => ep.id === activeEpisodeId) ??
    null;
  const showDraftEditor = Boolean(activeEpisode);
  const busy = generating || synthesizing || confirming;
  const editorDirty = Boolean(activeEpisode && editingScript !== activeEpisode.script);
  const editorEmpty = !editingScript.trim();
  const pipelineStep: 1 | 2 | 3 = !activeEpisode
    ? 1
    : activeEpisode.scriptReviewStatus !== "用户确认" || editorDirty
      ? 2
      : 3;

  const voiceOptions = useMemo(() => {
    const preset = voices.map((v) => v.voice);
    if (voice && !preset.includes(voice)) {
      return [voice, ...preset];
    }
    return preset;
  }, [voices, voice]);

  function beginEditEpisode(episode: PodcastEpisode) {
    onActiveEpisodeId(episode.id);
    onEditingScript(episode.script);
  }

  return (
    <section className="view-stack podcast-view">
      <HeaderBlock
        eyebrow="播客工作台"
        title="把一次专访生成可收听的语音节目"
        subtitle="先选来源并生成脚本，确认口播稿后再合成音频。默认不会在生成时自动扣费渲染。"
      />

      <div className="config-hint podcast-pipeline" aria-label="制作进度">
        <span className={pipelineStep === 1 ? "is-emphasis" : undefined}>① 选来源</span>
        <span className={pipelineStep === 2 ? "is-emphasis" : undefined}>② 确认脚本</span>
        <span className={pipelineStep === 3 ? "is-emphasis" : undefined}>③ 合成收听</span>
      </div>

      <section className="panel podcast-setup-panel">
        <div className="panel-title row">
          <Headphones size={18} aria-hidden="true" />
          <h2>① 选来源并生成脚本</h2>
        </div>

        <div className="podcast-setup-grid">
          <label className="field-stack" htmlFor="podcast-source-type">
            <span className="field-label">来源类型</span>
            <select
              id="podcast-source-type"
              value={sourceType}
              disabled={busy}
              onChange={(event) => {
                onSourceType(event.target.value as PodcastSourceType);
                onSourceId("");
              }}
            >
              {sourceOptions.map((option) => (
                <option value={option.value} key={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>

          <label className="field-stack" htmlFor="podcast-source">
            <span className="field-label">来源内容</span>
            <select
              id="podcast-source"
              value={selectedSourceId}
              disabled={busy || sourceItems.length === 0}
              onChange={(event) => {
                if (sourceType === "note") onNoteId(event.target.value);
                onSourceId(event.target.value);
              }}
            >
              {sourceItems.length === 0 ? (
                <option value="">暂无可用来源</option>
              ) : (
                sourceItems.map((item) => (
                  <option value={item.id} key={item.id}>
                    {item.label}
                  </option>
                ))
              )}
            </select>
          </label>

          <label className="field-stack" htmlFor="podcast-format">
            <span className="field-label">节目形态</span>
            <select
              id="podcast-format"
              value={format}
              disabled={busy}
              onChange={(event) => onFormat(event.target.value as PodcastEpisode["format"])}
            >
              <option value="solo">单人旁白</option>
              <option value="host-guest">主持对谈（两个声音）</option>
            </select>
          </label>

          <label className="field-stack" htmlFor="podcast-voice">
            <span className="field-label">声音配置</span>
            <input
              id="podcast-voice"
              list="podcast-voice-options"
              value={voice}
              disabled={busy}
              onChange={(event) => onVoice(event.target.value)}
              placeholder="CosyVoice voice id"
            />
            <datalist id="podcast-voice-options">
              {voiceOptions.map((v) => (
                <option value={v} key={v}>
                  {voices.find((x) => x.voice === v)?.name ?? v}
                </option>
              ))}
            </datalist>
            <span className="field-help">
              {format === "host-guest"
                ? "主持对谈会用龙安聆心和龙安谦两个人声轮流说。你选的是主持人；另一个当来宾。"
                : "推荐龙安聆心（longanlingxin）或龙安谦（longanqian）。单人旁白只用这一个声音。"}
            </span>
          </label>
        </div>

        <div className="form-actions">
          <button
            className={`primary-action${generating ? " btn-loading" : ""}`}
            type="button"
            onClick={onGenerateScript}
            disabled={!selectedSourceId || busy}
            aria-busy={generating}
          >
            {generating && <span className="spinner" aria-hidden="true" />}
            <Mic size={18} />
            {generating ? "生成中…" : "生成脚本"}
          </button>
          <button className="secondary-action" type="button" onClick={onSaveDefaultVoice} disabled={busy || !voice.trim()}>
            保存为默认声音
          </button>
        </div>

        {selectedNote && sourceType === "note" ? (
          <article className="podcast-source-card">
            <span className="label">当前来源</span>
            <h3>{selectedNote.title}</h3>
            <p>{selectedNote.summary}</p>
            <blockquote>&quot;{selectedNote.keyQuote}&quot;</blockquote>
          </article>
        ) : selectedSourceId && sourceType !== "note" ? (
          <article className="podcast-source-card">
            <span className="label">当前来源</span>
            <h3>{sourceItems.find((item) => item.id === selectedSourceId)?.label ?? "—"}</h3>
            <p>
              来源类型：{sourceOptions.find((o) => o.value === sourceType)?.label ?? "—"}
              {" · 脚本将基于该来源由 LLM 生成，失败会如实提示"}
            </p>
          </article>
        ) : (
          <div className="empty-module">
            <ClipboardList size={18} />
            <p>还没有可生成播客的内容。先完成一次专访并生成档案，或从外部调研带入简报。</p>
          </div>
        )}
      </section>

      {showDraftEditor && activeEpisode && (
        <section className="panel podcast-draft-panel">
          <div className="panel-title row-between">
            <div className="row">
              <Pencil size={18} aria-hidden="true" />
              <h2>② 确认脚本</h2>
            </div>
            <span className={`status-pill ${statusPillClass(activeEpisode)}`}>
              {formatEpisodeStatus(activeEpisode)}
            </span>
          </div>
          <p className="field-help mb-3">
            正在编辑：{activeEpisode.title} · {formatLabel[activeEpisode.format]} · {activeEpisode.voice}
          </p>
          <textarea
            className="script-textarea"
            value={editingScript}
            onChange={(event) => onEditingScript(event.target.value)}
            rows={12}
            disabled={synthesizing || confirming}
            aria-label="编辑播客脚本"
            placeholder="编辑或确认播客脚本..."
          />
          <div className="form-actions">
            <DraftActionButtons
              episode={activeEpisode}
              dirty={editorDirty}
              empty={editorEmpty}
              busy={busy}
              confirming={confirming}
              synthesizing={synthesizing}
              onConfirmScript={onConfirmScript}
              onConfirmAndSynthesize={onConfirmAndSynthesize}
              onSynthesizeSpeech={onSynthesizeSpeech}
            />
            <button
              className="secondary-action"
              type="button"
              disabled={busy}
              onClick={() => {
                onEditingScript("");
                onActiveEpisodeId(null);
              }}
            >
              收起草稿
            </button>
          </div>
        </section>
      )}

      <section className="podcast-library">
        <div className="memory-section-head">
          <div>
            <h2>③ 节目库（{state.podcastEpisodes.length}）</h2>
            <p className="field-help">收听、再编辑脚本并重新合成，或删除生成结果。</p>
          </div>
        </div>

        {state.podcastEpisodes.length === 0 ? (
          <section className="panel empty-state podcast-empty">
            <div className="memory-empty-icon" aria-hidden="true">
              <Headphones size={28} />
            </div>
            <h3 className="memory-empty-title">还没有播客</h3>
            <p>选择来源并生成脚本后，节目会出现在这里。</p>
          </section>
        ) : (
          <div className="podcast-episode-list">
            {state.podcastEpisodes.map((episode) => {
              const isActive = episode.id === activeEpisodeId;
              const deleting = deletingEpisodeId === episode.id;
              return (
                <article
                  className={`panel podcast-episode${isActive ? " is-active" : ""}`}
                  key={episode.id}
                >
                  <div className="episode-hero">
                    <div>
                      <div className="row-wrap mb-2">
                        <button
                          type="button"
                          className={`status-pill ${statusPillClass(episode)}`}
                          onClick={() => beginEditEpisode(episode)}
                        >
                          {formatEpisodeStatus(episode)}
                        </button>
                        <span className="status-pill">
                          {formatLabel[episode.format]} · {episode.voice}
                        </span>
                        <span className="status-pill tabular-nums">
                          {formatPodcastTimestamp(episode.durationSec)}
                        </span>
                      </div>
                      <h2>
                        <button
                          type="button"
                          className="episode-title-button"
                          onClick={() => beginEditEpisode(episode)}
                        >
                          {episode.title}
                        </button>
                      </h2>
                      <p className="field-help">
                        {new Date(episode.createdAt).toLocaleString("zh-CN")}
                        {episode.sourceLabel ? ` · 来源 ${episode.sourceLabel}` : ""}
                      </p>
                      <div className="record-actions">
                        <button
                          className="secondary-action"
                          type="button"
                          disabled={busy || deleting}
                          onClick={() => beginEditEpisode(episode)}
                        >
                          <Pencil size={16} />
                          {episode.audioRenderStatus === "failed" ? "改稿并重试" : "编辑脚本"}
                        </button>
                        {episode.scriptReviewStatus === "待确认" ? (
                          <button
                            className="secondary-action"
                            type="button"
                            disabled={busy || deleting}
                            onClick={() => beginEditEpisode(episode)}
                          >
                            <Pencil size={16} />
                            去确认
                          </button>
                        ) : (
                          <button
                            className={`secondary-action${synthesizing && isActive ? " btn-loading" : ""}`}
                            type="button"
                            disabled={busy || deleting || (isActive && editorDirty)}
                            onClick={() => {
                              onActiveEpisodeId(episode.id);
                              onSynthesizeSpeech(episode.id);
                            }}
                          >
                            <Volume2 size={16} />
                            重新合成
                          </button>
                        )}
                        <button
                          className={`danger-button${deleting ? " btn-loading" : ""}`}
                          type="button"
                          disabled={busy || deleting}
                          aria-busy={deleting}
                          onClick={() => onDeleteEpisode(episode.id)}
                        >
                          {deleting && <span className="spinner" aria-hidden="true" />}
                          <Trash2 size={16} />
                          删除播客
                        </button>
                      </div>
                    </div>
                    <PodcastAudioPreview episode={episode} />
                  </div>

                  <div className="episode-grid">
                    <section className="episode-section">
                      <div className="section-heading">
                        <span className="label">章节导航</span>
                        <strong>{episode.chapters.length} 段</strong>
                      </div>
                      <div className="chapter-list">
                        {episode.chapters.map((chapter, chapterIdx) => (
                          <button
                            type="button"
                            className="chapter-seek"
                            key={`${episode.id}-chapter-${chapterIdx}`}
                            onClick={() => seekEpisodeAudio(episode.id, chapter.startsAtSec)}
                            title="跳到该章节"
                          >
                            <strong>{chapter.title}</strong>
                            <span>{formatPodcastTimestamp(chapter.startsAtSec)}</span>
                            <p>{chapter.summary}</p>
                          </button>
                        ))}
                      </div>
                    </section>

                    <section className="episode-section">
                      <div className="section-heading">
                        <span className="label">Shownotes</span>
                        <strong>{episode.shownotes.length} 条</strong>
                      </div>
                      <ul className="shownotes-list">
                        {episode.shownotes.map((item, snIdx) => (
                          <li key={`${episode.id}-sn-${snIdx}`}>{item}</li>
                        ))}
                      </ul>
                    </section>

                    <section className="episode-section script-section">
                      <div className="section-heading">
                        <span className="label">脚本复核</span>
                        <strong>{episode.scriptReviewStatus || "口播稿"}</strong>
                      </div>
                      <pre className="script-preview">{episode.script}</pre>
                    </section>
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </section>
    </section>
  );
}

function DraftActionButtons({
  episode,
  dirty,
  empty,
  busy,
  confirming,
  synthesizing,
  onConfirmScript,
  onConfirmAndSynthesize,
  onSynthesizeSpeech
}: {
  episode: PodcastEpisode;
  dirty: boolean;
  empty: boolean;
  busy: boolean;
  confirming: boolean;
  synthesizing: boolean;
  onConfirmScript: (episodeId: string) => void;
  onConfirmAndSynthesize: (episodeId: string) => void;
  onSynthesizeSpeech: (episodeId: string) => void;
}) {
  const confirmed = episode.scriptReviewStatus === "用户确认";
  const showConfirm = !confirmed || dirty;
  const showSynthesize = confirmed && !dirty;
  return (
    <>
      {showConfirm ? (
        <>
          <button
            className={`primary-action${confirming ? " btn-loading" : ""}`}
            type="button"
            onClick={() => onConfirmScript(episode.id)}
            disabled={empty || busy}
            aria-busy={confirming}
          >
            {confirming && <span className="spinner" aria-hidden="true" />}
            <Check size={18} />
            {confirming ? "确认中…" : "确认这篇稿"}
          </button>
          <button
            className={`secondary-action${synthesizing ? " btn-loading" : ""}`}
            type="button"
            onClick={() => onConfirmAndSynthesize(episode.id)}
            disabled={empty || busy}
            aria-busy={synthesizing}
          >
            {synthesizing && <span className="spinner" aria-hidden="true" />}
            <Volume2 size={18} />
            {synthesizing ? "合成中…" : "确认并合成"}
          </button>
        </>
      ) : null}
      {showSynthesize ? (
        <button
          className={`primary-action${synthesizing ? " btn-loading" : ""}`}
          type="button"
          onClick={() => onSynthesizeSpeech(episode.id)}
          disabled={empty || busy}
          aria-busy={synthesizing}
        >
          {synthesizing && <span className="spinner" aria-hidden="true" />}
          <Volume2 size={18} />
          {synthesizing ? "合成中…" : "合成语音"}
        </button>
      ) : null}
    </>
  );
}

function PodcastAudioPreview({ episode }: { episode: PodcastEpisode }) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const playable = episode.audioRenderStatus === "rendered" && isPlayableAudioUrl(episode.audioUrl);
  const expired = isAudioExpired(episode);

  return (
    <div className="audio-preview" aria-label={`音频预览：${episode.title}`}>
      <Volume2 size={18} />
      <div>
        <strong>
          {playable ? (expired ? "音频链接可能已过期" : "可播放音频") : formatAudioPlaceholder(episode)}
        </strong>
        {playable && !expired ? (
          <audio
            ref={audioRef}
            id={`podcast-audio-${episode.id}`}
            controls
            preload="metadata"
          >
            <source src={episode.audioUrl} type={inferAudioMimeType(episode.audioUrl)} />
          </audio>
        ) : (
          <p>
            {expired
              ? "播放链接已过期，请点击「重新合成」生成新音频（脚本仍保留）。"
              : episode.audioRenderMessage ||
                (episode.audioRenderStatus === "pending"
                  ? "脚本待确认，确认后才会渲染音频。"
                  : "服务端未配置真实 TTS 时会保留占位地址。")}
          </p>
        )}
        {playable && !expired && <code className="audio-url">{episode.audioUrl}</code>}
      </div>
    </div>
  );
}

function seekEpisodeAudio(episodeId: string, startsAtSec: number) {
  const el = document.getElementById(`podcast-audio-${episodeId}`) as HTMLAudioElement | null;
  if (!el) return;
  el.currentTime = Math.max(0, startsAtSec);
  void el.play().catch(() => {
    /* autoplay may be blocked until user gesture on the control */
  });
}

function isAudioExpired(episode: PodcastEpisode): boolean {
  if (!episode.audioExpiresAt) return false;
  const ts = Date.parse(episode.audioExpiresAt);
  return Number.isFinite(ts) && ts <= Date.now();
}

function formatEpisodeStatus(episode: PodcastEpisode): string {
  if (episode.audioRenderStatus === "rendered" && isPlayableAudioUrl(episode.audioUrl)) {
    return isAudioExpired(episode) ? "音频已过期" : "可播放";
  }
  if (episode.audioRenderStatus === "failed") {
    return "渲染失败";
  }
  if (episode.audioRenderStatus === "pending" || !episode.audioRenderStatus) {
    return episode.scriptReviewStatus === "用户确认" ? "已确认，待合成" : "待确认脚本";
  }
  if (episode.status === "ready") {
    return "已就绪";
  }
  if (episode.status === "draft") {
    return "草稿";
  }
  return String(episode.status);
}

function statusPillClass(episode: PodcastEpisode): string {
  if (episode.audioRenderStatus === "rendered" && isAudioExpired(episode)) return "is-stale";
  if (episode.audioRenderStatus === "rendered") return "is-tracked";
  if (episode.audioRenderStatus === "failed") return "is-stale";
  return "";
}

function formatAudioPlaceholder(episode: PodcastEpisode): string {
  if (episode.audioRenderStatus === "failed") return "渲染失败";
  if (episode.audioRenderStatus === "pending") return "待合成";
  return "本地占位";
}

function isPlayableAudioUrl(value: string) {
  return /^(https?:\/\/|blob:|data:audio\/|\/api\/podcast\/episodes\/)/i.test(value);
}

function inferAudioMimeType(value: string) {
  const cleanUrl = value.split("?")[0].toLowerCase();
  if (cleanUrl.endsWith(".wav") || /\/api\/podcast\/episodes\/[^/]+\/audio$/.test(cleanUrl)) {
    return "audio/wav";
  }
  if (cleanUrl.endsWith(".ogg")) return "audio/ogg";
  if (cleanUrl.endsWith(".pcm")) return "audio/L16";
  return "audio/mpeg";
}
