#!/usr/bin/env node
/**
 * Wave A · A3.1 — lightweight capacity smoke (no external network).
 * Measures pure JS ranking cost as a lower bound proxy; Surreal hybrid needs mem:// suite.
 *
 * Usage: node scripts/capacity-smoke.mjs [chunkCount=2000]
 */
import { performance } from "node:perf_hooks";

const n = Math.max(100, Number(process.argv[2]) || 2000);
const query = "团队 放权 决策";

function tokenize(text) {
  return text
    .toLowerCase()
    .split(/[\s,，。.!！？?、；;：:\-_/\\|()\[\]{}「」『』""''《》<>]+/g)
    .filter((p) => p.length >= 2);
}

const chunks = Array.from({ length: n }, (_, i) => ({
  id: `c${i}`,
  title: `资料${i}`,
  text: i % 17 === 0 ? `团队正在评估放权与决策边界 ${i}` : `无关内容填充 ${i} 今天天气不错`,
  keywords: tokenize(`资料 ${i}`)
}));

const qTokens = [...new Set(tokenize(query))];
// Also emit CJK bigrams so continuous Chinese text can match (mirrors domain tokenizer spirit).
for (const part of query.replace(/\s+/g, "")) {
  /* no-op keep simple */
}
const cjk = query.replace(/\s+/g, "");
for (let i = 0; i < cjk.length - 1; i++) qTokens.push(cjk.slice(i, i + 2));
const qSet = [...new Set(qTokens.filter((t) => t.length >= 2))];

const t0 = performance.now();
const scored = chunks
  .map((c) => {
    const blob = `${c.title} ${c.text}`;
    let hits = 0;
    for (const t of qSet) if (blob.includes(t)) hits += 1;
    return { id: c.id, score: qSet.length ? hits / qSet.length : 0 };
  })
  .filter((s) => s.score > 0)
  .sort((a, b) => b.score - a.score)
  .slice(0, 8);
const ms = performance.now() - t0;

const out = {
  event: "capacity_smoke",
  chunkCount: n,
  hitCount: scored.length,
  rankMs: Number(ms.toFixed(2)),
  topIds: scored.map((s) => s.id),
  note: "JS keyword rank only — not Surreal HNSW/BM25. See packages/db surreal-recall tests for hybrid."
};
console.log(JSON.stringify(out, null, 2));
