const baseUrl = new URL(process.argv[2] ?? "http://127.0.0.1:3210");

function isHtml(response, body) {
  return /text\/html/i.test(response.headers.get("content-type") ?? "") || /<!doctype html|<html/i.test(body);
}

async function assertAsset(path, expectedMime) {
  const response = await fetch(new URL(path, baseUrl));
  const body = await response.text();
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
  if (!response.headers.get("content-type")?.toLowerCase().includes(expectedMime)) {
    throw new Error(`${path}: unexpected content-type ${response.headers.get("content-type")}`);
  }
  if (isHtml(response, body)) throw new Error(`${path}: received HTML fallback`);
}

await assertAsset("/vad/vad.worklet.bundle.min.js", "javascript");
await assertAsset("/vad/silero_vad_v5.onnx", "application");

const missing = await fetch(new URL("/vad/definitely-missing.worklet.js", baseUrl));
const missingBody = await missing.text();
if (missing.status !== 404 || isHtml(missing, missingBody)) {
  throw new Error("missing VAD asset must be non-HTML 404");
}

console.log(JSON.stringify({ event: "voice_static_smoke_pass" }));
