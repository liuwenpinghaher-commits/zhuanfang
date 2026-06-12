export function formatProviderErrorMessage(error: unknown, fallback = "unknown error", maxLength = 160) {
  const rawReason = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  const reason = rawReason
    .replace(/sk-[a-zA-Z0-9_-]+/g, "[redacted]")
    .replace(/Bearer\s+[a-zA-Z0-9._~+/=-]+/gi, "Bearer [redacted]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);

  return reason || fallback;
}
