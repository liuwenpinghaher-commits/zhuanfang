import { expect, test } from "@playwright/test";
import { expectNoHorizontalOverflow, openView, resetDemoState, useMobileViewport } from "./helpers";

const views = [
  ["今日访谈台", "你对“救火”和放手的真实边界"],
  ["实时专访", "专访启动"],
  ["联网素材", "主动搜集热点、素材和可讨论主题"],
  ["语料学习", "从外部专访中学习提问逻辑"],
  ["播客工作台", "把一次专访生成可收听的语音节目"],
  ["双轨笔记", "从访谈沉淀认知资产"],
  ["资产库", "观点、问题、决策和知识债"],
  ["长期追踪", "看见反复主题和观点变化"],
  ["系统配置", "底层能力、provider 和引擎策略"],
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
    await openView(page, "系统配置", "底层能力、provider 和引擎策略");

    await page.getByRole("button", { name: /Provider/ }).click();

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
    await openView(page, "系统配置", "底层能力、provider 和引擎策略");
    await page.getByRole("button", { name: "策略 搜索、语音和访谈运行策略" }).click();

    await page.getByLabel("DashScope / 百炼 API Key").fill("secret-that-stays-server-side");
    await page.getByLabel("联网搜索模型").fill("qwen3.7-plus");
    await page.getByRole("button", { name: "保存运行配置" }).click();

    await expect(page.getByText("运行配置已保存")).toBeVisible();
    expect(receivedUpdates).toEqual({
      DASHSCOPE_API_KEY: "secret-that-stays-server-side",
      BAILIAN_SEARCH_MODEL: "qwen3.7-plus"
    });
    await expectNoHorizontalOverflow(page);
  });

  test("saves product strategy configuration and applies it to later workflows", async ({ page }) => {
    const voice = `strategy-voice-${Date.now()}-${Math.random().toString(16).slice(2, 6)}`;
    await resetDemoState(page);
    await openView(page, "系统配置", "底层能力、provider 和引擎策略");
    await page.getByRole("button", { name: "策略 搜索、语音和访谈运行策略" }).click();

    await page.getByLabel("默认搜索 Provider").selectOption("anysearch");
    await page.getByLabel("搜索时效窗口").fill("9");
    await page.getByLabel("最大来源数").fill("4");
    await page.getByLabel("允许会中引用联网素材").selectOption("false");
    await page.getByLabel("播客默认声音").fill(voice);
    await page.getByLabel("启用实时语音").selectOption("true");
    await page.getByLabel("留白阈值").fill("1500");
    await page.getByLabel("最大追问深度").fill("6");
    await page.getByRole("button", { name: "保存产品策略" }).click();

    await expect(page.getByText("产品策略已保存")).toBeVisible();
    await page.getByRole("button", { name: "播客工作台" }).click();
    await expect(page.getByLabel("声音配置")).toHaveValue(voice);

    await page.getByRole("button", { name: "联网素材" }).click();
    await expect(page.getByText("当前默认 provider：anysearch")).toBeVisible();
    await expect(page.getByText("会中引用：关闭")).toBeVisible();
    await expect(page.getByText("最大来源：4")).toBeVisible();
    await expectNoHorizontalOverflow(page);
  });
});
