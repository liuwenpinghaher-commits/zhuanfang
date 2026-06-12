export type CapabilityTaskStatus = "idle" | "running" | "succeeded" | "failed" | "cancelled" | "degraded";

export interface CapabilityTask<T> {
  label: string;
  status: CapabilityTaskStatus;
  canRetry: boolean;
  providerId?: string;
  result?: T;
  error?: string;
  degradedReason?: string;
  startedAt?: string;
  completedAt?: string;
}

export function createIdleCapabilityTask<T>(label: string): CapabilityTask<T> {
  return {
    label,
    status: "idle",
    canRetry: false
  };
}

export function startCapabilityTask<T>(task: CapabilityTask<T>, providerId?: string): CapabilityTask<T> {
  return {
    label: task.label,
    status: "running",
    canRetry: false,
    providerId,
    startedAt: new Date().toISOString()
  };
}

export function completeCapabilityTask<T>(task: CapabilityTask<T>, result: T): CapabilityTask<T> {
  return {
    ...task,
    status: "succeeded",
    canRetry: false,
    result,
    error: undefined,
    degradedReason: undefined,
    completedAt: new Date().toISOString()
  };
}

export function failCapabilityTask<T>(task: CapabilityTask<T>, error: string): CapabilityTask<T> {
  return {
    ...task,
    status: "failed",
    canRetry: true,
    error,
    completedAt: new Date().toISOString()
  };
}

export function degradeCapabilityTask<T>(
  task: CapabilityTask<T>,
  result: T,
  degradedReason: string
): CapabilityTask<T> {
  return {
    ...task,
    status: "degraded",
    canRetry: true,
    result,
    degradedReason,
    completedAt: new Date().toISOString()
  };
}
