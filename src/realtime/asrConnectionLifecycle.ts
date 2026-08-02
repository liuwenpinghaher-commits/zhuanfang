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

const NON_RECOVERABLE_CLOSE_CODES = new Set([4001, 4003]);

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
