import { describe, it, expect } from "vitest";
import { tagSourceThemes } from "./theme-tagging";

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
});
