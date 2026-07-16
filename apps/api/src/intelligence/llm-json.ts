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

function tryParseObject(text: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(text);
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * Parse an LLM JSON-object response. Tolerates surrounding chatter (code fences, text
 * before/after the object) — that is output-format normalization. It does NOT repair
 * structural damage: a truncated or malformed object returns null so the caller surfaces
 * the failure instead of silently acting on a partial result. (真实性原则:截断的 JSON
 * 意味着资产不完整,打捞它会把"半成功"伪装成"完整成功"。)
 */
export function parseJsonObjectLoose(raw: string): Record<string, unknown> | null {
  const stripped = stripCodeFences(raw);
  const start = stripped.indexOf("{");
  if (start === -1) {
    return null;
  }
  // A top-level array (or anything where `[` opens before the first `{`) is NOT the object
  // these callers expect — let the caller reject.
  const firstBracket = stripped.indexOf("[");
  if (firstBracket !== -1 && firstBracket < start) {
    return null;
  }
  const direct = tryParseObject(stripped.slice(start));
  if (direct) {
    return direct;
  }
  // Trailing chatter after the closing brace is the only other benign shape.
  const end = stripped.lastIndexOf("}");
  if (end > start) {
    return tryParseObject(stripped.slice(start, end + 1));
  }
  return null;
}

export function asString(value: unknown): string {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

export function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

export function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function asStringArray(value: unknown, fallback: string[] = []): string[] {
  if (!Array.isArray(value)) {
    return fallback;
  }
  const items = value.map((item) => (typeof item === "string" ? item.trim() : "")).filter(Boolean);
  return items.length ? items : fallback;
}
