export function buildStableDigest(value: unknown) {
  return fnv1aDigest(stableStringify(value));
}

/**
 * C2#1:对"已经序列化好的字符串"做单遍 FNV-1a 摘要(格式与 buildStableDigest 一致:
 * fnv1a-xxxxxxxx)。给超大载荷(如含全部音频 base64 的导出包)用——buildStableDigest 会对
 * 对象做键排序深拷贝 + 再序列化一遍,内存/CPU 峰值随载荷翻倍;调用方已有 JSON 字符串时
 * 直接哈希该字符串即可。注意:摘要值取决于传入字符串的字节序(不做键排序),调用方需保证
 * 序列化方式自身稳定(同一构造路径下 JSON.stringify 的键序是确定的)。
 */
export function fnv1aDigest(text: string) {
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
