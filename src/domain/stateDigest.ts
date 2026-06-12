export function buildStableDigest(value: unknown) {
  const text = stableStringify(value);
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `fnv1a-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

export function stableStringify(value: unknown): string {
  return JSON.stringify(toStableJsonValue(value));
}

export function measureUtf8Bytes(value: string) {
  return new TextEncoder().encode(value).length;
}

function toStableJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(toStableJsonValue);
  }
  if (!value || typeof value !== "object") {
    return value;
  }

  return Object.keys(value as Record<string, unknown>)
    .sort()
    .reduce<Record<string, unknown>>((stableValue, key) => {
      const nextValue = (value as Record<string, unknown>)[key];
      if (nextValue !== undefined) {
        stableValue[key] = toStableJsonValue(nextValue);
      }
      return stableValue;
    }, {});
}
