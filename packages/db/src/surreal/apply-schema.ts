import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Surreal } from "surrealdb";

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "migrations");

interface MigrationRow { name: string; }

/**
 * 幂等应用 migrations/*.surql:用 _migration 账本表跳过已应用文件,
 * 文件内 DDL 自身也用 IF NOT EXISTS(双层幂等)。返回本次新应用的文件名(已应用则空数组)。
 */
export async function applySchema(db: Surreal): Promise<string[]> {
  await db.query(`
    DEFINE TABLE IF NOT EXISTS _migration SCHEMAFULL;
    DEFINE FIELD IF NOT EXISTS name      ON _migration TYPE string;
    DEFINE FIELD IF NOT EXISTS appliedAt ON _migration TYPE datetime DEFAULT time::now();
  `);

  const [appliedRows] = await db.query<[MigrationRow[]]>("SELECT name FROM _migration;");
  const applied = new Set((appliedRows ?? []).map((r) => r.name));

  const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".surql")).sort();
  const newlyApplied: string[] = [];
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = readFileSync(join(MIGRATIONS_DIR, file), "utf8");
    await db.query(sql);
    await db.query("CREATE _migration SET name = $name;", { name: file });
    newlyApplied.push(file);
  }
  return newlyApplied;
}
