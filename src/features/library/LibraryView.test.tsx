import { renderToString } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { LibraryView } from "./LibraryView";

describe("LibraryView", () => {
  it("defaults copy to 问全书 and keeps import as a nested pane", () => {
    const html = renderToString(
      <LibraryView pane="chat" onPane={vi.fn()}>
        <p>对话正文</p>
      </LibraryView>
    );
    expect(html).toContain("问全书");
    expect(html).toContain("导入与索引");
    expect(html).toContain("对话正文");
    expect(html).toContain("资料");
  });
});
