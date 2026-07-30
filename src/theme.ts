/** Color appearance: user preference + resolved effective theme. */

export type ThemePreference = "light" | "dark" | "system";
export type ResolvedTheme = "light" | "dark";

export const THEME_STORAGE_KEY = "zhuanfang.color-theme";

export function isThemePreference(value: unknown): value is ThemePreference {
  return value === "light" || value === "dark" || value === "system";
}

export function readStoredThemePreference(
  storage: Pick<Storage, "getItem"> | null | undefined = typeof localStorage !== "undefined" ? localStorage : null
): ThemePreference {
  try {
    const raw = storage?.getItem(THEME_STORAGE_KEY);
    if (isThemePreference(raw)) return raw;
  } catch {
    /* private mode / blocked storage */
  }
  return "system";
}

export function writeStoredThemePreference(
  preference: ThemePreference,
  storage: Pick<Storage, "setItem"> | null | undefined = typeof localStorage !== "undefined" ? localStorage : null
): void {
  try {
    storage?.setItem(THEME_STORAGE_KEY, preference);
  } catch {
    /* ignore quota / private mode */
  }
}

export function getSystemTheme(
  media:
    | Pick<MediaQueryList, "matches">
    | null
    | undefined = typeof window !== "undefined" && typeof window.matchMedia === "function"
      ? window.matchMedia("(prefers-color-scheme: dark)")
      : null
): ResolvedTheme {
  return media?.matches ? "dark" : "light";
}

export function resolveTheme(preference: ThemePreference, system: ResolvedTheme = getSystemTheme()): ResolvedTheme {
  if (preference === "system") return system;
  return preference;
}

export function cycleThemePreference(current: ThemePreference): ThemePreference {
  if (current === "system") return "light";
  if (current === "light") return "dark";
  return "system";
}

export function themePreferenceLabel(preference: ThemePreference): string {
  if (preference === "light") return "亮色";
  if (preference === "dark") return "暗色";
  return "跟随系统";
}

export function themeToggleAriaLabel(preference: ThemePreference, resolved: ResolvedTheme): string {
  return `外观：${themePreferenceLabel(preference)}（当前 ${resolved === "light" ? "亮色" : "暗色"}）。点击切换亮色 / 暗色 / 跟随系统`;
}

/** Apply resolved theme to documentElement for CSS `[data-theme]` + native controls. */
export function applyDocumentTheme(
  resolved: ResolvedTheme,
  root: { dataset: DOMStringMap; style: { colorScheme: string } } | null | undefined =
    typeof document !== "undefined" ? document.documentElement : null
): void {
  if (!root) return;
  root.dataset.theme = resolved;
  root.style.colorScheme = resolved;
}
