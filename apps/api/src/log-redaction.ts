/**
 * 日志脱敏工具(审计 F-07)。
 *
 * 为什么要脱敏:
 * - Provider(如 DashScope TTS)返回的音频 URL 带签名查询参数,在有效期内
 *   等同 bearer capability——谁拿到 URL 谁就能取到内容。日志里回显完整 URL
 *   (哪怕只截前 80 字符,签名 query 常在其中)= 把凭据写进日志。
 * - API key 前缀对排障没有验证价值(不能证明 key 有效),却增加凭据识别面
 *   (可用于关联同一账号、辅助撞库)。日志只应回答"配置了没有"。
 *
 * 与 scripts/lib/redact.mjs 的 redactUrl 保持行为等价(脚本侧无法 import TS,
 * 故两份实现;mjs 侧额外多一个脚本专用的 describeKeyStatus)。
 */
import { createHash } from "node:crypto";

/**
 * 把 URL 脱敏为 `origin [path#短hash]`:
 * - 保留 origin(host 足以判断"是不是真实外部资源");
 * - path 明文、query、fragment 全部移除——签名参数在 query 里,path 也可能
 *   含资源 id;短 hash 仅用于对比"两次日志是不是同一资源"。
 * - 解析失败(非法/空 URL)返回固定占位符,绝不回显原始输入。
 */
export function redactUrl(url: string): string {
  try {
    const u = new URL(url);
    const pathHash = createHash("sha256").update(u.pathname).digest("hex").slice(0, 8);
    return `${u.origin} [path#${pathHash}]`;
  } catch {
    return "[redacted-url]";
  }
}
