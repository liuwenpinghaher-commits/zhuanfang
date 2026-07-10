import { join } from "node:path";

// 审计修复(F-02/A2):产品状态存储档位的唯一解析入口。
// 此前 sentinel 判断只活在 buildApiServer 的默认工厂里,startServer 自己那条路径不认
// sentinel——PRODUCT_STATE_DB_PATH=memory 会被 new DatabaseSync("memory") 当普通文件路径,
// 叠加 loadLocalEnvFile 继承 .env.local 的 PRODUCT_STORE=dual-surreal,E2E 测试险些
// 连上真实 dual-surreal 存储并镜像覆盖真实数据。所有档位/路径决策收敛到这个纯函数。

export type ProductStoreMode = "memory" | "sqlite" | "surreal" | "dual" | "dual-surreal";

export interface ProductStoreSelection {
  mode: ProductStoreMode;
  /** 传给 buildApiServer 的路径:memory 档位下恒为 sentinel,冷层(raw/audio/knowledge)据此同走内存。 */
  productStateDbPath: string;
  /** sentinel 压过 PRODUCT_STORE 时,被忽略的档位原值(归一化后);用于启动日志,提醒档位继承被覆盖。 */
  ignoredProductStore?: string;
  /** 供启动日志解释本次选择(人读,不参与逻辑)。 */
  reason: string;
}

/** in-memory sentinel:表达"测试隔离、绝不落盘"的意图;大小写与首尾空白不敏感。 */
export function isInMemoryDbPath(dbPath: string) {
  const normalized = dbPath.trim().toLowerCase();
  return normalized === "memory" || normalized === ":memory:" || normalized === "in-memory";
}

export function resolveProductStoreSelection(
  env: { PRODUCT_STORE?: string; PRODUCT_STATE_DB_PATH?: string },
  cwd = process.cwd()
): ProductStoreSelection {
  const store = (env.PRODUCT_STORE ?? "").trim().toLowerCase();
  const rawDbPath = env.PRODUCT_STATE_DB_PATH;
  const hasDbPath = rawDbPath !== undefined && rawDbPath.trim() !== "";

  // 规则 b:dbPath sentinel 表达测试隔离意图,必须压过任何 PRODUCT_STORE 档位继承
  // (正是 F-02 的事故路径:playwright 设了 dbPath=memory 却继承了 .env.local 的 dual-surreal)。
  if (hasDbPath && isInMemoryDbPath(rawDbPath)) {
    const ignored = store !== "" && store !== "memory" ? store : undefined;
    return {
      mode: "memory",
      // 归一化为规范 sentinel,而非透传原文:下游只需认一种写法。
      productStateDbPath: "memory",
      ignoredProductStore: ignored,
      reason: ignored
        ? `PRODUCT_STATE_DB_PATH 为 in-memory sentinel,压过 PRODUCT_STORE=${ignored}(测试隔离意图优先于档位继承)`
        : "PRODUCT_STATE_DB_PATH 为 in-memory sentinel"
    };
  }

  // 规则 a:dbPath 缺省(或空白)= cwd/.data/product-state.db,保持现状。
  const productStateDbPath = hasDbPath ? rawDbPath : join(cwd, ".data", "product-state.db");

  // 规则 c:显式 memory 档位。冷层同样必须走内存,故路径也归一为 sentinel。
  if (store === "memory") {
    return {
      mode: "memory",
      productStateDbPath: "memory",
      reason: "PRODUCT_STORE=memory 显式档位"
    };
  }

  // 规则 d:已知档位透传;未设置或未知值 → sqlite(保持现状,不因拼错档位而换存储)。
  if (store === "surreal" || store === "dual" || store === "dual-surreal") {
    return { mode: store, productStateDbPath, reason: `PRODUCT_STORE=${store}` };
  }
  return {
    mode: "sqlite",
    productStateDbPath,
    reason: store === "" ? "PRODUCT_STORE 未设置,默认 sqlite" : `PRODUCT_STORE=${store} 未知,回落默认 sqlite`
  };
}
