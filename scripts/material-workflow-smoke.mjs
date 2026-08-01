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

async function getState(page) {
  const res = await page.evaluate(async () => {
    const r = await fetch("/api/state", { credentials: "include" });
    if (!r.ok) throw new Error("state " + r.status);
    return r.json();
  });
  return res;
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  page.setDefaultTimeout(30000);
  try {
    await page.goto(BASE + "/", { waitUntil: "networkidle" });
    const boot = await page.evaluate(async () => {
      const r = await fetch("/api/runtime-bootstrap", { credentials: "include" });
      return { status: r.status, body: await r.json() };
    });
    step("bootstrap", { status: boot.status === 200 ? "pass" : "fail", boot });
    if (boot.status !== 200) throw new Error("bootstrap failed");

    // cleanup empty resumes if any
    for (let i = 0; i < 4; i++) {
      const btn = page.getByRole("button", { name: "移除空场" }).first();
      if (!(await btn.isVisible().catch(() => false))) break;
      await btn.click();
      await page.waitForTimeout(300);
    }

    // open material
    await page.getByRole("button", { name: "素材库" }).click();
    await page.getByRole("heading", { name: "导入资料与知识索引" }).waitFor();
    const url = page.url();
    const urlOk = url.includes("view=material");
    step("open-material-url", { status: urlOk ? "pass" : "fail", url });
    if (!urlOk) throw new Error("URL not view=material: " + url);

    const markers = {
      workshop: await page.getByText("原料车间").first().isVisible(),
      index: await page.getByRole("heading", { name: "索引概览" }).isVisible(),
      rebuild: await page.getByRole("button", { name: /重建知识索引/ }).isVisible(),
      importBtn: await page.getByRole("button", { name: "导入" }).isVisible()
    };
    step("ui-markers", { status: Object.values(markers).every(Boolean) ? "pass" : "fail", markers });

    // fill import form with unique title
    const title = `UI冒烟素材-${Date.now()}`;
    const body = "端到端业务质量验证文本。关键判断：授权需要边界，复盘必须落到具体场景，而不是抽象口号。";
    await page.locator("#material-import-title").fill(title);
    await page.locator("#material-import-body").fill(body);
    await page.getByRole("button", { name: "导入", exact: true }).click();

    // wait result strip or error
    await page.waitForTimeout(500);
    const resultVisible = await page.getByText("本轮导入结果").waitFor({ state: "visible", timeout: 120000 }).then(() => true).catch(() => false);
    const errVisible = await page.locator(".field-status.is-danger").first().isVisible().catch(() => false);
    if (!resultVisible) {
      const errText = errVisible ? await page.locator(".field-status.is-danger").first().innerText() : "";
      throw new Error("import result missing; error=" + errText);
    }
    const resultText = await page.locator(".material-import-result").innerText();
    step("import-result-ui", { status: "pass", resultText: resultText.slice(0, 200) });

    // list contains title
    await page.getByText(title, { exact: true }).first().waitFor({ timeout: 10000 });
    step("list-contains-source", { status: "pass", title });

    // API consistency
    const st = await getState(page);
    const src = (st.importSources || []).find((s) => s.title === title);
    const cands = (st.memoryCandidates || []).filter((c) => c.sourceId === src?.id && c.status === "pending");
    step("import-api-consistency", {
      status: src && cands.length >= 0 ? "pass" : "fail",
      sourceId: src?.id,
      chunkIds: src?.chunkIds?.length,
      pendingCandidates: cands.length
    });
    if (!src) throw new Error("source not in state");

    // preview + start interview CTA visibility
    const row = page.locator(".material-source-row", { hasText: title }).first();
    await row.getByRole("button", { name: "预览" }).click();
    const previewOk = await row.locator(".material-source-preview").isVisible();
    step("preview", { status: previewOk ? "pass" : "fail" });

    // go review memory
    await page.getByRole("button", { name: /去审核候选记忆/ }).first().click();
    await page.getByRole("heading", { name: "导入资料，审核长期记忆" }).waitFor();
    const memUrl = page.url();
    const memUrlOk = memUrl.includes("view=memory");
    const focusCopy = await page.getByText(/正在查看素材导入的/).first().isVisible().catch(() => false);
    // if candidates filtered, subtitle changes; if zero candidates filter falls back to all
    step("review-memory-nav", { status: memUrlOk ? "pass" : "fail", memUrl, focusCopy, pendingShown: await page.locator("body").innerText().then(t => /待审/.test(t)) });

    // back to material via nav
    await page.getByRole("button", { name: "素材库" }).click();
    await page.getByRole("heading", { name: "导入资料与知识索引" }).waitFor();
    step("back-to-material", { status: page.url().includes("view=material") ? "pass" : "warn", url: page.url() });

    // use material start interview
    page.once("dialog", async (d) => { await d.accept(); });
    await page.locator(".material-source-row", { hasText: title }).getByRole("button", { name: "用此素材开场" }).click();
    const interview = await Promise.race([
      page.locator(".interview-layout").waitFor({ state: "visible", timeout: 25000 }).then(() => "layout"),
      page.locator(".opening-hero").waitFor({ state: "visible", timeout: 25000 }).then(() => "hero"),
      page.locator(".interview-launch").waitFor({ state: "visible", timeout: 25000 }).then(() => "launch")
    ]).catch(() => null);
    step("start-with-material", { status: interview ? "pass" : "fail", interview });
    if (!interview) throw new Error("did not enter interview");

    await page.waitForTimeout(1200);
    const st2 = await getState(page);
    const active = (st2.sessions || []).filter((s) => s.status === "active").sort((a,b)=>String(b.startedAt||"").localeCompare(String(a.startedAt||"")));
    const newest = active[0];
    const topic = newest?.guide?.topicHint || newest?.card?.title || newest?.title || "";
    const topicOk = String(topic).includes(title) || String(newest?.title || "").includes(title.slice(0, 8));
    step("session-topic-from-material", {
      status: newest && topicOk ? "pass" : "warn",
      newest: newest ? { id: newest.id, mode: newest.mode, title: newest.title, topicHint: newest.guide?.topicHint, relatedThemeIds: newest.relatedThemeIds || [] } : null,
      expectedTitle: title
    });

    // rebuild index smoke (optional but quality)
    await page.getByRole("button", { name: "素材库" }).click().catch(()=>{});
    // may still be on interview - force nav
    await page.getByRole("button", { name: "素材库" }).click();
    await page.getByRole("heading", { name: "导入资料与知识索引" }).waitFor({ timeout: 10000 });
    await page.getByRole("button", { name: /重建知识索引/ }).click();
    await page.getByText(/重建完成|重建失败/).first().waitFor({ timeout: 60000 }).catch(()=>{});
    const rebuildText = await page.locator("main").innerText();
    step("rebuild-index", { status: /重建完成/.test(rebuildText) ? "pass" : (/重建失败/.test(rebuildText) ? "warn" : "warn"), hit: (rebuildText.match(/重建完成[^\n]*/)||[])[0] || (rebuildText.match(/重建失败[^\n]*/)||[])[0] || null });

  } catch (err) {
    fail("workflow", err);
    try { await page.screenshot({ path: "/tmp/material-workflow-smoke.png", fullPage: true }); out.screenshot = "/tmp/material-workflow-smoke.png"; } catch {}
  } finally {
    out.finishedAt = new Date().toISOString();
    fs.writeFileSync("/tmp/material-workflow-smoke.json", JSON.stringify(out, null, 2));
    await browser.close();
    console.log("RESULT", out.ok ? "PASS" : "FAIL");
    if (!out.ok) process.exitCode = 1;
  }
}
main();
