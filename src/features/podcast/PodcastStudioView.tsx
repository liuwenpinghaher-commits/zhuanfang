import { ClipboardList, Headphones, Trash2, Volume2 } from "lucide-react";
import { HeaderBlock } from "../../components/HeaderBlock";
import type { ProductState } from "../../domain/types";
import { formatPodcastTimestamp, podcastProductionSections } from "../../ui";

interface PodcastStudioViewProps {
  state: ProductState;
  noteId: string;
  voice: string;
  onNoteId: (value: string) => void;
  onVoice: (value: string) => void;
  onGenerate: () => void;
  onDeleteEpisode: (episodeId: string) => void;
  onSaveDefaultVoice: () => void;
}

export function PodcastStudioView({
  state,
  noteId,
  voice,
  onNoteId,
  onVoice,
  onGenerate,
  onDeleteEpisode,
  onSaveDefaultVoice
}: PodcastStudioViewProps) {
  const selectedNoteId = noteId || state.notes[0]?.id || "";
  const selectedNote = state.notes.find((note) => note.id === selectedNoteId) ?? state.notes[0];
  const formatLabel: Record<"solo" | "host-guest", string> = {
    solo: "单人旁白",
    "host-guest": "主持对谈"
  };

  return (
    <section className="view-stack">
      <HeaderBlock
        eyebrow="播客工作台"
        title="把一次专访生成可收听的语音节目"
        subtitle="Product API 会生成脚本、shownotes 和音频；配置百炼 CosyVoice 后渲染真实音频，未配置时保留本地占位。"
      />

      <section className="podcast-workbench">
        <section className="panel podcast-setup-panel">
          <div className="panel-title"><Headphones size={18} /><h2>制作设置</h2></div>
          <div className="production-steps" aria-label="播客制作流程">
            {podcastProductionSections.map((section) => (
              <div className="production-step" key={section.id}>
                <strong>{section.label}</strong>
                <span>{section.description}</span>
              </div>
            ))}
          </div>
          <div className="input-row three">
            <label className="field-stack" htmlFor="podcast-note">
              <span className="field-label">来源笔记</span>
              <select id="podcast-note" value={selectedNoteId} onChange={(event) => onNoteId(event.target.value)}>
                {state.notes.map((note) => <option value={note.id} key={note.id}>{note.title}</option>)}
              </select>
            </label>
            <label className="field-stack" htmlFor="podcast-voice">
              <span className="field-label">声音配置</span>
              <input id="podcast-voice" value={voice} onChange={(event) => onVoice(event.target.value)} placeholder="声音配置" />
              <span className="field-help">可填写 CosyVoice voice id；常用默认值会由服务端映射到系统声音。</span>
            </label>
            <button className="primary-action" type="button" onClick={onGenerate} disabled={!selectedNote}>
              <Volume2 size={18} />生成音频播客
            </button>
            <button className="secondary-action" type="button" onClick={onSaveDefaultVoice}>
              保存为默认声音
            </button>
          </div>
          {selectedNote ? (
            <article className="podcast-source-card">
              <span className="label">当前来源</span>
              <h3>{selectedNote.title}</h3>
              <p>{selectedNote.summary}</p>
              <blockquote>“{selectedNote.keyQuote}”</blockquote>
            </article>
          ) : (
            <div className="empty-module">
              <ClipboardList size={22} />
              <p>还没有可生成播客的双轨笔记。先完成一次专访并生成档案。</p>
            </div>
          )}
        </section>

        <section className="podcast-result-panel">
          {state.podcastEpisodes.length === 0 && (
            <section className="panel empty-module">
              <Headphones size={22} />
              <p>还没有播客。选择一份双轨笔记后即可生成脚本、shownotes 和音频文件。</p>
            </section>
          )}
          {state.podcastEpisodes.map((episode) => (
            <article className="panel podcast-episode" key={episode.id}>
              <div className="episode-hero">
                <div>
                  <span className="status-pill">{episode.status} · {episode.voice}</span>
                  <h2>{episode.title}</h2>
                  <p>{formatLabel[episode.format]} · {formatPodcastTimestamp(episode.durationSec)} · {new Date(episode.createdAt).toLocaleDateString("zh-CN")}</p>
                  <div className="record-actions">
                    <button className="danger-button" type="button" onClick={() => onDeleteEpisode(episode.id)}>
                      <Trash2 size={16} />删除播客
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
                    {episode.chapters.map((chapter) => (
                      <div key={chapter.title}>
                        <strong>{chapter.title}</strong>
                        <span>{formatPodcastTimestamp(chapter.startsAtSec)}</span>
                        <p>{chapter.summary}</p>
                      </div>
                    ))}
                  </div>
                </section>

                <section className="episode-section">
                  <div className="section-heading">
                    <span className="label">Shownotes</span>
                    <strong>{episode.shownotes.length} 条</strong>
                  </div>
                  <ul className="shownotes-list">
                    {episode.shownotes.map((item) => <li key={item}>{item}</li>)}
                  </ul>
                </section>

                <section className="episode-section script-section">
                  <div className="section-heading">
                    <span className="label">脚本复核</span>
                    <strong>完整口播稿</strong>
                  </div>
                  <pre className="script-preview">{episode.script}</pre>
                </section>
              </div>
            </article>
          ))}
        </section>
      </section>
    </section>
  );
}

function PodcastAudioPreview({ episode }: { episode: ProductState["podcastEpisodes"][number] }) {
  const playable = isPlayableAudioUrl(episode.audioUrl);

  return (
    <div className="audio-preview" aria-label={`音频预览：${episode.title}`}>
      <Volume2 size={20} />
      <div>
        <strong>{playable ? "可播放音频" : "本地占位"}</strong>
        {playable ? (
          <audio controls preload="metadata">
            <source src={episode.audioUrl} type={inferAudioMimeType(episode.audioUrl)} />
          </audio>
        ) : (
          <p>服务端未配置真实 TTS 时会保留占位地址。</p>
        )}
        <code>{episode.audioUrl}</code>
      </div>
    </div>
  );
}

function isPlayableAudioUrl(value: string) {
  return /^(https?:\/\/|blob:|data:audio\/)/i.test(value);
}

function inferAudioMimeType(value: string) {
  const cleanUrl = value.split("?")[0].toLowerCase();
  if (cleanUrl.endsWith(".wav")) {
    return "audio/wav";
  }
  if (cleanUrl.endsWith(".ogg")) {
    return "audio/ogg";
  }
  if (cleanUrl.endsWith(".pcm")) {
    return "audio/L16";
  }
  return "audio/mpeg";
}
