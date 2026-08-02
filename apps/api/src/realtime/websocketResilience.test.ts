// @vitest-environment node
import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  attachWebSocketHeartbeat,
  buildRealtimeProxyLog,
  sanitizeWebSocketCloseCode,
  sanitizeWebSocketCloseReason
} from "./websocketResilience";

class FakeHeartbeatSocket extends EventEmitter {
  readyState = 1;
  ping = vi.fn();
  terminate = vi.fn();
}

describe("attachWebSocketHeartbeat", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("连续两个周期无 pong 才终止，pong 会重置漏报计数", () => {
    vi.useFakeTimers();
    const socket = new FakeHeartbeatSocket();
    const onTimeout = vi.fn();
    const dispose = attachWebSocketHeartbeat(socket, {
      intervalMs: 15_000,
      maxMissedPongs: 2,
      onTimeout
    });

    vi.advanceTimersByTime(15_000);
    expect(socket.ping).toHaveBeenCalledTimes(1);
    expect(socket.terminate).not.toHaveBeenCalled();

    socket.emit("pong");
    vi.advanceTimersByTime(15_000);
    expect(socket.ping).toHaveBeenCalledTimes(2);
    expect(socket.terminate).not.toHaveBeenCalled();

    vi.advanceTimersByTime(15_000);
    expect(onTimeout).toHaveBeenCalledOnce();
    expect(socket.terminate).toHaveBeenCalledOnce();
    dispose();
  });

  it("dispose 幂等移除 timer 与 pong listener", () => {
    vi.useFakeTimers();
    const socket = new FakeHeartbeatSocket();
    const dispose = attachWebSocketHeartbeat(socket, {
      intervalMs: 15_000,
      maxMissedPongs: 2,
      onTimeout: vi.fn()
    });

    expect(socket.listenerCount("pong")).toBe(1);
    dispose();
    dispose();
    expect(socket.listenerCount("pong")).toBe(0);

    vi.advanceTimersByTime(60_000);
    expect(socket.ping).not.toHaveBeenCalled();
    expect(socket.terminate).not.toHaveBeenCalled();
  });

  it("超时遥测回调抛错也必须终止死连接", () => {
    vi.useFakeTimers();
    const socket = new FakeHeartbeatSocket();
    attachWebSocketHeartbeat(socket, {
      intervalMs: 10,
      maxMissedPongs: 1,
      onTimeout: () => {
        throw new Error("telemetry failed");
      }
    });

    expect(() => vi.advanceTimersByTime(10)).toThrow("telemetry failed");
    expect(socket.terminate).toHaveBeenCalledOnce();
    expect(socket.listenerCount("pong")).toBe(0);
  });
});

describe("buildRealtimeProxyLog", () => {
  it("只返回固定 schema，并清除敏感 reason、CRLF 与过长 UTF-8 内容", () => {
    const payload = buildRealtimeProxyLog({
      event: "realtime_proxy_upstream_closed",
      sessionId: "rtv-1",
      direction: "upstream",
      code: 1011,
      reason: `temporary\r\nBearer secret-value\ntranscript=用户原话${"界".repeat(200)}`,
      phase: "ready",
      durationMs: 1234,
      extra: "must-not-escape"
    } as never);

    expect(Object.keys(payload)).toEqual([
      "event",
      "sessionId",
      "direction",
      "code",
      "reason",
      "phase",
      "durationMs"
    ]);
    const serialized = JSON.stringify(payload);
    expect(serialized).not.toMatch(/secret-value|用户原话|must-not-escape|\r|\n/);
    expect(Buffer.byteLength(payload.reason ?? "", "utf8")).toBeLessThanOrEqual(160);
    expect(payload).toMatchObject({ code: 1011, phase: "ready", durationMs: 1234 });
  });
});

describe("WebSocket close sanitization", () => {
  it("保留合法标准码与应用码，拒绝保留码和越界码", () => {
    expect(sanitizeWebSocketCloseCode(1000)).toBe(1000);
    expect(sanitizeWebSocketCloseCode(1011)).toBe(1011);
    expect(sanitizeWebSocketCloseCode(3000)).toBe(3000);
    expect(sanitizeWebSocketCloseCode(4999)).toBe(4999);
    for (const code of [999, 1004, 1005, 1006, 1015, 2999, 5000, Number.NaN]) {
      expect(sanitizeWebSocketCloseCode(code)).toBe(1000);
    }
  });

  it("关闭 reason 按 UTF-8 安全截到 123 字节", () => {
    const reason = sanitizeWebSocketCloseReason("断".repeat(100));
    expect(Buffer.byteLength(reason, "utf8")).toBeLessThanOrEqual(123);
    expect(reason).not.toContain("�");
  });
});
