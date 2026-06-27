import { describe, it, expect, vi } from "vitest";
import { createInMemoryProductStateRepository } from "./product-state-repository";
import { createDualWriteRepository } from "./dual-write-repository";
import { createInitialProductState } from "../../../src/domain/engine";

function pointState(id: string, title: string) {
  const base = createInitialProductState();
  return { ...base, points: [{ id, title, content: "c", status: "稳定观点" as const,
    confidence: "用户确认" as const, evidence: [], relatedThemeIds: [], important: false,
    updatedAt: "2026-06-27T00:00:00.000Z" }] };
}

describe("dual-write repository", () => {
  it("写入同时落 authoritative + shadow;读走 authoritative", () => {
    const auth = createInMemoryProductStateRepository();
    const shadow = createInMemoryProductStateRepository();
    const repo = createDualWriteRepository({ authoritative: auth, shadow });
    repo.replaceState(pointState("pt_1", "标题"));
    expect(auth.getState().points[0]?.id).toBe("pt_1");
    expect(shadow.getState().points[0]?.id).toBe("pt_1");   // shadow 也写了
    expect(repo.getState().points[0]?.id).toBe("pt_1");     // 读走权威
  });

  it("两边内容一致时不报发散", () => {
    const onDivergence = vi.fn();
    const repo = createDualWriteRepository({
      authoritative: createInMemoryProductStateRepository(),
      shadow: createInMemoryProductStateRepository(),
      onDivergence
    });
    repo.replaceState(pointState("pt_1", "标题"));
    expect(onDivergence).not.toHaveBeenCalled();
  });

  it("shadow 内容偏离 → onDivergence 被调用(但不抛)", () => {
    const onDivergence = vi.fn();
    const auth = createInMemoryProductStateRepository();
    // shadow 用一个被污染的实现:replaceState 故意丢掉 points
    const shadowInner = createInMemoryProductStateRepository();
    const shadow = {
      ...shadowInner,
      replaceState: (s: ReturnType<typeof createInitialProductState>) =>
        shadowInner.replaceState({ ...s, points: [] })
    };
    const repo = createDualWriteRepository({ authoritative: auth, shadow, onDivergence });
    expect(() => repo.replaceState(pointState("pt_1", "标题"))).not.toThrow();
    expect(onDivergence).toHaveBeenCalledTimes(1);
    expect(auth.getState().points[0]?.id).toBe("pt_1");     // 主写不受影响
  });

  it("shadow 写抛错 → 主写仍成功、不抛", () => {
    const auth = createInMemoryProductStateRepository();
    const shadow = {
      ...createInMemoryProductStateRepository(),
      replaceState: () => { throw new Error("shadow boom"); }
    };
    const onShadowError = vi.fn();
    const repo = createDualWriteRepository({ authoritative: auth, shadow, onShadowError });
    const result = repo.replaceState(pointState("pt_1", "标题"));
    expect(result.points[0]?.id).toBe("pt_1");
    expect(onShadowError).toHaveBeenCalledTimes(1);
  });

  it("乐观锁 + revision 走 authoritative", () => {
    const auth = createInMemoryProductStateRepository();
    const repo = createDualWriteRepository({ authoritative: auth, shadow: createInMemoryProductStateRepository() });
    const s0 = repo.getState();
    const s1 = repo.replaceState(s0);
    expect(s1.revision).toBe((s0.revision ?? 0) + 1);
  });
});
