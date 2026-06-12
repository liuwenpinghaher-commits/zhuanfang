import type { RuntimeEnv } from "./env";

export const DEFAULT_PROVIDER_REQUEST_TIMEOUT_MS = 30000;

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export async function fetchWithTimeout(
  fetchImpl: FetchLike,
  input: string,
  init: RequestInit,
  timeoutMs = DEFAULT_PROVIDER_REQUEST_TIMEOUT_MS
) {
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort(new Error(`Request timed out after ${timeoutMs}ms.`));
  }, timeoutMs);

  try {
    return await fetchImpl(input, {
      ...init,
      signal: controller.signal
    });
  } finally {
    clearTimeout(timeout);
  }
}

export function resolveRequestTimeoutMs(env: RuntimeEnv, specificKey: string) {
  return (
    normalizeRequestTimeoutMs(env[specificKey]) ??
    normalizeRequestTimeoutMs(env.PROVIDER_REQUEST_TIMEOUT_MS) ??
    DEFAULT_PROVIDER_REQUEST_TIMEOUT_MS
  );
}

function normalizeRequestTimeoutMs(value: string | undefined) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return undefined;
  }
  return Math.max(1000, Math.min(600000, Math.round(parsed)));
}
