/**
 * Full real-API interview lifecycle: start → turns → end → diary note.
 *
 * Uses the deterministic local Product API (port 8787, in-memory, no keys).
 * No page.route mocking — every call goes to the real API.
 */
import { expect, test } from "@playwright/test";
import { openView, resetDemoState } from "./helpers";

test("full interview lifecycle: start, submit 3 turns, end, assert diary note", async ({ page }) => {
  // Each LLM turn may take ~5-6s; 3 turns + finishInterview needs > 60s total.
  test.setTimeout(120000);
  await resetDemoState(page);

  // ── Step 1: start a decision interview from the home view ─────────────────
  // The primary-action button on HomeView reads "开始聊这个" and calls onStart("decision").
  await page.getByRole("button", { name: "今日访谈台" }).click();
  await expect(page.getByRole("button", { name: "一键开始" })).toBeVisible();

  // Note initial notes count from the notes view before we start.
  // (HomeView no longer shows a metric-row; we read the count after the interview ends instead.)
  const notesArticlesBefore = await page.locator("article.record-row").count();

  // ── Step 2: one-click start (P2-16) ───────────────────────────────────────
  // "一键开始" creates the session (POST /api/interview-sessions) and enters the live
  // interview directly, skipping the old "专访启动" pre-session launch screen.
  await page.getByRole("button", { name: "一键开始" }).click();

  // After session creation the view shows "实时专访" header and the text form.
  await expect(page.locator("#main-content").getByText("实时专访", { exact: true })).toBeVisible();
  await expect(page.getByLabel("你的回答")).toBeVisible();

  // ── Step 3: submit 3 coherent text turns ─────────────────────────────────
  const turns = [
    "我在考虑离职去做独立开发，但还没决定，因为不确定自己能不能撑过收入空窗期。",
    "最担心的是前六个月没有稳定收入，同时又需要持续开发产品才能验证方向。",
    "我觉得关键风险是时间：如果六个月没找到付费用户，我的存款就撑不住了。"
  ];

  for (const turnText of turns) {
    await page.getByLabel("你的回答").fill(turnText);
    await page.getByRole("button", { name: "提交表达" }).click();

    // Assert user's text appears in the transcript.
    await expect(page.getByText(turnText)).toBeVisible();

    // Assert an assistant turn appears after each user turn (role bubble, not exact copy).
    // LLM / fake provider may take several seconds — allow 20s per turn.
    await expect(page.locator("article.turn.assistant").last()).toBeVisible({ timeout: 20000 });
  }

  // ── Step 4: end the interview ─────────────────────────────────────────────
  // "结束并生成档案" button is disabled until there's ≥1 turn, then enabled.
  const finishButton = page.getByRole("button", { name: "结束并生成档案" });
  await expect(finishButton).toBeEnabled();
  page.once("dialog", async (dialog) => {
    await dialog.accept();
  });
  await finishButton.click();

  // ── Step 5: finish returns home with success notice + 上场摘要 ────────────
  // finishInterview calls the real API (POST /api/interview-sessions/:id/end) which
  // runs LLM-based session analysis — empirically ~16s. Allow 35s for headroom.
  await expect(page.getByText("专访档案已生成")).toBeVisible({ timeout: 35000 });
  await expect(page.getByText(/上场专访已结束|查看本场笔记|去记忆/).first()).toBeVisible({
    timeout: 10000
  });

  // ── Step 6: notes still exist — open 双轨笔记 and assert a record row ─────
  await page.getByRole("navigation", { name: "应用导航" }).getByRole("button", { name: "本场记录", exact: true }).click();
  await expect(page.getByText("这里就是以前的双轨笔记")).toBeVisible();
  await expect(page.locator("article.record-row").first()).toBeVisible();

  // ── Step 7: cross-view consistency — notes count increased after interview ─
  const notesArticlesAfter = await page.locator("article.record-row").count();
  expect(notesArticlesAfter).toBeGreaterThan(notesArticlesBefore);

  // HomeView is still reachable and shows the timeline.
  await page.getByRole("button", { name: "今日访谈台" }).click();
  await expect(page.getByRole("heading", { name: "时间轴" })).toBeVisible();
});
