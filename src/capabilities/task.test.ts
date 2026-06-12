import { describe, expect, it } from "vitest";
import {
  completeCapabilityTask,
  createIdleCapabilityTask,
  degradeCapabilityTask,
  failCapabilityTask,
  startCapabilityTask
} from "./task";

describe("capability task state", () => {
  it("moves through idle, running, succeeded, failed and degraded states", () => {
    const idle = createIdleCapabilityTask<string>("联网搜索");
    expect(idle.status).toBe("idle");
    expect(idle.canRetry).toBe(false);

    const running = startCapabilityTask<string>(idle, "anysearch");
    expect(running.status).toBe("running");
    expect(running.providerId).toBe("anysearch");

    const succeeded = completeCapabilityTask(running, "ok");
    expect(succeeded.status).toBe("succeeded");
    expect(succeeded.result).toBe("ok");

    const failed = failCapabilityTask(running, "API key missing");
    expect(failed.status).toBe("failed");
    expect(failed.canRetry).toBe(true);
    expect(failed.error).toContain("API key");

    const degraded = degradeCapabilityTask(running, "fallback", "AnySearch 未配置，已使用本地壳。");
    expect(degraded.status).toBe("degraded");
    expect(degraded.result).toBe("fallback");
    expect(degraded.degradedReason).toContain("本地壳");
  });
});
