import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: "http://127.0.0.1:5173",
    trace: "on-first-retry"
  },
  webServer: [
    {
      command: "npm run start:api",
      reuseExistingServer: true,
      timeout: 120_000,
      url: "http://127.0.0.1:8787/api/health",
      env: {
        PORT: "8787",
        HOST: "127.0.0.1",
        PRODUCT_STATE_DB_PATH: "memory",
        DASHSCOPE_API_KEY: "",
        BAILIAN_API_KEY: "",
        ANYSEARCH_API_KEY: "",
        TAVILY_API_KEY: "",
        EXA_API_KEY: "",
        BRAVE_SEARCH_API_KEY: "",
        BAILIAN_REALTIME_WEBRTC_ENDPOINT: "",
        PRODUCT_WEB_ORIGINS: "http://127.0.0.1:5173,http://localhost:5173"
      }
    },
    {
      command: "npm run dev -- --host 127.0.0.1",
      reuseExistingServer: true,
      timeout: 120_000,
      url: "http://127.0.0.1:5173"
    }
  ],
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] }
    }
  ]
});
