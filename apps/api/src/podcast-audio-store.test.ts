import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { deletePodcastAudio, purgePodcastAudioDir, writePodcastAudio } from "./podcast-audio-store";

describe("podcast-audio-store", () => {
  it("deletePodcastAudio removes the wav and purgePodcastAudioDir clears leftovers", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zf-pod-audio-"));
    const env = { PODCAST_AUDIO_DIR: dir };
    await writePodcastAudio("ep_keep", Buffer.from("RIFF"), env);
    await writePodcastAudio("ep_gone", Buffer.from("RIFF"), env);
    expect(await deletePodcastAudio("ep_gone", env)).toBe("deleted");
    expect(await deletePodcastAudio("ep_gone", env)).toBe("missing");
    const leftover = await readFile(join(dir, "ep_keep.wav"));
    expect(leftover.length).toBeGreaterThan(0);
    const purged = await purgePodcastAudioDir(env);
    expect(purged.deleted).toBe(1);
    await expect(readFile(join(dir, "ep_keep.wav"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
