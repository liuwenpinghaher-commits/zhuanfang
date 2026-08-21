// Recompute quote-match / placeholder stats for an INTERVIEW sample.
// Usage: node scripts/eval/lib/audit-products.mjs --products PATH --transcript PATH
import { readFileSync } from "node:fs";

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : "";
}

export function normalizeQuote(s) {
  return String(s || "")
    .replace(/[“”«»「」『』„\"']/g, "")
    .replace(/[‘’]/g, "")
    .replace(/\s+/g, "")
    .replace(/[.…⋯]+/g, "");
}

export function quoteInTranscript(quote, transcript, { normalize = true } = {}) {
  const t = normalize ? normalizeQuote(transcript) : transcript;
  const q = normalize ? normalizeQuote(quote) : quote;
  if (!q) return false;
  if (t.includes(q.slice(0, Math.min(40, q.length)))) return true;
  const parts = String(quote || "").split(/[.…⋯]+/).map((p) => (normalize ? normalizeQuote(p) : p)).filter((p) => p.length >= 8);
  return parts.length > 0 && parts.every((p) => t.includes(p.slice(0, 40)));
}

function main() {
  const productsPath = arg("--products");
  const transcriptPath = arg("--transcript");
  if (!productsPath || !transcriptPath) {
    console.error("usage: --products PATH --transcript PATH");
    process.exit(2);
  }
  const products = JSON.parse(readFileSync(productsPath, "utf8"));
  const transcript = readFileSync(transcriptPath, "utf8");
  const mem = products.memoryCandidates || [];
  const points = products.points || [];
  let ellipsis = 0;
  let exactMiss = 0;
  let normMiss = 0;
  for (const m of mem) {
    const q = m.evidenceQuote || "";
    if (/[.…⋯]/.test(q)) ellipsis += 1;
    if (!quoteInTranscript(q, transcript, { normalize: false })) exactMiss += 1;
    if (!quoteInTranscript(q, transcript, { normalize: true })) normMiss += 1;
  }
  console.log(JSON.stringify({
    memories: mem.length,
    points: points.length,
    ellipsisInQuotes: ellipsis,
    unnormalizedExactSubstringMisses: exactMiss,
    normalizedMisses: normMiss
  }, null, 2));
}

if (import.meta.url === `file://${process.argv[1]}`) main();
