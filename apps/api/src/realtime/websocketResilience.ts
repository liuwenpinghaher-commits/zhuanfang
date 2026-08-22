export interface HeartbeatSocket {
  readyState: number;
  ping(): void;
  terminate(): void;
  on(event: "pong" | "message", listener: () => void): unknown;
  off(event: "pong" | "message", listener: () => void): unknown;
}

export interface HeartbeatOptions {
  intervalMs: number;
  maxMissedPongs: number;
  onTimeout: () => void;
  /** Read each tick. Timeout while true must not dispose / terminate the socket. */
  isInFlight?: () => boolean;
}

export interface RealtimeProxyLogInput {
  event: string;
  sessionId: string;
  direction: "browser" | "upstream";
  code?: number;
  reason?: string;
  phase: "connecting" | "ready" | "closing";
  durationMs?: number;
  inFlight?: boolean;
}

export interface RealtimeProxyLogPayload {
  event: string;
  sessionId: string;
  direction: "browser" | "upstream";
  code: number | undefined;
  reason: string | undefined;
  phase: "connecting" | "ready" | "closing";
  durationMs: number | undefined;
  inFlight?: boolean;
}

const WEB_SOCKET_OPEN = 1;
const LOG_REASON_MAX_BYTES = 160;
const CLOSE_REASON_MAX_BYTES = 123;
const REDACTED_REASON = "[REDACTED]";
const SENSITIVE_REASON_MARKER = /(?:\b(?:authorization|token|cookie|transcript(?:ion)?|instructions?|secret|pcm)\b|\bapi\s*key\b|\binput\s+audio(?:\s+buffer)?\b|\baudio\s+payload\b|\b(?:bearer|basic)\s+[a-z0-9]+|令牌|口令|密钥|逐字稿)/i;

export function attachWebSocketHeartbeat(
  socket: HeartbeatSocket,
  options: HeartbeatOptions
): () => void {
  let missedPongs = 0;
  let disposed = false;

  const onAlive = () => {
    missedPongs = 0;
  };

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    clearInterval(timer);
    socket.off("pong", onAlive);
    socket.off("message", onAlive);
  };

  // DashScope / token-plan sockets often never pong RFC6455 ping. Any inbound
  // frame still means the connection is alive — treat it like a pong.
  socket.on("pong", onAlive);
  socket.on("message", onAlive);
  const timer = setInterval(() => {
    if (disposed || socket.readyState !== WEB_SOCKET_OPEN) return;

    missedPongs += 1;
    if (missedPongs >= options.maxMissedPongs) {
      if (options.isInFlight?.()) {
        missedPongs = 0;
        try {
          options.onTimeout();
        } catch {
          /* in-flight synthesis must keep the timer */
        }
        return;
      }
      dispose();
      try {
        options.onTimeout();
      } finally {
        socket.terminate();
      }
      return;
    }

    socket.ping();
  }, options.intervalMs);

  return dispose;
}

export function buildRealtimeProxyLog(input: RealtimeProxyLogInput): RealtimeProxyLogPayload {
  return {
    event: input.event,
    sessionId: input.sessionId,
    direction: input.direction,
    code: input.code,
    reason: input.reason === undefined ? undefined : sanitizeLogReason(input.reason),
    phase: input.phase,
    durationMs: input.durationMs,
    ...(input.inFlight !== undefined ? { inFlight: input.inFlight } : {})
  };
}

export function sanitizeWebSocketCloseCode(code: number): number {
  if (!Number.isInteger(code)) return 1000;
  if (code >= 3000 && code <= 4999) return code;
  if (code < 1000 || code > 1014) return 1000;
  return code === 1004 || code === 1005 || code === 1006 ? 1000 : code;
}

export function mapUpstreamCloseCodeForBrowser(code: number): number {
  const sanitized = sanitizeWebSocketCloseCode(code);
  return sanitized === 1000 && code !== 1000 ? 1011 : sanitized;
}

/** Omni realtime idle TTL when the session never created a model response. */
export function isOmniIdleTimeoutClose(code?: number, reason?: string): boolean {
  if (code !== 1007) return false;
  const r = String(reason ?? "").toLowerCase();
  return r.includes("no response was generated") || r.includes("no response is generated");
}

export function sanitizeWebSocketCloseReason(reason: string): string {
  return truncateUtf8(sanitizeLogReason(reason), CLOSE_REASON_MAX_BYTES);
}

function sanitizeLogReason(reason: string): string {
  const withoutLineBreaks = reason.replace(/[\r\n]+/g, " ");
  if (SENSITIVE_REASON_MARKER.test(normalizeSensitiveDetectionText(withoutLineBreaks))) {
    return REDACTED_REASON;
  }
  return truncateUtf8(withoutLineBreaks, LOG_REASON_MAX_BYTES);
}

function normalizeSensitiveDetectionText(value: string): string {
  return value
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[^A-Za-z0-9\u4e00-\u9fff]+/g, " ")
    .toLowerCase()
    .trim();
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;

  let result = "";
  let bytes = 0;
  for (const character of value) {
    const characterBytes = Buffer.byteLength(character, "utf8");
    if (bytes + characterBytes > maxBytes) break;
    result += character;
    bytes += characterBytes;
  }
  return result;
}
