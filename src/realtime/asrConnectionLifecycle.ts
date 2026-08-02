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

// 1007/1008 represent protocol/configuration failures. Reopening the same
// socket cannot heal them and only creates a reconnect loop that looks like a
// flaky microphone to the user.
const NON_RECOVERABLE_CLOSE_CODES = new Set([1000, 1007, 1008, 4001, 4003]);

export function isRecoverableAsrCloseCode(code: number | undefined): boolean {
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
