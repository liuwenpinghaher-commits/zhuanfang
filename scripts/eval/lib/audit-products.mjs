// Recompute quote-match / placeholder stats for an INTERVIEW sample.
// Usage: node scripts/eval/lib/audit-products.mjs --products PATH --transcript PATH
//
// Quote convention (must match apps/api/src/intelligence/memory-extraction-llm.ts):
//   strip CJK/ASCII quotes, collapse whitespace, strip ellipsis (…/⋯/three+ dots),
//   never a lone period; then prefix-includes of EVIDENCE_QUOTE_PREFIX_CHARS.
import { readFileSync } from "node:fs";

/** Keep in lockstep with EVIDENCE_QUOTE_PREFIX_CHARS in memory-extraction-llm.ts */
export const EVIDENCE_QUOTE_PREFIX_CHARS = 48;

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : "";
}

export function normalizeQuote(s) {
  return String(s || "")
    .replace(/[“”«»「」『』„\"']/g, "")
    .replace(/[‘’]/g, "")
    .replace(/\s+/g, "")
    .replace(/[…⋯]+/g, "")
    .replace(/\.{3,}/g, "");
}

function hasEllipsis(quote) {
  return /[…⋯]/.test(quote) || /\.{3}/.test(quote);
}

export function quoteInTranscript(quote, transcript, { normalize = true } = {}) {
  const t = normalize ? normalizeQuote(transcript) : transcript;
  const q = normalize ? normalizeQuote(quote) : quote;
  if (!q) return false;
  const n = EVIDENCE_QUOTE_PREFIX_CHARS;
  if (t.includes(q.slice(0, Math.min(n, q.length)))) return true;
  const parts = String(quote || "")
    .split(/[…⋯]+|\.{3,}/)
    .map((p) => (normalize ? normalizeQuote(p) : p))
    .filter((p) => p.length >= 8);
  return parts.length > 0 && parts.every((p) => t.includes(p.slice(0, n)));
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
    if (hasEllipsis(q)) ellipsis += 1;
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
