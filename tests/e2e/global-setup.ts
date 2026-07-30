// 审计修复(F-02/A2):E2E 存储隔离闸门。
// Playwright 先启动 webServer(plugin setup)再跑 globalSetup,所以这里可以直接请求 API。
// 历史事故:playwright 只设 PRODUCT_STATE_DB_PATH=memory,startServer 的 loadLocalEnvFile()
// 继承了 .env.local 的 PRODUCT_STORE=surreal(R7 前是 dual-surreal),E2E 测试连上真实 surreal
// 档位、在仓库根 .data/ 创建 surreal/ 目录,险些覆盖真实数据。此闸门在跑任何测试前核验实际档位,
// 不是 memory 就熔断。

const API_CAPABILITIES_URL = "http://127.0.0.1:13210/api/system/capabilities";

export default async function globalSetup() {
  let body: { productStore?: unknown } | null;
  try {
    // 10s 超时:reuseExistingServer 可能复用一个已 wedge 的开发服务器,不加超时会挂满 fetch 默认等待。
    const response = await fetch(API_CAPABILITIES_URL, { signal: AbortSignal.timeout(10_000) });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    body = (await response.json()) as { productStore?: unknown } | null;
  } catch (error) {
    throw new Error(
      `[E2E 隔离闸门] 无法从 ${API_CAPABILITIES_URL} 读取存储档位(${error instanceof Error ? error.message : String(error)})。` +
        "无法确认测试进程与真实存储隔离,拒绝开跑。请确认 API webServer 已在 3210 端口启动。"
    );
  }

  // N-15:E2E_REAL=1 时 real 族跑 surreal 权威档(数据目录已由 playwright.config 隔离到 tmp);
  // 默认族仍须是 memory。两种模式各自断言实际档位,错档位一律熔断。
  const expected = process.env.E2E_REAL === "1" ? "surreal" : "memory";
  const actual = (body ?? {}).productStore;
  if (actual !== expected) {
    if (expected === "surreal") {
      throw new Error(
        `[E2E 隔离闸门·real] E2E_REAL=1 预期 productStore="surreal",实际报告 ${JSON.stringify(actual)}。` +
          "real 族需 surreal 权威档(数据已隔离到 tmp,见 playwright.config)。排查:" +
          "① 3210 端口若有手动开发服务器,real 模式已设 reuseExistingServer=false 不复用——先关掉占端口的进程;" +
          "② 确认未手动把 PRODUCT_STORE 覆盖成 memory。"
      );
    }
    throw new Error(
      `[E2E 隔离闸门] 测试险些连上真实存储档位:/api/system/capabilities 报告 productStore=${JSON.stringify(actual)},预期 "memory"。` +
        "E2E 若在非内存档位上运行,会把测试写入(乃至镜像覆盖)真实专访数据。排查:" +
        "① 3210 端口可能有一个手动启动的开发服务器被 reuseExistingServer 复用了——关掉它,让 Playwright 用隔离 env 自己拉起;" +
        "② 确认 playwright.config.ts 的 API webServer env 同时含 PRODUCT_STORE=memory 与 PRODUCT_STATE_DB_PATH=memory;" +
        "③ 若 productStore 是 surreal,多半是 .env.local 的 PRODUCT_STORE 被 loadLocalEnvFile 继承(审计 F-02 的事故路径),或误设了 E2E_REAL=1。"
    );
  }
}
