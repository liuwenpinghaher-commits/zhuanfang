export type AsrConnectionState =
  | "connecting"
  | "ready"
  | "reconnecting"
  | "exhausted"
  | "stopped";

export interface AsrConnectionEvent {
  state: AsrConnectionState;
  attempt: number;
  maxAttempts: number;
  code?: number;
  reason?: string;
}

// 1007/1008 represent protocol/configuration failures — except the omni idle
// kick ("no response was generated for 180 seconds"). Cascade never asks omni
// to generate a reply (`create_response:false`), so that 1007 is an idle TTL,
// not a bad session.update. Reopening heals it; treating it as terminal left
// the UI on 聆听中 with a dead mic.
const NON_RECOVERABLE_CLOSE_CODES = new Set([1000, 1007, 1008, 4001, 4003]);

export function isOmniIdleTimeoutClose(code?: number, reason?: string): boolean {
  if (code !== 1007) return false;
  const r = String(reason ?? "").toLowerCase();
  return r.includes("no response was generated") || r.includes("no response is generated");
}

export function isRecoverableAsrCloseCode(code?: number, reason?: string): boolean {
  if (isOmniIdleTimeoutClose(code, reason)) return true;
  return code == null || !NON_RECOVERABLE_CLOSE_CODES.has(code);
}

export function computeAsrReconnectDelayMs(
  attempt: number,
  baseDelayMs: number,
  random: () => number,
): number {
  const exponent = Math.max(0, attempt - 1);
  const base = Math.max(0, baseDelayMs) * (2 ** exponent);
  const jitter = Math.min(1, Math.max(0, random())) * 0.2;
  return Math.round(base * (1 + jitter));
}
