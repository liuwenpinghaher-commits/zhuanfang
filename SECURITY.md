# Security Policy / 安全策略

## Supported Versions / 支持版本

| Version | Supported |
| ------- | --------- |
| `1.0.x` (`main`) | :white_check_mark: |

---

## Reporting a Vulnerability / 报告安全漏洞

If you discover a security vulnerability in **Zhuanfang (专访日记)**, please report it responsibly:

- **Do NOT open a public GitHub issue** for sensitive vulnerabilities (e.g., authentication bypass, SSRF, arbitrary file read/write, or secret leakage).
- Use **GitHub Private Vulnerability Reporting** on this repository (`Security` -> `Report a vulnerability`) or contact the maintainer directly via GitHub profile contact.
- Please include:
  1. Affected component or route (e.g., `apps/api/src/routes/...` or `src/realtime/...`);
  2. Minimal reproduction steps or proof-of-concept request;
  3. Potential impact and suggested remediation.

We aim to acknowledge vulnerability reports within **72 hours** and provide a fix or mitigation plan within **7 days**.

---

## Security & Privacy Architecture / 安全与隐私设计基线

1. **Server-Side Secret Isolation / 密钥服务端隔离**:
   - All LLM, ASR, TTS, and Search API keys (`DASHSCOPE_API_KEY`, `BAILIAN_API_KEY`, `ANYSEARCH_API_KEY`, etc.) are kept strictly inside the Fastify Product API server and are never exposed to browser clients.
   - `GET /api/system/config` masks all secret fields (`maskedValue`) and never echoes raw secret values.
   - Log redaction (`apps/api/src/log-redaction.ts`) strips bearer tokens, query tokens, and `sk-*` keys before writing to logs.

2. **Fail-Closed Production Authentication / 生产环境默认闭合鉴权**:
   - When `DEPLOYMENT_PROFILE=production`, `PRODUCT_API_TOKEN` is mandatory; the server refuses to boot if it is missing.
   - Human browser access supports L1 session authentication (`PRODUCT_AUTH_ENABLED=1` + `PRODUCT_SESSION_SECRET`) using HMAC-signed `HttpOnly; SameSite=Lax` cookies (`zf_session`) and PBKDF2-SHA256 password hashing.

3. **SSRF & Path Traversal Protection / SSRF 与路径穿越防护**:
   - Audio transcription and external URL fetches validate schemes and block private/loopback IP ranges unless explicitly allowlisted via `CORPUS_AUDIO_URL_ALLOWLIST`.
   - Local corpus audio and static asset serving enforce strict filename and path normalization checks.

4. **Personal Data Governance & Right to Erasure / 个人数据治理与擦除闭环**:
   - Users can inspect their complete personal data inventory (`GET /api/state/privacy-report`), export a full JSON backup (`GET /api/state/export`), forget individual interview sessions (`POST /api/notes/:id/forget`), or permanently purge all personal data and local audio artifacts (`POST /api/state/purge` with `confirm: "PURGE_PERSONAL_DATA"`).
