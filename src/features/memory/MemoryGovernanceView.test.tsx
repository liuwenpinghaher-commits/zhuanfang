/**
 * B4: MemoryGovernanceView unit tests
 * Uses react-dom/client + jsdom directly (no @testing-library).
 * Tests:
 *  - inline edit replaces window.prompt
 *  - approve/reject/save buttons call callbacks
 *  - sensitive icon is lucide SVG (not emoji 🔒)
 *  - empty states use .empty-state class
 *  - import content-length guard
 */
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createEmptyProductState } from "../../domain/engine";
import type { MemoryCandidate, MemoryRecord, ProductState } from "../../domain/types";
import { MemoryGovernanceView } from "./MemoryGovernanceView";

// window.prompt must not be called
beforeAll(() => {
  vi.spyOn(window, "prompt").mockImplementation(() => {
    throw new Error("window.prompt must not be called from MemoryGovernanceView");
  });
});

let container: HTMLDivElement;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
});

afterEach(() => {
  document.body.removeChild(container);
});

// Helper: render into jsdom container
function renderView(ui: React.ReactElement) {
  const root = createRoot(container);
  act(() => {
    root.render(ui);
  });
  return {
    container,
    unmount: () => act(() => root.unmount())
  };
}

function makeCandidate(overrides: Partial<MemoryCandidate> = {}): MemoryCandidate {
  return {
    id: "c1",
    text: "受访者喜欢在早晨工作",
    status: "pending",
    sourceType: "interview_session",
    sourceId: "s1",
    sensitivity: "normal",
    reviewScore: 0.85,
    reviewSignals: [],
    evidenceQuote: "",
    reason: "",
    createdAt: "2024-01-01T00:00:00Z",
    ...overrides
  };
}

function makeRecord(overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    id: "r1",
    text: "受访者是一名产品经理",
    status: "confirmed",
    sourceType: "interview_session",
    sensitivity: "normal",
    evidenceQuote: "",
    sourceId: "s1",
    createdAt: "2024-01-01T00:00:00Z",
    updatedAt: "2024-01-01T00:00:00Z",
    ...overrides
  };
}

function makeState(overrides: Partial<ProductState> = {}): ProductState {
  return { ...createEmptyProductState(), ...overrides };
}

const noop = () => {};

// ── 1. SSR render guard ────────────────────────────────────────────────────
describe("SSR render guard", () => {
  it("renders with empty state without throwing", () => {
    const state = makeState();
    expect(() =>
      renderToString(
        <MemoryGovernanceView
          state={state}
          importing={false}
          onImport={noop}
          onApprove={noop}
          onReject={noop}
          onEditCandidate={noop}
          onDeprecate={noop}
          onDeleteRecord={noop}
          onEditRecord={noop}
          onConsolidate={noop}
          onAddAnnotation={noop}
          onRemoveAnnotation={noop}
          getRawMaterial={async () => null}
        />
      )
    ).not.toThrow();
  });

  it("renders with candidates and records without throwing", () => {
    const state = makeState({
      memoryCandidates: [makeCandidate()],
      memoryRecords: [makeRecord()]
    });
    expect(() =>
      renderToString(
        <MemoryGovernanceView
          state={state}
          importing={false}
          onImport={noop}
          onApprove={noop}
          onReject={noop}
          onEditCandidate={noop}
          onDeprecate={noop}
          onDeleteRecord={noop}
          onEditRecord={noop}
          onConsolidate={noop}
          onAddAnnotation={noop}
          onRemoveAnnotation={noop}
          getRawMaterial={async () => null}
        />
      )
    ).not.toThrow();
  });
});

// ── 2. Empty states ────────────────────────────────────────────────────────
describe("empty states", () => {
  it("pending empty state uses .empty-state class", () => {
    const state = makeState();
    renderView(
      <MemoryGovernanceView
        state={state}
        importing={false}
        onImport={noop}
        onApprove={noop}
        onReject={noop}
        onEditCandidate={noop}
        onDeprecate={noop}
        onDeleteRecord={noop}
        onEditRecord={noop}
        onConsolidate={noop}
        onAddAnnotation={noop}
        onRemoveAnnotation={noop}
        getRawMaterial={async () => null}
      />
    );
    const emptyStates = container.querySelectorAll(".empty-state");
    expect(emptyStates.length).toBeGreaterThanOrEqual(1);
  });

  it("pending empty state shows guide text", () => {
    const state = makeState();
    renderView(
      <MemoryGovernanceView
        state={state}
        importing={false}
        onImport={noop}
        onApprove={noop}
        onReject={noop}
        onEditCandidate={noop}
        onDeprecate={noop}
        onDeleteRecord={noop}
        onEditRecord={noop}
        onConsolidate={noop}
        onAddAnnotation={noop}
        onRemoveAnnotation={noop}
        getRawMaterial={async () => null}
      />
    );
    expect(container.textContent).toContain("暂无待审候选");
  });

  it("confirmed empty state shows guide text", () => {
    const state = makeState();
    renderView(
      <MemoryGovernanceView
        state={state}
        importing={false}
        onImport={noop}
        onApprove={noop}
        onReject={noop}
        onEditCandidate={noop}
        onDeprecate={noop}
        onDeleteRecord={noop}
        onEditRecord={noop}
        onConsolidate={noop}
        onAddAnnotation={noop}
        onRemoveAnnotation={noop}
        getRawMaterial={async () => null}
      />
    );
    expect(container.textContent).toContain("还没有确认的长期记忆");
  });
});

// ── 3. Sensitive icon: lucide SVG, not emoji ───────────────────────────────
describe("sensitive icon", () => {
  it("sensitive candidate does NOT render emoji 🔒", () => {
    const state = makeState({
      memoryCandidates: [makeCandidate({ sensitivity: "sensitive" })]
    });
    const html = renderToString(
      <MemoryGovernanceView
        state={state}
        importing={false}
        onImport={noop}
        onApprove={noop}
        onReject={noop}
        onEditCandidate={noop}
        onDeprecate={noop}
        onDeleteRecord={noop}
        onEditRecord={noop}
        onConsolidate={noop}
        onAddAnnotation={noop}
        onRemoveAnnotation={noop}
        getRawMaterial={async () => null}
      />
    );
    expect(html).not.toContain("🔒"); // 🔒 unicode
    expect(html).not.toContain("🔒");
  });

  it("sensitive candidate renders SVG element", () => {
    const state = makeState({
      memoryCandidates: [makeCandidate({ sensitivity: "sensitive" })]
    });
    const html = renderToString(
      <MemoryGovernanceView
        state={state}
        importing={false}
        onImport={noop}
        onApprove={noop}
        onReject={noop}
        onEditCandidate={noop}
        onDeprecate={noop}
        onDeleteRecord={noop}
        onEditRecord={noop}
        onConsolidate={noop}
        onAddAnnotation={noop}
        onRemoveAnnotation={noop}
        getRawMaterial={async () => null}
      />
    );
    expect(html).toContain("<svg");
  });

  it("sensitive candidate icon has aria-label", () => {
    const state = makeState({
      memoryCandidates: [makeCandidate({ sensitivity: "sensitive" })]
    });
    const html = renderToString(
      <MemoryGovernanceView
        state={state}
        importing={false}
        onImport={noop}
        onApprove={noop}
        onReject={noop}
        onEditCandidate={noop}
        onDeprecate={noop}
        onDeleteRecord={noop}
        onEditRecord={noop}
        onConsolidate={noop}
        onAddAnnotation={noop}
        onRemoveAnnotation={noop}
        getRawMaterial={async () => null}
      />
    );
    expect(html).toContain("敏感");
    // aria-label attribute present on the svg
    expect(html).toContain("aria-label");
  });

  it("sensitive confirmed record does NOT render emoji 🔒", () => {
    const state = makeState({
      memoryRecords: [makeRecord({ sensitivity: "sensitive" })]
    });
    const html = renderToString(
      <MemoryGovernanceView
        state={state}
        importing={false}
        onImport={noop}
        onApprove={noop}
        onReject={noop}
        onEditCandidate={noop}
        onDeprecate={noop}
        onDeleteRecord={noop}
        onEditRecord={noop}
        onConsolidate={noop}
        onAddAnnotation={noop}
        onRemoveAnnotation={noop}
        getRawMaterial={async () => null}
      />
    );
    expect(html).not.toContain("🔒");
  });
});

// ── 4. Inline edit replaces window.prompt ─────────────────────────────────
describe("inline edit", () => {
  it("clicking 修正 opens a textarea without calling window.prompt", () => {
    const state = makeState({
      memoryCandidates: [makeCandidate()]
    });
    renderView(
      <MemoryGovernanceView
        state={state}
        importing={false}
        onImport={noop}
        onApprove={noop}
        onReject={noop}
        onEditCandidate={noop}
        onDeprecate={noop}
        onDeleteRecord={noop}
        onEditRecord={noop}
        onConsolidate={noop}
        onAddAnnotation={noop}
        onRemoveAnnotation={noop}
        getRawMaterial={async () => null}
      />
    );

    const editBtn = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent?.includes("修正")
    );
    expect(editBtn).toBeTruthy();

    act(() => {
      editBtn!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    // textarea with the candidate text pre-filled
    const textareas = container.querySelectorAll("textarea");
    // At least one textarea should be visible (could be import + edit)
    const editTextarea = Array.from(textareas).find(
      (t) => t.getAttribute("aria-label")?.includes("修正候选记忆内容")
    );
    expect(editTextarea).toBeTruthy();
    expect((editTextarea as HTMLTextAreaElement).value).toBe("受访者喜欢在早晨工作");
  });

  it("clicking 取消 collapses the inline editor", () => {
    const state = makeState({
      memoryCandidates: [makeCandidate()]
    });
    renderView(
      <MemoryGovernanceView
        state={state}
        importing={false}
        onImport={noop}
        onApprove={noop}
        onReject={noop}
        onEditCandidate={noop}
        onDeprecate={noop}
        onDeleteRecord={noop}
        onEditRecord={noop}
        onConsolidate={noop}
        onAddAnnotation={noop}
        onRemoveAnnotation={noop}
        getRawMaterial={async () => null}
      />
    );

    // Open edit
    const editBtn = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent?.includes("修正")
    )!;
    act(() => {
      editBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    // Verify edit textarea visible
    let editTextarea = Array.from(container.querySelectorAll("textarea")).find(
      (t) => t.getAttribute("aria-label")?.includes("修正候选记忆内容")
    );
    expect(editTextarea).toBeTruthy();

    // Click cancel
    const cancelBtn = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent?.includes("取消")
    )!;
    act(() => {
      cancelBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    // Edit textarea gone
    editTextarea = Array.from(container.querySelectorAll("textarea")).find(
      (t) => t.getAttribute("aria-label")?.includes("修正候选记忆内容")
    );
    expect(editTextarea).toBeUndefined();
  });

  it("saving changed text calls onEditCandidate with new text", async () => {
    const onEditCandidate = vi.fn();
    const state = makeState({
      memoryCandidates: [makeCandidate()]
    });
    renderView(
      <MemoryGovernanceView
        state={state}
        importing={false}
        onImport={noop}
        onApprove={noop}
        onReject={noop}
        onEditCandidate={onEditCandidate}
        onDeprecate={noop}
        onDeleteRecord={noop}
        onEditRecord={noop}
        onConsolidate={noop}
        onAddAnnotation={noop}
        onRemoveAnnotation={noop}
        getRawMaterial={async () => null}
      />
    );

    // Open edit
    const editBtn = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent?.includes("修正")
    )!;
    act(() => {
      editBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    // Change textarea value
    const editTextarea = Array.from(container.querySelectorAll("textarea")).find(
      (t) => t.getAttribute("aria-label")?.includes("修正候选记忆内容")
    ) as HTMLTextAreaElement;
    act(() => {
      const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype,
        "value"
      )!.set!;
      nativeInputValueSetter.call(editTextarea, "受访者喜欢在傍晚工作");
      editTextarea.dispatchEvent(new Event("input", { bubbles: true }));
      // Also fire React's change event
      editTextarea.dispatchEvent(new Event("change", { bubbles: true }));
    });

    // Click save
    const saveBtn = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent?.includes("保存修正")
    )!;
    await act(async () => {
      saveBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(onEditCandidate).toHaveBeenCalledWith("c1", "受访者喜欢在傍晚工作");
  });

  it("saving unchanged text does NOT call onEditCandidate", async () => {
    const onEditCandidate = vi.fn();
    const state = makeState({
      memoryCandidates: [makeCandidate()]
    });
    renderView(
      <MemoryGovernanceView
        state={state}
        importing={false}
        onImport={noop}
        onApprove={noop}
        onReject={noop}
        onEditCandidate={onEditCandidate}
        onDeprecate={noop}
        onDeleteRecord={noop}
        onEditRecord={noop}
        onConsolidate={noop}
        onAddAnnotation={noop}
        onRemoveAnnotation={noop}
        getRawMaterial={async () => null}
      />
    );

    const editBtn = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent?.includes("修正")
    )!;
    act(() => {
      editBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    // Do NOT change text; click save immediately
    const saveBtn = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent?.includes("保存修正")
    )!;
    await act(async () => {
      saveBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(onEditCandidate).not.toHaveBeenCalled();
  });
});

// ── 5. Approve / reject callbacks ─────────────────────────────────────────
describe("approval actions", () => {
  it("approve button calls onApprove with candidate id and default mode", async () => {
    const onApprove = vi.fn();
    const state = makeState({
      memoryCandidates: [makeCandidate()]
    });
    renderView(
      <MemoryGovernanceView
        state={state}
        importing={false}
        onImport={noop}
        onApprove={onApprove}
        onReject={noop}
        onEditCandidate={noop}
        onDeprecate={noop}
        onDeleteRecord={noop}
        onEditRecord={noop}
        onConsolidate={noop}
        onAddAnnotation={noop}
        onRemoveAnnotation={noop}
        getRawMaterial={async () => null}
      />
    );

    const approveBtn = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent?.includes("确认记住")
    )!;
    await act(async () => {
      approveBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(onApprove).toHaveBeenCalledWith("c1", "add");
  });

  it("reject button calls onReject with candidate id", async () => {
    const onReject = vi.fn();
    const state = makeState({
      memoryCandidates: [makeCandidate()]
    });
    renderView(
      <MemoryGovernanceView
        state={state}
        importing={false}
        onImport={noop}
        onApprove={noop}
        onReject={onReject}
        onEditCandidate={noop}
        onDeprecate={noop}
        onDeleteRecord={noop}
        onEditRecord={noop}
        onConsolidate={noop}
        onAddAnnotation={noop}
        onRemoveAnnotation={noop}
        getRawMaterial={async () => null}
      />
    );

    const rejectBtn = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent?.includes("不要记")
    )!;
    await act(async () => {
      rejectBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(onReject).toHaveBeenCalledWith("c1");
  });
});

// ── 6. Import: content-length guard ───────────────────────────────────────
describe("import content length guard", () => {
  it("shows error when content exceeds 20000 chars (SSR html check)", () => {
    // This is a state-driven component; we verify the SSR text includes
    // the aria-describedby wiring when content is oversized.
    // Interactive version: just verify the error text path via renderToString trick.
    // We test the client path in the DOM test below.
    const state = makeState();
    renderView(
      <MemoryGovernanceView
        state={state}
        importing={false}
        onImport={noop}
        onApprove={noop}
        onReject={noop}
        onEditCandidate={noop}
        onDeprecate={noop}
        onDeleteRecord={noop}
        onEditRecord={noop}
        onConsolidate={noop}
        onAddAnnotation={noop}
        onRemoveAnnotation={noop}
        getRawMaterial={async () => null}
      />
    );

    // Find the content textarea
    const contentTextarea = container.querySelector(
      "#memory-import-content"
    ) as HTMLTextAreaElement;
    expect(contentTextarea).toBeTruthy();

    act(() => {
      const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype,
        "value"
      )!.set!;
      nativeInputValueSetter.call(contentTextarea, "a".repeat(20001));
      contentTextarea.dispatchEvent(new Event("input", { bubbles: true }));
      contentTextarea.dispatchEvent(new Event("change", { bubbles: true }));
    });

    expect(container.textContent).toContain("内容超过");
  });

  it("import button is disabled when content empty (default)", () => {
    const state = makeState();
    renderView(
      <MemoryGovernanceView
        state={state}
        importing={false}
        onImport={noop}
        onApprove={noop}
        onReject={noop}
        onEditCandidate={noop}
        onDeprecate={noop}
        onDeleteRecord={noop}
        onEditRecord={noop}
        onConsolidate={noop}
        onAddAnnotation={noop}
        onRemoveAnnotation={noop}
        getRawMaterial={async () => null}
      />
    );

    const importBtn = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent?.includes("导入并抽取候选记忆")
    ) as HTMLButtonElement;
    expect(importBtn).toBeTruthy();
    expect(importBtn.disabled).toBe(true);
  });

  it("shows btn-loading class and spinner when importing=true", () => {
    const state = makeState();
    renderView(
      <MemoryGovernanceView
        state={state}
        importing={true}
        onImport={noop}
        onApprove={noop}
        onReject={noop}
        onEditCandidate={noop}
        onDeprecate={noop}
        onDeleteRecord={noop}
        onEditRecord={noop}
        onConsolidate={noop}
        onAddAnnotation={noop}
        onRemoveAnnotation={noop}
        getRawMaterial={async () => null}
      />
    );

    const loadingBtn = container.querySelector(".btn-loading");
    expect(loadingBtn).toBeTruthy();
    // spinner element present inside
    expect(container.querySelector(".spinner")).toBeTruthy();
    // button shows "抽取中…"
    expect(loadingBtn!.textContent).toContain("抽取中");
  });
});
