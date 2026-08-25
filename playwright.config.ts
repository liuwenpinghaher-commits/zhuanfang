import { defineConfig, devices } from "@playwright/test";
import { tmpdir } from "node:os";
import { join } from "node:path";

// N-15:real E2E 族(real-*.spec.ts + voice-cascade)与默认 mock/内存族结构性互斥——real 族要真
// key + surreal 权威(如 graph-consistency 断言 200),默认族的 F-02 内存闸门会熔断它们,导致 real
// 族在任何默认配置下都不可能通过、只能"手工挑着跑"。这里用 E2E_REAL=1 显式门控切换成独立跑法:
//   · 默认(E2E_REAL 未设):跑 mock/内存族,testIgnore real-*/voice-cascade,webServer=memory 档,
//     globalSetup 断言 productStore=memory(F-02 隔离闸门不变)。
//   · E2E_REAL=1:只跑 real-*/voice-cascade,webServer=surreal 档但落到【隔离的临时数据目录】
//     (绝不碰仓库 .data/ 真实库),透传真实 key;reuseExistingServer=false 强制自起隔离进程,
//     避免复用一个连着真实数据的开发服务器;globalSetup 断言 productStore=surreal。
const REAL = process.env.E2E_REAL === "1";

/** Drop production shell secrets so Playwright env merges cannot re-enable auth/CORS. */
function scrubShellEnv(base: Record<string, string>): Record<string, string> {
  const blocked = new Set([
    "PRODUCT_API_TOKEN",
    "PRODUCT_WEB_ORIGINS",
    "DEPLOYMENT_PROFILE",
    "PRODUCT_STATIC_DIR",
    "PRODUCT_ENV_FILE",
    "VITE_PRODUCT_API_TOKEN"
  ]);
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v == null) continue;
    if (blocked.has(k)) continue;
    out[k] = v;
  }
  return { ...out, ...base };
}
// 隔离的 real-E2E surreal 数据目录:dbPath 旁会建 surreal/,落到 tmp 而非仓库 .data/。
const REAL_DB_PATH = join(tmpdir(), "zhuanfang-e2e-real", "product-state.db");

const apiEnv: Record<string, string> = REAL
  ? {
      PORT: "13210",
      HOST: "127.0.0.1",
      // real 族:surreal 权威档,但数据目录隔离到 tmp(红线:零接触仓库 .data/)。
      PRODUCT_STORE: "surreal",
      PRODUCT_STATE_DB_PATH: REAL_DB_PATH,
      DEPLOYMENT_PROFILE: "local",
      PRODUCT_API_TOKEN: "",
      // Real e2e keeps cloud LLM, but uses local embeddings for stable create/approve paths.
      EMBEDDING_PROVIDER: "local",
      PROVIDER_REQUEST_TIMEOUT_MS: "120000",
      BAILIAN_REQUEST_TIMEOUT_MS: "120000",
      BAILIAN_INTERVIEW_REQUEST_TIMEOUT_MS: "120000",
      PRODUCT_ENV_FILE: join(tmpdir(), "zhuanfang-e2e-real.env.local"),
      // 透传真实 provider key(开发者跑 E2E_REAL=1 时须在环境里提供);缺失时对应 real 用例自 skip。
      DASHSCOPE_API_KEY: process.env.DASHSCOPE_API_KEY ?? "",
      BAILIAN_API_KEY: process.env.BAILIAN_API_KEY ?? "",
      ANYSEARCH_API_KEY: process.env.ANYSEARCH_API_KEY ?? "",
      TAVILY_API_KEY: process.env.TAVILY_API_KEY ?? "",
      EXA_API_KEY: process.env.EXA_API_KEY ?? "",
      BRAVE_SEARCH_API_KEY: process.env.BRAVE_SEARCH_API_KEY ?? "",
      BAILIAN_REALTIME_WEBRTC_ENDPOINT: process.env.BAILIAN_REALTIME_WEBRTC_ENDPOINT ?? "",
      PRODUCT_WEB_ORIGINS: "http://127.0.0.1:13220,http://localhost:13220"
    }
  : {
      PORT: "13210",
      HOST: "127.0.0.1",
      // 审计修复(F-02/A2):双保险隔离。startServer 会 loadLocalEnvFile() 继承 .env.local 中
      // 未被覆盖的键——只设 dbPath sentinel 时曾继承 PRODUCT_STORE(现为 surreal)连上真实存储。
      // 显式 PRODUCT_STORE=memory 掐断继承;dbPath sentinel 保留,两者任一都足以进内存档位。
      PRODUCT_STORE: "memory",
      PRODUCT_STATE_DB_PATH: "memory",
      // Track V1: never inherit production auth from a developer's shell/.env.local.
      DEPLOYMENT_PROFILE: "local",
      PRODUCT_API_TOKEN: "",
      // F-02 事故收口(2026-07-10):陈旧 mock 未拦截时,PATCH /api/system/config 曾打到这个
      // 真实 API 并把仓库根 .env.local 的真实 DASHSCOPE_API_KEY 覆盖成测试占位值。
      // PRODUCT_ENV_FILE 把 config 写盘路径隔离到 tmp——即使将来再有 mock 漏拦,写坏的也
      // 只是一次性测试文件,永远不是仓库根 .env.local。
      PRODUCT_ENV_FILE: join(tmpdir(), "zhuanfang-e2e.env.local"),
      // 真实性重构(2026-07-16):生产剔除全部离线兜底,LLM/搜索/TTS/ASR 无 key 即 503——
      // 默认族不再依赖"无 key 走确定性兜底",改为把造假推到【外部网络边界】:
      // key 用占位值让 client 正常装配,base URL 全部指向本地 fake-provider-server.mjs
      // (webServer[0] 拉起),生产代码 100% 走真实代码路径。
      DASHSCOPE_API_KEY: "e2e-fake-key",
      BAILIAN_API_KEY: "",
      ANYSEARCH_API_KEY: "e2e-fake-key",
      BAILIAN_BASE_URL: "http://127.0.0.1:13230",
      BAILIAN_AUDIO_BASE_URL: "http://127.0.0.1:13230",
      BAILIAN_TTS_WS_URL: "ws://127.0.0.1:13230/api-ws/v1/inference",
      ANYSEARCH_BASE_URL: "http://127.0.0.1:13230",
      TAVILY_API_KEY: "",
      EXA_API_KEY: "",
      BRAVE_SEARCH_API_KEY: "",
      BAILIAN_REALTIME_WEBRTC_ENDPOINT: "",
      PRODUCT_WEB_ORIGINS: "http://127.0.0.1:13220,http://localhost:13220"
    };

// real 族:real-*.spec.ts + voice-cascade.spec.ts。默认族 testIgnore 掉它们;real 模式只跑它们。
const REAL_GLOB = ["**/real-*.spec.ts", "**/voice-cascade.spec.ts"];

export default defineConfig({
  testDir: "./tests/e2e",
  // 审计修复(F-02/A2):webServer 起来后、跑任何测试前,先断言 API 实际档位(默认 memory /
  // E2E_REAL 时 surreal),reuseExistingServer 可能复用错档位的开发服务器,globalSetup 兜底拦截。
  globalSetup: "./tests/e2e/global-setup.ts",
  ...(REAL ? { testMatch: REAL_GLOB } : { testIgnore: REAL_GLOB }),
  fullyParallel: false,
  workers: 1,
  // Real provider suites are subject to transient LLM/network flakes.
  retries: REAL ? 1 : 0,
  reporter: [["list"]],
  use: {
    baseURL: "http://127.0.0.1:13220",
    trace: "on-first-retry"
  },
  webServer: [
    // 默认族的外部网络边界替身(fake DashScope/AnySearch);real 族(E2E_REAL=1)不使用它
    // (base URL 不指向它),但进程无害地闲置。
    {
      command: "node tests/e2e/fake-provider-server.mjs",
      // Isolated ports: never reuse a foreign process on the default stack.
      reuseExistingServer: false,
      timeout: 30_000,
      url: "http://127.0.0.1:13230/health",
      env: { FAKE_PROVIDER_PORT: "13230" }
    },
    {
      command: "npm run start:api",
      // Default + real: always self-start on isolated ports (Track V1: avoid 3210 prod-auth reuse).
      reuseExistingServer: false,
      // local embedding prewarm may download Xenova/bge-large-zh on first run.
      timeout: REAL ? 600_000 : 120_000,
      url: "http://127.0.0.1:13210/api/health",
      env: scrubShellEnv(apiEnv)
    },
    {
      command: "npm run dev -- --host 127.0.0.1 --port 13220 --strictPort",
      reuseExistingServer: false,
      timeout: 120_000,
      url: "http://127.0.0.1:13220",
      env: {
        ...process.env,
        // Always pin e2e SPA → isolated API. Do not inherit shell/production :3210.
        VITE_INTERVIEW_TURN_TIMEOUT_MS: REAL ? "180000" : (process.env.VITE_INTERVIEW_TURN_TIMEOUT_MS ?? ""),
        VITE_PRODUCT_API_BASE_URL: "http://127.0.0.1:13210",
        VITE_PRODUCT_API_TOKEN: "",
        DEPLOYMENT_PROFILE: "local",
        PRODUCT_API_TOKEN: ""
      }
    }
  ],
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] }
    }
  ]
});
