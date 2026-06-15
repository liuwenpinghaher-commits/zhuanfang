// Defensive coercion helpers shared by the server-side LLM intelligence modules.
export function stripCodeFences(raw: string): string {
  const trimmed = raw.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  return (fenced ? fenced[1] : trimmed).trim();
}

export function parseJsonObject(raw: string): Record<string, unknown> {
  const value = JSON.parse(stripCodeFences(raw));
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Expected a JSON object from the LLM.");
  }
  return value as Record<string, unknown>;
}

export function asString(value: unknown): string {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

export function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

export function asStringArray(value: unknown, fallback: string[] = []): string[] {
  if (!Array.isArray(value)) {
    return fallback;
  }
  const items = value.map((item) => (typeof item === "string" ? item.trim() : "")).filter(Boolean);
  return items.length ? items : fallback;
}
