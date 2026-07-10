// 把现有 sqlite 整 ProductState 种进嵌入式 SurrealDB,使双写影子起点相等。
// 用法(经 tsx,因要 import TS 源):
//   npx tsx scripts/migrate-sqlite-to-surreal.mjs --src .data/product-state.db --dst .data/surreal [--dry-run]
// 幂等:surreal 用稳定 id UPSERT 覆盖(P1b persist),重复跑结果一致。
import process from "node:process";
import { writeFileSync } from "node:fs";
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
// 审计修复(P3-34):getState 是内存工作副本,digest 比对是"内存 vs 内存"恒等——persist 若失败
// (队列内 catch 吞错、flush 照常 resolve)DB 可能一行没写进去,却报 equivalent:true exit 0。
// 必须查权威库落库健康度(现成的 getPersistHealth),失败即 exit 1,不让运维误判成功继续切档。
const persistHealth = surreal.getPersistHealth?.() ?? { consecutiveFailures: 0 };
await surreal.close();
console.log(JSON.stringify({ event: "migrate_done", equivalent: eq, persistFailures: persistHealth.consecutiveFailures }));
if (!eq) { console.error("迁移后 surreal getState 与 sqlite 不等价 —— 排查 surreal 映射"); process.exit(1); }
if (persistHealth.consecutiveFailures > 0) {
  console.error(`迁移落库失败(consecutiveFailures=${persistHealth.consecutiveFailures}, lastError=${persistHealth.lastError ?? "?"}) —— DB 未写入,勿切档`);
  process.exit(1);
}

// 审计修复(F-01/A1):迁移确认成功(等价校验通过 + 落库零失败)后,在 surreal 数据目录落
// cutover-marker.json。server 启动期 fail-closed 时读它,把"上次迁移完成于 X / 从未迁移"
// 写进错误信息,帮运维定位是漏 migrate 还是回退后误切。
// 注意:marker **仅做诊断,不参与放行判定**——它只证明历史某刻迁移成功,不证明当下两库一致
// (迁移后回退 sqlite 继续写再切回时 marker 仍在但 surreal 已落后),放行一律由 server 侧
// assessDualSurrealCutover 的内容摘要检查决定,过期 marker 绕不过。写入失败只警告不影响
// 迁移成功的退出码(marker 是锦上添花的诊断,不是迁移交付物)。
// 时机:必须在上面两道成功校验之后——失败迁移落 marker 会制造"迁过了"的假象,误导排查。
// 只存 counts 明细、不存求和总数:此处 counts 只数 6 个核心数组,与 server 侧
// userEntityCount(16 数组)口径不同,再存一个叫"entityCount"的总数会在 fail-closed
// 日志里与 detail.surrealEntityCount 并排出现且对不上数,徒增排查困惑;明细自带语义。
try {
  writeFileSync(join(dst, "cutover-marker.json"), JSON.stringify({
    migratedAt: new Date().toISOString(),
    sourceSqliteRevision: state.revision ?? 0,
    counts,
    src, dst
  }, null, 2));
  console.log(JSON.stringify({ event: "migrate_cutover_marker_written", path: join(dst, "cutover-marker.json") }));
} catch (err) {
  console.warn(JSON.stringify({ event: "migrate_cutover_marker_write_failed", error: err instanceof Error ? err.message : String(err) }));
}
process.exit(0);
