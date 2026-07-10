/**
 * 日志脱敏(审计 F-07)——单测 + 防回归静态扫描。
 *
 * 背景:real-provider 测试与 scripts/*.mjs 曾把带签名的音频 URL(有效期内等同
 * bearer capability)和 API key 前缀写进日志。本文件除了单测 redactUrl 行为,
 * 还对源码做静态扫描:若有人把 `console.log(audioUrl)` 或 key 前缀输出加回来,
 * 这里会变红。
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { redactUrl } from "./log-redaction";

// vitest 跑在 jsdom 下,import.meta.url 仍是 file:// URL(见 real-llm-journeys 同款处理)
const thisDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(thisDir, "../../..");

// 带签名 query 的真实形态样例(值是假的)——脱敏后绝不能出现其中任何片段
const SIGNED_URL =
  "https://dashscope-result-bj.oss-cn-beijing.aliyuncs.com/tts/2f9a/output.mp3" +
  "?Expires=1751900000&OSSAccessKeyId=LTAI5tFAKEFAKE&Signature=aBc%2FdEf123";

describe("redactUrl(TS 实现)", () => {
  it("移除 query(签名所在)、fragment 与 path 明文,只留 origin + path 短 hash", () => {
    const out = redactUrl(SIGNED_URL);
    expect(out).toMatch(
      /^https:\/\/dashscope-result-bj\.oss-cn-beijing\.aliyuncs\.com \[path#[0-9a-f]{8}\]$/
    );
    for (const leak of ["Expires", "OSSAccessKeyId", "Signature", "LTAI5t", "aBc%2FdEf", "output.mp3", "2f9a", "?", "#fragment"]) {
      expect(out).not.toContain(leak);
    }
  });

  it("fragment 一并移除", () => {
    expect(redactUrl("https://host.example/a/b#token=secret")).not.toContain("secret");
  });

  it("同 path 稳定、异 path 区分(hash 仅用于对比是否同一资源)", () => {
    expect(redactUrl("https://h.example/a?x=1")).toBe(redactUrl("https://h.example/a?y=2"));
    expect(redactUrl("https://h.example/a")).not.toBe(redactUrl("https://h.example/b"));
  });

  it("非法/空 URL 返回固定占位符,绝不回显输入", () => {
    expect(redactUrl("not a url")).toBe("[redacted-url]");
    expect(redactUrl("")).toBe("[redacted-url]");
  });
});

describe("scripts/lib/redact.mjs(脚本侧等价实现)", () => {
  it("redactUrl 与 TS 实现输出逐字节一致;describeKeyStatus 绝不含 key 字节", async () => {
    const mjs = await import(pathToFileURL(join(repoRoot, "scripts/lib/redact.mjs")).href);
    for (const sample of [
      SIGNED_URL,
      "https://h.example/a?x=1",
      // 中文 path:钉住两实现对 Unicode percent-encode 的一致性
      "https://h.example/音频/文件.mp3?Signature=x",
      "not a url",
      ""
    ]) {
      expect(mjs.redactUrl(sample)).toBe(redactUrl(sample));
    }
    expect(mjs.describeKeyStatus("sk-verysecret123")).toBe("configured: true");
    expect(mjs.describeKeyStatus("sk-verysecret123")).not.toContain("sk-");
    expect(mjs.describeKeyStatus("")).toBe("configured: false");
    expect(mjs.describeKeyStatus(undefined)).toBe("configured: false");
  });
});

// ---------------------------------------------------------------------------
// 防回归静态扫描(F-07)
//
// 扫描对象:scripts/**/*.mjs 与 apps/api/src/e2e/*.real.test.ts。
// 做法务实:按行扫描;先剥掉字符串字面量的静态文本(模板串只保留 ${...} 内的
// 表达式),避免把日志文案里的 "url" 字样误判成变量;然后:
//   (a) console 行里不得对名字含 key 的标识符做 .slice(0 / .substring(0;
//   (b) console 行里出现 url 结尾/含 url 的标识符(或 .url 属性)时,该行必须
//       经过 redactUrl( 包裹;
//   (c) console 行里出现凭据形态的 key 标识符(全大写含 KEY 的常量如
//       KEY/ANY_KEY/DASHSCOPE_API_KEY,或以大写 Key 结尾的 camelCase 如
//       apiKey)时,该行必须经过 describeKeyStatus( 包裹——堵住整 key 直出
//       (console.log(KEY) / `${KEY}`)这条比前缀更严重的路。
// 误报走 EXEMPT 精确豁免清单。
//
// ★ 已知盲区(绿灯 ≠ 无泄露,改扫描器前先读这里):
//   1. 同行混用只需一次包裹即可放行整行——`console.log(redactUrl(a), b.url)`
//      或 `console.log(describeKeyStatus(KEY), OTHER_KEY)` 不会报;
//   2. 跨多行的 console 调用(参数换行)逃逸——扫描是行级的;
//   3. 先赋值再打印(`const p = KEY.slice(0, 8); console.log(p)`)逃逸——
//      不做数据流分析。
// 这些靠 code review 兜底;本扫描钉死的是"直接把 URL / key 写进 console"
// 的最常见回归路径。
// ---------------------------------------------------------------------------

/** 精确豁免清单:key = 相对 repoRoot 的文件路径,value = 行内必须包含的准确片段 */
const EXEMPT: Array<{ file: string; lineIncludes: string }> = [];

/** 剥掉字符串字面量:'…'/"…" 整体移除;`…` 只保留 ${…} 内的表达式 */
function stripStaticStrings(line: string): string {
  let out = line.replace(/`(?:[^`\\]|\\.)*`/g, (tpl) => {
    const exprs = tpl.match(/\$\{[^}]*\}/g) ?? [];
    return exprs.map((e) => e.slice(2, -1)).join(" ; ");
  });
  out = out.replace(/'(?:[^'\\]|\\.)*'/g, "''").replace(/"(?:[^"\\]|\\.)*"/g, '""');
  return out;
}

/** 名字含 key 的标识符后接 .slice(0 / .substring(0(允许中间有 ) 与 ?.) */
const KEY_SLICE = /key[\w$]*\s*\)*\s*(?:\?\.|\.)\s*(?:slice|substring)\s*\(\s*0/i;

/**
 * 凭据形态的 key 标识符:
 * - 全大写常量且含 KEY(KEY / ANY_KEY / DASHSCOPE_API_KEY),排除 KEYS 结尾
 *   的复数泛指(如 MERGE_KEYS 这类字段名列表);
 * - 以大写 Key 结尾的 camelCase(apiKey / anySearchKey)。
 * 泛指名(循环变量 key、entry.keyword)不匹配,避免误伤。
 */
function isCredentialKeyToken(t: string): boolean {
  if (t === "describeKeyStatus") return false;
  if (/^[A-Z0-9_$]*KEY[A-Z0-9_$]*$/.test(t) && !/KEYS$/.test(t)) return true;
  return /^[a-z$][\w$]*Key$/.test(t);
}

/** (c) 整 key 直出:console 行有凭据形态 key 标识符但没经 describeKeyStatus( */
function hasUnwrappedKeyToken(sanitized: string): boolean {
  const tokens = sanitized.match(/[\w$]+/g) ?? [];
  if (!tokens.some(isCredentialKeyToken)) return false;
  return !sanitized.includes("describeKeyStatus(");
}

/** url 形态的标识符或 .url 属性访问(排除 redactUrl 自身) */
function hasUnredactedUrlToken(sanitized: string): boolean {
  const tokens = sanitized.match(/[\w$]*[Uu][Rr][Ll][\w$]*/g) ?? [];
  const urlish = tokens.filter((t) => t !== "redactUrl");
  if (urlish.length === 0) return false;
  return !sanitized.includes("redactUrl(");
}

function collectFiles(): string[] {
  const files: string[] = [];
  const scriptsDir = join(repoRoot, "scripts");
  const walk = (dir: string) => {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, ent.name);
      if (ent.isDirectory()) walk(p);
      else if (ent.name.endsWith(".mjs")) files.push(p);
    }
  };
  walk(scriptsDir);
  const e2eDir = join(repoRoot, "apps/api/src/e2e");
  for (const ent of readdirSync(e2eDir)) {
    if (ent.endsWith(".real.test.ts")) files.push(join(e2eDir, ent));
  }
  return files;
}

describe("F-07 防回归静态扫描(scripts/**/*.mjs + e2e/*.real.test.ts)", () => {
  const files = collectFiles();

  it("扫描对象非空(目录结构变了要更新本测试)", () => {
    expect(files.length).toBeGreaterThan(5);
    expect(files.some((f) => f.endsWith("real-llm-journeys.real.test.ts"))).toBe(true);
    expect(files.some((f) => f.endsWith("verify-tts.mjs"))).toBe(true);
  });

  it("console 输出里没有 key 前缀/整 key 直出与未脱敏的 URL 变量", () => {
    const violations: string[] = [];
    for (const file of files) {
      const rel = file.slice(repoRoot.length + 1);
      const lines = readFileSync(file, "utf8").split(/\r?\n/);
      lines.forEach((raw, i) => {
        const sanitized = stripStaticStrings(raw);
        const consoleAt = sanitized.search(/console\s*\.\s*(log|error|warn|info|debug)/);
        if (consoleAt < 0) return;
        if (EXEMPT.some((e) => rel === e.file && raw.includes(e.lineIncludes))) return;
        // 只审 console. 起的调用片段:同行 console 之前的守卫(如
        // `if (!KEY) { console.error("静态文案") }`)不是泄露,不该误报
        const call = sanitized.slice(consoleAt);
        if (KEY_SLICE.test(call)) {
          violations.push(`${rel}:${i + 1} [key 前缀输出] ${raw.trim()}`);
        }
        if (hasUnwrappedKeyToken(call)) {
          violations.push(`${rel}:${i + 1} [key 未经 describeKeyStatus 包裹] ${raw.trim()}`);
        }
        if (hasUnredactedUrlToken(call)) {
          violations.push(`${rel}:${i + 1} [URL 未经 redactUrl 脱敏] ${raw.trim()}`);
        }
      });
    }
    expect(violations, `F-07 违规:\n${violations.join("\n")}`).toEqual([]);
  });
});
