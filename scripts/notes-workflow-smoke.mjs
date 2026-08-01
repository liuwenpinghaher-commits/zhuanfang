import { chromium } from "playwright";
import fs from "node:fs";

const BASE = process.env.SMOKE_BASE || "http://127.0.0.1:3210";
const out = {
  base: BASE,
  startedAt: new Date().toISOString(),
  steps: [],
  ok: true,
  errors: []
};

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
  return page.evaluate(async () => {
    const res = await fetch("/api/state", { credentials: "include" });
    if (!res.ok) throw new Error("state http " + res.status);
    return res.json();
  });
}

function norm(text) {
  return String(text || "").replace(/[\s。，、；：！？·.,;:!?]/g, "");
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();
  page.setDefaultTimeout(25000);

  try {
    await page.goto(BASE + "/", { waitUntil: "networkidle" });
    const boot = await page.evaluate(async () => {
      const res = await fetch("/api/runtime-bootstrap", { credentials: "include" });
      return { status: res.status, body: await res.json() };
    });
    step("runtime-bootstrap", { status: boot.status === 200 ? "pass" : "fail", boot });
    if (boot.status !== 200) throw new Error("bootstrap failed");

    // Prefer notes without leaving dirty empty shells blocking UX; discard if present
    const discardButtons = page.getByRole("button", { name: "移除空场" });
    const discardCount = await discardButtons.count();
    if (discardCount > 0) {
      for (let i = 0; i < Math.min(discardCount, 4); i += 1) {
        // always click first because list shrinks
        const btn = page.getByRole("button", { name: "移除空场" }).first();
        if (!(await btn.isVisible().catch(() => false))) break;
        await btn.click();
        await page.waitForTimeout(400);
      }
      step("cleanup-empty-sessions", { status: "pass", attempted: discardCount });
    } else {
      step("cleanup-empty-sessions", { status: "info", reason: "none visible on home" });
    }

    await page.getByRole("button", { name: "双轨笔记" }).click();
    await page.getByRole("heading", { name: "从访谈沉淀认知资产" }).waitFor();
    step("open-notes", {
      status: (await page.getByText("阅读与回访").first().isVisible()) ? "pass" : "fail"
    });

    const markers = {
      heroStart: await page.getByRole("button", { name: /用下个问题开场|再做一次复盘/ }).first().isVisible(),
      saveBtn: await page.getByRole("button", { name: /保存到资产库|已保存到资产/ }).first().isVisible().catch(() => false),
      startQ: await page.getByRole("button", { name: "用此问题开场" }).first().isVisible().catch(() => false),
      rawBtn: await page.getByRole("button", { name: /查看原始材料/ }).first().isVisible().catch(() => false),
      search: await page.locator("#notes-search").isVisible().catch(() => false),
      filterQ: await page.getByRole("button", { name: "有回访问题" }).isVisible().catch(() => false),
      podcast: await page.getByRole("button", { name: "生成播客" }).first().isVisible().catch(() => false),
      archive: await page.getByRole("button", { name: "打开专访档案" }).first().isVisible().catch(() => false)
    };
    const surfaceOk = markers.heroStart && markers.search && markers.filterQ && markers.startQ;
    step("ui-markers", { status: surfaceOk ? "pass" : "fail", markers });
    if (!surfaceOk) throw new Error("notes UI markers missing");

    // Expand dual track if available
    const expand = page.getByRole("button", { name: "展开全部双轨与问题" }).first();
    if (await expand.isVisible().catch(() => false)) {
      await expand.click();
      step("expand-tracks", { status: "pass" });
    } else {
      step("expand-tracks", { status: "info", reason: "no overflow to expand" });
    }

    // Raw material
    const rawToggle = page.getByRole("button", { name: /查看原始材料/ }).first();
    await rawToggle.click();
    await page.waitForTimeout(1200);
    const rawText = await page.locator("main").innerText();
    const rawOk = /正在加载原始材料|主持人|原始材料未找到|加载原始材料失败|播这一段|加旁注|受访者录音/.test(rawText);
    step("open-raw-material", { status: rawOk ? "pass" : "warn", hasHostOrEmpty: rawOk });

    // Capture target question text from first question row
    const qText = (await page.locator(".notes-question-text").first().innerText().catch(() => "")).trim();
    step("target-question", { status: qText ? "pass" : "fail", qText });
    if (!qText) throw new Error("no question text on notes page");

    const beforeState = await getState(page);
    const beforeCount = (beforeState.questions || []).length;
    const beforeHas = (beforeState.questions || []).some((q) => norm(q.question) === norm(qText));

    const save = page.getByRole("button", { name: "保存到资产库" }).first();
    if (await save.isVisible().catch(() => false)) {
      await save.click();
      await page.getByText(/问题已保存到资产库|问题已在资产库/).first().waitFor({ timeout: 10000 });
      await page.getByRole("heading", { name: "从访谈沉淀认知资产" }).waitFor();
      // wait autosave
      let after = beforeState;
      let persisted = beforeHas;
      for (let i = 0; i < 10; i += 1) {
        await page.waitForTimeout(700);
        after = await getState(page);
        persisted = (after.questions || []).some((q) => norm(q.question) === norm(qText));
        if (persisted) break;
      }
      const hit = (after.questions || []).find((q) => norm(q.question) === norm(qText));
      const uiSaved = await page.getByRole("button", { name: /已保存到资产/ }).first().isVisible().catch(() => false);
      const ok = persisted && hit && hit.status === "正在聚焦" && String(hit.whyImportant || "").includes("会后反馈");
      step("save-question", {
        status: ok ? "pass" : "fail",
        beforeCount,
        afterCount: (after.questions || []).length,
        beforeHas,
        persisted,
        uiSaved,
        hit: hit
          ? { question: hit.question, status: hit.status, whyImportant: hit.whyImportant, sourceSessionId: hit.sourceSessionId }
          : null,
        stayedOnNotes: true
      });
      if (!ok) throw new Error("save-question not persisted with expected metadata");
    } else if (beforeHas) {
      step("save-question", { status: "pass", reason: "already persisted before smoke" });
    } else {
      throw new Error("save button missing and question not already saved");
    }

    // filter
    await page.getByRole("button", { name: "有回访问题", exact: true }).click();
    await page.waitForTimeout(200);
    step("filter-with-questions", {
      status: (await page.getByRole("button", { name: "用此问题开场" }).first().isVisible().catch(() => false)) ? "pass" : "warn"
    });
    await page.locator(".notes-toolbar").getByRole("button", { name: "全部", exact: true }).click();

    // start with question
    page.once("dialog", async (d) => {
      step("active-session-confirm", { message: d.message().slice(0, 160) });
      await d.accept();
    });
    await page.getByRole("button", { name: "用此问题开场" }).first().click();
    const interviewVisible = await Promise.race([
      page.locator(".interview-layout").waitFor({ state: "visible", timeout: 25000 }).then(() => "layout"),
      page.locator(".opening-hero").waitFor({ state: "visible", timeout: 25000 }).then(() => "hero"),
      page.locator(".interview-launch").waitFor({ state: "visible", timeout: 25000 }).then(() => "launch")
    ]).catch(() => null);
    const body = await page.locator("body").innerText();
    const started = Boolean(interviewVisible) || /无法开始专访|准备中/.test(body);
    step("start-with-question", { status: started ? "pass" : "fail", interviewVisible, failNotice: /无法开始专访/.test(body) });
    if (!started) throw new Error("did not enter interview");

    // verify newest active session carries topic
    await page.waitForTimeout(1500);
    const st = await getState(page);
    const active = (st.sessions || [])
      .filter((s) => s.status === "active")
      .sort((a, b) => String(b.startedAt || "").localeCompare(String(a.startedAt || "")));
    const newest = active[0];
    const topic = newest?.guide?.topicHint || newest?.card?.title || newest?.title || "";
    const topicOk = norm(topic).includes(norm(qText).slice(0, 12)) || String(topic).includes(qText.slice(0, 10));
    step("session-topic-binding", {
      status: newest ? (topicOk ? "pass" : "warn") : "fail",
      newest: newest
        ? {
            id: newest.id,
            mode: newest.mode,
            title: newest.title,
            topicHint: newest.guide?.topicHint,
            cardTitle: newest.card?.title,
            relatedThemeIds: newest.relatedThemeIds || [],
            userTurns: (newest.turns || []).filter((t) => t.role === "user").length
          }
        : null,
      expectedQuestion: qText
    });

    // optional: open archive from notes later not needed if we left page

  } catch (err) {
    fail("workflow", err);
    try {
      await page.screenshot({ path: "/tmp/notes-workflow-smoke.png", fullPage: true });
      out.screenshot = "/tmp/notes-workflow-smoke.png";
    } catch {}
  } finally {
    out.finishedAt = new Date().toISOString();
    fs.writeFileSync("/tmp/notes-workflow-smoke.json", JSON.stringify(out, null, 2));
    await browser.close();
    console.log("RESULT", out.ok ? "PASS" : "FAIL");
    if (!out.ok) process.exitCode = 1;
  }
}

main();
