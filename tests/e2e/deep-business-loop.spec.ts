/**
 * 真实业务深度 E2E 闭环测试（覆盖开源批次 2 · 步骤 1 要求的全部 6 项核心业务流）：
 *   1. 用户注册 / 会话登录（LoginPage + /api/runtime-bootstrap + /api/auth/login）
 *   2. 开启语音 / 文字专访会话（一键开始 + 实时语音会话建立）
 *   3. AI 追问流转（含只引用原话、留白 / 读下一问状态流转与会中访谈调节）
 *   4. 两步结束向导与待审记忆确认（Step 1 待审记忆拦截 → Step 2 确认后生成专访档案并跳转本场记录）
 *   5. 认知传记档案生成与完整 JSON 备份导出
 *   6. 记忆撤回（停止引用）、单场删除（忘掉这场）与个人数据彻底擦除闭环
 */
import { expect, test } from "@playwright/test";
import { installFakeMic } from "./fakeMic";
import { openView, resetDemoState } from "./helpers";

test.describe("deep business loop E2E", () => {
  test("1. L1 session auth gate: rejects wrong password and logs in to workbench", async ({ page }) => {
    let authenticated = false;

    await page.route("http://127.0.0.1:13210/api/runtime-bootstrap", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          authRequired: true,
          authenticated,
          authMode: "session"
        })
      });
    });

    await page.route("http://127.0.0.1:13210/api/auth/login", async (route) => {
      const payload = JSON.parse(route.request().postData() ?? "{}") as {
        username?: string;
        password?: string;
      };
      if (payload.username === "interviewer" && payload.password === "correct-pass-2026") {
        authenticated = true;
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ ok: true, username: "interviewer" })
        });
        return;
      }
      await route.fulfill({
        status: 401,
        contentType: "application/json",
        body: JSON.stringify({ error: "用户名或密码错误" })
      });
    });

    await page.goto("/", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "专访登录" })).toBeVisible();

    await page.getByPlaceholder("用户名").fill("interviewer");
    await page.getByPlaceholder("密码").fill("wrong-pass");
    await page.getByRole("button", { name: "登录" }).click();
    await expect(page.getByRole("alert")).toContainText("用户名或密码错误");

    await page.getByPlaceholder("密码").fill("correct-pass-2026");
    await page.getByRole("button", { name: "登录" }).click();

    await expect(page.getByRole("navigation", { name: "应用导航" })).toBeVisible({ timeout: 15000 });
    await expect(page.getByRole("button", { name: "今日访谈台" })).toBeVisible();

    await page.unroute("http://127.0.0.1:13210/api/runtime-bootstrap");
    await page.unroute("http://127.0.0.1:13210/api/auth/login");
  });

  test("2-6. full interview → voice/text & controls → two-step memory confirm → archive & export → memory revoke & privacy purge", async ({
    page,
    context
  }) => {
    test.setTimeout(150_000);
    await installFakeMic(context);
    await resetDemoState(page);

    // ── 2. 开启文字 + 语音专访会话 ───────────────────────────────────────────
    await page.getByRole("button", { name: "一键开始" }).click();
    await expect(page.locator("#main-content").getByText("实时专访", { exact: true })).toBeVisible();
    await expect(page.getByTestId("opening-hero")).toBeVisible();

    const voiceSessionPromise = page.waitForResponse(
      (res) => res.url().includes("/api/realtime-voice/sessions") && res.request().method() === "POST"
    );
    await page.getByRole("button", { name: "开始录音" }).click();
    const voiceRes = await voiceSessionPromise;
    expect(voiceRes.status()).toBe(200);

    // 断言会中节奏（保持留白 / 正在读下一问 / 语音连接兼容提示）可见
    await expect(
      page.getByText(/保持留白|正在读下一问|实时语音会话已就绪|本场文字专访仍可继续|语音连接未恢复/).first()
    ).toBeVisible({ timeout: 15000 });

    // ── 3. AI 追问流转（只引用原话 + 访谈调节控制流转） ───────────────────────
    const turn1 = "我在测试里说过这句话。当时团队正面临六个月的收入空窗期，我既想放权又怕失控。";
    await page.getByLabel("你的回答").fill(turn1);
    await page.getByRole("button", { name: "提交表达" }).click();

    await expect(page.getByText(turn1)).toBeVisible();
    // AI 追问逐字引用用户原话前段，且剥离 <pre_signals>
    await expect(page.getByText(/你刚才提到「我在测试里说过这句话。当」，能给一个具体发生过的时刻吗？/)).toBeVisible({
      timeout: 20000
    });

    // 展开「访谈调节」触发「放慢一点」（节奏/留白调节）
    await page.getByRole("button", { name: /访谈调节/ }).click();
    await page.getByRole("button", { name: "放慢一点" }).click();
    await expect(page.getByText("下轮：放慢一点")).toBeVisible();

    const turn2 = "具体时刻是上周五评审会，我忍住没替大家拍板，留白让大家自己争论出结论。";
    await page.getByLabel("你的回答").fill(turn2);
    await page.getByRole("button", { name: "提交表达" }).click();
    await expect(page.getByText(turn2)).toBeVisible();
    await expect(page.getByText(/你刚才提到「具体时刻是上周五评审会，」，能给一个具体发生过的时刻吗？/)).toBeVisible({
      timeout: 20000
    });

    // ── 4. 两步结束向导与待审记忆确认 ────────────────────────────────────────
    page.once("dialog", async (dialog) => {
      await dialog.accept();
    });
    await page.getByRole("button", { name: "结束本场" }).click();

    // 第一步：因为本场抽出了待审记忆（evidenceQuote 匹配 turn1 中的「我在测试里说过这句话。」），
    // 系统诚实跳转到「记忆」页展示待审横幅，不提前宣称档案已生成。
    await expect(page.getByTestId("interview-end-hitl")).toBeVisible({ timeout: 35000 });
    await expect(page.getByTestId("interview-end-hitl")).toContainText("本场已结束，记忆待你确认");

    const pendingCard = page
      .locator("article.memory-card")
      .filter({ hasText: "当系统失败时会如实暴露而不是伪装成功。" });
    await expect(pendingCard).toBeVisible({ timeout: 10000 });
    await expect(pendingCard).toContainText("我在测试里说过这句话。");

    // 第二步：点击「确认记住」，待审记忆清零后自动宣称「专访档案已生成」并跳至「本场记录」
    await pendingCard.getByRole("button", { name: "确认记住" }).click();
    await expect(page.getByText("专访档案已生成").first()).toBeVisible({ timeout: 15000 });
    await expect(page.getByText("这里就是以前的双轨笔记")).toBeVisible({ timeout: 10000 });

    // ── 5. 认知传记档案生成与备份导出 ────────────────────────────────────────
    // 双轨笔记中包含本场沉淀的摘要、原话与双轨条目
    await expect(page.getByText("这次对话把「测试主题」推进到了可验证阶段。").first()).toBeVisible();
    await expect(page.getByText("用户复述了测试要点一。").first()).toBeVisible();
    await expect(page.getByText("被挑战的假设：测试即真实。").first()).toBeVisible();

    // 切换到「资产库」tab 查看从本场抽出的认知资产
    await page.getByTestId("session-record-tab-assets").click();
    await expect(page.getByText("测试观点").first()).toBeVisible();
    await page.getByTestId("session-record-tab-archive").click();

    // 进入「个人档案」执行完整 JSON 备份导出
    await page.getByRole("navigation", { name: "应用导航" }).getByRole("button", { name: "个人档案", exact: true }).click();
    const downloadPromise = page.waitForEvent("download").catch(() => null);
    await page.getByRole("button", { name: "导出数据" }).click();
    await expect(page.getByText(/已下载完整 JSON 备份包|已下载，但该备份不是完整恢复保障/).first()).toBeVisible();
    await downloadPromise;

    // ── 6. 记忆撤回、单场忘掉与隐私擦除闭环 ──────────────────────────────────
    // 6a. 在「记忆」页撤回刚确认的长期记忆（停止引用）
    await openView(page, "记忆", "点头之后，下场才认");
    const confirmedCard = page
      .locator("article.memory-card")
      .filter({ hasText: "当系统失败时会如实暴露而不是伪装成功。" });
    await expect(confirmedCard).toBeVisible();
    page.once("dialog", async (dialog) => {
      await dialog.accept();
    });
    await confirmedCard.getByRole("button", { name: "撤销（停止引用）" }).click();
    await expect(confirmedCard).not.toBeVisible({ timeout: 8000 });

    // 6b. 在「本场记录」中点击「删除这场」（忘掉这场及其专属抽出物）
    await openView(page, "本场记录", "这里就是以前的双轨笔记");
    const noteCard = page
      .locator("article.note-card")
      .filter({ hasText: "这次对话把「测试主题」推进到了可验证阶段。" })
      .first();
    await expect(noteCard).toBeVisible();
    await noteCard.getByRole("button", { name: "删除这场" }).click();
    const forgetPanel = page.getByRole("region", { name: "确认删除这场" });
    await expect(forgetPanel).toBeVisible();
    await expect(forgetPanel).toContainText("确定拿走这场？");
    await forgetPanel.getByRole("button", { name: "确定删除这场" }).click();
    await expect(forgetPanel).not.toBeVisible({ timeout: 10000 });

    // 6c. 在「个人档案」彻底清空个人数据并验证隐私报告归零
    await page.getByRole("navigation", { name: "应用导航" }).getByRole("button", { name: "个人档案", exact: true }).click();
    page.once("dialog", async (dialog) => {
      await dialog.accept();
    });
    await page.getByRole("button", { name: "清空个人数据" }).click();
    await expect(page.locator("span", { hasText: "个人数据已彻底清空" })).toBeVisible({ timeout: 10000 });

    await page.getByRole("button", { name: "隐私报告" }).click();
    const interviewsRow = page.locator("li", { hasText: "专访与双轨笔记" });
    await expect(interviewsRow).toContainText("0");
  });
});
