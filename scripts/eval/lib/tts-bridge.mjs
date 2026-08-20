/**
 * Canonical utterance audio: CosyVoice when the key works, else espeak-ng + sox
 * so voice eval can still inject 16k mono s16le PCM.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";

const CACHE = new URL("../.tts-cache/", import.meta.url);

export function cachePath(text) {
  const sha = createHash("sha256").update(String(text)).digest("hex");
  return join(CACHE.pathname, `${sha}.json`);
}

function synthesizeWithEspeak(text) {
  mkdirSync(CACHE.pathname, { recursive: true });
  const wav = join(CACHE.pathname, "espeak.wav");
  const pcmPath = join(CACHE.pathname, "espeak.raw");
  let r = spawnSync("espeak-ng", ["-v", "zh", "-s", "140", "-w", wav, text], { encoding: "utf8" });
  if (r.status !== 0) {
    r = spawnSync("espeak-ng", ["-v", "cmn", "-s", "140", "-w", wav, text], { encoding: "utf8" });
  }
  if (r.status !== 0) {
    throw new Error(`espeak-ng failed: ${String(r.stderr || r.error || "").slice(0, 200)}`);
  }
  const sox = spawnSync(
    "sox",
    [wav, "-t", "raw", "-r", "16000", "-c", "1", "-b", "16", "-e", "signed-integer", pcmPath],
    { encoding: "utf8" }
  );
  if (sox.status !== 0) {
    throw new Error(`sox failed: ${String(sox.stderr || sox.error || "").slice(0, 200)}`);
  }
  const pcm = readFileSync(pcmPath);
  const durationMs = Math.round((pcm.length / 2 / 16000) * 1000);
  return {
    sampleRate: 16000,
    channels: 1,
    format: "s16le",
    source: "espeak-ng",
    utterances: [{ text, pcmBase64: pcm.toString("base64"), durationMs }]
  };
}

export async function synthesizeCanonical(text, env = process.env) {
  mkdirSync(CACHE.pathname, { recursive: true });
  const file = cachePath(text);
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    /* miss */
  }
  if (String(env.EVAL_TTS_LOCAL ?? "") === "1") {
    const local = synthesizeWithEspeak(text);
    writeFileSync(file, JSON.stringify(local), "utf8");
    return local;
  }
  const key = String(env.DASHSCOPE_API_KEY ?? env.BAILIAN_API_KEY ?? "").trim();
  if (key) {
    try {
      const script = new URL("../../gen-voice-fixtures.mjs", import.meta.url).pathname;
      const tmpIn = join(CACHE.pathname, "in.json");
      const tmpOut = join(CACHE.pathname, "out.json");
      writeFileSync(tmpIn, JSON.stringify([{ content: text }]), "utf8");
      const childEnv = { ...env, DASHSCOPE_API_KEY: key, BAILIAN_API_KEY: env.BAILIAN_API_KEY || key };
      await new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [script, tmpIn, tmpOut], { env: childEnv, stdio: "inherit" });
        child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`tts ${code}`))));
      });
      const out = JSON.parse(readFileSync(tmpOut, "utf8"));
      writeFileSync(file, JSON.stringify(out), "utf8");
      return out;
    } catch {
      /* DashScope key often 401 for CosyVoice WS; fall through to local TTS. */
    }
  }
  const local = synthesizeWithEspeak(text);
  writeFileSync(file, JSON.stringify(local), "utf8");
  return local;
}
