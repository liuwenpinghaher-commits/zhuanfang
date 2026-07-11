import { Surreal, createRemoteEngines } from "surrealdb";
import { createNodeEngines } from "@surrealdb/node";
import { SURREAL_NS, SURREAL_DB } from "./constants.js";

export interface SurrealConnectionOptions {
  /** surrealkv://<dir>/surreal(持久) | mem://(测试) */
  url: string;
  namespace?: string;
  database?: string;
  /** N-07:connect 超时(ms)。缺省 SURREAL_CONNECT_TIMEOUT_MS;测试可调小以断言超时路径。 */
  connectTimeoutMs?: number;
}

/**
 * N-07:嵌入式 surrealkv 是【同进程独占锁】。第二个进程 connect 同一数据目录时,
 * `db.connect()` 会静默永挂——无超时、无日志、无报错,进程卡在 listen 之前全程零输出
 * (实测 12s+ 无反应;kill 持锁进程后立即连上且数据完好)。常见触发:两个 dev:full 并发启动、
 * dev:full 跑着时又手动 dev:api、旧进程未死透就重启。给 connect 加超时上限,超时抛可识别错误
 * (指认 url + 持锁假设),由调用方结构化落日志并 exit 1,而不是让运维盯着挂死进程猜。
 */
export const SURREAL_CONNECT_TIMEOUT_MS = 15_000;

/** N-07:connect 超时的可识别错误——调用方据 name/url 落结构化"疑似双开持锁"日志。 */
export class SurrealConnectTimeoutError extends Error {
  readonly url: string;
  readonly timeoutMs: number;
  constructor(url: string, timeoutMs: number) {
    super(
      `SurrealDB connect 超时(${timeoutMs}ms):${url}。` +
        `嵌入式 surrealkv 为同进程独占锁,极可能已有另一进程持有该数据目录的锁` +
        `(并发 dev:full、dev:full 跑着又手动 dev:api、或旧进程未退干净)。` +
        `确认没有第二个进程打开同一数据目录后重试。`
    );
    this.name = "SurrealConnectTimeoutError";
    this.url = url;
    this.timeoutMs = timeoutMs;
  }
}

/** 打开一个嵌入式 SurrealDB 连接并选好 ns/db。调用方负责 close()。 */
export async function createSurrealConnection(opts: SurrealConnectionOptions): Promise<Surreal> {
  const db = new Surreal({ engines: { ...createRemoteEngines(), ...createNodeEngines() } });
  const timeoutMs = opts.connectTimeoutMs ?? SURREAL_CONNECT_TIMEOUT_MS;
  // N-07:Promise.race 给 connect 加超时;超时抛可识别错误而非无限挂死。
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      db.connect(opts.url),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new SurrealConnectTimeoutError(opts.url, timeoutMs)), timeoutMs);
      })
    ]);
  } catch (err) {
    // 超时或连接失败:尽力回收半开连接(fire-and-forget——close 本身可能也挂在同一把锁上,
    // 不 await 以免把超时路径又拖成挂死;进程通常随即 exit 1)。
    void db.close().catch(() => {});
    throw err;
  } finally {
    if (timer) clearTimeout(timer);
  }
  await db.use({ namespace: opts.namespace ?? SURREAL_NS, database: opts.database ?? SURREAL_DB });
  return db;
}
