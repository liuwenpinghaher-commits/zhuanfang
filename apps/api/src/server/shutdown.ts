/** Split from server.ts — graceful shutdown sequence. */
import { withDeadline } from "./defaults";

/** Default flush budget (ms). Keep ~10s; raise via PRODUCT_SHUTDOWN_FLUSH_MS up to 30s. */
export const DEFAULT_SHUTDOWN_FLUSH_MS = 10_000;
export const MIN_SHUTDOWN_FLUSH_MS = 1_000;
export const MAX_SHUTDOWN_FLUSH_MS = 30_000;
export const DEFAULT_SHUTDOWN_CLOSE_MS = 8_000;

/**
 * Optional multi-store registry hook for graceful flush (no S3 / cloud SDK dependency).
 * When user-scoped SurrealStores registry lands (PR-S3), wire:
 *   flushPersistence: flushFromRegistry(registry)
 * so SIGTERM drains every open user store, not only the legacy singleton.
 */
export interface ShutdownStoreRegistry {
  closeAll(): Promise<void>;
}

/** Build a flushPersistence callback from a registry that implements closeAll. */
export function flushFromRegistry(registry: ShutdownStoreRegistry): () => Promise<void> {
  return () => registry.closeAll();
}

/**
 * Resolve PRODUCT_SHUTDOWN_FLUSH_MS (default 10000, clamped to [1s, 30s]).
 * Invalid / empty → default.
 */
export function resolveShutdownFlushMs(
  env: Record<string, string | undefined> = typeof process !== "undefined" ? process.env : {}
): number {
  const raw = env.PRODUCT_SHUTDOWN_FLUSH_MS;
  if (raw === undefined || raw === null || String(raw).trim() === "") {
    return DEFAULT_SHUTDOWN_FLUSH_MS;
  }
  const n = Number(String(raw).trim());
  if (!Number.isFinite(n)) return DEFAULT_SHUTDOWN_FLUSH_MS;
  return Math.max(MIN_SHUTDOWN_FLUSH_MS, Math.min(MAX_SHUTDOWN_FLUSH_MS, Math.round(n)));
}

export function resolveShutdownCloseMs(
  env: Record<string, string | undefined> = typeof process !== "undefined" ? process.env : {}
): number {
  const raw = env.PRODUCT_SHUTDOWN_CLOSE_MS;
  if (raw === undefined || raw === null || String(raw).trim() === "") {
    return DEFAULT_SHUTDOWN_CLOSE_MS;
  }
  const n = Number(String(raw).trim());
  if (!Number.isFinite(n)) return DEFAULT_SHUTDOWN_CLOSE_MS;
  return Math.max(MIN_SHUTDOWN_FLUSH_MS, Math.min(MAX_SHUTDOWN_FLUSH_MS, Math.round(n)));
}

export interface GracefulShutdownDeps {
  /** 停止收新请求(Fastify server.close;排空在途 HTTP)。 */
  closeServer: () => Promise<void>;
  /** 排空持久化——surreal 档 = stores.close(先 flush persist 队列再关连接);memory 档 = flush(no-op 也无妨)。
   *  分仓时建议 = registry.closeAll()（见 flushFromRegistry）。 */
  flushPersistence: () => Promise<void>;
  /** 关闭 OTel(数据 flush 之后才调,内部已吞错)。 */
  shutdownTelemetry: () => Promise<void>;
  /** 退出进程(注入以便单测断言,不真的杀测试进程)。 */
  exit: (code: number) => void;
  /** flush 上限超时(默认 10s / PRODUCT_SHUTDOWN_FLUSH_MS):flush 卡住不永久挂起。 */
  flushTimeoutMs?: number;
  /** server.close 上限超时(默认 8s):某个永挂的在途请求不该挡住 flush 步骤。 */
  closeTimeoutMs?: number;
  /**
   * Optional secondary closeAll after flushPersistence (e.g. orphan registry).
   * Prefer wiring closeAll into flushPersistence via flushFromRegistry when the registry
   * owns the only durable handles; use this only for a second registry without S3 deps.
   */
  closeAll?: () => Promise<void>;
}

/**
 * N-10:统一优雅关闭序列(数据 flush 优先于 OTel)。抽成可注入依赖的工厂,便于单测断言
 * 「close → flush → OTel → exit」顺序、幂等(重复信号只跑一次)、flush 超时兜底(不卡死)。
 *
 * 序列:① closeServer() 停止收新请求(排空在途 HTTP,有界超时——永挂请求不该挡住 flush);
 * ② flushPersistence() 排空 persist 队列——R7 删同步 sqlite 后这是唯一持久路径,不 flush 直接退
 * 会丢已确认 200 的写(常态窗口小,但重试期/积压/降级期 N-02 窗口可无限);③ optional closeAll;
 * ④ shutdownTelemetry() 关 OTel(数据已落库);⑤ exit(0)。② 加上限超时:超时后强制走完 OTel + exit,
 * 并 console.error 记 graceful_shutdown_flush_timeout(可能丢失未落库写)。任一步抛错都不阻断后续。
 */
export function createGracefulShutdown(deps: GracefulShutdownDeps): (signal: string) => Promise<void> {
  const flushTimeoutMs = deps.flushTimeoutMs ?? DEFAULT_SHUTDOWN_FLUSH_MS;
  const closeTimeoutMs = deps.closeTimeoutMs ?? DEFAULT_SHUTDOWN_CLOSE_MS;
  let shuttingDown = false;
  return async (signal: string) => {
    // 幂等防重入:第二个信号(SIGINT 后 SIGTERM,或同信号重发)直接返回,绝不重复跑关闭序列。
    if (shuttingDown) return;
    shuttingDown = true;
    console.warn(
      JSON.stringify({
        event: "graceful_shutdown_start",
        signal,
        flushTimeoutMs,
        closeTimeoutMs
      })
    );

    // ① 停止收新请求(有界:永挂的在途请求不该挡住 flush 步骤)。
    try {
      await withDeadline(deps.closeServer(), closeTimeoutMs, "server_close");
    } catch (err) {
      console.error(
        JSON.stringify({
          event: "graceful_shutdown_server_close_failed",
          error: err instanceof Error ? err.message : String(err)
        })
      );
    }

    // ② 排空 persist 队列(数据优先于 OTel)。超时兜底 → 至少留信号,不永久挂起。
    try {
      await withDeadline(deps.flushPersistence(), flushTimeoutMs, "flush");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const isTimeout = /timeout/i.test(msg);
      console.error(
        JSON.stringify({
          event: isTimeout ? "graceful_shutdown_flush_timeout" : "graceful_shutdown_flush_failed",
          flushTimeoutMs,
          error: msg,
          detail:
            "persist 队列未能在超时内排空,可能丢失未落库的写(已确认 200 但未落 surreal 权威库)。"
        })
      );
    }

    // ②b optional secondary registry closeAll (best-effort, same flush budget).
    if (deps.closeAll) {
      try {
        await withDeadline(deps.closeAll(), flushTimeoutMs, "closeAll");
      } catch (err) {
        console.error(
          JSON.stringify({
            event: "graceful_shutdown_close_all_failed",
            error: err instanceof Error ? err.message : String(err)
          })
        );
      }
    }

    // ③ 关 OTel(数据已 flush;shutdownTelemetry 内部已吞错,此处再兜一层保证到达 exit)。
    try {
      await deps.shutdownTelemetry();
    } catch {
      /* 已在 shutdownTelemetry 内记账;绝不阻断 exit */
    }

    // ④ 退出。
    deps.exit(0);
  };
}
