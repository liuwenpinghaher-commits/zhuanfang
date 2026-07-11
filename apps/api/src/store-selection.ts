import { join } from "node:path";

// 审计修复(F-02/A2):产品状态存储档位的唯一解析入口。
// 此前 sentinel 判断只活在 buildApiServer 的默认工厂里,startServer 自己那条路径不认
// sentinel——PRODUCT_STATE_DB_PATH=memory 会被当普通文件路径,叠加 loadLocalEnvFile 继承
// .env.local 的 PRODUCT_STORE 档位,E2E 测试险些连上真实存储并覆盖真实数据。所有档位/路径
// 决策收敛到这个纯函数。
//
// R7(2026-07-10):PRODUCT_STORE 从 5 档收敛为 2 档——sqlite 冷层 + dual-write + dual-surreal
// 守卫整体删除,surreal 成为唯一持久档、也是默认档。旧值 sqlite/dual/dual-surreal 不再是合法档位,
// 归一到 surreal 并在 reason/deprecatedProductStore 里响亮标注,让用户旧 .env 不炸(见规则 d)。

export type ProductStoreMode = "memory" | "surreal";

/** R7 已废弃、归一到 surreal 的历史档位值(仅用于给旧 .env 一次响亮提示,不再是合法 mode)。 */
const DEPRECATED_STORES = new Set(["sqlite", "dual", "dual-surreal"]);

export interface ProductStoreSelection {
  mode: ProductStoreMode;
  /** 传给 buildApiServer 的路径:memory 档位下恒为 sentinel,冷层(raw/audio/knowledge)据此同走内存。 */
  productStateDbPath: string;
  /** sentinel 压过 PRODUCT_STORE 时,被忽略的档位原值(归一化后);用于启动日志,提醒档位继承被覆盖。 */
  ignoredProductStore?: string;
  /** R7:命中已废弃档位值(sqlite/dual/dual-surreal)时的原值;server 据此启动期响亮告警旧 .env 需更新。 */
  deprecatedProductStore?: string;
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
  // (正是 F-02 的事故路径:playwright 设了 dbPath=memory 却继承了 .env.local 的真实档位)。
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

  // 规则 d(R7):除显式 memory 外,一律落唯一持久档 surreal。
  //  - PRODUCT_STORE=surreal:正常显式持久档;
  //  - sqlite/dual/dual-surreal:R7 已废弃,归一到 surreal 并标注 deprecatedProductStore(旧 .env 不炸);
  //  - 未设置或未知值:默认 surreal(R7 前默认是 sqlite)。
  if (store === "surreal") {
    return { mode: "surreal", productStateDbPath, reason: "PRODUCT_STORE=surreal" };
  }
  if (DEPRECATED_STORES.has(store)) {
    return {
      mode: "surreal",
      productStateDbPath,
      deprecatedProductStore: store,
      // P3-15:明确告知存量 sqlite 数据不会被读取/迁移——旧 sqlite 档用户升级后以【空 surreal 库】启动
      // (只连 .data/surreal,绝不读旧 .data/product-state.db),否则运维会误以为历史数据自动搬家了。
      reason: `PRODUCT_STORE=${store} 档位已于 R7 废弃(sqlite 冷层/dual-write/dual-surreal 已删除),已按唯一持久档 surreal 启动;请把 .env 改为 PRODUCT_STORE=surreal。注意:旧 sqlite 数据不会被自动读取或迁移,系统只连 .data/surreal,如需保留历史数据请先用旧版本导出 JSON 再 import`
    };
  }
  return {
    mode: "surreal",
    productStateDbPath,
    reason: store === "" ? "PRODUCT_STORE 未设置,默认 surreal(R7 唯一持久档)" : `PRODUCT_STORE=${store} 未知,回落默认 surreal`
  };
}
