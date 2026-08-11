import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { usePersistHealthPoll } from "./usePersistHealthPoll";

const getHealth = vi.fn();

vi.mock("../api/productApi", () => ({
  productApiClient: {
    getHealth: (...args: unknown[]) => getHealth(...args)
  }
}));

function Probe({ enabled }: { enabled: boolean }) {
  const health = usePersistHealthPoll(enabled);
  return (
    <div data-testid="probe">
      {health ? `${health.consecutiveFailures}|${health.lastErrorAt ?? ""}` : "null"}
    </div>
  );
}

describe("usePersistHealthPoll", () => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  let root: Root | undefined;
  let container: HTMLDivElement | undefined;

  beforeEach(() => {
    getHealth.mockReset();
    vi.useFakeTimers();
  });

  afterEach(() => {
    if (root) act(() => root?.unmount());
    container?.remove();
    root = undefined;
    container = undefined;
    vi.useRealTimers();
  });

  function mount(enabled: boolean) {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
      root?.render(<Probe enabled={enabled} />);
    });
  }

  it("api 离线时不请求且 banner 为 null", () => {
    mount(false);
    expect(getHealth).not.toHaveBeenCalled();
    expect(container?.textContent).toBe("null");
  });

  it("degraded 时透出 consecutiveFailures，健康时清零", async () => {
    getHealth.mockResolvedValueOnce({
      ok: true,
      persist: { degraded: true, consecutiveFailures: 3, lastErrorAt: "2026-01-01T00:00:00.000Z" }
    });
    mount(true);
    await act(async () => {
      await Promise.resolve();
    });
    expect(getHealth).toHaveBeenCalledTimes(1);
    expect(container?.textContent).toBe("3|2026-01-01T00:00:00.000Z");

    getHealth.mockResolvedValueOnce({ ok: true });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(container?.textContent).toBe("null");
  });

  it("网络失败不伪造成 persist degraded", async () => {
    getHealth.mockRejectedValueOnce(new Error("network down"));
    mount(true);
    await act(async () => {
      await Promise.resolve();
    });
    expect(container?.textContent).toBe("null");
  });

  it("曾 degraded 后网络失败保留 prior banner", async () => {
    getHealth.mockResolvedValueOnce({
      ok: true,
      persist: { degraded: true, consecutiveFailures: 2, lastErrorAt: "2026-02-01T00:00:00.000Z" }
    });
    mount(true);
    await act(async () => {
      await Promise.resolve();
    });
    expect(container?.textContent).toBe("2|2026-02-01T00:00:00.000Z");

    getHealth.mockRejectedValueOnce(new Error("network down"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    // Prior degraded banner sticky — network fail must not clear or invent new state.
    expect(container?.textContent).toBe("2|2026-02-01T00:00:00.000Z");
  });
});
