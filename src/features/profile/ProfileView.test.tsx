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

  it("C13: knowledgeIndex=failed 展示诚实文案与重建索引 CTA", async () => {
    const state = createInitialProductState();
    const onRebuildIndex = vi.fn(async () => ({ chunkCount: 3 }));
    const onImport = vi.fn(async () => ({
      state,
      receipt: {
        partial: true,
        restored: { rawMaterials: 1, audios: 0 },
        skipped: { rawMaterials: [], audios: [] },
        missing: { audioSessions: [] as string[] },
        knowledgeIndex: "failed" as const
      }
    }));
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
          onImport={onImport}
          onPrivacyReport={vi.fn()}
          onPurge={vi.fn()}
          onSetProductState={vi.fn()}
          onSaveProfile={vi.fn(async (s) => s)}
          onRebuildIndex={onRebuildIndex}
        />
      );
    });

    // Simulate successful import path by re-rendering with receipt already shown:
    // trigger via private-ish path — call onImport through file handler is heavy;
    // instead mount with a controlled re-render after import by exercising rebuild CTA
    // visibility through re-render with forced receipt state via import flow mock.
    // Use FileReader-less path: invoke import by dispatching change with a stub file.
    const fileInput = container?.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File(
      [
        JSON.stringify({
          state,
          rawMaterials: [],
          audios: []
        })
      ],
      "backup.json",
      { type: "application/json" }
    );
    // confirm() is required by handleImportFile
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    await act(async () => {
      Object.defineProperty(fileInput, "files", { value: [file], configurable: true });
      fileInput.dispatchEvent(new Event("change", { bubbles: true }));
    });
    // allow promise chain
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container?.textContent).toContain("备份已恢复，但语义索引重建失败");
    expect(container?.textContent).toContain("索引重建失败，热态已写入");
    expect(container?.textContent).not.toContain("已完整恢复并核对清单");
    const rebuildBtn = Array.from(container?.querySelectorAll("button") ?? []).find((b) =>
      (b.textContent ?? "").includes("重建知识索引")
    );
    expect(rebuildBtn).toBeTruthy();
    await act(async () => {
      rebuildBtn?.click();
      await Promise.resolve();
    });
    expect(onRebuildIndex).toHaveBeenCalledTimes(1);
    expect(container?.textContent).toContain("重建完成：3 块已写入索引");
    confirmSpy.mockRestore();
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
