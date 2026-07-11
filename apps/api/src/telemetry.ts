// OpenTelemetry SDK initialization — must be imported first
import { NodeSDK } from "@opentelemetry/sdk-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { getNodeAutoInstrumentations } from "@opentelemetry/auto-instrumentations-node";
import { resourceFromAttributes } from "@opentelemetry/resources";
import {
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION,
} from "@opentelemetry/semantic-conventions";

const otlpEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT || "http://localhost:4318";

// 媒体回放 <audio src> 与 WS 升级用 ?token=<PRODUCT_API_TOKEN> 携带凭据（浏览器无法设请求头）。
// instrumentation-http 默认把含 query 的完整 URL 写进 span 属性并经 OTLP 导出 → 生产 bearer token 外泄。
// 在 span 落地前对敏感 query 参数做脱敏。
const SENSITIVE_QUERY_KEYS = new Set(["token", "access_token", "api_key", "apikey", "key", "password", "secret"]);

function redactQueryString(query: string): string {
  return query
    .split("&")
    .map((pair) => {
      const eq = pair.indexOf("=");
      const rawKey = eq === -1 ? pair : pair.slice(0, eq);
      const key = decodeURIComponent(rawKey).toLowerCase();
      if (SENSITIVE_QUERY_KEYS.has(key)) return `${rawKey}=REDACTED`;
      return pair;
    })
    .join("&");
}

// 对 http.url / http.target / url.full（含 "?") 与 url.query（裸 query）两类属性统一脱敏。
function redactUrlAttribute(attrKey: string, value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined;
  if (attrKey === "url.query") return redactQueryString(value);
  const queryIndex = value.indexOf("?");
  if (queryIndex === -1) return value;
  return `${value.slice(0, queryIndex)}?${redactQueryString(value.slice(queryIndex + 1))}`;
}

const sdk = new NodeSDK({
  resource: resourceFromAttributes({
    [ATTR_SERVICE_NAME]: process.env.OTEL_SERVICE_NAME || "interview-api",
    [ATTR_SERVICE_VERSION]: process.env.OTEL_SERVICE_VERSION || "1.0.0",
  }),
  traceExporter: new OTLPTraceExporter({
    url: `${otlpEndpoint}/v1/traces`,
  }),
  instrumentations: [
    getNodeAutoInstrumentations({
      "@opentelemetry/instrumentation-http": {
        ignoreIncomingRequestHook: (req) =>
          req.url === "/health" || req.url === "/api/health",
        // 脱敏 span 上的 URL 属性，避免 ?token= 等敏感 query 经 OTLP 导出到 trace 后端。
        applyCustomAttributesOnSpan: (span) => {
          const attrs = (span as unknown as { attributes?: Record<string, unknown> }).attributes;
          if (!attrs) return;
          for (const attrKey of ["http.url", "http.target", "url.full", "url.query"] as const) {
            const redacted = redactUrlAttribute(attrKey, attrs[attrKey]);
            if (redacted !== undefined) span.setAttribute(attrKey, redacted);
          }
        },
      },
      "@opentelemetry/instrumentation-fs": { enabled: false },
    }),
  ],
});

sdk.start();

/**
 * N-10:优雅关闭协调——telemetry 不再自行注册 SIGTERM handler。
 *
 * 旧实现 `process.on("SIGTERM", () => sdk.shutdown().finally(() => process.exit(0)))` 有两处害:
 *  ① 它不等 persist 队列排空就 exit——R7 删同步 sqlite 后异步 persist 是唯一持久路径,
 *     重试期/队列积压/降级期(N-02)窗口会丢已确认 200 的写;
 *  ② 若 server.ts 也注册一个关闭钩子,两个 handler 会各自 process.exit 打架(谁先退谁说了算,
 *     数据 flush 可能根本没跑完)。
 * 改为:导出 shutdownTelemetry(),由 startServer 的统一关闭序列在【数据 flush 之后】调用
 * (数据落库优先 → OTel 其次 → 单一 exit)。错误吞掉:OTel 关不掉绝不该阻塞进程退出。
 */
export async function shutdownTelemetry(): Promise<void> {
  try {
    await sdk.shutdown();
  } catch (err) {
    console.error(JSON.stringify({
      event: "otel_shutdown_failed",
      error: err instanceof Error ? err.message : String(err)
    }));
  }
}
