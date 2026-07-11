import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { isInMemoryDbPath, resolveProductStoreSelection } from "./store-selection";

// 审计修复(F-02/A2):startServer 的档位解析必须是纯函数、可穷举测试——
// 此前 "memory" sentinel 只在 buildApiServer 的默认工厂里生效,startServer 直接把
// 字符串 "memory" 当文件路径交给持久工厂,E2E 测试还会继承 .env.local 的 PRODUCT_STORE,
// 险些镜像覆盖真实数据。这里钉死全部解析规则。
// R7:档位收敛为 memory|surreal 两档;sqlite/dual/dual-surreal 归一到 surreal(见 deprecated 用例)。
describe("resolveProductStoreSelection", () => {
  const cwd = "/fake/project";

  it.each(["memory", ":memory:", "in-memory"])(
    "dbPath sentinel %s → mode=memory,且冷层路径同样是 in-memory sentinel",
    (sentinel) => {
      const selection = resolveProductStoreSelection({ PRODUCT_STATE_DB_PATH: sentinel }, cwd);
      expect(selection.mode).toBe("memory");
      // 冷层(raw/audio/knowledge)靠 isInMemoryDbPath(productStateDbPath) 判内存,必须命中。
      expect(isInMemoryDbPath(selection.productStateDbPath)).toBe(true);
    }
  );

  it("dbPath sentinel 大小写/首尾空白不敏感", () => {
    for (const sentinel of ["  MEMORY  ", ":Memory:", " In-Memory "]) {
      const selection = resolveProductStoreSelection({ PRODUCT_STATE_DB_PATH: sentinel }, cwd);
      expect(selection.mode).toBe("memory");
    }
  });

  it("PRODUCT_STORE=memory 显式档位 → mode=memory,即便 dbPath 指向真实文件", () => {
    const selection = resolveProductStoreSelection(
      { PRODUCT_STORE: "memory", PRODUCT_STATE_DB_PATH: "/real/data/product-state.db" },
      cwd
    );
    expect(selection.mode).toBe("memory");
    // 显式 memory 档位表达的是测试隔离意图:冷层也必须走内存,不能落到 /real/data 旁边。
    expect(isInMemoryDbPath(selection.productStateDbPath)).toBe(true);
  });

  it("sentinel 压过 PRODUCT_STORE=surreal(测试隔离意图 > 档位继承),并记录被忽略的档位", () => {
    const selection = resolveProductStoreSelection(
      { PRODUCT_STORE: "surreal", PRODUCT_STATE_DB_PATH: "memory" },
      cwd
    );
    expect(selection.mode).toBe("memory");
    expect(selection.ignoredProductStore).toBe("surreal");
  });

  it("档位 surreal 原样透传", () => {
    const selection = resolveProductStoreSelection(
      { PRODUCT_STORE: "surreal", PRODUCT_STATE_DB_PATH: "/real/data/product-state.db" },
      cwd
    );
    expect(selection.mode).toBe("surreal");
    expect(selection.productStateDbPath).toBe("/real/data/product-state.db");
    expect(selection.ignoredProductStore).toBeUndefined();
    expect(selection.deprecatedProductStore).toBeUndefined();
  });

  // R7:sqlite/dual/dual-surreal 三档已删除,归一到 surreal 并标注 deprecatedProductStore
  // (旧 .env 不炸,启动期响亮提示改档位)。
  it.each(["sqlite", "dual", "dual-surreal"])("已废弃档位 %s → surreal + deprecatedProductStore", (store) => {
    const selection = resolveProductStoreSelection(
      { PRODUCT_STORE: store, PRODUCT_STATE_DB_PATH: "/real/data/product-state.db" },
      cwd
    );
    expect(selection.mode).toBe("surreal");
    expect(selection.deprecatedProductStore).toBe(store);
    expect(selection.productStateDbPath).toBe("/real/data/product-state.db");
  });

  it("PRODUCT_STORE 归一化:trim + lowercase", () => {
    const selection = resolveProductStoreSelection(
      { PRODUCT_STORE: "  SurReal  ", PRODUCT_STATE_DB_PATH: "/real/data/product-state.db" },
      cwd
    );
    expect(selection.mode).toBe("surreal");
  });

  it("PRODUCT_STORE 未设置 → surreal(R7 唯一持久档,默认)", () => {
    const selection = resolveProductStoreSelection(
      { PRODUCT_STATE_DB_PATH: "/real/data/product-state.db" },
      cwd
    );
    expect(selection.mode).toBe("surreal");
    expect(selection.productStateDbPath).toBe("/real/data/product-state.db");
    expect(selection.deprecatedProductStore).toBeUndefined();
  });

  it("PRODUCT_STORE 未知值 → surreal(任何未知值落默认持久档)", () => {
    const selection = resolveProductStoreSelection(
      { PRODUCT_STORE: "postgres", PRODUCT_STATE_DB_PATH: "/real/data/product-state.db" },
      cwd
    );
    expect(selection.mode).toBe("surreal");
    // 未知值(非废弃档)不标 deprecated,只在 reason 里说明回落。
    expect(selection.deprecatedProductStore).toBeUndefined();
  });

  it("dbPath 缺省 → join(cwd, '.data', 'product-state.db')(默认 surreal)", () => {
    const selection = resolveProductStoreSelection({}, cwd);
    expect(selection.mode).toBe("surreal");
    expect(selection.productStateDbPath).toBe(join(cwd, ".data", "product-state.db"));
  });

  it("dbPath 为空白字符串视同缺省,推导默认路径", () => {
    const selection = resolveProductStoreSelection({ PRODUCT_STATE_DB_PATH: "   " }, cwd);
    expect(selection.mode).toBe("surreal");
    expect(selection.productStateDbPath).toBe(join(cwd, ".data", "product-state.db"));
  });

  // 回归钉死审计 F-02 实验:PRODUCT_STORE=<任意档> + PRODUCT_STATE_DB_PATH=memory 曾在
  // startServer 里把字符串 "memory" 当文件路径,在仓库根创建了名为 memory 的文件。sentinel
  // 必须解析为 memory 档位、绝不当文件路径——即便档位值是已废弃的 sqlite 也一样(sentinel 优先)。
  it("回归(F-02):{PRODUCT_STORE:'sqlite'(已废弃), PRODUCT_STATE_DB_PATH:'memory'} → mode=memory", () => {
    const selection = resolveProductStoreSelection(
      { PRODUCT_STORE: "sqlite", PRODUCT_STATE_DB_PATH: "memory" },
      cwd
    );
    expect(selection.mode).toBe("memory");
    expect(isInMemoryDbPath(selection.productStateDbPath)).toBe(true);
    expect(selection.ignoredProductStore).toBe("sqlite");
  });

  it("PRODUCT_STORE=memory 与 sentinel 同时出现时不算'被忽略'(两者意图一致)", () => {
    const selection = resolveProductStoreSelection(
      { PRODUCT_STORE: "memory", PRODUCT_STATE_DB_PATH: ":memory:" },
      cwd
    );
    expect(selection.mode).toBe("memory");
    expect(selection.ignoredProductStore).toBeUndefined();
  });
});

describe("isInMemoryDbPath", () => {
  it("识别三种 sentinel(大小写/空白不敏感)", () => {
    for (const value of ["memory", ":memory:", "in-memory", " MEMORY ", ":MeMoRy:"]) {
      expect(isInMemoryDbPath(value)).toBe(true);
    }
  });

  it("真实路径与空串不是 sentinel", () => {
    for (const value of ["/data/memory.db", "./memory-notes", "", "   "]) {
      expect(isInMemoryDbPath(value)).toBe(false);
    }
  });
});
