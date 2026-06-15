import { describe, expect, it } from "vitest";
import {
  asArray,
  asObject,
  asString,
  asStringArray,
  parseJsonObject,
  stripCodeFences
} from "./llm-json";

describe("stripCodeFences", () => {
  it("strips ```json fences", () => {
    expect(stripCodeFences("```json\n{\"a\":1}\n```")).toBe('{"a":1}');
  });

  it("strips plain ``` fences", () => {
    expect(stripCodeFences("```\n{\"a\":1}\n```")).toBe('{"a":1}');
  });

  it("returns the input unchanged when no fences", () => {
    expect(stripCodeFences('{"a":1}')).toBe('{"a":1}');
  });

  it("trims surrounding whitespace", () => {
    expect(stripCodeFences('  {"a":1}  ')).toBe('{"a":1}');
  });
});

describe("parseJsonObject", () => {
  it("parses a plain JSON object string", () => {
    const result = parseJsonObject('{"key":"value"}');
    expect(result).toEqual({ key: "value" });
  });

  it("strips ```json fences before parsing", () => {
    const result = parseJsonObject('```json\n{"key":"value"}\n```');
    expect(result).toEqual({ key: "value" });
  });

  it("throws on array top-level", () => {
    expect(() => parseJsonObject("[1,2,3]")).toThrow("Expected a JSON object");
  });

  it("throws on string top-level", () => {
    expect(() => parseJsonObject('"hello"')).toThrow("Expected a JSON object");
  });

  it("throws on non-JSON", () => {
    expect(() => parseJsonObject("not json")).toThrow();
  });

  it("throws on null top-level", () => {
    expect(() => parseJsonObject("null")).toThrow("Expected a JSON object");
  });
});

describe("asString", () => {
  it("returns the string when given a non-empty string", () => {
    expect(asString("hello")).toBe("hello");
  });

  it("returns empty string for a number", () => {
    expect(asString(7)).toBe("");
  });

  it("returns empty string for null", () => {
    expect(asString(null)).toBe("");
  });

  it("returns empty string for undefined", () => {
    expect(asString(undefined)).toBe("");
  });

  it("returns empty string for empty string", () => {
    expect(asString("")).toBe("");
  });

  it("returns empty string for whitespace-only string", () => {
    expect(asString("   ")).toBe("");
  });

  it("trims a padded string", () => {
    expect(asString("  x  ")).toBe("x");
  });
});

describe("asObject", () => {
  it("returns the object when given a plain object", () => {
    const obj = { a: 1, b: "two" };
    expect(asObject(obj)).toBe(obj);
  });

  it("returns {} for null", () => {
    expect(asObject(null)).toEqual({});
  });

  it("returns {} for undefined", () => {
    expect(asObject(undefined)).toEqual({});
  });

  it("returns {} for an array", () => {
    expect(asObject([1, 2])).toEqual({});
  });

  it("returns {} for a string", () => {
    expect(asObject("string")).toEqual({});
  });

  it("returns {} for a number", () => {
    expect(asObject(42)).toEqual({});
  });
});

describe("asArray", () => {
  it("returns the array as-is", () => {
    const arr = [1, "a", null];
    expect(asArray(arr)).toBe(arr);
  });

  it("returns [] for a string (non-array)", () => {
    expect(asArray("nope")).toEqual([]);
  });

  it("returns [] for null", () => {
    expect(asArray(null)).toEqual([]);
  });

  it("returns [] for an object", () => {
    expect(asArray({ a: 1 })).toEqual([]);
  });

  it("returns [] for undefined", () => {
    expect(asArray(undefined)).toEqual([]);
  });
});

describe("asStringArray", () => {
  it("filters out non-strings and trims strings", () => {
    // Numbers are non-strings → dropped; strings are trimmed
    const result = asStringArray(["a", 1, " b "]);
    expect(result).toEqual(["a", "b"]);
  });

  it("returns fallback when given a non-array", () => {
    expect(asStringArray("nope", ["x"])).toEqual(["x"]);
  });

  it("returns fallback when the filtered result is empty", () => {
    // All items are numbers (non-strings) → all trimmed to "" → empty → fallback
    expect(asStringArray([1, 2, 3], ["x"])).toEqual(["x"]);
  });

  it("uses empty array as default fallback", () => {
    expect(asStringArray("nope")).toEqual([]);
  });

  it("drops strings that are whitespace-only (trim becomes empty)", () => {
    expect(asStringArray(["  ", "hello", "  "], ["fallback"])).toEqual(["hello"]);
  });

  it("returns fallback for null", () => {
    expect(asStringArray(null, ["default"])).toEqual(["default"]);
  });

  it("returns an all-string array unchanged (after trimming)", () => {
    expect(asStringArray(["foo", "bar"])).toEqual(["foo", "bar"]);
  });
});
