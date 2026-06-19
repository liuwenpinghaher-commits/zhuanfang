import { describe, it, expect } from "vitest";
import { tagSourceThemes } from "./theme-tagging";
import { createInitialProductState } from "./engine";

const themes = [
  { id: "theme-control", name: "控制感" },
  { id: "theme-role", name: "问题定义权" },
  { id: "theme-other", name: "组织韧性" }
];

describe("tagSourceThemes", () => {
  it("返回含主题名的文本对应的 id", () => {
    const result = tagSourceThemes("关于控制感的一篇随手记", themes);
    expect(result).toEqual(["theme-control"]);
  });

  it("文本不含任何主题名时返回空数组", () => {
    const result = tagSourceThemes("完全无关的内容", themes);
    expect(result).toEqual([]);
  });

  it("多个主题名同时命中时返回多个 id", () => {
    const result = tagSourceThemes("控制感与问题定义权的权衡", themes);
    expect(result).toContain("theme-control");
    expect(result).toContain("theme-role");
    expect(result).not.toContain("theme-other");
  });

  it("themes 列表为空时返回空数组", () => {
    const result = tagSourceThemes("控制感", []);
    expect(result).toEqual([]);
  });

  it("主题 name 为空字符串时不会误匹配", () => {
    const withEmpty = [{ id: "theme-empty", name: "" }, ...themes];
    const result = tagSourceThemes("任意内容", withEmpty);
    expect(result).not.toContain("theme-empty");
  });

  describe("语义匹配(名称未出现但谈到主题相关词)", () => {
    const seedThemes = createInitialProductState().themes;
    const control = seedThemes.find((t) => t.id === "theme-control")!;

    it("资料谈到主题摘要/原话里的词(但不含主题名)也能归属", () => {
      // 控制感 摘要/原话涉及:团队授权、亲自下场、替他们兜底。
      // 这段资料不含"控制感"三字,但密集命中其语料词汇。
      const related =
        "在团队授权和亲自下场之间反复摇摆，既不想每次都替团队兜底，又怕一旦授权就失去判断。";
      expect(related.includes("控制感")).toBe(false); // 确认不是靠强信号
      const result = tagSourceThemes(related, [control]);
      expect(result).toEqual(["theme-control"]);
    });

    it("无关资料不会被误归属", () => {
      const unrelated = "今天学习 React 组件拆分和状态管理的最佳实践，顺便整理了构建脚本。";
      const result = tagSourceThemes(unrelated, [control]);
      expect(result).toEqual([]);
    });
  });
});
