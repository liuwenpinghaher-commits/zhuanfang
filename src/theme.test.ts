import { describe, expect, it } from "vitest";
import {
  THEME_STORAGE_KEY,
  applyDocumentTheme,
  cycleThemePreference,
  getSystemTheme,
  isThemePreference,
  readStoredThemePreference,
  resolveTheme,
  themePreferenceLabel,
  themeToggleAriaLabel,
  writeStoredThemePreference
} from "./theme";

describe("theme preference", () => {
  it("validates preference values", () => {
    expect(isThemePreference("light")).toBe(true);
    expect(isThemePreference("dark")).toBe(true);
    expect(isThemePreference("system")).toBe(true);
    expect(isThemePreference("auto")).toBe(false);
  });

  it("cycles system → light → dark → system", () => {
    expect(cycleThemePreference("system")).toBe("light");
    expect(cycleThemePreference("light")).toBe("dark");
    expect(cycleThemePreference("dark")).toBe("system");
  });

  it("resolves system preference against OS theme", () => {
    expect(resolveTheme("light", "dark")).toBe("light");
    expect(resolveTheme("dark", "light")).toBe("dark");
    expect(resolveTheme("system", "light")).toBe("light");
    expect(resolveTheme("system", "dark")).toBe("dark");
  });

  it("reads and writes localStorage preference", () => {
    const store = new Map<string, string>();
    const storage = {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => {
        store.set(key, value);
      }
    };

    expect(readStoredThemePreference(storage)).toBe("system");
    writeStoredThemePreference("light", storage);
    expect(store.get(THEME_STORAGE_KEY)).toBe("light");
    expect(readStoredThemePreference(storage)).toBe("light");
  });

  it("maps system media query to resolved theme", () => {
    expect(getSystemTheme({ matches: true })).toBe("dark");
    expect(getSystemTheme({ matches: false })).toBe("light");
    expect(getSystemTheme(null)).toBe("light");
  });

  it("applies data-theme and color-scheme on the document root", () => {
    const root = { dataset: {} as DOMStringMap, style: { colorScheme: "" } };
    applyDocumentTheme("light", root);
    expect(root.dataset.theme).toBe("light");
    expect(root.style.colorScheme).toBe("light");
    applyDocumentTheme("dark", root);
    expect(root.dataset.theme).toBe("dark");
    expect(root.style.colorScheme).toBe("dark");
  });

  it("exposes Chinese labels for the toggle", () => {
    expect(themePreferenceLabel("light")).toBe("亮色");
    expect(themePreferenceLabel("dark")).toBe("暗色");
    expect(themePreferenceLabel("system")).toBe("跟随系统");
    expect(themeToggleAriaLabel("system", "light")).toContain("跟随系统");
    expect(themeToggleAriaLabel("system", "light")).toContain("亮色");
  });
});
