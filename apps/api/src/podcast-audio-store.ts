import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const SAFE_ID = /^[A-Za-z0-9._-]+$/;

export function resolvePodcastAudioDir(env: Record<string, string | undefined> = process.env): string {
  const explicit = (env.PODCAST_AUDIO_DIR ?? "").trim();
  if (explicit) return explicit;
  const corpus = (env.CORPUS_UPLOAD_DIR ?? "").trim();
  if (corpus) return join(corpus, "..", "podcast-audio");
  return join(process.cwd(), ".data", "podcast-audio");
}

export function podcastAudioPublicPath(episodeId: string, cacheBust?: number): string {
  const q = cacheBust ? `?t=${cacheBust}` : "";
  return `/api/podcast/episodes/${encodeURIComponent(episodeId)}/audio${q}`;
}

export async function writePodcastAudio(
  episodeId: string,
  bytes: Buffer,
  env: Record<string, string | undefined> = process.env
): Promise<string> {
  const id = assertSafeEpisodeId(episodeId);
  const dir = resolvePodcastAudioDir(env);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${id}.wav`), bytes);
  return podcastAudioPublicPath(id, Date.now());
}

export async function readPodcastAudio(
  episodeId: string,
  env: Record<string, string | undefined> = process.env
): Promise<Buffer | null> {
  const id = assertSafeEpisodeId(episodeId);
  try {
    return await readFile(join(resolvePodcastAudioDir(env), `${id}.wav`));
  } catch {
    return null;
  }
}

function assertSafeEpisodeId(episodeId: string): string {
  const id = episodeId.trim();
  if (!SAFE_ID.test(id)) {
    throw new Error("Invalid podcast episode id.");
  }
  return id;
}
