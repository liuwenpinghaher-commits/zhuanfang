/**
 * Demo-host voice adapter. Dynamic-import Playwright only.
 * Never import cascade e2e specs or server-reset helpers.
 * Cookie: zf_session on HTTPS only.
 */
import { installFakeMic, speak } from "./fake-mic.mjs";

async function emptyBook() {
  return { title: "", turns: [], userTurns: 0, assistantTurns: 0 };
}

async function readBook(pollBook) {
  if (typeof pollBook !== "function") return emptyBook();
  try {
    return { ...(await emptyBook()), ...(await pollBook()) };
  } catch {
    return emptyBook();
  }
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

async function waitCaptureReady(page) {
  await page.waitForFunction(
    () => {
      const capture = String(window.__asrCapture ?? "");
      return typeof window.__asrFeedPcm === "function"
        && capture !== ""
        && capture !== "starting";
    },
    { timeout: 30000 }
  ).catch(() => undefined);
}

async function waitListening(page, timeoutMs = 25000) {
  const listening = page.getByText("聆听");
  const speaking = page.getByText("AI 正在回应");
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const isListening = await listening.isVisible().catch(() => false);
    const isSpeaking = await speaking.isVisible().catch(() => false);
    if (isListening && !isSpeaking) return true;
    await page.waitForTimeout(400);
  }
  return false;
}

async function feedPcm(page, pcmB64) {
  return page.evaluate(async (b64) => {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const i16 = new Int16Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.byteLength / 2));
    const f32 = new Float32Array(i16.length);
    for (let i = 0; i < i16.length; i++) f32[i] = i16[i] / 32768;
    const feed = window.__asrFeedPcm;
    if (typeof feed !== "function") return { samples: 0, ticks: 0, peak: 0 };
    const CHUNK = 4096;
    for (let i = 0; i < f32.length; i += CHUNK) {
      feed(Array.from(f32.subarray(i, i + CHUNK)));
      await new Promise((r) => setTimeout(r, 40));
    }
    feed(new Array(16000).fill(0));
    return {
      samples: f32.length,
      ticks: Number(window.__asrTicks ?? 0),
      peak: Number(window.__asrPeak ?? 0)
    };
  }, pcmB64);
}

async function deliverUtterance(page, pcm, log) {
  const peakBefore = await page.evaluate(() => Number(window.__asrPeak ?? 0));
  const playedMs = await page.evaluate((b64) => window.__fakeMic.play(b64), pcm);
  await page.waitForTimeout(Math.min(500, Number(playedMs) + 80));
  const info = await page.evaluate(() => ({
    ticks: Number(window.__asrTicks ?? 0),
    peak: Number(window.__asrPeak ?? 0),
    capture: String(window.__asrCapture ?? ""),
    hasFeed: typeof window.__asrFeedPcm === "function"
  }));
  log(JSON.stringify({ event: "eval_asr_ticks", playedMs, ...info }));
  const gotSound = info.peak - peakBefore >= 0.02 || info.peak >= 0.05;
  if (!gotSound && info.hasFeed) {
    const fed = await feedPcm(page, pcm);
    log(JSON.stringify({ event: "eval_asr_feed", ...fed }));
  }
  const afterMs = Number(playedMs) > 8000
    ? 1800
    : Math.max(900, Number(playedMs) * 0.15 + 900);
  if (info.hasFeed) {
    await page.evaluate(() => {
      const feed = window.__asrFeedPcm;
      if (typeof feed === "function") feed(new Array(16000).fill(0));
    });
  }
  const health = await page.evaluate(() => ({
    wsReady: Boolean(window.__asrWsReady),
    lastTranscriptAt: Number(window.__asrLastTranscriptAt ?? 0),
    ticks: Number(window.__asrTicks ?? 0)
  }));
  log(JSON.stringify({ event: "eval_asr_health", ...health }));
  await page.waitForTimeout(afterMs);
  return { ...info, ...health };
}

async function waitUntil(pollBook, pred, timeoutMs, log, event) {
  const deadline = Date.now() + timeoutMs;
  let last = await readBook(pollBook);
  while (Date.now() < deadline) {
    if (pred(last)) return last;
    await new Promise((r) => setTimeout(r, 800));
    last = await readBook(pollBook);
  }
  log(JSON.stringify({ event, userTurns: last.userTurns, assistantTurns: last.assistantTurns, title: String(last.title ?? "").slice(0, 80) }));
  return last;
}

export async function deliverVoiceScenario({
  scenario,
  cookie,
  origin,
  utterances,
  username,
  password,
  pollBook,
  pollUserTurns,
  log = console.log
}) {
  if (!origin.startsWith("https://")) {
    throw new Error("voice adapter requires HTTPS origin (zf_session Secure)");
  }
  const bookPoll = pollBook ?? (typeof pollUserTurns === "function"
    ? async () => ({ userTurns: Number(await pollUserTurns()) || 0, assistantTurns: 0, turns: [], title: "" })
    : null);
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
    assistantTurns: 0,
    echoSpokeEarly: false,
    echoCreatedTurn: false,
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
    page.on("console", (msg) => {
      const t = String(msg.text() ?? "");
      if (/asr_|cascade|transcript|error|warn|WebSocket|401|403/i.test(t)) {
        log(JSON.stringify({ event: "eval_browser_console", t: t.slice(0, 240) }));
      }
    });
    page.setDefaultTimeout(Number(scenario.maxUserTurns ?? 0) >= 8 ? 300000 : 30000);
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
    const speakingAppeared = page.getByText("AI 正在回应").waitFor({ state: "visible", timeout: 25000 }).then(() => true).catch(() => false);

    const storyPcm = utterances?.[0]?.pcmBase64;
    if (!storyPcm) {
      result.ok = false;
      result.error = "missing_pcm";
      return result;
    }
    const bargePcm = utterances?.[1]?.pcmBase64 ?? storyPcm;

    await waitCaptureReady(page);

    if (scenario.id === "VOICE-echo") {
      const speakingVisible = await speakingAppeared;
      if (speakingVisible) {
        const before = await readBook(bookPoll);
        await deliverUtterance(page, storyPcm, log);
        result.echoSpokeEarly = true;
        await page.waitForTimeout(1600);
        const afterEcho = await readBook(bookPoll);
        result.echoCreatedTurn = afterEcho.userTurns > before.userTurns;
        log(JSON.stringify({
          event: "eval_echo_early",
          createdTurn: result.echoCreatedTurn,
          before: before.userTurns,
          after: afterEcho.userTurns
        }));
      }
    }

    const readyListen = await waitListening(page, Number(scenario.maxUserTurns ?? 0) >= 8 ? 90000 : 28000);
    if (!readyListen) {
      log(JSON.stringify({ event: "eval_voice_not_listening" }));
      result.error = "not_listening";
    }
    await page.waitForTimeout(600);
    const statusText = await page.locator(".status-dot").locator("xpath=..").innerText().catch(() => "");
    log(JSON.stringify({ event: "eval_voice_ready", statusText: String(statusText).slice(0, 80) }));

    const longSpeech = Number(scenario.maxUserTurns ?? 0) >= 8 || scenario.id === "VOICE-speech20";
    if (longSpeech && result.error !== "not_listening") {
      const n = Math.min(utterances.length, Number(scenario.maxUserTurns ?? utterances.length));
      let emptyStreak = 0;
      for (let i = 0; i < n; i++) {
        if (i > 0) {
          const listening = await waitListening(page, 120000);
          log(JSON.stringify({ event: "eval_speech_listen", i, listening }));
          if (!listening) {
            result.error = "not_listening";
            break;
          }
        }
        const before = await readBook(bookPoll);
        const pcm = utterances[i]?.pcmBase64;
        if (!pcm) break;
        await deliverUtterance(page, pcm, log);
        await waitUntil(bookPoll, (b) => b.userTurns > before.userTurns, 60000, log, "eval_speech_wait_user");
        await waitUntil(bookPoll, (b) => b.assistantTurns > before.assistantTurns, 90000, log, "eval_speech_wait_host");
        const now = await readBook(bookPoll);
        log(JSON.stringify({
          event: "eval_speech_turn",
          i,
          userTurns: now.userTurns,
          assistantTurns: now.assistantTurns
        }));
        if (now.userTurns <= before.userTurns) {
          emptyStreak += 1;
          if (emptyStreak >= 2) {
            result.error = "book_not_growing";
            log(JSON.stringify({ event: "eval_speech_abort", i, emptyStreak }));
            break;
          }
        } else {
          emptyStreak = 0;
        }
      }
    } else if (!longSpeech) {
    const beforeStory = await readBook(bookPoll);
    await deliverUtterance(page, storyPcm, log);
    const hostSpeech = scenario.id === "VOICE-barge"
      ? page.getByText("AI 正在回应").waitFor({ state: "visible", timeout: 50000 }).then(() => true).catch(() => false)
      : Promise.resolve(false);
    await waitUntil(
      bookPoll,
      (b) => b.userTurns > beforeStory.userTurns,
      50000,
      log,
      "eval_voice_wait_user"
    );
    await waitUntil(
      bookPoll,
      (b) => b.assistantTurns > beforeStory.assistantTurns,
      45000,
      log,
      "eval_voice_wait_host"
    );

    if (scenario.id === "VOICE-barge") {
      const hostSpeaking = await hostSpeech;
      const bookNow = await readBook(bookPoll);
      const hostStarted = hostSpeaking || bookNow.assistantTurns > beforeStory.assistantTurns;
      if (hostStarted) {
        result.bargeAttempted = true;
        const beforeBarge = await readBook(bookPoll);
        await speak(page, bargePcm, { vadSilenceMs: 900 });
        const bargePeak = await page.evaluate(() => Number(window.__asrPeak ?? 0));
        if (bargePeak < 0.05) await feedPcm(page, bargePcm);
        await waitUntil(
          bookPoll,
          (b) => b.userTurns > beforeBarge.userTurns || b.assistantTurns > beforeBarge.assistantTurns,
          25000,
          log,
          "eval_voice_wait_barge"
        );
        log(JSON.stringify({ event: "eval_barge_spoke" }));
      } else {
        log(JSON.stringify({ event: "eval_barge_no_host_speech" }));
      }
    }
    }

    const finalBook = await readBook(bookPoll);
    result.userTurns = finalBook.userTurns;
    result.assistantTurns = finalBook.assistantTurns;
    result.turns = finalBook.turns;
    result.title = finalBook.title;
    result.ok = result.userTurns > 0 && result.assistantTurns > 0;
    if (scenario.id === "VOICE-echo") {
      result.ok = result.ok && result.echoSpokeEarly && !result.echoCreatedTurn;
    }
    if (scenario.id === "VOICE-barge") {
      result.ok = result.ok && result.bargeAttempted;
    }
    if (!result.ok) {
      try {
        await page.screenshot({ path: `voice-fail-${scenario.id}.png`, fullPage: true });
      } catch {
        /* */
      }
    }
    log(JSON.stringify({ event: "eval_voice_done", ...result, turns: undefined }));
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
