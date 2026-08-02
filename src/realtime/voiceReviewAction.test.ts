import { describe, expect, it, vi } from "vitest";
import { runVoiceReviewAction } from "./voiceReviewAction";

describe("runVoiceReviewAction", () => {
  it("先清除当前项再执行管线动作，使同步发布的下一项保持可见", () => {
    const first = { text: "第一次断线", reason: "断线一", source: "recovery" as const };
    const next = { text: "第二次断线", reason: "断线二", source: "recovery" as const };
    const ref: { current: typeof first | null } = { current: first };
    let rendered: typeof first | null = first;
    const order: string[] = [];

    const consumed = runVoiceReviewAction({
      ref,
      clearRendered: () => {
        order.push("clear");
        rendered = null;
      },
      action: () => {
        order.push("consume");
        ref.current = next;
        rendered = next;
        order.push("publish-next");
      },
    });

    expect(consumed).toBe(true);
    expect(order).toEqual(["clear", "consume", "publish-next"]);
    expect(ref.current).toBe(next);
    expect(rendered).toBe(next);
  });

  it("没有当前 review 时不执行动作", () => {
    const action = vi.fn();
    expect(runVoiceReviewAction({
      ref: { current: null },
      clearRendered: vi.fn(),
      action,
    })).toBe(false);
    expect(action).not.toHaveBeenCalled();
  });
});
