/**
 * Demo-host voice adapter. Dynamic-import Playwright only.
 * Never import cascade e2e specs or server-reset helpers.
 * Cookie: zf_session on HTTPS only.
 */
import { installFakeMic, speak } from "./fake-mic.mjs";

async function userTurnCount(pollUserTurns) {
  if (typeof pollUserTurns !== "function") return 0;
  return Number(await pollUserTurns()) || 0;
}

async function maybeLogin(page, username, password) {
  const userBox = page.locator('input[name="username"]');
  if (await userBox.isVisible({ timeout: 3000 }).catch(() => false)) {
    await userBox.fill(username);
    await page.locator('input[name="password"]').fill(password);
    await page.locator('button[type="submit"]').click();
    await page.waitForTimeout(1500);
  }
}

export async function deliverVoiceScenario({
  scenario,
  cookie,
  origin,
  utterances,
  username,
  password,
  pollUserTurns,
  log = console.log
}) {
  if (!origin.startsWith("https://")) {
    throw new Error("voice adapter requires HTTPS origin (zf_session Secure)");
  }
  const pw = await import("playwright");
  const { chromium } = pw;
  const launchOpts = {
    headless: true,
    args: ["--use-fake-ui-for-media-stream", "--autoplay-policy=no-user-gesture-required"]
  };
  if (process.env.EVAL_CHROME_CHANNEL) launchOpts.channel = process.env.EVAL_CHROME_CHANNEL;
  if (process.env.EVAL_CHROME_PATH) launchOpts.executablePath = process.env.EVAL_CHROME_PATH;
  const browser = await chromium.launch(launchOpts);
  const result = {
    ok: false,
    scenarioId: scenario.id,
    userTurns: 0,
    echoSpokeEarly: false,
    bargeAttempted: false
  };
  let page;
  try {
    const context = await browser.newContext();
    await context.addCookies([
      {
        name: "zf_session",
        value: cookie,
        url: origin,
        httpOnly: true,
        secure: true
      }
    ]);
    await installFakeMic(context);
    page = await context.newPage();
    await page.goto(origin.replace(/\/$/, "") + "/", { waitUntil: "domcontentloaded", timeout: 60000 });
    await maybeLogin(page, username, password);
    log(JSON.stringify({ event: "eval_voice_page", url: origin, scenario: scenario.id }));

    const home = page.getByRole("button", { name: "今日访谈台" });
    if (await home.isVisible({ timeout: 8000 }).catch(() => false)) {
      await home.click();
    }
    const resume = page.getByRole("button", { name: /^继续$/ });
    if (await resume.first().isVisible({ timeout: 4000 }).catch(() => false)) {
      await resume.first().click();
    } else {
      const start = page.locator("button.primary-action").filter({ hasText: /一键开始|另开一场/ });
      await start.first().click({ timeout: 25000 });
    }
    const rec = page.getByLabel("开始录音");
    await rec.click({ timeout: 45000 });

    const pcm = utterances?.[0]?.pcmBase64;
    if (!pcm) {
      result.ok = false;
      result.error = "missing_pcm";
      return result;
    }

    if (scenario.id === "VOICE-echo") {
      const speaking = page.getByText("AI 正在回应");
      const speakingVisible = await speaking.isVisible({ timeout: 8000 }).catch(() => false);
      if (speakingVisible) {
        const before = await userTurnCount(pollUserTurns);
        await speak(page, pcm, { vadSilenceMs: 800 });
        result.echoSpokeEarly = true;
        await page.waitForTimeout(1500);
        const afterEcho = await userTurnCount(pollUserTurns);
        result.echoCreatedTurn = afterEcho > before;
      }
    }

    const listening = page.getByText("聆听");
    await listening.waitFor({ timeout: 40000 });
    await page.waitForTimeout(1200);
    const hasMic = await page.evaluate(() => Boolean(window.__fakeMic));
    const statusText = await page.locator(".status-dot").locator("xpath=..").innerText().catch(() => "");
    log(JSON.stringify({ event: "eval_voice_ready", hasMic, statusText: String(statusText).slice(0, 80) }));
    const beforeSpeak = await userTurnCount(pollUserTurns);
    await speak(page, pcm, { vadSilenceMs: 1800 });
    const deadline = Date.now() + 50000;
    while (Date.now() < deadline) {
      const n = await userTurnCount(pollUserTurns);
      if (n > beforeSpeak) {
        result.userTurns = n;
        break;
      }
      await page.waitForTimeout(2000);
    }
    result.userTurns = await userTurnCount(pollUserTurns);

    if (scenario.id === "VOICE-barge") {
      const hostSpeaking = await page.getByText("AI 正在回应").isVisible({ timeout: 20000 }).catch(() => false);
      if (hostSpeaking) {
        result.bargeAttempted = true;
        await speak(page, pcm, { vadSilenceMs: 1700 });
      }
    }

    result.ok = result.userTurns > 0;
    if (!result.ok) {
      try {
        await page.screenshot({ path: `voice-fail-${scenario.id}.png`, fullPage: true });
      } catch {
        /* */
      }
    }
    log(JSON.stringify({ event: "eval_voice_done", ...result }));
    return result;
  } catch (err) {
    try {
      if (page) await page.screenshot({ path: `voice-fail-${scenario.id}.png`, fullPage: true });
    } catch {
      /* */
    }
    throw err;
  } finally {
    await browser.close();
  }
}

export function voiceAdapterForbiddenImports() {
  return {
    cascadeSpec: false,
    e2eResetHelpers: false,
    allDataReset: false
  };
}
