import { defineConfig, devices } from "@playwright/test";
import { tmpdir } from "node:os";
import { join } from "node:path";

export default defineConfig({
  testDir: "./tests/e2e",
  // 审计修复(F-02/A2):webServer 起来后、跑任何测试前,先断言 API 实际档位是 memory。
  // reuseExistingServer 可能复用一个连着真实 dual-surreal 数据的开发服务器,globalSetup 兜底拦截。
  globalSetup: "./tests/e2e/global-setup.ts",
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: "http://127.0.0.1:3220",
    trace: "on-first-retry"
  },
  webServer: [
    {
      command: "npm run start:api",
      reuseExistingServer: true,
      timeout: 120_000,
      url: "http://127.0.0.1:3210/api/health",
      env: {
        PORT: "3210",
        HOST: "127.0.0.1",
        // 审计修复(F-02/A2):双保险隔离。startServer 会 loadLocalEnvFile() 继承 .env.local 中
        // 未被覆盖的键——只设 dbPath sentinel 时曾继承 PRODUCT_STORE=dual-surreal 连上真实存储。
        // 显式 PRODUCT_STORE=memory 掐断继承;dbPath sentinel 保留,两者任一都足以进内存档位。
        PRODUCT_STORE: "memory",
        PRODUCT_STATE_DB_PATH: "memory",
        // F-02 事故收口(2026-07-10):陈旧 mock 未拦截时,PATCH /api/system/config 曾打到这个
        // 真实 API 并把仓库根 .env.local 的真实 DASHSCOPE_API_KEY 覆盖成测试占位值。
        // PRODUCT_ENV_FILE 把 config 写盘路径隔离到 tmp——即使将来再有 mock 漏拦,写坏的也
        // 只是一次性测试文件,永远不是仓库根 .env.local。
        PRODUCT_ENV_FILE: join(tmpdir(), "zhuanfang-e2e.env.local"),
        DASHSCOPE_API_KEY: "",
        BAILIAN_API_KEY: "",
        ANYSEARCH_API_KEY: "",
        TAVILY_API_KEY: "",
        EXA_API_KEY: "",
        BRAVE_SEARCH_API_KEY: "",
        BAILIAN_REALTIME_WEBRTC_ENDPOINT: "",
        PRODUCT_WEB_ORIGINS: "http://127.0.0.1:3220,http://localhost:3220"
      }
    },
    {
      command: "npm run dev -- --host 127.0.0.1",
      reuseExistingServer: true,
      timeout: 120_000,
      url: "http://127.0.0.1:3220"
    }
  ],
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] }
    }
  ]
});
