import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export type RuntimeEnv = Record<string, string | undefined>;

export function loadLocalEnvFile(cwd = process.cwd()) {
  for (const fileName of [".env.local", ".env"]) {
    const filePath = join(cwd, fileName);
    if (!existsSync(filePath)) {
      continue;
    }

    const content = readFileSync(filePath, "utf8");
    for (const line of content.split(/\r?\n/)) {
      const entry = parseEnvLine(line);
      if (!entry || process.env[entry.key] !== undefined) {
        continue;
      }
      process.env[entry.key] = entry.value;
    }
  }
}

export function readEnvFile(filePath: string): RuntimeEnv {
  if (!existsSync(filePath)) {
    return {};
  }

  return readFileSync(filePath, "utf8")
    .split(/\r?\n/)
    .reduce<RuntimeEnv>((env, line) => {
      const entry = parseEnvLine(line);
      if (entry) {
        env[entry.key] = entry.value;
      }
      return env;
    }, {});
}

export function writeEnvFileUpdates(filePath: string, updates: RuntimeEnv) {
  const existingLines = existsSync(filePath) ? readFileSync(filePath, "utf8").split(/\r?\n/) : [];
  const updatedKeys = new Set<string>();
  const nextLines = existingLines
    .map((line) => {
      const entry = parseEnvLine(line);
      if (!entry || !(entry.key in updates)) {
        return line;
      }

      updatedKeys.add(entry.key);
      const nextValue = updates[entry.key];
      return nextValue === undefined ? "" : `${entry.key}=${formatEnvValue(nextValue)}`;
    })
    .filter((line) => line.trim() !== "");

  for (const [key, value] of Object.entries(updates)) {
    if (!updatedKeys.has(key) && value !== undefined) {
      nextLines.push(`${key}=${formatEnvValue(value)}`);
    }
  }

  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, nextLines.length > 0 ? `${nextLines.join("\n")}\n` : "");
}

function parseEnvLine(line: string) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) {
    return null;
  }

  const separatorIndex = trimmed.indexOf("=");
  if (separatorIndex <= 0) {
    return null;
  }

  const key = trimmed.slice(0, separatorIndex).trim();
  const rawValue = trimmed.slice(separatorIndex + 1).trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
    return null;
  }

  return { key, value: unquoteEnvValue(rawValue) };
}

function unquoteEnvValue(value: string) {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}

function formatEnvValue(value: string) {
  if (/^[A-Za-z0-9_./:@-]+$/.test(value)) {
    return value;
  }
  return JSON.stringify(value);
}
