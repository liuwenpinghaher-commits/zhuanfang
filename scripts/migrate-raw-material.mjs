// One-shot migration: backfill evidence anchors + offload completed sessions' raw material
// into cold storage. Idempotent — re-running is a no-op for sessions already offloaded.
// Requires the API server to be running (npm run dev / start). Reads PRODUCT_API_BASE from .env.local.
import { readFileSync } from "node:fs";

function loadEnv(url) {
  const e = {};
  try {
    for (const l of readFileSync(url, "utf8").split(/\r?\n/)) {
      const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (m && !l.trim().startsWith("#")) e[m[1]] = m[2];
    }
  } catch {}
  return e;
}

const env = loadEnv(new URL("../.env.local", import.meta.url));
const API = env.PRODUCT_API_BASE || "http://127.0.0.1:3210";

const res = await fetch(`${API}/api/admin/offload-completed`, { method: "POST" });
if (!res.ok) {
  console.error(`迁移失败: HTTP ${res.status} — ${await res.text()}`);
  process.exit(1);
}
const { offloaded } = await res.json();
console.log(`已降冷 ${offloaded} 个已完成会话（证据锚点已在降冷前回填）。`);
