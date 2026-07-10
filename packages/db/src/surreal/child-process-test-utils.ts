import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

/** 测试共享 helper(仅测试引用,非生产代码):
 *  跑一个 .mts 脚本子进程(tsx)。@surrealdb/node 的 HNSW 原生线程在同进程内 db.close() 后
 *  仍持 surrealkv 独占文件锁,故所有 surrealkv I/O 必须在独立子进程完成。 */
export function runScript(src: string, scriptPath: string): { stdout: string; stderr: string; status: number | null } {
  writeFileSync(scriptPath, src);
  const tsxBin = join(process.cwd(), "node_modules/.bin/tsx");
  const result = spawnSync(tsxBin, [scriptPath], { encoding: "utf8", timeout: 30000 });
  return { stdout: result.stdout ?? "", stderr: result.stderr ?? "", status: result.status };
}

/** 取子进程 stdout 里最后一行 JSON(约定:脚本以单行 JSON 报告结果)。 */
export function lastJsonLine(stdout: string): Record<string, unknown> {
  return JSON.parse(stdout.trim().split("\n").filter((l) => l.startsWith("{")).at(-1) ?? "{}") as Record<string, unknown>;
}
