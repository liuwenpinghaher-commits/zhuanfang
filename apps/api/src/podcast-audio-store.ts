import { mkdir, readdir, readFile, unlink, writeFile } from "node:fs/promises";
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

export async function deletePodcastAudio(
  episodeId: string,
  env: Record<string, string | undefined> = process.env
): Promise<"deleted" | "missing"> {
  const id = assertSafeEpisodeId(episodeId);
  try {
    await unlink(join(resolvePodcastAudioDir(env), `${id}.wav`));
    return "deleted";
  } catch (err) {
    const code = err && typeof err === "object" && "code" in err ? String((err as { code?: unknown }).code) : "";
    if (code === "ENOENT") return "missing";
    throw err;
  }
}

/** Full wipe: remove leftover wavs after purge/reset (ids may already be gone from state). */
export async function purgePodcastAudioDir(
  env: Record<string, string | undefined> = process.env
): Promise<{ deleted: number; missing: number }> {
  const dir = resolvePodcastAudioDir(env);
  let names: string[] = [];
  try {
    names = await readdir(dir);
  } catch (err) {
    const code = err && typeof err === "object" && "code" in err ? String((err as { code?: unknown }).code) : "";
    if (code === "ENOENT") return { deleted: 0, missing: 0 };
    throw err;
  }
  let deleted = 0;
  let missing = 0;
  for (const name of names) {
    if (!name.endsWith(".wav")) continue;
    const id = name.slice(0, -4);
    if (!SAFE_ID.test(id)) continue;
    try {
      await unlink(join(dir, name));
      deleted += 1;
    } catch (err) {
      const code = err && typeof err === "object" && "code" in err ? String((err as { code?: unknown }).code) : "";
      if (code === "ENOENT") missing += 1;
      else {
        console.warn(JSON.stringify({ event: "podcast_audio_purge_failed", file: name, error: err instanceof Error ? err.message : String(err) }));
      }
    }
  }
  return { deleted, missing };
}

function assertSafeEpisodeId(episodeId: string): string {
  const id = episodeId.trim();
  if (!SAFE_ID.test(id)) {
    throw new Error("Invalid podcast episode id.");
  }
  return id;
}
