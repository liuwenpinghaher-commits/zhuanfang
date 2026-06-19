import { expect, test } from "@playwright/test";
import { expectNoHorizontalOverflow, openView, resetDemoState, useMobileViewport } from "./helpers";

// R2 导航重构后的 9 项导航（3 区各 3 项）:
// 访谈工作台: 今日访谈台 / 实时专访 / 主题线
// 认知资产:   我的资产 / 外部调研 / 记忆
// 系统:       系统配置 / 语料学习 / 个人档案
// 播客工作台/双轨笔记/资产库/情报中心 不再是顶层导航项。
const views = [
  ["今日访谈台", "一键开始"],
  ["实时专访", "专访启动"],
  ["主题线", "看见反复主题和观点变化"],
  ["我的资产", "专访档案与认知资产库"],
  ["外部调研", "主动搜集热点、素材和可讨论主题"],
  ["记忆", "导入资料，审核长期记忆"],
  ["系统配置", "状态页展示 Product API 的真实能力健康"],
  ["语料学习", "从外部专访中学习提问逻辑"],
  ["个人档案", "产品负责人 · AI 产品 / 创业"]
] as const;

test.describe("primary navigation", () => {
  test("opens every primary view on desktop without horizontal overflow", async ({ page }) => {
    await resetDemoState(page);

    for (const [navName, expectedText] of views) {
      await openView(page, navName, expectedText);
      await expectNoHorizontalOverflow(page);
    }
  });

  test("opens every primary view on mobile without horizontal overflow", async ({ page }) => {
    await useMobileViewport(page);
    await resetDemoState(page);

    for (const [navName, expectedText] of views) {
      await openView(page, navName, expectedText);
      await expectNoHorizontalOverflow(page);
    }
  });

  test("shows live Product API capability health in system configuration", async ({ page }) => {
    await page.route("http://127.0.0.1:8787/api/system/capabilities", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          generatedAt: "2026-06-10T00:00:00.000Z",
          configVersion: "local-demo-2026.06.10",
          runtime: {
            service: "interview-product-api",
            stateStore: "memory"
          },
          capabilities: [
            {
              id: "state-store",
              kind: "storage",
              label: "Product State Store",
              status: "ready",
              active: true,
              detail: "内存状态库已启用，重启后回到 seed 状态。",
              requiredEnv: ["PRODUCT_STATE_DB_PATH"],
              lastCheckedAt: "2026-06-10T00:00:00.000Z"
            },
            {
              id: "bailian-realtime",
              kind: "voice",
              label: "百炼 Qwen-Omni Realtime",
              status: "needs-endpoint",
              active: false,
              detail: "缺少 BAILIAN_REALTIME_WEBRTC_ENDPOINT。",
              requiredEnv: ["DASHSCOPE_API_KEY", "BAILIAN_REALTIME_WEBRTC_ENDPOINT"],
              model: "qwen3.5-omni-plus-realtime",
              transport: "webrtc",
              lastCheckedAt: "2026-06-10T00:00:00.000Z"
            }
          ]
        })
      });
    });
    await resetDemoState(page);
    // 系统配置默认进入「状态」区，实时能力健康直接可见，无需再切分段。
    await openView(page, "系统配置", "状态页展示 Product API 的真实能力健康");

    await expect(page.getByRole("heading", { name: "Product API 实时状态" })).toBeVisible();
    await expect(page.getByText("Product State Store")).toBeVisible();
    await expect(page.getByText("DASHSCOPE_API_KEY")).toBeVisible();
    await expectNoHorizontalOverflow(page);
  });

  test("edits runtime provider configuration from the system policy page", async ({ page }) => {
    let receivedUpdates: Record<string, unknown> | undefined;
    const configResponse = {
      generatedAt: "2026-06-10T00:00:00.000Z",
      envFilePath: "/tmp/interview/.env.local",
      sections: [
        {
          id: "secrets",
          label: "密钥",
          settings: [
            {
              key: "DASHSCOPE_API_KEY",
              section: "secrets",
              label: "DashScope / 百炼 API Key",
              description: "百炼主密钥。",
              valueKind: "secret",
              secret: true,
              required: true,
              configured: false,
              value: null,
              maskedValue: "未配置",
              restartRequired: false
            }
          ]
        },
        {
          id: "models",
          label: "模型",
          settings: [
            {
              key: "BAILIAN_SEARCH_MODEL",
              section: "models",
              label: "联网搜索模型",
              description: "用于百炼联网搜索。",
              valueKind: "string",
              secret: false,
              required: false,
              configured: true,
              value: "qwen-plus",
              defaultValue: "qwen3.7-plus",
              restartRequired: false
            }
          ]
        }
      ]
    };

    await page.route("http://127.0.0.1:8787/api/system/config", async (route) => {
      const request = route.request();
      if (request.method() === "PATCH") {
        receivedUpdates = JSON.parse(request.postData() ?? "{}").updates;
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            settingsUpdated: Object.keys(receivedUpdates ?? {}),
            config: {
              ...configResponse,
              sections: configResponse.sections.map((section) => ({
                ...section,
                settings: section.settings.map((setting) =>
                  setting.key === "DASHSCOPE_API_KEY"
                    ? { ...setting, configured: true, maskedValue: "已配置（末 4 位 0000）" }
                    : setting.key === "BAILIAN_SEARCH_MODEL"
                      ? { ...setting, value: "qwen3.7-plus" }
                      : setting
                )
              }))
            }
          })
        });
        return;
      }

      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(configResponse)
      });
    });
    await page.route("http://127.0.0.1:8787/api/system/capabilities", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          generatedAt: "2026-06-10T00:00:00.000Z",
          configVersion: "local-demo-2026.06.10",
          runtime: {
            service: "interview-product-api",
            stateStore: "memory"
          },
          capabilities: []
        })
      });
    });

    await resetDemoState(page);
    await openView(page, "系统配置", "状态页展示 Product API 的真实能力健康");
    // 服务端配置(env)表单现在归到「参数」区。
    await page.getByRole("button", { name: /参数/ }).click();

    await page.getByLabel("DashScope / 百炼 API Key").fill("secret-that-stays-server-side");
    await page.getByLabel("联网搜索模型").fill("qwen3.7-plus");
    await page.getByRole("button", { name: "保存服务端配置" }).click();

    await expect(page.getByText("运行配置已保存")).toBeVisible();
    expect(receivedUpdates).toEqual({
      DASHSCOPE_API_KEY: "secret-that-stays-server-side",
      BAILIAN_SEARCH_MODEL: "qwen3.7-plus"
    });
    await expectNoHorizontalOverflow(page);
  });

  test("saves product strategy configuration and applies it to later workflows", async ({ page }) => {
    // 播客默认声音 is a <select> sourced from /api/realtime-voice/voices.
    // The available options depend on what the server returns — we read the first option value
    // at runtime instead of hard-coding a preset name that may not exist.
    await resetDemoState(page);
    await openView(page, "系统配置", "状态页展示 Product API 的真实能力健康");
    // 产品策略表单现在归到「参数」区。
    await page.getByRole("button", { name: /参数/ }).click();

    // Wait for voices to load then pick the first available value
    const voiceSelect = page.getByLabel("播客默认声音");
    await expect(voiceSelect.locator("option")).not.toHaveCount(0, { timeout: 10000 });
    const voice = await voiceSelect.evaluate(
      (el: HTMLSelectElement) => el.options[0]?.value ?? ""
    );

    await page.getByLabel("默认搜索 Provider").selectOption("anysearch");
    await page.getByLabel("搜索时效窗口").fill("9");
    await page.getByLabel("最大来源数").fill("4");
    await page.getByLabel("允许会中引用联网素材").selectOption("false");
    await voiceSelect.selectOption(voice);
    // 「启用实时语音」布尔开关已改为「实时语音模式」下拉（cascade/bailian/livekit）。
    // 参数区有两个「实时语音模式」select（服务端 env + 产品策略），这里指向产品策略那一个。
    await page.locator("#product-realtime-mode").selectOption("cascade");
    await page.getByLabel("留白阈值").fill("1500");
    await page.getByLabel("最大追问深度").fill("6");
    await page.getByRole("button", { name: "保存产品策略" }).click();

    await expect(page.getByText("产品策略已保存")).toBeVisible();
    // 播客工作台已移出顶层导航，从"我的资产"档案卡点击"生成播客"进入。
    // demo state 中 notes[0] 存在，点击后 App 跳转至 podcast view。
    await page.getByRole("button", { name: "我的资产" }).click();
    await expect(page.getByText("专访档案与认知资产库")).toBeVisible();
    await page.getByRole("button", { name: "生成播客" }).first().click();
    // The free-text 声音配置 input in PodcastStudioView is seeded from systemConfig.voice.podcastVoice
    await expect(page.getByLabel("声音配置")).toHaveValue(voice);

    // 联网素材已重命名为"外部调研"
    await page.getByRole("button", { name: "外部调研" }).click();
    await expect(page.getByText("当前默认 provider：anysearch")).toBeVisible();
    await expect(page.getByText("会中引用：关闭")).toBeVisible();
    await expect(page.getByText("最大来源：4")).toBeVisible();
    await expectNoHorizontalOverflow(page);
  });
});
