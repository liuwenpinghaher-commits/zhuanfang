import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createInitialProductState } from "../domain/engine";
import type { ProductState } from "../domain/types";
import type { View } from "../ui";
import { useServerReviews } from "./useServerReviews";

const getReviews = vi.fn();

vi.mock("../api/productApi", () => ({
  productApiClient: {
    getReviews: (...args: unknown[]) => getReviews(...args)
  }
}));

function Probe(props: {
  apiPersistenceEnabled: boolean;
  view: View;
  productState: ProductState;
  reviewsNonce: number;
}) {
  const { serverReviews, reviewsError, reviewsLoading } = useServerReviews(props);
  return (
    <div data-testid="probe">
      <span data-loading={reviewsLoading ? "1" : "0"} />
      <span data-error={reviewsError ?? ""} />
      <span data-has={serverReviews ? "1" : "0"} />
      <span data-monthly={serverReviews?.monthly ? "1" : "0"} />
    </div>
  );
}

describe("useServerReviews", () => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  let root: Root | undefined;
  let container: HTMLDivElement | undefined;
  const baseState = createInitialProductState();

  beforeEach(() => {
    getReviews.mockReset();
    vi.useFakeTimers();
  });

  afterEach(() => {
    if (root) act(() => root?.unmount());
    container?.remove();
    root = undefined;
    container = undefined;
    vi.useRealTimers();
  });

  function mount(props: {
    apiPersistenceEnabled: boolean;
    view: View;
    productState?: ProductState;
    reviewsNonce?: number;
  }) {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
      root?.render(
        <Probe
          apiPersistenceEnabled={props.apiPersistenceEnabled}
          view={props.view}
          productState={props.productState ?? baseState}
          reviewsNonce={props.reviewsNonce ?? 0}
        />
      );
    });
  }

  function remount(props: {
    apiPersistenceEnabled: boolean;
    view: View;
    productState?: ProductState;
    reviewsNonce?: number;
  }) {
    act(() => {
      root?.render(
        <Probe
          apiPersistenceEnabled={props.apiPersistenceEnabled}
          view={props.view}
          productState={props.productState ?? baseState}
          reviewsNonce={props.reviewsNonce ?? 0}
        />
      );
    });
  }

  it("非复盘视图不请求", () => {
    mount({ apiPersistenceEnabled: true, view: "profile" });
    expect(getReviews).not.toHaveBeenCalled();
  });

  it("API 离线不请求", () => {
    mount({ apiPersistenceEnabled: false, view: "themes" });
    expect(getReviews).not.toHaveBeenCalled();
  });

  it("themes 视图成功写入 serverReviews", async () => {
    getReviews.mockResolvedValueOnce({
      monthly: { title: "m" },
      yearly: { title: "y" },
      radar: { axes: [] }
    });
    mount({ apiPersistenceEnabled: true, view: "themes" });
    await act(async () => {
      await Promise.resolve();
    });
    expect(getReviews).toHaveBeenCalledTimes(1);
    expect(container?.querySelector("[data-has]")?.getAttribute("data-has")).toBe("1");
    expect(container?.querySelector("[data-error]")?.getAttribute("data-error")).toBe("");
  });

  it("失败保留旧 serverReviews 并设置 reviewsError", async () => {
    getReviews.mockResolvedValueOnce({
      monthly: { title: "m" },
      yearly: { title: "y" },
      radar: { axes: [] }
    });
    mount({ apiPersistenceEnabled: true, view: "home" });
    await act(async () => {
      await Promise.resolve();
    });
    expect(container?.querySelector("[data-has]")?.getAttribute("data-has")).toBe("1");

    getReviews.mockRejectedValueOnce(new Error("503 reviews unavailable"));
    remount({ apiPersistenceEnabled: true, view: "home", reviewsNonce: 1 });
    await act(async () => {
      await Promise.resolve();
    });
    expect(container?.querySelector("[data-has]")?.getAttribute("data-has")).toBe("1");
    expect(container?.querySelector("[data-error]")?.getAttribute("data-error")).toContain("503");
  });

  it("资产签名连变两次：2s debounce 内只再拉一次", async () => {
    getReviews.mockResolvedValue({
      monthly: { title: "m" },
      yearly: { title: "y" },
      radar: { axes: [] }
    });
    mount({ apiPersistenceEnabled: true, view: "themes", productState: baseState });
    await act(async () => {
      await Promise.resolve();
    });
    const initialCalls = getReviews.mock.calls.length;
    expect(initialCalls).toBe(1);

    // assetSig includes revision — bump twice inside the debounce window.
    remount({
      apiPersistenceEnabled: true,
      view: "themes",
      productState: { ...baseState, revision: baseState.revision + 1 }
    });
    remount({
      apiPersistenceEnabled: true,
      view: "themes",
      productState: { ...baseState, revision: baseState.revision + 2 }
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_500);
    });
    expect(getReviews.mock.calls.length).toBe(initialCalls);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(600);
    });
    // Only one debounced fetch after the double bump.
    expect(getReviews.mock.calls.length).toBe(initialCalls + 1);
  });
});
