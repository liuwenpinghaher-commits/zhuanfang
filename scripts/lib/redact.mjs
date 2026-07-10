// 日志脱敏工具(审计 F-07)——scripts/*.mjs 专用,与 apps/api/src/log-redaction.ts 行为等价
// (.mjs 无法 import TS,故维护两份实现;改其一必须同步改另一份)。
//
// 为什么要脱敏:
// - Provider 返回的音频 URL 带签名查询参数,在有效期内等同 bearer capability——
//   谁拿到 URL 谁就能取到内容。日志回显完整 URL = 把凭据写进日志。
// - API key 前缀对排障没有验证价值(不能证明 key 有效),却增加凭据识别面。
//   日志只应回答"配置了没有"。
import { createHash } from "node:crypto";

/**
 * 把 URL 脱敏为 `origin [path#短hash]`:保留 origin(足以判断指向哪个服务),
 * path 明文、query(签名所在)、fragment 全部移除;短 hash 仅供对比同一资源。
 * 解析失败返回固定占位符,绝不回显原始输入。
 */
export function redactUrl(url) {
  try {
    const u = new URL(url);
    const pathHash = createHash("sha256").update(u.pathname).digest("hex").slice(0, 8);
    return `${u.origin} [path#${pathHash}]`;
  } catch {
    return "[redacted-url]";
  }
}

/**
 * 描述某个密钥/凭据是否已配置,绝不包含任何 key 字节(连前缀都不给,
 * 前缀无验证价值却增加凭据识别面——见文件头)。
 */
export function describeKeyStatus(value) {
  const configured = typeof value === "string" && value.trim().length > 0;
  return `configured: ${configured}`;
}
