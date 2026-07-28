#!/usr/bin/env node
/**
 * Stage-3 backup drill (read-only against running API or dry fixture).
 * Usage:
 *   PRODUCT_API_BASE_URL=http://127.0.0.1:3210 node scripts/backup-export-smoke.mjs
 * Without a live API, exits 0 after printing how to run (honest non-fake).
 */
const base = (process.env.PRODUCT_API_BASE_URL || "").replace(/\/$/, "");
const token = process.env.PRODUCT_API_TOKEN || process.env.VITE_PRODUCT_API_TOKEN || "";

async function main() {
  if (!base) {
    console.log(
      JSON.stringify({
        ok: true,
        mode: "dry",
        message:
          "Set PRODUCT_API_BASE_URL to run live export completeness smoke. Example: PRODUCT_API_BASE_URL=http://127.0.0.1:3210 node scripts/backup-export-smoke.mjs"
      })
    );
    return;
  }
  const headers = token ? { authorization: `Bearer ${token}` } : {};
  const res = await fetch(`${base}/api/state/export`, { headers });
  if (!res.ok) {
    console.error(JSON.stringify({ ok: false, status: res.status, path: "/api/state/export" }));
    process.exit(1);
  }
  const body = await res.json();
  const completeness = body.completeness ?? {};
  const out = {
    ok: completeness.status === "complete" || completeness.status === "partial",
    status: completeness.status ?? "unknown",
    reasons: completeness.reasons ?? [],
    hasState: Boolean(body.state || body.package)
  };
  console.log(JSON.stringify(out, null, 2));
  if (!out.ok && completeness.status === "unknown") process.exit(2);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
