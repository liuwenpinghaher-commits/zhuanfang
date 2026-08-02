import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createInitialProductState } from "../../domain/engine";
import type { ProductState } from "../../domain/types";
import { ProfileView } from "./ProfileView";

describe("ProfileView 显性档案保存", () => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  let root: Root | undefined;
  let container: HTMLDivElement | undefined;

  afterEach(() => {
    if (root) act(() => root?.unmount());
    container?.remove();
    root = undefined;
    container = undefined;
  });

  it("服务端确认前保持保存中，确认后才显示已保存", async () => {
    const state = createInitialProductState();
    let resolveSave!: (state: ProductState) => void;
    const onSaveProfile = vi.fn(() => new Promise<ProductState>((resolve) => { resolveSave = resolve; }));
    renderProfile(state, onSaveProfile);
    const nameInput = container?.querySelector("input[placeholder='你希望被怎么称呼']") as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    act(() => {
      setter?.call(nameInput, "草稿称呼");
      nameInput.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const button = findSaveButton();

    act(() => button.click());

    expect(button.disabled).toBe(true);
    expect(button.textContent).toContain("保存中");
    expect(container?.textContent).not.toContain("已保存");

    await act(async () => resolveSave(state));
    expect(container?.textContent).toContain("已保存");
  });

  it("服务端拒绝时显示失败并保留用户草稿", async () => {
    const state = createInitialProductState();
    const onSaveProfile = vi.fn(async () => { throw new Error("服务器版本已更新，请刷新后重试。"); });
    renderProfile(state, onSaveProfile);
    const nameInput = container?.querySelector("input[placeholder='你希望被怎么称呼']") as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    act(() => {
      setter?.call(nameInput, "新的称呼");
      nameInput.dispatchEvent(new Event("input", { bubbles: true }));
    });

    await act(async () => findSaveButton().click());

    expect(nameInput.value).toBe("新的称呼");
    expect(container?.textContent).toContain("服务器版本已更新，请刷新后重试。");
    expect(container?.textContent).not.toContain("已保存");
  });

  function renderProfile(state: ProductState, onSaveProfile: (state: ProductState) => Promise<ProductState>) {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
      root?.render(
        <ProfileView
          state={state}
          correctionText=""
          onCorrectionText={vi.fn()}
          onAddCorrection={vi.fn()}
          onReset={vi.fn()}
          onExport={vi.fn()}
          onImport={vi.fn()}
          onPrivacyReport={vi.fn()}
          onPurge={vi.fn()}
          onSetProductState={vi.fn()}
          onSaveProfile={onSaveProfile} />
      );
    });
  }

  function findSaveButton(): HTMLButtonElement {
    const button = Array.from(container?.querySelectorAll("button") ?? []).find((item) => item.textContent?.includes("保存档案"));
    if (!button) throw new Error("保存档案按钮不存在");
    return button;
  }
});
