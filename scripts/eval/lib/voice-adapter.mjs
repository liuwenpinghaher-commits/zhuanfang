/**
 * Demo-host voice adapter. Dynamic-import Playwright only.
 *
 * Dead commands — never pull the cascade e2e spec, never call the e2e
 * server-reset helpers, never POST the all-data reset confirm token.
 * Cookie: zf_session on HTTPS only.
 */
export async function deliverVoiceScenario({ scenario, cookie, origin, utterances, log = console.log }) {
  if (!origin.startsWith("https://")) {
    throw new Error("voice adapter requires HTTPS origin (zf_session Secure)");
  }
  const pw = await import("playwright");
  const { chromium } = pw;
  const browser = await chromium.launch({ headless: true });
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
    let fakeMic;
    try {
      fakeMic = await import("../../../tests/e2e/fakeMic.ts");
    } catch (err) {
      throw new Error(`fakeMic load failed on demo host: ${err.message}`);
    }
    await fakeMic.installFakeMic(context);
    const page = await context.newPage();
    await page.goto(origin, { waitUntil: "domcontentloaded", timeout: 60000 });
    log(JSON.stringify({ event: "eval_voice_page", url: origin, scenario: scenario.id }));
    const first = utterances?.[0];
    if (first?.pcmBase64) {
      await fakeMic.speak(page, first.pcmBase64);
    }
    return { ok: true, scenarioId: scenario.id };
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
