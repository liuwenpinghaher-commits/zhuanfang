// 把现有 sqlite 整 ProductState 种进嵌入式 SurrealDB,使双写影子起点相等。
// 用法(经 tsx,因要 import TS 源):
//   npx tsx scripts/migrate-sqlite-to-surreal.mjs --src .data/product-state.db --dst .data/surreal [--dry-run]
// 幂等:surreal 用稳定 id UPSERT 覆盖(P1b persist),重复跑结果一致。
import process from "node:process";
import { dirname, join } from "node:path";
import { createSqliteProductStateRepository } from "../packages/db/src/sqlite-product-state-repository.ts";
import { createSurrealProductStateRepository } from "../packages/db/src/surreal/surreal-product-state-repository.ts";
import { buildStableDigest } from "../src/domain/stateDigest.ts";

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--") ? process.argv[i + 1] : def;
}
const dryRun = process.argv.includes("--dry-run");
const src = arg("src", join(process.cwd(), ".data", "product-state.db"));
const dst = arg("dst", join(dirname(src), "surreal"));

const sqlite = createSqliteProductStateRepository({ dbPath: src });
const state = sqlite.getState();
const counts = {
  points: state.points.length, decisions: state.decisions.length, themes: state.themes.length,
  notes: state.notes.length, memoryRecords: state.memoryRecords.length, sessions: state.sessions.length
};
console.log(JSON.stringify({ event: "migrate_plan", src, dst, revision: state.revision, counts }));

if (dryRun) { console.log(JSON.stringify({ event: "migrate_dry_run_done" })); process.exit(0); }

const surreal = await createSurrealProductStateRepository({ url: `surrealkv://${dst}/surreal` });
surreal.replaceState(state);
await surreal.flush();

// 迁后等价校验(忽略 revision)
const back = surreal.getState();
const eq = buildStableDigest({ ...state, revision: 0 }) === buildStableDigest({ ...back, revision: 0 });
await surreal.close();
console.log(JSON.stringify({ event: "migrate_done", equivalent: eq }));
if (!eq) { console.error("迁移后 surreal getState 与 sqlite 不等价 —— 排查 surreal 映射"); process.exit(1); }
process.exit(0);
