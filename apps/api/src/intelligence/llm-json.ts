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

function closersFor(stack: string[]): string {
  return stack
    .slice()
    .reverse()
    .map((open) => (open === "{" ? "}" : "]"))
    .join("");
}

/**
 * Tolerant object parse. Returns the strict parse when possible; otherwise SALVAGES a
 * truncated JSON object (the common LLM failure: output cut off at max_tokens mid-value) by
 * closing the open string/brackets at each structural boundary and keeping the longest prefix
 * that parses. Returns null only when nothing usable can be recovered. Used as a fallback so a
 * slightly malformed LLM response degrades gracefully (keep the assets it DID emit) instead of
 * dropping everything.
 */
export function parseJsonObjectLoose(raw: string): Record<string, unknown> | null {
  const stripped = stripCodeFences(raw);
  const start = stripped.indexOf("{");
  if (start === -1) {
    return null;
  }
  // A top-level array (or anything where `[` opens before the first `{`) is NOT the object
  // these callers expect — don't salvage an inner object out of it; let the caller reject.
  const firstBracket = stripped.indexOf("[");
  if (firstBracket !== -1 && firstBracket < start) {
    return null;
  }
  const body = stripped.slice(start);
  const direct = tryParseObject(body);
  if (direct) {
    return direct;
  }

  // Build repair candidates at every structural boundary, longest-prefix first.
  const candidates: Array<{ idx: number; text: string }> = [];
  const stack: string[] = [];
  let inString = false;
  let escaped = false;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') {
        inString = false;
        candidates.push({ idx: i + 1, text: body.slice(0, i + 1) + closersFor(stack) });
      }
      continue;
    }
    if (c === '"') inString = true;
    else if (c === "{" || c === "[") stack.push(c);
    else if (c === "}" || c === "]") {
      stack.pop();
      candidates.push({ idx: i + 1, text: body.slice(0, i + 1) + closersFor(stack) });
    } else if (c === ",") {
      candidates.push({ idx: i, text: body.slice(0, i) + closersFor(stack) }); // drop dangling element
    }
  }
  if (inString) {
    candidates.push({ idx: body.length, text: body + '"' + closersFor(stack) }); // close the open value string
  }

  const seen = new Set<string>();
  for (const cand of candidates.sort((a, b) => b.idx - a.idx)) {
    if (seen.has(cand.text)) continue;
    seen.add(cand.text);
    const parsed = tryParseObject(cand.text);
    if (parsed) return parsed;
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
