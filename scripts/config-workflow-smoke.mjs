import { chromium } from "playwright";
import fs from "node:fs";

const BASE = process.env.SMOKE_BASE || "http://127.0.0.1:3210";
const out = { base: BASE, startedAt: new Date().toISOString(), steps: [], ok: true, errors: [] };

function step(name, data = {}) {
  const row = { name, at: new Date().toISOString(), ...data };
  out.steps.push(row);
  console.log(JSON.stringify(row));
  return row;
}
function fail(name, err) {
  out.ok = false;
  const msg = err instanceof Error ? err.message : String(err);
  out.errors.push({ name, msg });
  step(name, { status: "fail", error: msg });
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  page.setDefaultTimeout(40000);
  try {
    const health = await fetch(BASE + "/api/health").then((r) => r.json());
    if (!health.ok || !health.ready) throw new Error("health not ready");
    step("health", { status: "pass" });

    await page.goto(BASE + "/?view=config&section=status", { waitUntil: "networkidle" });
    await page.evaluate(async () => {
      const r = await fetch("/api/runtime-bootstrap", { credentials: "include" });
      if (!r.ok) throw new Error("bootstrap " + r.status);
    });
    await page.getByRole("heading", { name: "实时能力状态与运行参数" }).waitFor();
    const url = page.url();
    step("open-config-url", { status: url.includes("view=config") ? "pass" : "fail", url });
    if (!url.includes("view=config")) throw new Error("url not config");

    await page.getByRole("heading", { name: "Product API 实时状态" }).waitFor({ timeout: 20000 });
    const risk = await page.getByTestId("config-risk-strip").isVisible().catch(() => false);
    step("risk-or-status", { status: "pass", risk });

    // sticky my-assets should not remain when on config
    await page.goto(BASE + "/?view=my-assets&filter=all&important=0&sort=updated-desc", { waitUntil: "networkidle" });
    await page.getByRole("button", { name: "系统配置", exact: true }).click();
    await page.getByRole("heading", { name: "实时能力状态与运行参数" }).waitFor();
    await page.waitForTimeout(400);
    const afterNav = page.url();
    const clean =
      afterNav.includes("view=config") &&
      !afterNav.includes("filter=") &&
      !afterNav.includes("important=") &&
      !afterNav.includes("sort=");
    step("nav-clears-my-assets-query", { status: clean ? "pass" : "fail", url: afterNav });
    if (!clean) throw new Error("sticky my-assets query: " + afterNav);

    // config tabs: accessible name includes description text, so match by class + label
    await page.locator("button.config-tab", { hasText: "参数" }).click();
    await page.getByRole("heading", { name: "产品策略" }).waitFor({ timeout: 15000 });
    await page.waitForTimeout(300);
    step("open-settings", { status: page.url().includes("section=settings") ? "pass" : "warn", url: page.url() });

    const silence = page.locator('input[name="interview.silenceHoldMs"]');
    const before = await silence.inputValue();
    const nextVal = String(Math.min(6000, Math.max(300, Number(before) === 1500 ? 1600 : 1500)));
    await silence.fill(nextVal);
    await page.waitForTimeout(200);
    const sticky = await page.getByText("未保存").first().isVisible().catch(() => false);
    step("dirty-sticky", { status: sticky ? "pass" : "warn", before, nextVal, sticky });

    await page.getByTestId("save-product-config").click();
    await page.waitForTimeout(600);
    const saved = await silence.inputValue();
    step("save-product", { status: saved === nextVal ? "pass" : "fail", saved });

    // restore original
    await silence.fill(before);
    await page.getByTestId("save-product-config").click();
    await page.waitForTimeout(400);
    step("restore-product", { status: (await silence.inputValue()) === before ? "pass" : "warn", before });

    await page.goto(BASE + "/?view=config&section=status", { waitUntil: "networkidle" });
    await page.getByRole("heading", { name: "Product API 实时状态" }).waitFor();
    step("refresh-status", { status: "pass", url: page.url() });
  } catch (err) {
    fail("workflow", err);
    try {
      await page.screenshot({ path: "/tmp/config-workflow-smoke.png", fullPage: true });
      out.screenshot = "/tmp/config-workflow-smoke.png";
    } catch {}
  } finally {
    out.finishedAt = new Date().toISOString();
    const pass = out.steps.filter((s) => s.status === "pass").length;
    const failN = out.steps.filter((s) => s.status === "fail").length;
    const warn = out.steps.filter((s) => s.status === "warn").length;
    out.summary = { pass, fail: failN, warn, ok: out.ok && failN === 0 };
    fs.writeFileSync("/tmp/config-workflow-smoke.json", JSON.stringify(out, null, 2));
    await browser.close();
    console.log("SUMMARY", JSON.stringify(out.summary));
    console.log("RESULT", out.summary.ok ? "PASS" : "FAIL");
    if (!out.summary.ok) process.exitCode = 1;
  }
}
main();
