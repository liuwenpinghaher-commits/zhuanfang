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

  it("注入的回调自身抛错也绝不破坏主写(加固不变量)", () => {
    const auth = createInMemoryProductStateRepository();
    const shadow = {
      ...createInMemoryProductStateRepository(),
      replaceState: () => { throw new Error("shadow boom"); }
    };
    // onShadowError 自身再抛 —— 不得冒泡出 replaceState。
    const repo = createDualWriteRepository({
      authoritative: auth, shadow,
      onShadowError: () => { throw new Error("callback boom"); }
    });
    const result = repo.replaceState(pointState("pt_1", "标题"));
    expect(result.points[0]?.id).toBe("pt_1");          // 主写仍成功、未抛
    expect(auth.getState().points[0]?.id).toBe("pt_1");
  });

  it("注入的 onDivergence 自身抛错也不破坏主写", () => {
    const auth = createInMemoryProductStateRepository();
    const shadowInner = createInMemoryProductStateRepository();
    const shadow = {
      ...shadowInner,
      replaceState: (s: ReturnType<typeof createInitialProductState>) => shadowInner.replaceState({ ...s, points: [] })
    };
    const repo = createDualWriteRepository({
      authoritative: auth, shadow,
      onDivergence: () => { throw new Error("divergence callback boom"); }
    });
    expect(() => repo.replaceState(pointState("pt_1", "标题"))).not.toThrow();
    expect(auth.getState().points[0]?.id).toBe("pt_1");
  });

  it("R6-1:shadow 发散(写成功但内容偏离)计入 persistHealth——冷备落后可见,非恒绿", () => {
    const auth = createInMemoryProductStateRepository();
    const shadowInner = createInMemoryProductStateRepository();
    const shadow = { ...shadowInner, replaceState: (s: ReturnType<typeof createInitialProductState>) => shadowInner.replaceState({ ...s, points: [] }) };
    const repo = createDualWriteRepository({ authoritative: auth, shadow, onDivergence: () => {} });
    repo.replaceState(pointState("pt_1", "标题"));
    // 发散不抛异常,但此前只进 console → health 恒绿;R6-1 让其计入 shadowFailures/consecutiveFailures
    expect(repo.getPersistHealth().consecutiveFailures).toBeGreaterThan(0);
    expect(repo.getPersistHealth().shadowFailures).toBeGreaterThan(0);
  });

  it("R6-2:影子恢复一致后 consecutiveFailures 清零——一次瞬时异常不永久 degraded", () => {
    const auth = createInMemoryProductStateRepository();
    const shadowInner = createInMemoryProductStateRepository();
    let corrupt = true;
    const shadow = { ...shadowInner, replaceState: (s: ReturnType<typeof createInitialProductState>) => shadowInner.replaceState(corrupt ? { ...s, points: [] } : s) };
    const repo = createDualWriteRepository({ authoritative: auth, shadow, onDivergence: () => {} });
    repo.replaceState(pointState("pt_1", "标题"));                 // 发散一次
    expect(repo.getPersistHealth().consecutiveFailures).toBeGreaterThan(0);
    corrupt = false;
    repo.replaceState(pointState("pt_2", "标题2"));                // 影子恢复一致
    expect(repo.getPersistHealth().consecutiveFailures).toBe(0);   // 连续计数清零(名副其实)
  });

  it("R6-3:shadow 抛错后 persistHealth 带 lastErrorAt(此前 ?? 短路到 dual repo 恒缺失)", () => {
    const auth = createInMemoryProductStateRepository();
    const shadow = { ...createInMemoryProductStateRepository(), replaceState: () => { throw new Error("shadow boom"); } };
    const repo = createDualWriteRepository({ authoritative: auth, shadow, onShadowError: () => {} });
    repo.replaceState(pointState("pt_1", "标题"));
    expect(repo.getPersistHealth().lastErrorAt).toBeTruthy();
    expect(repo.getPersistHealth().lastError).toContain("shadow boom");
  });
});
