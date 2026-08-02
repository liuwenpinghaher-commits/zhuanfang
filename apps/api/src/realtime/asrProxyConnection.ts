import { WebSocket } from "ws";
import {
  attachWebSocketHeartbeat,
  buildRealtimeProxyLog,
  mapUpstreamCloseCodeForBrowser,
  sanitizeWebSocketCloseCode,
  sanitizeWebSocketCloseReason,
} from "./websocketResilience";

interface UpstreamBinding {
  socket: WebSocket;
  disposeHeartbeat: () => void;
  handshakeTimer: ReturnType<typeof setTimeout>;
  onMessage: (data: Buffer) => void;
  onError: (error: Error) => void;
  onClose: (code: number, reason: Buffer) => void;
}

export interface RealtimeAsrProxyOptions {
  browser: WebSocket;
  sessionId: string;
  apiKey: string;
  primaryModel: string;
  fallbackModel: string;
  createUpstream: (url: string, options: { headers: Record<string, string> }) => WebSocket;
  heartbeatIntervalMs: number;
  heartbeatMaxMissedPongs: number;
  handshakeTimeoutMs: number;
  now: () => number;
  onBrowserActivity: () => void;
  onClosed: () => void;
}

export function connectRealtimeAsrProxy(options: RealtimeAsrProxyOptions): void {
  const {
    browser,
    sessionId,
    apiKey,
    primaryModel,
    fallbackModel,
    createUpstream,
    heartbeatIntervalMs,
    heartbeatMaxMissedPongs,
    handshakeTimeoutMs,
    now,
    onBrowserActivity,
    onClosed,
  } = options;
  const startedAt = now();
  let phase: "connecting" | "ready" | "closing" = "connecting";
  let binding: UpstreamBinding | null = null;
  let pendingSessionUpdate: string | null = null;
  let fallbackAttempted = primaryModel === fallbackModel;
  let cleaned = false;
  let disposeBrowserHeartbeat: () => void = () => undefined;

  const writeProxyLog = (
    event: string,
    direction: "browser" | "upstream",
    code?: number,
    reason?: string,
  ) => {
    console.info(JSON.stringify(buildRealtimeProxyLog({
      event,
      sessionId,
      direction,
      code,
      reason,
      phase,
      durationMs: Math.max(0, now() - startedAt),
    })));
  };

  function detachUpstream(current: UpstreamBinding): void {
    clearTimeout(current.handshakeTimer);
    current.disposeHeartbeat();
    current.socket.off("message", current.onMessage);
    current.socket.off("error", current.onError);
    current.socket.off("close", current.onClose);
    if (binding === current) binding = null;
  }

  function closeUpstreamForBrowser(): void {
    const current = binding;
    if (!current) return;
    detachUpstream(current);
    if (current.socket.readyState === WebSocket.OPEN) {
      current.socket.close(1000, "client disconnected");
    } else if (current.socket.readyState === WebSocket.CONNECTING) {
      current.socket.terminate();
    }
  }

  function cleanup(cleanupOptions: {
    closeBrowser?: { code: number; reason: string };
    closeUpstream?: boolean;
  } = {}): void {
    if (cleaned) return;
    cleaned = true;
    phase = "closing";
    disposeBrowserHeartbeat();
    if (cleanupOptions.closeUpstream) closeUpstreamForBrowser();
    else if (binding) detachUpstream(binding);
    browser.off("message", onBrowserMessage);
    browser.off("close", onBrowserClose);
    browser.off("error", onBrowserError);
    if (cleanupOptions.closeBrowser && browser.readyState === WebSocket.OPEN) {
      browser.close(
        sanitizeWebSocketCloseCode(cleanupOptions.closeBrowser.code),
        sanitizeWebSocketCloseReason(cleanupOptions.closeBrowser.reason),
      );
    }
    onClosed();
  }

  function startFallback(current: UpstreamBinding | null, reason: string): boolean {
    if (cleaned || phase !== "connecting" || fallbackAttempted || !fallbackModel) return false;
    fallbackAttempted = true;
    writeProxyLog("realtime_proxy_fallback_started", "upstream", undefined, reason);
    if (current) {
      detachUpstream(current);
      if (current.socket.readyState === WebSocket.OPEN || current.socket.readyState === WebSocket.CONNECTING) {
        current.socket.terminate();
      }
    }
    connectModel(fallbackModel);
    return true;
  }

  function connectModel(model: string): void {
    if (cleaned) return;
    let socket: WebSocket;
    try {
      const url = `wss://dashscope.aliyuncs.com/api-ws/v1/realtime?model=${encodeURIComponent(model)}`;
      socket = createUpstream(url, { headers: { Authorization: `Bearer ${apiKey}` } });
    } catch (error) {
      const reason = error instanceof Error ? error.message : "unknown";
      writeProxyLog("realtime_proxy_upstream_error", "upstream", undefined, reason);
      cleanup({ closeBrowser: { code: 4002, reason: "Failed to connect to DashScope" } });
      return;
    }

    const onMessage = (data: Buffer) => {
      const current = binding;
      if (cleaned || !current || current.socket !== socket) return;
      const payload = data.toString();
      let messageType: unknown;
      try {
        messageType = (JSON.parse(payload) as { type?: unknown }).type;
      } catch {
        messageType = undefined;
      }
      if (phase === "connecting" && messageType === "error") {
        if (startFallback(current, "upstream rejected realtime session")) return;
      }
      if (browser.readyState === WebSocket.OPEN) browser.send(payload);
      if (phase !== "connecting" || messageType !== "session.created") return;
      phase = "ready";
      clearTimeout(current.handshakeTimer);
      if (pendingSessionUpdate && socket.readyState === WebSocket.OPEN) {
        socket.send(pendingSessionUpdate);
        pendingSessionUpdate = null;
      }
      if (browser.readyState === WebSocket.OPEN) {
        browser.send(JSON.stringify({ type: "proxy.connected" }));
      }
    };

    const onError = (error: Error) => {
      const current = binding;
      if (cleaned || !current || current.socket !== socket) return;
      writeProxyLog("realtime_proxy_upstream_error", "upstream", undefined, error.message);
      if (browser.readyState === WebSocket.OPEN) {
        browser.send(JSON.stringify({
          type: "error",
          error: { type: "proxy_error", message: "Upstream connection failed." },
        }));
      }
      cleanup({
        closeBrowser: { code: 1011, reason: "upstream connection error" },
        closeUpstream: true,
      });
    };

    const onClose = (code: number, reason: Buffer) => {
      const current = binding;
      if (cleaned || !current || current.socket !== socket) return;
      const closeReason = reason.toString() || "dashscope closed";
      writeProxyLog("realtime_proxy_upstream_closed", "upstream", code, closeReason);
      if ((code === 1007 || code === 1008) && startFallback(current, closeReason)) return;
      cleanup({
        closeBrowser: {
          code: mapUpstreamCloseCodeForBrowser(code),
          reason: closeReason,
        },
      });
    };

    const handshakeTimer = setTimeout(() => {
      const current = binding;
      if (cleaned || phase !== "connecting" || !current || current.socket !== socket) return;
      const reason = "session.created handshake timeout";
      writeProxyLog("realtime_proxy_upstream_error", "upstream", undefined, reason);
      if (startFallback(current, reason)) return;
      cleanup({
        closeBrowser: { code: 1011, reason: "upstream handshake timeout" },
        closeUpstream: true,
      });
    }, handshakeTimeoutMs);

    const current: UpstreamBinding = {
      socket,
      disposeHeartbeat: () => undefined,
      handshakeTimer,
      onMessage,
      onError,
      onClose,
    };
    binding = current;
    socket.on("message", onMessage);
    socket.on("error", onError);
    socket.on("close", onClose);
    current.disposeHeartbeat = attachWebSocketHeartbeat(socket, {
      intervalMs: heartbeatIntervalMs,
      maxMissedPongs: heartbeatMaxMissedPongs,
      onTimeout: () => {
        if (cleaned || binding !== current) return;
        const reason = "upstream heartbeat timeout";
        writeProxyLog("realtime_proxy_heartbeat_timeout", "upstream");
        cleanup({ closeBrowser: { code: 1011, reason } });
      },
    });
  }

  function onBrowserMessage(data: Buffer): void {
    if (cleaned) return;
    onBrowserActivity();
    const payload = data.toString();
    if (phase === "ready" && binding?.socket.readyState === WebSocket.OPEN) {
      binding.socket.send(payload);
      return;
    }
    if (Buffer.byteLength(payload, "utf8") > 64 * 1024) return;
    try {
      if ((JSON.parse(payload) as { type?: unknown }).type === "session.update") {
        pendingSessionUpdate = payload;
      }
    } catch {
      // Malformed pre-ready control frames are ignored and never logged.
    }
  }

  function onBrowserClose(code: number, reason: Buffer): void {
    if (cleaned) return;
    writeProxyLog("realtime_proxy_browser_closed", "browser", code, reason.toString());
    cleanup({ closeUpstream: true });
  }

  function onBrowserError(error: Error): void {
    if (cleaned) return;
    writeProxyLog("realtime_proxy_browser_error", "browser", undefined, error.message);
    cleanup({ closeUpstream: true });
  }

  browser.on("message", onBrowserMessage);
  browser.on("close", onBrowserClose);
  browser.on("error", onBrowserError);
  disposeBrowserHeartbeat = attachWebSocketHeartbeat(browser, {
    intervalMs: heartbeatIntervalMs,
    maxMissedPongs: heartbeatMaxMissedPongs,
    onTimeout: () => {
      if (cleaned) return;
      writeProxyLog("realtime_proxy_heartbeat_timeout", "browser");
      cleanup({ closeUpstream: true });
    },
  });
  connectModel(primaryModel);
}
