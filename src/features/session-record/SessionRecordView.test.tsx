import { renderToString } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { SessionRecordView } from "./SessionRecordView";

describe("SessionRecordView", () => {
  it("keeps 双轨笔记 in the eyebrow and explains the old name", () => {
    const html = renderToString(
      <SessionRecordView pane="notes" onPane={vi.fn()}>
        <p>笔记正文</p>
      </SessionRecordView>
    );
    expect(html).toContain("双轨笔记");
    expect(html).toContain("这里就是以前的双轨笔记");
    expect(html).toContain("笔记正文");
  });

  it("renders 笔记 / 档案 / 资产 tabs", () => {
    const html = renderToString(
      <SessionRecordView pane="archive" onPane={vi.fn()}>
        <p>档案正文</p>
      </SessionRecordView>
    );
    expect(html).toContain("笔记");
    expect(html).toContain("本场档案");
    expect(html).toContain("本场资产");
    expect(html).toContain("档案正文");
  });
});
