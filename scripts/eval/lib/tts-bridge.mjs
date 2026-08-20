/**
 * Optional CosyVoice TTS for the same canonical utterance as the text path.
 * Only loaded from the voice adapter (demo host).
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const CACHE = new URL("../.tts-cache/", import.meta.url);

export function cachePath(text) {
  const sha = createHash("sha256").update(text).digest("hex");
  return join(CACHE.pathname, `${sha}.json`);
}

export async function synthesizeCanonical(text, env = process.env) {
  mkdirSync(CACHE.pathname, { recursive: true });
  const file = cachePath(text);
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    /* miss */
  }
  const key = String(env.DASHSCOPE_API_KEY ?? "").trim();
  if (!key) {
    throw new Error("DASHSCOPE_API_KEY required for TTS");
  }
  const { spawn } = await import("node:child_process");
  // Reuse project generator when present; otherwise leave a stub for demo host.
  const script = new URL("../../gen-voice-fixtures.mjs", import.meta.url).pathname;
  const tmpIn = join(CACHE.pathname, "in.json");
  const tmpOut = join(CACHE.pathname, "out.json");
  writeFileSync(tmpIn, JSON.stringify([{ content: text }]), "utf8");
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, tmpIn, tmpOut], { env, stdio: "inherit" });
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`tts ${code}`))));
  });
  const out = JSON.parse(readFileSync(tmpOut, "utf8"));
  writeFileSync(file, JSON.stringify(out), "utf8");
  return out;
}
