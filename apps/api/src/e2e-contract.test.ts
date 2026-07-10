import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

/**
 * 审计修复 F-08 防回归契约扫描。
 *
 * 背景:POST /api/state/reset 自 F-05 起要求 body { confirm: "RESET_ALL_DATA" }(否则 422)。
 * F-08 发现 Playwright spec 里散落着裸 POST reset,真实旅程从 422 开始却被后续断言掩盖。
 * 修复方式是统一收口到 tests/e2e/helpers.ts 的 resetServerState()。
 *
 * 为什么用"源码扫描"而不是跑 Playwright:E2E 需要真实服务与 provider key,vitest 里跑不了;
 * 但"tests/e2e 不得绕过 helper 直拼 reset 请求"是纯文本可判定的契约——有人再裸调,这里立刻变红,
 * 不必等到夜间 E2E 才发现旅程第一步就 422。
 *
 * 为什么放在 apps/api/src 而不是 tests/ 旁边:vite.config 的 test.include 只收集
 * src/apps/packages 三棵树,tests/ 不在 vitest 发现范围(放那里会静默不执行);
 * 且本测试钉的正是 API 侧的 reset 契约,归属 apps/api 语义上也成立。
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../..");
const e2eDir = path.join(repoRoot, "tests/e2e");

/**
 * 递归列出 tests/e2e 下的全部文件(返回相对 e2eDir 的路径)。
 * 为什么递归:Playwright 的 testMatch 是递归的,未来 subdir/foo.spec.ts 的裸调只扫顶层就会漏。
 * 为什么不只扫 *.spec.ts:fakeMic.ts / global-setup.ts / fixtures 等共享文件同样会被 spec
 * 引用甚至自己发请求,绕道它们拼 reset 一样是绕过 helper——所以除 helpers.ts 本体外全部纳入。
 */
function walk(dir: string, prefix = ""): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      out.push(...walk(path.join(dir, entry.name), rel));
    } else if (entry.isFile()) {
      out.push(rel);
    }
  }
  return out;
}

/** 唯一豁免:helper 本体必须包含 reset URL(它就是收口点,由下面的正向对照用例钉住)。 */
const EXEMPT = new Set(["helpers.ts"]);

/**
 * 判定一行是否"直拼 reset 请求":
 * - 引号/模板字符串里出现 /api/state/reset(如 `${API}/api/state/reset`、"http://…/api/state/reset")
 *   → 视为直调。注释里的裸文本(如 "POST /api/state/reset → …")不带引号,不会误伤。
 * - 刻意不做完整注释剥离:朴素的 // 剥离会把 "http://…" 误当注释开头,反而漏掉真实违规。
 */
function findDirectResetCalls(source: string): Array<{ line: number; text: string }> {
  const hits: Array<{ line: number; text: string }> = [];
  const quotedResetUrl = /["'`][^"'`\n]*\/api\/state\/reset/;
  source.split("\n").forEach((text, idx) => {
    if (quotedResetUrl.test(text)) {
      hits.push({ line: idx + 1, text: text.trim() });
    }
  });
  return hits;
}

describe("e2e 契约:/api/state/reset 必须经 helpers.resetServerState(F-08)", () => {
  const allFiles = walk(e2eDir);
  const scanned = allFiles.filter((f) => !EXEMPT.has(f));

  it("扫描目标存在(路径失效时测试应失败而非空转假绿)", () => {
    // 既能看到 spec 也能看到被豁免的 helpers.ts,说明目录没被挪走、豁免名单没有失配。
    expect(allFiles.some((f) => f.endsWith(".spec.ts"))).toBe(true);
    expect(allFiles).toContain("helpers.ts");
  });

  it("除 helpers.ts 外,tests/e2e 下任何文件(递归,含共享文件/fixtures)不得直拼 /api/state/reset 请求", () => {
    const violations: string[] = [];
    for (const file of scanned) {
      const source = readFileSync(path.join(e2eDir, file), "utf8");
      for (const hit of findDirectResetCalls(source)) {
        violations.push(`tests/e2e/${file}:${hit.line} → ${hit.text}`);
      }
    }
    expect(
      violations,
      `以下文件绕过了 helpers.resetServerState 直拼 reset 请求(裸 POST 会被 422 拒,见 F-05/F-08):\n${violations.join("\n")}`
    ).toEqual([]);
  });

  it("helpers.resetServerState 在请求体构造里携带 confirm 契约(正向对照,防扫描规则空转)", () => {
    const helpers = readFileSync(path.join(e2eDir, "helpers.ts"), "utf8");
    // helper 是唯一允许拼 reset URL 的地方。
    expect(helpers).toMatch(/\/api\/state\/reset/);
    expect(helpers).toMatch(/export async function resetServerState/);
    // 关键:RESET_ALL_DATA 必须出现在 data: 请求体构造里——只断言"文件里存在该字符串"
    // 太弱(仅注释里提到也能通过),那样 helper 真丢了 confirm 字段这里不会变红。
    expect(helpers).toMatch(/data:\s*\{\s*confirm:\s*["']RESET_ALL_DATA["']\s*\}/);
  });
});
