import { expect, test } from "@playwright/test";
import { expectNoHorizontalOverflow, openView, resetDemoState } from "./helpers";

test("analyzes imported interview text and applies a PlaybookPatch", async ({ page }) => {
  // Corpus insights API calls the real LLM (~27s); allow generous timeout.
  test.setTimeout(90000);
  const sampleTitle = `优秀专访样本-${Date.now()}-${Math.random().toString(16).slice(2, 6)}`;
  await resetDemoState(page);
  await openView(page, "语料学习", "从外部专访中学习提问逻辑");

  await page.getByLabel("样本标题").fill(sampleTitle);
  await page.getByLabel("专访文本或转写稿").fill([
    "主持人：你刚才说增长很难，能不能讲一个具体时刻？",
    "被访者：真正困难是团队不敢暴露坏消息。",
    "主持人：如果反过来看，是不是机制奖励了报喜不报忧？"
  ].join("\n"));
  await page.getByRole("button", { name: "分析并生成建议" }).click();

  await expect(page.getByText("语料分析已完成")).toBeVisible({ timeout: 40000 });
  const textInsight = page.locator("article.record-row").filter({ hasText: `${sampleTitle}：访谈逻辑分析` });
  await expect(textInsight).toHaveCount(1, { timeout: 10000 });
  await expect(textInsight.getByRole("heading", { name: `${sampleTitle}：访谈逻辑分析` })).toBeVisible();
  await expectNoHorizontalOverflow(page);

  await textInsight.getByRole("button", { name: "确认影响引擎" }).click();
  await expect(page.getByText("PlaybookPatch 已应用")).toBeVisible({ timeout: 10000 });
  await expect(page.getByText("PlaybookPatch")).toBeVisible();
});

test("analyzes imported audio interview transcripts with source metadata", async ({ page }) => {
  // Corpus insights API calls the real LLM (~27s); allow generous timeout.
  test.setTimeout(90000);
  const sampleTitle = `优秀音频专访样本-${Date.now()}-${Math.random().toString(16).slice(2, 6)}`;
  const sourceUrl = `https://example.com/interview-audio-${Date.now()}-${Math.random().toString(16).slice(2, 6)}.mp3`;
  await resetDemoState(page);
  await openView(page, "语料学习", "从外部专访中学习提问逻辑");

  await page.getByLabel("样本类型").selectOption("audio");
  await page.getByLabel("样本标题").fill(sampleTitle);
  await page.getByLabel("音频来源 URL").fill(sourceUrl);
  await page.getByLabel("音频转写稿或摘要").fill([
    "主持人：你说团队不愿意承担判断，能不能讲一个真实会议？",
    "被访者：他们只等我拍板。",
    "主持人：如果反过来看，是不是机制奖励了等待？"
  ].join("\n"));
  await page.getByRole("button", { name: "分析并生成建议" }).click();

  await expect(page.getByText("语料分析已完成")).toBeVisible({ timeout: 40000 });
  const audioInsight = page.locator("article.record-row").filter({ hasText: sourceUrl });
  await expect(audioInsight).toHaveCount(1, { timeout: 10000 });
  await expect(audioInsight.getByText("audio · 已分析")).toBeVisible();
  await expectNoHorizontalOverflow(page);
});

test("transcribes an audio source before corpus analysis", async ({ page }) => {
  // Corpus insights API calls the real LLM (~27s); allow generous timeout.
  test.setTimeout(90000);
  const sampleTitle = `自动转写音频样本-${Date.now()}-${Math.random().toString(16).slice(2, 6)}`;
  const sourceUrl = `https://example.com/interview-auto-${Date.now()}-${Math.random().toString(16).slice(2, 6)}.mp3`;
  await resetDemoState(page);
  await page.route("http://127.0.0.1:8787/api/corpus/transcriptions", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        transcription: {
          providerId: "bailian-sensevoice",
          model: "sensevoice-v1",
          status: "ready",
          title: sampleTitle,
          sourceUrl,
          text: [
            "主持人：能不能讲一个具体会议？",
            "被访者：他们只等我拍板。",
            "主持人：如果反过来看，是不是机制奖励了等待？"
          ].join("\n"),
          taskId: "task-e2e",
          createdAt: "2026-06-10T00:00:00.000Z"
        }
      })
    });
  });
  await openView(page, "语料学习", "从外部专访中学习提问逻辑");

  await page.getByLabel("样本类型").selectOption("audio");
  await page.getByLabel("样本标题").fill(sampleTitle);
  await page.getByLabel("音频来源 URL").fill(sourceUrl);
  await page.getByRole("button", { name: "生成转写稿" }).click();

  await expect(page.getByText("音频转写已完成")).toBeVisible();
  await expect(page.getByLabel("音频转写稿或摘要")).toHaveValue(/机制奖励了等待/);

  await page.getByRole("button", { name: "分析并生成建议" }).click();

  await expect(page.getByText("语料分析已完成")).toBeVisible({ timeout: 40000 });
  const autoInsight = page.locator("article.record-row").filter({ hasText: sourceUrl });
  await expect(autoInsight).toHaveCount(1, { timeout: 10000 });
  await expect(autoInsight.getByText("audio · 已分析")).toBeVisible();
  await expectNoHorizontalOverflow(page);
});

test("generates and deletes a podcast episode from the first note", async ({ page }) => {
  const voice = `narrator-${Date.now()}-${Math.random().toString(16).slice(2, 6)}`;
  await resetDemoState(page);
  // R2: 播客工作台已移出顶层导航，通过"我的资产"档案卡"生成播客"按钮进入。
  await openView(page, "我的资产", "专访档案与认知资产库");
  await page.getByRole("button", { name: "生成播客" }).first().click();
  await expect(page.getByText("把一次专访生成可收听的语音节目")).toBeVisible();

  await page.getByLabel("声音配置").fill(voice);
  await page.getByRole("button", { name: "生成脚本" }).click();
  await expect(page.getByText("播客脚本已生成")).toBeVisible({ timeout: 20000 });
  await page.getByRole("button", { name: "合成语音" }).click();

  await expect(page.getByText("语音合成")).toBeVisible({ timeout: 15000 });
  const podcastEpisode = page.locator("article.podcast-episode").filter({ hasText: voice });
  await expect(podcastEpisode).toHaveCount(1, { timeout: 10000 });
  await expect(podcastEpisode.getByText(`ready · ${voice}`)).toBeVisible();
  await expect(podcastEpisode.getByText("本地占位", { exact: true })).toBeVisible();
  await expectNoHorizontalOverflow(page);

  page.once("dialog", async (dialog) => {
    expect(dialog.message()).toContain("确定要删除这条播客生成结果吗");
    await dialog.accept();
  });
  await podcastEpisode.getByRole("button", { name: "删除播客" }).click();

  await expect(page.getByText("播客生成结果已删除")).toBeVisible({ timeout: 10000 });
});

test("saves the current podcast voice as the default product voice", async ({ page }) => {
  // 声音配置 is a free-text input in PodcastStudioView. 播客默认声音 in ConfigView is a <select>
  // sourced from /api/realtime-voice/voices. We must use a value that actually exists in the
  // select — read the first available option value from the voices API before testing.
  await resetDemoState(page);
  // R2: 播客工作台已移出顶层导航，通过"我的资产"档案卡"生成播客"按钮进入。
  await openView(page, "我的资产", "专访档案与认知资产库");
  await page.getByRole("button", { name: "生成播客" }).first().click();
  await expect(page.getByText("把一次专访生成可收听的语音节目")).toBeVisible();

  // Determine a valid voice value from ConfigView's voices select before filling the free-text field.
  await page.getByRole("button", { name: "系统配置" }).click();
  await page.getByRole("button", { name: "策略 搜索、语音和访谈运行策略" }).click();
  // Wait for voices to load (select is populated from /api/realtime-voice/voices)
  const voiceSelect = page.getByLabel("播客默认声音");
  // Wait for at least one option to appear, then grab its value
  await expect(voiceSelect.locator("option")).not.toHaveCount(0, { timeout: 10000 });
  const voice = await voiceSelect.evaluate(
    (el: HTMLSelectElement) => el.options[0]?.value ?? ""
  );

  // Navigate back to podcast studio and set the voice
  await page.getByRole("button", { name: "我的资产" }).click();
  await page.getByRole("button", { name: "生成播客" }).first().click();
  await expect(page.getByText("把一次专访生成可收听的语音节目")).toBeVisible();

  await page.getByLabel("声音配置").fill(voice);
  await page.getByRole("button", { name: "保存为默认声音" }).click();

  await expect(page.getByText("播客默认声音已更新")).toBeVisible({ timeout: 10000 });
  await page.getByRole("button", { name: "系统配置" }).click();
  await page.getByRole("button", { name: "策略 搜索、语音和访谈运行策略" }).click();
  await expect(page.getByLabel("播客默认声音")).toHaveValue(voice, { timeout: 10000 });
  await expectNoHorizontalOverflow(page);
});
