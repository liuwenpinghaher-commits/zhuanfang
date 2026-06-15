// E2E for Phase 8: voice-path pre_signals endpoint. Run: npx tsx scripts/verify-presignals.ts
import { readFileSync } from "node:fs";
import { buildApiServer } from "../apps/api/src/server";

for (const line of readFileSync(new URL("../.env.local", import.meta.url), "utf8").split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
  if (m && !line.trim().startsWith("#")) process.env[m[1]] ??= m[2];
}

const server = buildApiServer();
const post = async (url: string, payload?: unknown) =>
  (await server.inject({ method: "POST", url, payload: (payload ?? {}) as object })).json() as any;

const created = await post("/api/interview-sessions", { mode: "decision", strength: "standard" });
const id = created.session.id;
for (const t of [
  "我在纠结要不要把现在这个项目交给团队自己扛。",
  "主要是怕他们扛不住，最后还是得我来收拾。"
]) {
  await post(`/api/interview-sessions/${id}/turns`, { content: t });
}

const r = await post(`/api/interview-sessions/${id}/pre-signals`);
const ps = r.preSignals;
console.log("=== Phase 8：语音路径 pre_signals（LLM 实时预判）===");
console.log("depthDirection   :", JSON.stringify(ps?.depthDirection));
console.log("backchannel 白名单:", ps?.backchannelWhitelist);
console.log("interrupt 触发词  :", ps?.interruptTriggers);
console.log("sensitivity      :", ps?.interruptSensitivity);

const ok =
  ps &&
  (ps.depthDirection?.concept || ps.depthDirection?.guidance) &&
  Array.isArray(ps.backchannelWhitelist) &&
  ["low", "medium", "high"].includes(ps.interruptSensitivity);
console.log("\n判定 →", ok ? "✅ pre_signals 成功生成并解析" : "⚠️ pre_signals 结构不完整");

await server.close();
