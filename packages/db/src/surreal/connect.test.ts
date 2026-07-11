import { describe, it, expect, vi, beforeEach } from "vitest";

// N-07:嵌入式 surrealkv 同进程独占锁——第二进程 connect 静默永挂。这里 mock surrealdb 的 Surreal,
// 让 connect 行为可控(永挂 / 立即完成),确定性验证超时抛可识别错误、正常路径不误触发。不碰真库。
let connectImpl: (url: string) => Promise<void>;
const closeSpy = vi.fn(async () => {});
const useSpy = vi.fn(async () => {});

vi.mock("surrealdb", () => ({
  createRemoteEngines: () => ({}),
  Surreal: class {
    connect(url: string): Promise<void> {
      return connectImpl(url);
    }
    use = useSpy;
    close = closeSpy;
  }
}));
vi.mock("@surrealdb/node", () => ({ createNodeEngines: () => ({}) }));

const { createSurrealConnection, SurrealConnectTimeoutError } = await import("./connect");

describe("createSurrealConnection · N-07 connect 超时", () => {
  beforeEach(() => {
    connectImpl = async () => {};
    closeSpy.mockClear();
    useSpy.mockClear();
  });

  it("connect 永挂 → 在超时上限内抛 SurrealConnectTimeoutError,而非无限挂死", async () => {
    connectImpl = () => new Promise<void>(() => {}); // 永不 resolve,模拟双开持锁
    await expect(
      createSurrealConnection({ url: "surrealkv:///tmp/x/surreal", connectTimeoutMs: 20 })
    ).rejects.toBeInstanceOf(SurrealConnectTimeoutError);
  });

  it("超时错误携带 url/timeoutMs 供指认,并尽力回收半开连接", async () => {
    connectImpl = () => new Promise<void>(() => {});
    const url = "surrealkv:///tmp/y/surreal";
    const err = await createSurrealConnection({ url, connectTimeoutMs: 15 }).catch((e) => e);
    expect(err).toBeInstanceOf(SurrealConnectTimeoutError);
    expect((err as InstanceType<typeof SurrealConnectTimeoutError>).url).toBe(url);
    expect((err as InstanceType<typeof SurrealConnectTimeoutError>).timeoutMs).toBe(15);
    // 回收是 fire-and-forget(close 可能也挂,不 await),给微任务一拍后应已调用。
    await new Promise((r) => setTimeout(r, 5));
    expect(closeSpy).toHaveBeenCalled();
  });

  it("connect 正常 → 选好 ns/db 返回连接,不误触发超时、不回收连接", async () => {
    connectImpl = async () => {};
    const db = await createSurrealConnection({ url: "mem://", connectTimeoutMs: 1000 });
    expect(db).toBeDefined();
    expect(useSpy).toHaveBeenCalledOnce();
    expect(closeSpy).not.toHaveBeenCalled();
  });
});
