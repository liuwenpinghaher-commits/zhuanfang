import { expect, test } from "@playwright/test";
import {
  createInitialProductState,
  createSessionDraft,
  receiveUserTurnWithAssistant
} from "../../src/domain/engine";
import type { InterviewSession, ProductState } from "../../src/domain/types";

// Regression guard for the turn-drop bug: submitTurn used to spread the STALE
// closure `session` whenever the API reply carried `interactionPreSignals`
// (which the real character model ALWAYS returns), dropping the freshly-added
// user + assistant turns — the server had them (200) but the UI showed none.
// The deterministic API never emits pre_signals, so only a mock that DOES emit
// them reproduces the bug. This test fails against the old code and passes after.
test("a submitted text turn renders both turns even when the reply carries pre_signals", async ({ page }) => {
  let storedState: ProductState = createInitialProductState();
  let session: InterviewSession | undefined;

  await page.route("http://127.0.0.1:8787/api/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const method = request.method();

    if (path === "/api/state" && method === "GET") {
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(storedState) });
    }
    if (path === "/api/state" && method === "PUT") {
      storedState = JSON.parse(request.postData() ?? "{}") as ProductState;
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(storedState) });
    }
    if (path === "/api/reviews" && method === "GET") {
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ monthly: null, yearly: null, radar: null }) });
    }
    if (path === "/api/interview-sessions" && method === "POST") {
      session = createSessionDraft(storedState, "decision", "standard", {});
      storedState = { ...storedState, sessions: [session, ...storedState.sessions] };
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ session, state: storedState }) });
    }
    if (path.endsWith("/turns") && method === "POST") {
      const content = (JSON.parse(request.postData() ?? "{}") as { content: string }).content;
      const withTurns = receiveUserTurnWithAssistant(session!, content, {
        content: "这听起来更像是身份的问题，而不是收入，对吗？",
        intent: "追问锚点"
      });
      // The exact trigger: attach interactionPreSignals to the response session.
      session = { ...withTurns, interactionPreSignals: { recommendedAction: "anchor_probe", confidence: 0.8 } as never };
      storedState = { ...storedState, sessions: [session, ...storedState.sessions.filter((s) => s.id !== session!.id)] };
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ session, state: storedState, preSignals: session.interactionPreSignals })
      });
    }
    return route.fallback();
  });

  await page.goto("/");
  await expect(page.getByRole("button", { name: "今日访谈台" })).toBeVisible();

  await page.getByRole("button", { name: /开始聊这个/ }).click();
  await page.getByRole("button", { name: "开始专访" }).click();

  const answer = "我在纠结要不要离开大厂去做独立开发，怕失去那种稳定的身份感。";
  await page.getByLabel("你的回答").fill(answer);
  await page.getByRole("button", { name: "提交表达" }).click();

  // BOTH turns must be visible — the old bug dropped them when pre_signals were present.
  await expect(page.getByText(answer)).toBeVisible();
  await expect(page.getByText("这听起来更像是身份的问题，而不是收入，对吗？")).toBeVisible();
});
