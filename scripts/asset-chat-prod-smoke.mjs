import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const BASE = process.env.SMOKE_BASE || "http://127.0.0.1:3210";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// when script lives in /tmp, project is cwd
const PROJECT = process.cwd();

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
function pass(name, data = {}) {
  step(name, { status: "pass", ...data });
}
function warn(name, data = {}) {
  step(name, { status: "warn", ...data });
}

async function api(page, method, urlPath, body) {
  return page.evaluate(
    async ({ method, urlPath, body }) => {
      const r = await fetch(urlPath, {
        method,
        credentials: "include",
        headers: body ? { "content-type": "application/json" } : undefined,
        body: body ? JSON.stringify(body) : undefined
      });
      const text = await r.text();
      let json = null;
      try {
        json = JSON.parse(text);
      } catch {
        json = { raw: text.slice(0, 500) };
      }
      return { status: r.status, json };
    },
    { method, urlPath, body }
  );
}

async function dismissEmptyResumes(page) {
  for (let i = 0; i < 6; i++) {
    const btn = page.getByRole("button", { name: "移除空场" }).first();
    if (!(await btn.isVisible().catch(() => false))) break;
    page.once("dialog", async (d) => {
      await d.accept().catch(() => {});
    });
    await btn.click().catch(() => {});
    await page.waitForTimeout(250);
  }
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  page.setDefaultTimeout(45000);

  try {
    // 1 health
    const health = await fetch(BASE + "/api/health").then((r) => r.json());
    if (!health.ok || !health.ready) throw new Error("health not ready: " + JSON.stringify(health));
    pass("health", { health: { ok: health.ok, ready: health.ready, service: health.service } });

    // 2 open app + bootstrap
    await page.goto(BASE + "/", { waitUntil: "networkidle" });
    const boot = await page.evaluate(async () => {
      const r = await fetch("/api/runtime-bootstrap", { credentials: "include" });
      return { status: r.status, body: await r.json().catch(() => ({})) };
    });
    if (boot.status !== 200) throw new Error("bootstrap " + boot.status);
    pass("bootstrap", { status: boot.status, hasToken: Boolean(boot.body?.token || boot.body?.productApiToken) });

    await dismissEmptyResumes(page);

    // 3 frontend bundle markers
    const html = await page.content();
    const assetJs = await page.evaluate(async () => {
      const scripts = [...document.querySelectorAll("script[src]")].map((s) => s.getAttribute("src"));
      const js = scripts.find((s) => s && s.includes("/assets/index-"));
      if (!js) return { js: null, text: "" };
      const t = await fetch(js).then((r) => r.text());
      return {
        js,
        markers: {
          draft: t.includes("草稿线程"),
          grounding: t.includes("已依据资料"),
          interviewCta: t.includes("就这个开专访"),
          draftId: t.includes("__new__")
        }
      };
    });
    const markersOk = assetJs.markers && Object.values(assetJs.markers).every(Boolean);
    step("bundle-markers", { status: markersOk ? "pass" : "fail", ...assetJs });
    if (!markersOk) throw new Error("bundle missing asset-chat markers");

    // 4 API: new chat session auto-title + groundingMode
    const q1 = `生产冒烟-资产对话-${Date.now()}：用一句话说明什么是诚实失败暴露。`;
    const chat1 = await api(page, "POST", "/api/chat", { message: q1 });
    if (chat1.status !== 200) throw new Error("chat1 status " + chat1.status + " " + JSON.stringify(chat1.json).slice(0, 300));
    const b1 = chat1.json;
    const sid = b1.sessionId;
    const sess1 = (b1.state?.chatSessions || []).find((s) => s.id === sid);
    const asst1 = sess1?.messages?.filter((m) => m.role === "assistant").at(-1);
    const titleOk = sess1?.title && sess1.title !== "新对话" && sess1.title.includes("生产冒烟");
    const gmOk = b1.groundingMode && asst1?.groundingMode === b1.groundingMode;
    const cites = Array.isArray(b1.citations) ? b1.citations : [];
    step("api-chat-new", {
      status: titleOk && gmOk && b1.answer ? "pass" : "fail",
      sessionId: sid,
      title: sess1?.title,
      groundingMode: b1.groundingMode,
      msgGrounding: asst1?.groundingMode,
      citationCount: cites.length,
      answerHead: String(b1.answer || "").slice(0, 120)
    });
    if (!titleOk || !gmOk || !b1.answer) throw new Error("api-chat-new checks failed");

    // 5 API: append same session
    const chat2 = await api(page, "POST", "/api/chat", {
      sessionId: sid,
      message: "请用更短的一句话复述刚才的定义，并尽量带引用。"
    });
    if (chat2.status !== 200) throw new Error("chat2 status " + chat2.status);
    const b2 = chat2.json;
    const sess2 = (b2.state?.chatSessions || []).find((s) => s.id === sid);
    const msgCount = sess2?.messages?.length || 0;
    const sameSid = b2.sessionId === sid;
    step("api-chat-append", {
      status: sameSid && msgCount >= 4 ? "pass" : "fail",
      sessionId: b2.sessionId,
      msgCount,
      groundingMode: b2.groundingMode,
      citationCount: (b2.citations || []).length
    });
    if (!sameSid || msgCount < 4) throw new Error("append failed");

    // 6 UI navigate asset-chat + URL
    await page.getByRole("button", { name: "资产对话", exact: true }).click();
    await page.getByRole("heading", { name: "与你的认知资产对话" }).waitFor({ timeout: 15000 });
    await page.waitForTimeout(400);
    const url1 = page.url();
    const urlOk = url1.includes("view=asset-chat");
    step("ui-open-asset-chat-url", { status: urlOk ? "pass" : "fail", url: url1 });
    if (!urlOk) throw new Error("url not asset-chat: " + url1);

    // session list should include our titled session (title may truncate in UI)
    const titleKey = String(sess1.title || "").slice(0, 10);
    const listHas = titleKey
      ? await page.locator(".session-list-item", { hasText: titleKey }).first().isVisible().catch(() => false)
      : false;
    step("ui-session-list-title", { status: listHas ? "pass" : "warn", titleSample: sess1.title.slice(0, 40), titleKey });

    // select our session if visible
    const sessionBtn = page.locator(".session-list-item", { hasText: titleKey }).first();
    if (titleKey && (await sessionBtn.isVisible().catch(() => false))) {
      await sessionBtn.click();
      await page.waitForTimeout(300);
    }

    // assistant grounding pill / citations if present
    const bodyText = await page.locator("main").innerText();
    const hasGroundingUi =
      /已依据资料|部分依据|无可靠资料/.test(bodyText) ||
      (await page.locator(".chat-grounding").count()) > 0;
    const hasCiteBtn = (await page.locator(".chat-thread button").filter({ hasText: /\[/ }).count()) > 0;
    step("ui-grounding-and-cites", {
      status: hasGroundingUi || hasCiteBtn ? "pass" : "warn",
      hasGroundingUi,
      hasCiteBtn,
      citeButtons: await page.locator(".chat-thread button").filter({ hasText: /\[/ }).count()
    });

    // citation click deep-link (if any)
    const cite = page.locator(".chat-thread button").filter({ hasText: /\[/ }).first();
    if (await cite.isVisible().catch(() => false)) {
      const before = page.url();
      await cite.click();
      await page.waitForTimeout(800);
      const after = page.url();
      const leftChat = !after.includes("view=asset-chat") || after !== before;
      // may stay if target same view; check notice or view change
      const notice = await page.locator(".notice, [class*='notice']").first().innerText().catch(() => "");
      const navigated =
        after.includes("view=notes") ||
        after.includes("view=memory") ||
        after.includes("view=material") ||
        after.includes("view=my-assets") ||
        after.includes("view=themes") ||
        after.includes("view=track") ||
        /已定位来源/.test(notice + (await page.locator("body").innerText()));
      step("ui-citation-click", {
        status: navigated ? "pass" : "warn",
        before,
        after,
        notice: notice.slice(0, 120)
      });
      // return to chat
      await page.getByRole("button", { name: "资产对话", exact: true }).click();
      await page.getByRole("heading", { name: "与你的认知资产对话" }).waitFor();
    } else {
      warn("ui-citation-click", { reason: "no citation buttons in current thread" });
    }

    // 7 New chat draft: must show empty thread, not historical bubbles
    await page.getByRole("button", { name: "新对话", exact: true }).click();
    await page.waitForTimeout(400);
    const draftBanner = await page.getByText("草稿线程").isVisible().catch(() => false);
    const emptyReady = await page.getByText("新对话已就绪").isVisible().catch(() => false);
    const draftUrl = page.url();
    const draftUrlOk = draftUrl.includes("view=asset-chat") && (draftUrl.includes("chat=new") || draftUrl.includes("chat=__new__") || true);
    const chatMsgs = await page.locator(".chat-msg").count();
    // historical answer snippet should not appear as bubble if draft works
    const histBubble = await page.locator(".chat-msg .chat-bubble", { hasText: String(b1.answer || "").slice(0, 20) }).count();
    step("ui-new-chat-draft", {
      status: draftBanner && emptyReady && chatMsgs === 0 && histBubble === 0 ? "pass" : "fail",
      draftBanner,
      emptyReady,
      chatMsgs,
      histBubble,
      url: draftUrl,
      draftUrlOk
    });
    if (!(draftBanner && emptyReady && chatMsgs === 0)) throw new Error("draft new chat failed");

    // send from draft UI
    const qUi = `UI草稿发送-${Date.now()}：一句话定义控制感。`;
    await page.locator("#asset-chat-draft").fill(qUi);
    await page.getByRole("button", { name: "发送", exact: true }).click();
    await page.getByText("发送中").waitFor({ state: "visible", timeout: 5000 }).catch(() => {});
    // wait for user bubble or completion
    await page.waitForFunction(
      (text) => document.body.innerText.includes(text) && !document.body.innerText.includes("发送中…"),
      qUi,
      { timeout: 120000 }
    ).catch(() => {});
    await page.waitForTimeout(800);
    const afterSendText = await page.locator("main").innerText();
    const userShown = afterSendText.includes(qUi);
    const stillDraft = await page.getByText("草稿线程").isVisible().catch(() => false);
    const errShown = await page.locator(".field-status.is-danger").first().isVisible().catch(() => false);
    const errText = errShown ? await page.locator(".field-status.is-danger").first().innerText() : "";
    // state check
    const st = await api(page, "GET", "/api/state");
    const sessions = st.json?.chatSessions || [];
    const created = sessions.find((s) => (s.messages || []).some((m) => m.role === "user" && m.content.includes(qUi)));
    step("ui-draft-send", {
      status: userShown && created && !stillDraft && !errShown ? "pass" : errShown ? "fail" : "warn",
      userShown,
      stillDraft,
      errText: errText.slice(0, 200),
      createdSessionId: created?.id,
      createdTitle: created?.title,
      url: page.url()
    });
    if (errShown) throw new Error("ui send error: " + errText);
    if (!created) throw new Error("draft send did not create session in state");

    // 8 interview CTA if assistant present
    const interviewCta = page.getByRole("button", { name: "就这个开专访" }).first();
    if (await interviewCta.isVisible().catch(() => false)) {
      page.once("dialog", async (d) => {
        await d.accept().catch(() => {});
      });
      await interviewCta.click();
      const entered = await Promise.race([
        page.locator(".interview-layout").waitFor({ state: "visible", timeout: 20000 }).then(() => "layout"),
        page.locator(".opening-hero").waitFor({ state: "visible", timeout: 20000 }).then(() => "hero"),
        page.locator(".interview-launch").waitFor({ state: "visible", timeout: 20000 }).then(() => "launch")
      ]).catch(() => null);
      step("ui-start-interview-cta", { status: entered ? "pass" : "warn", entered, url: page.url() });
      await page.getByRole("button", { name: "资产对话", exact: true }).click().catch(() => {});
    } else {
      warn("ui-start-interview-cta", { reason: "CTA not visible yet" });
    }

    // 9 material prefill path
    await page.getByRole("button", { name: "素材库" }).click();
    await page.getByRole("heading", { name: "导入资料与知识索引" }).waitFor({ timeout: 10000 });
    const goChat = page.getByRole("button", { name: "去资产对话" }).first();
    if (await goChat.isVisible().catch(() => false)) {
      await goChat.click();
      await page.getByRole("heading", { name: "与你的认知资产对话" }).waitFor();
      await page.waitForTimeout(500);
      const draftVal = await page.locator("#asset-chat-draft").inputValue();
      const prefillOk = draftVal.includes("关于") || draftVal.includes("素材") || draftVal.length > 5;
      const draftOn = await page.getByText("草稿线程").isVisible().catch(() => false);
      step("ui-material-prefill", {
        status: prefillOk && draftOn ? "pass" : "warn",
        draftOn,
        prefillHead: draftVal.slice(0, 80),
        url: page.url()
      });
    } else {
      warn("ui-material-prefill", { reason: "no material row CTA (empty library?)" });
    }

    // 10 refresh URL stickiness
    await page.goto(BASE + "/?view=asset-chat", { waitUntil: "networkidle" });
    await page.getByRole("heading", { name: "与你的认知资产对话" }).waitFor({ timeout: 15000 });
    step("ui-url-refresh", { status: page.url().includes("view=asset-chat") ? "pass" : "fail", url: page.url() });

    // capabilities / error path sample: empty message 422
    const bad = await api(page, "POST", "/api/chat", { message: "   " });
    step("api-empty-message-422", {
      status: bad.status === 422 ? "pass" : "fail",
      statusCode: bad.status,
      error: bad.json?.error
    });

  } catch (err) {
    fail("workflow", err);
    try {
      await page.screenshot({ path: "/tmp/asset-chat-prod-smoke.png", fullPage: true });
      out.screenshot = "/tmp/asset-chat-prod-smoke.png";
    } catch {}
  } finally {
    out.finishedAt = new Date().toISOString();
    const passN = out.steps.filter((s) => s.status === "pass").length;
    const failN = out.steps.filter((s) => s.status === "fail").length;
    const warnN = out.steps.filter((s) => s.status === "warn").length;
    out.summary = { pass: passN, fail: failN, warn: warnN, ok: out.ok && failN === 0 };
    fs.writeFileSync("/tmp/asset-chat-prod-smoke.json", JSON.stringify(out, null, 2));
    await browser.close();
    console.log("SUMMARY", JSON.stringify(out.summary));
    console.log("RESULT", out.summary.ok ? "PASS" : "FAIL");
    if (!out.summary.ok) process.exitCode = 1;
  }
}

main();
