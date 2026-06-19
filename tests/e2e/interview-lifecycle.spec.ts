/**
 * Full real-API interview lifecycle: start → turns → end → diary note.
 *
 * Uses the deterministic local Product API (port 8787, in-memory, no keys).
 * No page.route mocking — every call goes to the real API.
 */
import { expect, test } from "@playwright/test";
import { openView, resetDemoState } from "./helpers";

test("full interview lifecycle: start, submit 3 turns, end, assert diary note", async ({ page }) => {
  await resetDemoState(page);

  // ── Step 1: start a decision interview from the home view ─────────────────
  // The primary-action button on HomeView reads "开始聊这个" and calls onStart("decision").
  await page.getByRole("button", { name: "今日访谈台" }).click();
  await expect(page.getByText("系统已根据长期主题、知识债和历史原话准备本次专访方向。")).toBeVisible();

  // Note initial "本月信号" notes count before we start.
  const notesMetricBefore = await page.locator(".metric-row").getByText("笔记").locator("..").locator("strong").textContent();

  // ── Step 2: one-click start (P2-16) ───────────────────────────────────────
  // "开始聊这个" now creates the session (POST /api/interview-sessions) and enters the live
  // interview directly, skipping the old "专访启动" pre-session launch screen.
  await page.getByRole("button", { name: "开始聊这个" }).click();

  // After session creation the view shows "实时专访" header and the text form.
  await expect(page.getByText("实时专访")).toBeVisible();
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

    // Assert an assistant turn appears after each user turn.
    // The deterministic engine always returns an "assistant" role turn.
    // We wait for any article with role "assistant" to appear after the user turn.
    await expect(page.locator("article.turn.assistant").last()).toBeVisible();
  }

  // ── Step 4: end the interview ─────────────────────────────────────────────
  // "结束并生成档案" button is disabled until there's ≥1 turn, then enabled.
  const finishButton = page.getByRole("button", { name: "结束并生成档案" });
  await expect(finishButton).toBeEnabled();
  await finishButton.click();

  // ── Step 5: assert navigation to notes view + success notice ──────────────
  await expect(page.getByText("专访档案已生成")).toBeVisible();
  // App navigates to "notes" view after finishing.
  await expect(page.getByText("从访谈沉淀认知资产")).toBeVisible();

  // ── Step 6: assert a note card was produced in 双轨笔记 ───────────────────
  // NotesView renders each note as <article class="record-row">.
  await expect(page.locator("article.record-row").first()).toBeVisible();

  // ── Step 7: cross-view consistency — home "本月信号" note count increased ─
  await page.getByRole("button", { name: "今日访谈台" }).click();
  await expect(page.getByText("系统已根据长期主题、知识债和历史原话准备本次专访方向。")).toBeVisible();

  const notesMetricAfter = await page.locator(".metric-row").getByText("笔记").locator("..").locator("strong").textContent();
  const countBefore = Number(notesMetricBefore ?? "0");
  const countAfter = Number(notesMetricAfter ?? "0");
  expect(countAfter).toBeGreaterThan(countBefore);
});
