import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { isInMemoryDbPath, resolveProductStoreSelection } from "./store-selection";

// 审计修复(F-02/A2):startServer 的档位解析必须是纯函数、可穷举测试——
// 此前 "memory" sentinel 只在 buildApiServer 的默认工厂里生效,startServer 直接把
// 字符串 "memory" 当文件路径交给 SQLite/dual 工厂,E2E 测试还会继承 .env.local 的
// PRODUCT_STORE=dual-surreal,险些镜像覆盖真实数据。这里钉死全部解析规则。
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

  it("sentinel 压过 PRODUCT_STORE=dual-surreal(测试隔离意图 > 档位继承),并记录被忽略的档位", () => {
    const selection = resolveProductStoreSelection(
      { PRODUCT_STORE: "dual-surreal", PRODUCT_STATE_DB_PATH: "memory" },
      cwd
    );
    expect(selection.mode).toBe("memory");
    expect(selection.ignoredProductStore).toBe("dual-surreal");
  });

  it.each(["surreal", "dual", "dual-surreal"])("档位 %s 原样透传", (store) => {
    const selection = resolveProductStoreSelection(
      { PRODUCT_STORE: store, PRODUCT_STATE_DB_PATH: "/real/data/product-state.db" },
      cwd
    );
    expect(selection.mode).toBe(store);
    expect(selection.productStateDbPath).toBe("/real/data/product-state.db");
    expect(selection.ignoredProductStore).toBeUndefined();
  });

  it("PRODUCT_STORE 归一化:trim + lowercase", () => {
    const selection = resolveProductStoreSelection(
      { PRODUCT_STORE: "  DUAL-Surreal  ", PRODUCT_STATE_DB_PATH: "/real/data/product-state.db" },
      cwd
    );
    expect(selection.mode).toBe("dual-surreal");
  });

  it("PRODUCT_STORE 未设置 → sqlite(保持现状)", () => {
    const selection = resolveProductStoreSelection(
      { PRODUCT_STATE_DB_PATH: "/real/data/product-state.db" },
      cwd
    );
    expect(selection.mode).toBe("sqlite");
    expect(selection.productStateDbPath).toBe("/real/data/product-state.db");
  });

  it("PRODUCT_STORE 未知值 → sqlite(保持现状:任何未知值落默认分支)", () => {
    const selection = resolveProductStoreSelection(
      { PRODUCT_STORE: "postgres", PRODUCT_STATE_DB_PATH: "/real/data/product-state.db" },
      cwd
    );
    expect(selection.mode).toBe("sqlite");
  });

  it("dbPath 缺省 → join(cwd, '.data', 'product-state.db')(保持现状)", () => {
    const selection = resolveProductStoreSelection({}, cwd);
    expect(selection.mode).toBe("sqlite");
    expect(selection.productStateDbPath).toBe(join(cwd, ".data", "product-state.db"));
  });

  it("dbPath 为空白字符串视同缺省,推导默认路径", () => {
    const selection = resolveProductStoreSelection({ PRODUCT_STATE_DB_PATH: "   " }, cwd);
    expect(selection.mode).toBe("sqlite");
    expect(selection.productStateDbPath).toBe(join(cwd, ".data", "product-state.db"));
  });

  // 回归钉死审计 F-02 实验:PRODUCT_STORE=sqlite + PRODUCT_STATE_DB_PATH=memory 曾在
  // startServer 里把字符串 "memory" 交给 new DatabaseSync("memory"),在仓库根创建了名为
  // memory 的 SQLite 文件。sentinel 必须解析为 memory 档位,绝不当文件路径。
  it("回归(F-02):{PRODUCT_STORE:'sqlite', PRODUCT_STATE_DB_PATH:'memory'} → mode=memory", () => {
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
