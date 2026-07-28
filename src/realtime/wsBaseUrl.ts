export function deriveRealtimeWsBaseUrl(apiBaseUrl: string, pageUrl?: string) {
  const fallbackPage = pageUrl
    ?? (typeof location !== "undefined" ? location.href : "http://127.0.0.1/");
  const url = new URL(apiBaseUrl, fallbackPage);
  const protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${url.host}`;
}
